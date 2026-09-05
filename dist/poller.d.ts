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
import type { Endpoint } from './api/client';
import { BluOSClient } from './api/client';
import type { VolumeResult } from './api/sync-status';
import type { PlayerObservation, PluginLogger, RefreshReason } from './types';
/** Collaborators and callbacks for one poller. */
export interface DevicePollerOptions {
    log: PluginLogger;
    client: BluOSClient;
    deviceId: string;
    displayName: string;
    endpoint: Endpoint;
    /** Called with every accepted observation. */
    onObservation: (observation: PlayerObservation, reason: RefreshReason) => void;
    /** Called when the player could not be reached often enough to matter. */
    onUnreachable: (error: unknown) => void;
    /**
     * Ask the platform to find this player's current address.
     *
     * Invoked after repeated failures, which is the signature of a DHCP lease
     * change, and rate-limited so a genuinely absent player does not cause
     * continuous multicast traffic.
     */
    resolveEndpoint: (deviceId: string) => Promise<Endpoint | undefined>;
    /** Called when an address changes, so it can be persisted. */
    onEndpointChanged?: (endpoint: Endpoint) => void;
}
/** Drives one player zone. */
export declare class DevicePoller {
    private readonly options;
    private currentEndpoint;
    private observation;
    /** Opaque long-poll token. Cleared to force a plain read next time round. */
    private etag;
    /** Incremented by every local write, to invalidate responses that predate it. */
    private generation;
    private consecutiveFailures;
    private lastRediscoveryAt;
    private stopped;
    private loop;
    private abort;
    /** Resolves the current backoff sleep early when a refresh is requested. */
    private wake;
    constructor(options: DevicePollerOptions);
    get endpoint(): Endpoint;
    get lastObservation(): PlayerObservation | undefined;
    /** Point this poller at a new address, dropping any request in flight. */
    setEndpoint(endpoint: Endpoint): void;
    /** Begin polling. Safe to call more than once. */
    start(): void;
    /** Stop polling and drop any request in flight. */
    stop(): Promise<void>;
    /**
     * Adopt the state a write reported, and invalidate anything in flight.
     *
     * The player's answer to a write is authoritative — it clamps the level into
     * its own configured range — so this is both the fastest and the most accurate
     * update available.
     */
    adoptWriteResult(result: VolumeResult): void;
    /**
     * Drop the request in flight and start a plain read.
     *
     * Used after a reboot: the long-poll is aimed at a box that is already going
     * down, and waiting it out only delays the first reading of whatever state the
     * player comes back in.
     */
    refreshNow(): void;
    /** Cancel the request in flight and wake any backoff sleep. */
    private interrupt;
    private run;
    /**
     * Read this zone once, long-polling when there is a token to poll with.
     *
     * Both reads are abortable, not just the long poll. A plain read is the path an
     * unreachable player takes — a failure clears the etag — and it can sit for the
     * whole status timeout, which a shutdown would otherwise wait out per player.
     */
    private readOnce;
    private handleFailure;
    /**
     * Look for a new address for this player. True when the address changed.
     *
     * Rate-limited: a player that is switched off would otherwise trigger a
     * multicast sweep on every backoff cycle.
     */
    private tryRediscovery;
    /**
     * Name plus stable id, for a log line someone has to act on.
     *
     * Two players can share a display name — the configuration validator warns
     * about it rather than refusing it — so a failure line naming only the name
     * cannot be traced back to a player.
     */
    private label;
    /**
     * Sleep, but return early if a write, refresh or shutdown arrives.
     *
     * The timer is cleared rather than left to expire, so stopping the plugin does
     * not have to wait out a backoff delay that no longer matters.
     */
    private sleepInterruptibly;
}
