/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview mDNS discovery of BluOS zones.
 *
 * Two service types are browsed, because a multi-zone chassis advertises each
 * zone separately: `_musc._tcp` for primary zones and `_musp._tcp` for the
 * secondaries of a CI S2 or CI 580. API v1.7 section 1 is explicit that the port
 * "should be discovered by use of the MDNS protocol using the services musc.tcp
 * and musp.tcp", and only the SRV record knows whether a zone is on 11000,
 * 11010, 11020 or 11030.
 *
 * The appendix also describes LSDP, a UDP-broadcast alternative that Lenbrook
 * says is more reliable than multicast on consumer networks. It is not
 * implemented: on the network this plugin was developed against, mDNS returned
 * every zone with full metadata while LSDP returned nothing at all, twice —
 * first with a global broadcast and then with per-interface subnet broadcasts
 * and an all-classes query. LSDP also never carries a zone's port, so it could
 * not replace this path even where it does answer. Manual entry by address
 * covers networks where multicast is filtered.
 *
 * Nothing here is trusted: an endpoint only counts as a player once it has
 * answered `/SyncStatus`, which is also where authoritative identity comes from.
 */
import type { Answer, Question } from 'dns-packet';
import type { DiscoveredPlayer, PluginLogger } from '../types';
import type { BluOSClient, Endpoint } from './client';
/** An mDNS response packet, narrowed to the parts used here. */
export interface MdnsPacket {
    answers?: Answer[];
    additionals?: Answer[];
}
/** Where a packet came from. Used as a fallback when no A record is offered. */
export interface MdnsRemote {
    address: string;
}
/**
 * The slice of `multicast-dns` this module needs.
 *
 * Declared structurally so a test can supply a fake without a socket, and so a
 * future move to a different mDNS implementation does not ripple outwards.
 */
export interface MdnsSession {
    on(event: 'response', listener: (packet: MdnsPacket, remote: MdnsRemote) => void): void;
    /**
     * `error` is fatal for the session (the socket could not be bound); `warning`
     * covers recoverable trouble such as an undecodable packet. Both must be
     * subscribed, because an unheard `error` on an EventEmitter is thrown, and a
     * throw here would take Homebridge down with it.
     */
    on(event: 'error' | 'warning', listener: (error: Error) => void): void;
    query(request: {
        questions: Question[];
    }): void;
    destroy(callback?: () => void): void;
}
/** Creates an mDNS session. */
export type MdnsFactory = () => MdnsSession;
/** Injectable collaborators for {@link BluOSDiscovery}. */
export interface DiscoveryOptions {
    log: PluginLogger;
    client: BluOSClient;
    createMdns?: MdnsFactory;
}
/** Discovers BluOS zones and confirms them against the API. */
export declare class BluOSDiscovery {
    private readonly log;
    private readonly client;
    private readonly createMdns;
    /** Live browse windows, so a shutdown does not have to wait one out. */
    private readonly openWindows;
    private cancelled;
    constructor(options: DiscoveryOptions);
    /**
     * Abandon every browse in flight and refuse any that start afterwards.
     *
     * A browse window is a referenced timer holding a bound multicast socket, so
     * without this a shutdown during an address re-resolution keeps the Homebridge
     * process alive for the rest of the window — up to 30 s per unreachable
     * player. One-way by design: it is only called when the platform is stopping.
     */
    cancelAll(): void;
    /**
     * Browse for zones and return the ones that answer `/SyncStatus`.
     *
     * Failures are logged and skipped rather than thrown: a single unreachable
     * player must not deny the user the rest of the fleet.
     */
    discover(timeoutSec: number): Promise<DiscoveredPlayer[]>;
    /**
     * Verify candidates a few at a time.
     *
     * Verification opens a connection and holds it for up to the status timeout,
     * and nothing throttles distinct endpoints against each other, so verifying
     * every advertisement at once would let whatever answered the browse decide how
     * many sockets this plugin opens at one moment.
     */
    private verifyAll;
    /**
     * Find the current address of an already-known player.
     *
     * Called at launch and after a player goes silent, so a DHCP lease change does
     * not require the user to re-save configuration.
     */
    resolveEndpoint(playerId: string, timeoutSec: number): Promise<Endpoint | undefined>;
    /** Probe one endpoint directly, for the UI's manual-entry path. */
    probe(endpoint: Endpoint): Promise<DiscoveredPlayer | undefined>;
    private verify;
    /**
     * Turn service instances into addressable endpoints.
     *
     * A zone is only usable once its SRV record (for the port) and an IPv4 address
     * are both known. The address comes from an A record when one was offered, and
     * otherwise from the responder's own source address, which for a player
     * advertising its own service is the same machine.
     */
    private toEndpoints;
    /** Collect mDNS records for the configured window. */
    private browse;
}
/**
 * Default mDNS session.
 *
 * `loopback: false` stops us from answering our own queries, and the require is
 * deferred so that importing this module — which the config UI does — cannot
 * fail merely because a socket could not be bound.
 *
 * Interfaces are enumerated up front because `multicast-dns` does the same from
 * inside its `listening` handler, where a throw would surface as an uncaught
 * exception instead of a failed call. Doing it here keeps the failure catchable
 * by {@link BluOSDiscovery.browse}, which degrades to "discovery unavailable".
 */
export declare const defaultMdnsFactory: MdnsFactory;
