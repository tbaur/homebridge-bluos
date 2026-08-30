"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview BluOS Custom Integration API client.
 *
 * Three scheduling rules are enforced here rather than at the call sites, so no
 * caller can accidentally violate them:
 *
 * 1. At least one second between consecutive requests for the same resource on
 *    the same endpoint. API v1.7 section 2 requires this of long-polling
 *    clients, and phrases it as a requirement rather than advice.
 * 2. At least 100 ms between control calls to one endpoint, so a HomeKit scene
 *    that touches several tiles at once cannot burst a player.
 * 3. Writes to one chassis are serialised. A NAD CI S2 or CI 580 exposes several
 *    zones on one IP; concurrent writes to `:11000` and `:11010` are writes to
 *    the same box. Different chassis still run in parallel.
 *
 * Note that a chassis and a group are different things. Serialisation above is
 * per chassis, because that is one piece of hardware; grouping is a logical
 * relationship between zones that may live on different chassis entirely, and it
 * is expressed per write through {@link WriteScope}.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BluOSClient = void 0;
const settings_1 = require("../settings");
const errors_1 = require("../utils/errors");
const timing_1 = require("../utils/timing");
const validators_1 = require("../utils/validators");
const http_1 = require("./http");
const identity_1 = require("./identity");
const sync_status_1 = require("./sync-status");
/**
 * Talks to BluOS players over the LAN.
 *
 * One instance serves the whole fleet: the rate limits and the per-chassis write
 * lock are only meaningful if every request goes through the same bookkeeping.
 */
