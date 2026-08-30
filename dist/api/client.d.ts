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
import type { PlayerObservation, PluginLogger } from '../types';
import { type HttpGet, type HttpPost } from './http';
import { type VolumeResult } from './sync-status';
/** Where to reach one player zone. */
export interface Endpoint {
    host: string;
    port: number;
}
/**
 * How far a volume write should reach.
 *
 * `tellSlaves` maps to the API's `tell_slaves` parameter. False confines the
 * write to the addressed zone; true lets a group leader carry its followers with
 * it, which is what the BluOS app does when you move a leader's slider.
 *
 * Defaults to false everywhere, so a caller that has not thought about grouping
 * gets the conservative answer.
 */
export interface WriteScope {
    tellSlaves: boolean;
}
/**
 * What a reboot request produced.
 *
 * `acknowledged` is false when the player took the request and then stopped
 * answering, which is a success rather than a failure — see
 * {@link BluOSClient.reboot}. It is carried so the log can say which happened,
 * because "sent, no answer" and "sent, answered" look identical to the user and
 * only one of them is worth investigating if the player never comes back.
 */
export interface RebootResult {
    acknowledged: boolean;
}
/** Injectable collaborators, so tests need neither sockets nor real clocks. */
export interface BluOSClientOptions {
    log: PluginLogger;
    httpGet?: HttpGet;
    httpPost?: HttpPost;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
/**
 * Talks to BluOS players over the LAN.
 *
 * One instance serves the whole fleet: the rate limits and the per-chassis write
 * lock are only meaningful if every request goes through the same bookkeeping.
 */
export declare class BluOSClient {
    private readonly log;
    private readonly httpGet;
    private readonly httpPost;
    private readonly now;
    private readonly sleep;
    /** Last request time, keyed by `endpoint|resource`, for the one-second rule. */
    private readonly lastResourceRequest;
    /** Last control call time, keyed by endpoint. */
    private readonly lastControlRequest;
    /** Tail of the write queue for each chassis host. */
    private readonly chassisWriteQueue;
    constructor(options: BluOSClientOptions);
    /** Read `/SyncStatus` once, without long-polling. */
    readSyncStatus(endpoint: Endpoint): Promise<PlayerObservation>;
    /**
     * Long-poll `/SyncStatus`, returning when the player's state changes or the
     * poll window elapses.
     *
     * Measured on firmware 4.16.6: with a current etag the request holds for the
     * full requested window (15.03 s for `timeout=15`), and with a stale etag it
     * answers in 44 ms. Verified per-zone rather than per-chassis, so a sibling
     * zone changing volume does not wake this poll.
     */
    pollSyncStatus(endpoint: Endpoint, etag: string, signal?: AbortSignal): Promise<PlayerObservation>;
    /**
     * Read `/Volume` without changing anything.
     *
     * Not on the polling path: `/SyncStatus` is the source of truth for level and
     * mute, and it long-polls. This exists for the diagnostic scripts and for
     * confirming what a player reports when a write result looks wrong.
     */
    readVolume(endpoint: Endpoint): Promise<VolumeResult>;
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
    setVolume(endpoint: Endpoint, level: number, scope?: WriteScope): Promise<VolumeResult>;
    /**
     * Mute or unmute this zone.
     *
     * `mute=1` mutes and `mute=0` unmutes. API v1.7's parameter table in section
     * 3.1 states the opposite, but sections 3.4 and 3.5, the response attribute
     * tables, and firmware 4.16.6 all agree with the mapping used here: writing
     * `mute=1` produced `mute="1" muteVolume="72"` on a real player.
     */
    setMute(endpoint: Endpoint, muted: boolean, scope?: WriteScope): Promise<VolumeResult>;
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
    reboot(host: string): Promise<RebootResult>;
    private control;
    /**
     * Queue work behind anything already writing to this chassis.
     *
     * The queue tail is stored per host; failures are swallowed for the purpose of
     * chaining so one rejected write does not poison later ones, while the
     * original promise still rejects for its own caller.
     */
    private withChassisLock;
    private respectControlRate;
    /**
     * Wait out the API's one-second minimum gap between consecutive requests for
     * the same resource on the same endpoint.
     */
    private respectResourceGap;
    /**
     * Validate the host and wait out the same-resource gap, then name the target.
     *
     * Shared by every request whatever its method, so a new call path cannot
     * forget either. The host check especially: two copies of the one defence
     * against a configuration or cache value altering a request URL would
     * eventually disagree, and the disagreement would be the security regression.
     * It is the same check the settings page and the configuration validator apply.
     */
    private prepare;
    private get;
}
