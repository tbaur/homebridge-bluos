"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One long-poll loop per player zone.
 *
 * The loop holds a `/SyncStatus?timeout=100&etag=…` request open and is woken by
 * the player the moment that zone's state changes. Verified against firmware
 * 4.16.6: with a current etag the request holds for exactly the requested window,
 * with a stale etag it answers in 44 ms, and the etag is per-zone — a sibling zone
 * on the same chassis changing volume does not wake this poll. That last point is
 * why one loop per zone is correct rather than wasteful.
 *
 * The set/poll race is handled with a generation counter. A response that was
 * computed before a local write cannot be distinguished from a fresh one by its
 * contents, so any response that arrives across a write is discarded and replaced
 * by an immediate re-read. That costs one cheap request — a stale etag answers
 * immediately — and removes the class of bug where a HomeKit slider springs back
 * to its old position a moment after being moved.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DevicePoller = void 0;
const settings_1 = require("./settings");
const utils_1 = require("./utils");
/**
 * Marks a read that this plugin cancelled on purpose.
 *
 * A write, a refresh request or an address change drops the poll in flight, and
 * the resulting rejection is indistinguishable from a network failure by its
 * type. Counting it as one would be actively harmful: three writes in a row
 * would trip the unreachable threshold and show every accessory for that player
 * as No Response, and each write would pay a backoff delay before the state it
 * just changed could be read back.
 */
