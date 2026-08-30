/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The platform: configuration, accessory lifecycle, orchestration.
 *
 * Two policies here matter more than the mechanics.
 *
 * Accessories are adopted, never replaced. Identity is derived from the player's
 * MAC and zone port and never from its address, so a DHCP lease change leaves
 * every UUID untouched. When a cached accessory carries the right identity in its
 * context but a different UUID — the situation an identity-scheme change would
 * create — it is adopted rather than orphaned, because losing an accessory takes
 * the user's rooms, scenes and automations with it.
 *
 * A broken configuration disables the platform instead of deleting anything. The
 * accessories stay registered and report No Response, which is recoverable; a
 * plugin that unregisters accessories when it cannot parse its own settings
 * destroys work the user cannot get back.
 */
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { BluOSClient, type Endpoint } from './api/client';
import type { VolumeResult } from './api/sync-status';
import { type AccessoryHost, type RebootTarget } from './devices';
import type { PlayerObservation } from './types';
/** The BluOS dynamic platform. */
export declare class BluOSPlatform implements DynamicPlatformPlugin, AccessoryHost {
    readonly log: Logging;
    readonly client: BluOSClient;
    readonly pluginVersion: string;
    private readonly api;
    private readonly config;
    private readonly discovery;
    /** Accessories restored from disk, by UUID. */
    private readonly restored;
    /** Live accessories, by UUID. */
    private readonly active;
    /** Accessory handlers grouped by the player they belong to. */
    private readonly handlers;
    private readonly pollers;
    private devices;
    private discoveryTimeoutSec;
    /** True when configuration could not be used; nothing is polled. */
    private disabled;
    private shuttingDown;
    /** Warnings raised while resolving options in the constructor, logged at start. */
    private readonly discoveryWarnings;
    /** Pending poller starts, tracked so a shutdown can clear them. */
    private readonly staggerTimers;
    /** The launch address sweep, tracked so a shutdown can wait for it to end. */
    private launchSweep;
    /** Addresses we have just asked to reboot, while silence from them is expected. */
    private readonly rebootGrace;
    constructor(log: Logging, config: PlatformConfig, api: API);
    get hap(): API['hap'];
    /** Homebridge hands back every accessory it restored from disk. */
    configureAccessory(accessory: PlatformAccessory): void;
    endpointFor(deviceId: string): Endpoint | undefined;
    observationFor(deviceId: string): PlayerObservation | undefined;
    adoptWriteResult(deviceId: string, result: VolumeResult): void;
    /**
     * Write accessory context back to the Homebridge cache.
     *
     * One accessory by default, because `updatePlatformAccessories` makes
     * Homebridge serialise and rewrite the whole cache file: a front-panel volume
     * knob produces a stream of observations, and writing every accessory's context
     * for each of them is sustained disk churn on the SD card of a typical host.
     */
    persistContext(accessory?: PlatformAccessory): void;
    /**
     * Every address the global reboot switch should restart.
     *
     * Keyed on host alone, not host and port. Reboot is served on port 80, which is
     * one server per chassis, so the two zones of a CI S2 are one target: sending
     * twice would only aim a second request at a box already going down. Each
     * target carries every player behind it so the log can name what is really
     * about to stop.
     *
     * The union of what is configured and what mDNS answers for. Both halves are
     * needed: discovery alone does nothing on a network that filters multicast,
     * which is the case the manual-address fallback exists for, and the configured
     * list alone would miss the players this switch is advertised as reaching.
     *
     * Configured players are added first so their names win. A user who called a
     * player "Kitchen" in the plugin settings should read "Kitchen" in the log, not
     * whatever it is called in the BluOS app.
     *
     * A failed sweep degrades to the configured list rather than failing the press,
     * because rebooting the boxes we are sure of beats rebooting none of them.
     */
    rebootTargets(): Promise<readonly RebootTarget[]>;
    /**
     * Other configured players that share an address with this one.
     *
     * They will go down with it, because reboot cannot be aimed at one zone of a
     * chassis. Configured players only: a zone the user never exposed still
     * restarts, but naming it would mean reporting on equipment this plugin was
     * not asked to manage.
     */
    playersSharingAddress(deviceId: string): readonly string[];
    /**
     * A reboot request has reached this address.
     *
     * In-flight long-polls are dropped so the next reading is of the player after
     * it comes back, not of the request that died with the box. Failures during
     * the grace window do not mark accessories unreachable.
     */
    expectReboot(host: string): void;
    /** Current address of a player, preferring the poller when it has one. */
    private hostOf;
    private start;
    private stop;
    /**
     * Bring the registered accessory set in line with configuration.
     *
     * Creates what is missing, adopts what matches by identity, and unregisters
     * only what configuration no longer asks for.
     */
    private syncAccessories;
    private uuidFor;
    /**
     * Find a cached accessory that describes this one but under a different UUID.
     *
     * The safety net for an identity-scheme change: matching on the persisted
     * context lets the accessory be adopted instead of being replaced by a fresh
     * one, which would silently drop it out of every scene it belongs to.
     */
    private findByIdentity;
    private createAccessory;
    private adoptAccessory;
    private buildContext;
    /**
     * Build the handler for an accessory from its persisted context.
     *
     * Driven by context rather than configuration so that the same path works when
     * the platform is disabled and there is no valid configuration to consult.
     */
    private attachHandler;
    private startPollers;
    /** Correct addresses once at launch, so a DHCP change needs no user action. */
    private correctAddresses;
    /** Record a new address in accessory context so it survives a restart. */
    private rememberEndpoint;
    private publish;
    private reportUnavailable;
    /**
     * Put every cached accessory into No Response.
     *
     * Used when configuration is unusable. Handlers are attached first so that the
     * characteristics exist to be marked, which also means HomeKit sees a
     * well-formed accessory that happens to be unreachable rather than a
     * half-registered one.
     */
    private reportEverythingUnavailable;
    /**
     * Push No Response onto an accessory that has no handler.
     *
     * Generic rather than per accessory kind, because the reason it is needed is
     * that the context which would have told us the kind could not be read.
     * Accessory Information is left alone so the tile keeps its name and model.
     */
    private markAccessoryUnavailable;
    /** True when the platform gave up on its configuration. Exposed for tests. */
    get isDisabled(): boolean;
}