class BluOSClient {
    log;
    httpGet;
    httpPost;
    now;
    sleep;
    /** Last request time, keyed by `endpoint|resource`, for the one-second rule. */
    lastResourceRequest = new Map();
    /** Last control call time, keyed by endpoint. */
    lastControlRequest = new Map();
    /** Tail of the write queue for each chassis host. */
    chassisWriteQueue = new Map();
    constructor(options) {
        this.log = options.log;
        this.httpGet = options.httpGet ?? http_1.httpGet;
        this.httpPost = options.httpPost ?? http_1.httpPost;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? timing_1.sleep;
    }
    /** Read `/SyncStatus` once, without long-polling. */
    async readSyncStatus(endpoint) {
        const body = await this.get({
            endpoint,
            resource: 'SyncStatus',
            query: {},
            totalTimeoutMs: settings_1.STATUS_TIMEOUT_MS,
        });
        return (0, sync_status_1.parseSyncStatus)(body, (0, identity_1.formatEndpoint)(endpoint.host, endpoint.port));
    }
    /**
     * Long-poll `/SyncStatus`, returning when the player's state changes or the
     * poll window elapses.
     *
     * Measured on firmware 4.16.6: with a current etag the request holds for the
     * full requested window (15.03 s for `timeout=15`), and with a stale etag it
     * answers in 44 ms. Verified per-zone rather than per-chassis, so a sibling
     * zone changing volume does not wake this poll.
     */
    async pollSyncStatus(endpoint, etag, signal) {
        const body = await this.get({
            endpoint,
            resource: 'SyncStatus',
            query: { timeout: String(settings_1.LONG_POLL_SEC), etag },
            totalTimeoutMs: settings_1.LONG_POLL_SEC * 1_000 + settings_1.LONG_POLL_READ_SLACK_MS,
            signal,
        });
        return (0, sync_status_1.parseSyncStatus)(body, (0, identity_1.formatEndpoint)(endpoint.host, endpoint.port));
    }
    /**
     * Read `/Volume` without changing anything.
     *
     * Not on the polling path: `/SyncStatus` is the source of truth for level and
     * mute, and it long-polls. This exists for the diagnostic scripts and for
     * confirming what a player reports when a write result looks wrong.
     */
    async readVolume(endpoint) {
        const body = await this.get({
            endpoint,
            resource: 'Volume',
            query: {},
            totalTimeoutMs: settings_1.STATUS_TIMEOUT_MS,
        });
        return (0, sync_status_1.parseVolume)(body);
    }
    /**
     * Set this zone's absolute level.
     *
     * `tell_slaves` is always sent explicitly rather than left to the firmware's
     * default, because the two answers are both defensible and the caller is the
     * only one that knows which applies: a tile addressing a zone that leads a
     * group should move the group, and a tile addressing any other zone must move
     * nothing else. See {@link WriteScope}.
     *
     * The player clamps the level into its own configured dB range, so the result
     * is authoritative and the caller should adopt it rather than assume the
     * requested value took effect.
     */
    async setVolume(endpoint, level, scope = { tellSlaves: false }) {
        if (!Number.isInteger(level) || level < settings_1.VOLUME_MIN || level > settings_1.VOLUME_MAX) {
            throw new RangeError(`volume must be an integer ${settings_1.VOLUME_MIN}-${settings_1.VOLUME_MAX}, got ${level}`);
        }
        return this.control(endpoint, {
            level: String(level),
            tell_slaves: scope.tellSlaves ? '1' : '0',
        });
    }
    /**
     * Mute or unmute this zone.
     *
     * `mute=1` mutes and `mute=0` unmutes. API v1.7's parameter table in section
     * 3.1 states the opposite, but sections 3.4 and 3.5, the response attribute
     * tables, and firmware 4.16.6 all agree with the mapping used here: writing
     * `mute=1` produced `mute="1" muteVolume="72"` on a real player.
     */
    async setMute(endpoint, muted, scope = { tellSlaves: false }) {
        return this.control(endpoint, {
            mute: muted ? '1' : '0',
            tell_slaves: scope.tellSlaves ? '1' : '0',
        });
    }
    /**
     * Restart the box at an address.
     *
     * Takes a host and no port, which is the whole story about this call. `/reboot`
     * is served on port 80 alongside `/diagnostics`, and the control ports answer
     * 404 for it. Port 80 is one server per chassis, so this restarts every zone
     * behind the address and cannot be aimed at one zone of a CI S2, however much
     * the rest of the API is per zone. See docs/PROTOCOL.md.
     *
     * Deliberately outside {@link withChassisLock}, unlike every other write. That
     * lock protects one address from concurrent volume and mute traffic, which is
     * rapid and repeated; a reboot is one request per address per press. Holding
     * the lock would only mean that a box which dies mid-response makes anything
     * queued behind it wait out the whole timeout. `respectResourceGap` still
     * paces repeat presses, keyed on the same address.
     *
     * A lost connection counts as success once the request reached the player.
     * This is the one call where that is right rather than reckless: a player that
     * is restarting cannot finish answering, so insisting on a clean response would
     * report failure precisely when the command worked. A failure to connect at all
     * is still a failure, which is the distinction {@link ConnectionError.delivered}
     * exists to draw.
     */
    async reboot(host) {
        if (!(0, validators_1.isValidHost)(host)) {
            throw new errors_1.ConnectionError(`refusing to contact an invalid host: ${JSON.stringify(host)}`);
        }
        await this.respectResourceGap(`${host}|${settings_1.REBOOT_RESOURCE}`);
        const url = `http://${host}/${settings_1.REBOOT_RESOURCE}`;
        this.log.debug(`POST ${url}`);
        try {
            const response = await this.httpPost(url, { ...settings_1.REBOOT_FORM }, {
                connectTimeoutMs: settings_1.CONNECT_TIMEOUT_MS,
                totalTimeoutMs: settings_1.REBOOT_TIMEOUT_MS,
                maxBytes: settings_1.MAX_XML_BYTES,
            });
            if (response.status !== 200) {
                throw new errors_1.ProtocolError(`reboot on ${host} answered HTTP ${response.status}`);
            }
            return { acknowledged: true };
        }
        catch (error) {
            if (error instanceof errors_1.ConnectionError && error.delivered) {
                this.log.debug(`${host} stopped answering after the reboot request, which is expected`);
                return { acknowledged: false };
            }
            throw error;
        }
    }
    async control(endpoint, query) {
        // Serialised per chassis: zones of a multi-zone player share one box.
        return this.withChassisLock(endpoint.host, async () => {
            await this.respectControlRate(endpoint);
            const body = await this.get({
                endpoint,
                resource: 'Volume',
                query,
                totalTimeoutMs: settings_1.CONTROL_TIMEOUT_MS,
            });
            return (0, sync_status_1.parseVolume)(body);
        });
    }
    /**
     * Queue work behind anything already writing to this chassis.
     *
     * The queue tail is stored per host; failures are swallowed for the purpose of
     * chaining so one rejected write does not poison later ones, while the
     * original promise still rejects for its own caller.
     */
    async withChassisLock(host, work) {
        const previous = this.chassisWriteQueue.get(host) ?? Promise.resolve();
        const run = previous.then(work, work);
        this.chassisWriteQueue.set(host, run.catch(() => undefined));
        try {
            return await run;
        }
        finally {
            // Only clear if nothing else queued behind us in the meantime.
            if (this.chassisWriteQueue.get(host) === run) {
                this.chassisWriteQueue.delete(host);
            }
        }
    }
    async respectControlRate(endpoint) {
        const key = (0, identity_1.formatEndpoint)(endpoint.host, endpoint.port);
        const last = this.lastControlRequest.get(key);
        const elapsed = last === undefined ? Number.POSITIVE_INFINITY : this.now() - last;
        if (elapsed < settings_1.CONTROL_RATE_LIMIT_MS) {
            await this.sleep(settings_1.CONTROL_RATE_LIMIT_MS - elapsed);
        }
        this.lastControlRequest.set(key, this.now());
    }
    /**
     * Wait out the API's one-second minimum gap between consecutive requests for
     * the same resource on the same endpoint.
     */
    async respectResourceGap(key) {
        const last = this.lastResourceRequest.get(key);
        const elapsed = last === undefined ? Number.POSITIVE_INFINITY : this.now() - last;
        if (elapsed < settings_1.SAME_RESOURCE_MIN_GAP_MS) {
            await this.sleep(settings_1.SAME_RESOURCE_MIN_GAP_MS - elapsed);
        }
        this.lastResourceRequest.set(key, this.now());
    }
    /**
     * Validate the host and wait out the same-resource gap, then name the target.
     *
     * Shared by every request whatever its method, so a new call path cannot
     * forget either. The host check especially: two copies of the one defence
     * against a configuration or cache value altering a request URL would
     * eventually disagree, and the disagreement would be the security regression.
     * It is the same check the settings page and the configuration validator apply.
     */
    async prepare(endpoint, resource) {
        const target = (0, identity_1.formatEndpoint)(endpoint.host, endpoint.port);
        if (!(0, validators_1.isValidHost)(endpoint.host)) {
            throw new errors_1.ConnectionError(`refusing to contact an invalid host: ${JSON.stringify(endpoint.host)}`);
        }
        await this.respectResourceGap(`${target}|${resource}`);
        return target;
    }
    async get(request) {
        const { endpoint, resource, query, totalTimeoutMs, signal } = request;
        const target = await this.prepare(endpoint, resource);
        const search = new URLSearchParams(query).toString();
        const url = `http://${target}/${resource}${search.length > 0 ? `?${search}` : ''}`;
        // Safe to log unsanitised, and the only place in the plugin where wire data
        // reaches a log line without passing through forLog: the query carries a
        // player-supplied etag, which URLSearchParams percent-encodes, so no control
        // character can reach the log. Templating the query by hand would reintroduce
        // log injection.
        this.log.debug(`GET ${url}`);
        const response = await this.httpGet(url, {
            connectTimeoutMs: settings_1.CONNECT_TIMEOUT_MS,
            totalTimeoutMs,
            maxBytes: settings_1.MAX_XML_BYTES,
            ...(signal === undefined ? {} : { signal }),
        });
        if (response.status !== 200) {
            throw new errors_1.ProtocolError(`${resource} on ${target} answered HTTP ${response.status}`);
        }
        return response.body;
    }
}
exports.BluOSClient = BluOSClient;