class PollInterrupted extends Error {
    constructor() {
        super('poll interrupted');
        this.name = 'PollInterrupted';
    }
}
/** Drives one player zone. */
class DevicePoller {
    options;
    currentEndpoint;
    observation;
    /** Opaque long-poll token. Cleared to force a plain read next time round. */
    etag;
    /** Incremented by every local write, to invalidate responses that predate it. */
    generation = 0;
    consecutiveFailures = 0;
    lastRediscoveryAt = 0;
    stopped = false;
    loop;
    abort;
    /** Resolves the current backoff sleep early when a refresh is requested. */
    wake;
    constructor(options) {
        this.options = options;
        this.currentEndpoint = options.endpoint;
    }
    get endpoint() {
        return this.currentEndpoint;
    }
    get lastObservation() {
        return this.observation;
    }
    /** Point this poller at a new address, dropping any request in flight. */
    setEndpoint(endpoint) {
        if (endpoint.host === this.currentEndpoint.host && endpoint.port === this.currentEndpoint.port) {
            return;
        }
        this.options.log.info(`${(0, utils_1.forLog)(this.options.displayName)} moved to ${endpoint.host}:${endpoint.port}`);
        this.currentEndpoint = endpoint;
        this.etag = undefined;
        this.options.onEndpointChanged?.(endpoint);
        this.interrupt();
    }
    /** Begin polling. Safe to call more than once. */
    start() {
        if (this.loop !== undefined) {
            return;
        }
        this.stopped = false;
        // The loop is deliberately not awaited by its caller, so its promise needs a
        // rejection handler of its own. Without one, an unexpected throw anywhere in
        // the loop becomes an unhandled rejection, which on Node 20+ terminates the
        // process — taking Homebridge and every other plugin down with it.
        this.loop = this.run().catch((error) => {
            this.options.log.error(`${this.label()} polling stopped after an unexpected error, so its state will `
                + `no longer update until Homebridge restarts: ${(0, utils_1.describeError)(error)}`);
        });
    }
    /** Stop polling and drop any request in flight. */
    async stop() {
        this.stopped = true;
        this.interrupt();
        const loop = this.loop;
        this.loop = undefined;
        if (loop !== undefined) {
            await loop;
        }
    }
    /**
     * Adopt the state a write reported, and invalidate anything in flight.
     *
     * The player's answer to a write is authoritative — it clamps the level into
     * its own configured range — so this is both the fastest and the most accurate
     * update available.
     */
    adoptWriteResult(result) {
        this.generation += 1;
        const previous = this.observation;
        const merged = {
            ...(previous ?? {
                name: this.options.displayName,
                fixedVolume: false,
                muted: false,
                syncRole: 'standalone',
            }),
            fixedVolume: result.fixedVolume,
            muted: result.muted,
        };
        if (result.level !== undefined) {
            merged.volume = result.level;
        }
        if (result.muteVolume !== undefined) {
            merged.muteVolume = result.muteVolume;
        }
        else if (!result.muted) {
            // The firmware only publishes muteVolume while muted, so carrying the old
            // one forward past an unmute would let a stale pre-mute level win the
            // restore decision in restoreLevelFrom and jump the room loud.
            delete merged.muteVolume;
        }
        if (result.db !== undefined) {
            merged.db = result.db;
        }
        // The etag from a /Volume response is not a /SyncStatus etag, so the next
        // poll starts from a plain read rather than a token from the wrong resource.
        this.etag = undefined;
        this.observation = merged;
        this.options.onObservation(merged, 'post-set');
        this.interrupt();
    }
    /**
     * Drop the request in flight and start a plain read.
     *
     * Used after a reboot: the long-poll is aimed at a box that is already going
     * down, and waiting it out only delays the first reading of whatever state the
     * player comes back in.
     */
    refreshNow() {
        this.etag = undefined;
        this.interrupt();
    }
    /** Cancel the request in flight and wake any backoff sleep. */
    interrupt() {
        this.abort?.abort();
        this.abort = undefined;
        this.wake?.();
        this.wake = undefined;
    }
    async run() {
        let first = true;
        while (!this.stopped) {
            const generation = this.generation;
            try {
                const observation = await this.readOnce();
                if (this.stopped) {
                    return;
                }
                if (this.generation !== generation) {
                    // A write landed while this was in flight, so the response may describe
                    // the state before it. Discard and re-read rather than risk showing the
                    // user their change being undone.
                    this.options.log.debug(`${(0, utils_1.forLog)(this.options.displayName)} discarding a poll response that crossed a write`);
                    this.etag = undefined;
                    continue;
                }
                this.consecutiveFailures = 0;
                this.etag = observation.etag;
                this.observation = observation;
                this.options.onObservation(observation, first ? 'startup' : 'poll');
                first = false;
            }
            catch (error) {
                if (this.stopped) {
                    return;
                }
                if (error instanceof PollInterrupted) {
                    // Our own doing, so it is not a failure: start a fresh read at once.
                    this.etag = undefined;
                    continue;
                }
                await this.handleFailure(error);
            }
        }
    }
    async readOnce() {
        const etag = this.etag;
        if (etag === undefined) {
            return this.options.client.readSyncStatus(this.currentEndpoint);
        }
        const abort = new AbortController();
        this.abort = abort;
        try {
            return await this.options.client.pollSyncStatus(this.currentEndpoint, etag, abort.signal);
        }
        catch (error) {
            throw abort.signal.aborted ? new PollInterrupted() : error;
        }
        finally {
            if (this.abort === abort) {
                this.abort = undefined;
            }
        }
    }
    async handleFailure(error) {
        this.consecutiveFailures += 1;
        // A failed long-poll leaves the token untrustworthy; the next attempt starts
        // from a plain read so a stale etag cannot mask a recovered player.
        this.etag = undefined;
        if (this.consecutiveFailures === 1) {
            this.options.log.debug(`${this.label()} poll failed: ${(0, utils_1.describeError)(error)}`);
        }
        // Two separate policies, deliberately read from two constants: how long
        // before HomeKit is told the truth, and how long before we go looking for a
        // new address.
        if (this.consecutiveFailures >= settings_1.POLL_FAILURES_BEFORE_UNKNOWN) {
            this.options.onUnreachable(error);
        }
        if (this.consecutiveFailures >= settings_1.FAILURES_BEFORE_REDISCOVERY) {
            const moved = await this.tryRediscovery();
            if (moved) {
                // The address is known to have changed, so there is nothing to wait for:
                // sleeping out a backoff that may already be at its one-minute ceiling
                // would delay recovery for no reason.
                this.consecutiveFailures = 0;
                return;
            }
        }
        if (this.stopped) {
            return;
        }
        const exponent = Math.min(this.consecutiveFailures - 1, 10);
        const ceiling = Math.min(settings_1.POLL_BACKOFF_MAX_MS, settings_1.POLL_BACKOFF_BASE_MS * 2 ** exponent);
        // Full jitter, so a rebooting fleet does not synchronise its retries into a
        // burst against the network.
        const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
        await this.sleepInterruptibly(delay);
    }
    /**
     * Look for a new address for this player. True when the address changed.
     *
     * Rate-limited: a player that is switched off would otherwise trigger a
     * multicast sweep on every backoff cycle.
     */
    async tryRediscovery() {
        const now = Date.now();
        if (this.stopped || now - this.lastRediscoveryAt < settings_1.REDISCOVERY_MIN_INTERVAL_MS) {
            return false;
        }
        this.lastRediscoveryAt = now;
        try {
            const found = await this.options.resolveEndpoint(this.options.deviceId);
            // A sweep can outlive a shutdown request, and re-pointing a stopping poller
            // would persist an address change nobody asked for.
            if (this.stopped || found === undefined) {
                return false;
            }
            const moved = found.host !== this.currentEndpoint.host
                || found.port !== this.currentEndpoint.port;
            this.setEndpoint(found);
            return moved;
        }
        catch (error) {
            this.options.log.debug(`${this.label()} address lookup failed: ${(0, utils_1.describeError)(error)}`);
            return false;
        }
    }
    /**
     * Name plus stable id, for a log line someone has to act on.
     *
     * Two players can share a display name — the configuration validator warns
     * about it rather than refusing it — so a failure line naming only the name
     * cannot be traced back to a player.
     */
    label() {
        return `${(0, utils_1.forLog)(this.options.displayName)} [${(0, utils_1.forLog)(this.options.deviceId)}]`;
    }
    /**
     * Sleep, but return early if a write, refresh or shutdown arrives.
     *
     * The timer is cleared rather than left to expire, so stopping the plugin does
     * not have to wait out a backoff delay that no longer matters.
     */
    async sleepInterruptibly(ms) {
        const pending = (0, utils_1.interruptibleSleep)(ms);
        this.wake = () => pending.interrupt();
        try {
            await pending.promise;
        }
        finally {
            this.wake = undefined;
        }
    }
}
exports.DevicePoller = DevicePoller;
