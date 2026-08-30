"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BluOSPlatform = void 0;
const client_1 = require("./api/client");
const discovery_1 = require("./api/discovery");
const identity_1 = require("./api/identity");
const devices_1 = require("./devices");
const poller_1 = require("./poller");
const settings_1 = require("./settings");
const utils_1 = require("./utils");
/** Delay between starting successive pollers, so a fleet does not start as a burst. */
const POLLER_STAGGER_MS = 120;
/** The BluOS dynamic platform. */
class BluOSPlatform {
    log;
    client;
    pluginVersion;
    api;
    config;
    discovery;
    /** Accessories restored from disk, by UUID. */
    restored = new Map();
    /** Live accessories, by UUID. */
    active = new Map();
    /** Accessory handlers grouped by the player they belong to. */
    handlers = new Map();
    pollers = new Map();
    devices = [];
    discoveryTimeoutSec;
    /** True when configuration could not be used; nothing is polled. */
    disabled = false;
    shuttingDown = false;
    /** Warnings raised while resolving options in the constructor, logged at start. */
    discoveryWarnings = [];
    /** Pending poller starts, tracked so a shutdown can clear them. */
    staggerTimers = new Set();
    /** The launch address sweep, tracked so a shutdown can wait for it to end. */
    launchSweep;
    /** Addresses we have just asked to reboot, while silence from them is expected. */
    rebootGrace = new utils_1.RebootGrace(settings_1.REBOOT_GRACE_MS);
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.pluginVersion = (0, settings_1.readPluginVersion)(log);
        this.client = new client_1.BluOSClient({ log });
        this.discovery = new discovery_1.BluOSDiscovery({ log, client: this.client });
        // Warnings are collected rather than logged here: the constructor runs before
        // Homebridge has finished wiring logging for the platform, and a clamped or
        // unreadable value the user never hears about is a support call.
        this.discoveryTimeoutSec = (0, utils_1.resolveDiscoveryTimeoutSec)(config.options?.discoveryTimeoutSec, this.discoveryWarnings);
        this.api.on('didFinishLaunching', () => {
            // Startup is synchronous up to the point where polling begins, so a
            // configuration problem is reported before Homebridge finishes launching.
            // Anything slower — address correction, the poll loops themselves — is
            // started in the background from within.
            try {
                this.start();
            }
            catch (error) {
                this.log.error(`BluOS failed to start: ${(0, utils_1.describeError)(error)}`);
                // The stack only at debug level: a startup fault this unexpected is a bug
                // in the plugin, and the report is useless without one.
                this.log.debug((0, utils_1.describeErrorStack)(error));
            }
        });
        this.api.on('shutdown', () => {
            void this.stop();
        });
    }
    get hap() {
        return this.api.hap;
    }
    /** Homebridge hands back every accessory it restored from disk. */
    configureAccessory(accessory) {
        this.log.debug(`restoring cached accessory ${(0, utils_1.forLog)(accessory.displayName)}`);
        this.restored.set(accessory.UUID, accessory);
    }
    // --- AccessoryHost --------------------------------------------------------
    endpointFor(deviceId) {
        return this.pollers.get(deviceId)?.endpoint;
    }
    observationFor(deviceId) {
        return this.pollers.get(deviceId)?.lastObservation;
    }
    adoptWriteResult(deviceId, result) {
        this.pollers.get(deviceId)?.adoptWriteResult(result);
    }
    /**
     * Write accessory context back to the Homebridge cache.
     *
     * One accessory by default, because `updatePlatformAccessories` makes
     * Homebridge serialise and rewrite the whole cache file: a front-panel volume
     * knob produces a stream of observations, and writing every accessory's context
     * for each of them is sustained disk churn on the SD card of a typical host.
     */
    persistContext(accessory) {
        if (accessory !== undefined) {
            this.api.updatePlatformAccessories([accessory]);
            return;
        }
        if (this.active.size === 0) {
            return;
        }
        this.api.updatePlatformAccessories([...this.active.values()]);
    }
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
    async rebootTargets() {
        const byHost = new Map();
        const add = (host, name) => {
            const names = byHost.get(host);
            if (names === undefined) {
                byHost.set(host, [name]);
            }
            else if (!names.includes(name)) {
                names.push(name);
            }
        };
        const configured = new Set();
        for (const device of this.devices) {
            configured.add(device.id);
            // The poller's address when there is one: it tracks re-addressing, so it
            // is fresher than what configuration last recorded.
            add(this.endpointFor(device.id)?.host ?? device.host, device.name);
        }
        try {
            for (const player of await this.discovery.discover(this.discoveryTimeoutSec)) {
                // Skipped by identity rather than by address: a configured player is
                // usually called something else in the BluOS app, and matching on the
                // address alone would list the same player twice under both names.
                if (!configured.has(player.id)) {
                    add(player.host, player.name);
                }
            }
        }
        catch (error) {
            this.log.warn('reboot all could not sweep the network for players: '
                + `${(0, utils_1.describeError)(error)}. Rebooting the configured players only`);
        }
        return [...byHost].map(([host, names]) => ({ host, names }));
    }
    /**
     * Other configured players that share an address with this one.
     *
     * They will go down with it, because reboot cannot be aimed at one zone of a
     * chassis. Configured players only: a zone the user never exposed still
     * restarts, but naming it would mean reporting on equipment this plugin was
     * not asked to manage.
     */
    playersSharingAddress(deviceId) {
        const subject = this.devices.find((device) => device.id === deviceId);
        if (subject === undefined) {
            return [];
        }
        const host = this.endpointFor(deviceId)?.host ?? subject.host;
        return this.devices
            .filter((device) => device.id !== deviceId
            && (this.endpointFor(device.id)?.host ?? device.host) === host)
            .map((device) => device.name);
    }
    /**
     * A reboot request has reached this address.
     *
     * In-flight long-polls are dropped so the next reading is of the player after
     * it comes back, not of the request that died with the box. Failures during
     * the grace window do not mark accessories unreachable.
     */
    expectReboot(host) {
        this.rebootGrace.expect(host);
        for (const [deviceId, poller] of this.pollers) {
            if (this.hostOf(deviceId) === host) {
                poller.refreshNow();
            }
        }
    }
    /** Current address of a player, preferring the poller when it has one. */
    hostOf(deviceId) {
        return this.endpointFor(deviceId)?.host
            ?? this.devices.find((device) => device.id === deviceId)?.host;
    }
    // --- Lifecycle ------------------------------------------------------------
    start() {
        const result = (0, utils_1.validateConfig)(this.config);
        for (const warning of result.warnings) {
            this.log.warn(warning);
        }
        for (const warning of this.discoveryWarnings) {
            this.log.warn(warning);
        }
        if (result.errors.length > 0) {
            this.disabled = true;
            for (const error of result.errors) {
                this.log.error(error);
            }
            this.log.error('BluOS is disabled until its configuration is fixed. Cached accessories are kept '
                + 'and will show as No Response, so rooms and automations are not lost.');
            this.reportEverythingUnavailable();
            return;
        }
        this.devices = result.devices;
        const accessoryWarnings = [];
        const wanted = (0, utils_1.resolveAccessories)(this.devices, accessoryWarnings, {
            rebootAll: result.options.rebootAll,
            rebootAllName: result.options.rebootAllName,
            // Falls back to the platform alias, which is what the Homebridge form
            // pre-fills, so the switch is named rather than blank on a hand-written
            // config that omitted `name`.
            name: typeof this.config.name === 'string' && this.config.name.trim().length > 0
                ? this.config.name.trim()
                : settings_1.PLATFORM_NAME,
        });
        for (const warning of accessoryWarnings) {
            this.log.warn(warning);
        }
        this.syncAccessories(wanted);
        this.startPollers();
        // Address correction runs alongside polling rather than before it: a player
        // that has not moved should not have startup delayed by a multicast sweep.
        // The promise is kept so a shutdown can wait for it instead of leaving a
        // bound multicast socket behind.
        this.launchSweep = this.correctAddresses();
    }
    async stop() {
        this.shuttingDown = true;
        for (const timer of this.staggerTimers) {
            clearTimeout(timer);
        }
        this.staggerTimers.clear();
        // Cancelled before the pollers are awaited: a poller inside an address
        // re-resolution is waiting on a browse window that nothing else can end, so
        // without this the process cannot exit until the window elapses — up to 30 s
        // for every player that happened to be unreachable.
        this.discovery.cancelAll();
        const pollers = [...this.pollers.values()];
        this.pollers.clear();
        const sweep = this.launchSweep;
        this.launchSweep = undefined;
        await Promise.all([
            ...pollers.map(async (poller) => poller.stop()),
            sweep ?? Promise.resolve(),
        ]);
        this.log.debug('BluOS polling stopped');
    }
    /**
     * Bring the registered accessory set in line with configuration.
     *
     * Creates what is missing, adopts what matches by identity, and unregisters
     * only what configuration no longer asks for.
     */
    syncAccessories(wanted) {
        const claimed = new Set();
        const byId = new Map(this.devices.map((device) => [device.id, device]));
        for (const accessory of wanted) {
            const uuid = this.uuidFor(accessory);
            // Every wanted accessory was expanded from one of these devices, so a miss
            // is impossible rather than merely unlikely; the map exists to keep startup
            // linear in accessory count. The exception is the platform's own reboot
            // switch, which has no device behind it; anything else missing a device is
            // a bug, and skipping it beats registering something nothing can drive.
            const device = byId.get(accessory.deviceId);
            if (device === undefined && accessory.deviceId !== settings_1.PLATFORM_DEVICE_ID) {
                continue;
            }
            const existing = this.restored.get(uuid) ?? this.findByIdentity(accessory, claimed);
            if (existing === undefined) {
                this.createAccessory(uuid, accessory, device);
                continue;
            }
            claimed.add(existing.UUID);
            this.adoptAccessory(existing, uuid, accessory, device);
        }
        for (const [uuid, accessory] of this.restored) {
            if (claimed.has(uuid) || this.active.has(uuid)) {
                continue;
            }
            this.log.info(`removing ${(0, utils_1.forLog)(accessory.displayName)}, no longer in the configuration`);
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
        }
    }
    uuidFor(accessory) {
        return this.api.hap.uuid.generate(`${settings_1.UUID_PREFIX}${(0, identity_1.accessoryIdentityKey)(accessory)}`);
    }
    /**
     * Find a cached accessory that describes this one but under a different UUID.
     *
     * The safety net for an identity-scheme change: matching on the persisted
     * context lets the accessory be adopted instead of being replaced by a fresh
     * one, which would silently drop it out of every scene it belongs to.
     */
    findByIdentity(accessory, claimed) {
        for (const [uuid, candidate] of this.restored) {
            if (claimed.has(uuid)) {
                continue;
            }
            const context = candidate.context;
            if ((0, identity_1.hasAccessoryIdentity)(context, accessory)) {
                return candidate;
            }
        }
        return undefined;
    }
    createAccessory(uuid, accessory, device) {
        this.log.info(`adding ${(0, utils_1.forLog)(accessory.name)}`);
        const platformAccessory = new this.api.platformAccessory(accessory.name, uuid);
        platformAccessory.context = this.buildContext({
            accessory,
            device,
            serialNumber: (0, utils_1.newAccessorySerialNumber)(),
            adoptedLegacyUuid: false,
        });
        this.attachHandler(platformAccessory);
        this.active.set(uuid, platformAccessory);
        this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [platformAccessory]);
    }
    adoptAccessory(existing, expectedUuid, accessory, device) {
        const adopted = existing.UUID !== expectedUuid;
        const alreadyAdopted = existing.context.adoptedLegacyUuid === true;
        // A HAP UUID is immutable, so an adopted accessory keeps its old one and takes
        // this path on every launch. The flag is what makes the notice a migration
        // notice rather than a line the user reads forever.
        if (adopted && !alreadyAdopted) {
            this.log.info(`adopting cached accessory ${(0, utils_1.forLog)(existing.displayName)} by identity; `
                + 'its rooms and automations are preserved');
        }
        // The serial number is carried over rather than regenerated: HomeKit treats a
        // changed serial as a different piece of hardware.
        const serialNumber = (0, utils_1.ensureAccessorySerialNumber)(existing);
        existing.context = this.buildContext({
            accessory,
            device,
            serialNumber,
            adoptedLegacyUuid: adopted || alreadyAdopted,
        });
        if (existing.displayName !== accessory.name) {
            this.log.info(`${(0, utils_1.forLog)(existing.displayName)} is now named ${(0, utils_1.forLog)(accessory.name)}`);
            existing.displayName = accessory.name;
        }
        this.attachHandler(existing);
        this.active.set(existing.UUID, existing);
        this.api.updatePlatformAccessories([existing]);
    }
    buildContext(input) {
        const { accessory, device, serialNumber, adoptedLegacyUuid } = input;
        const previous = this.restored.get(this.uuidFor(accessory))?.context;
        // The platform's own switch has no device, and so no address: its host and
        // port are placeholders that nothing reads, because it resolves its targets
        // when it is pressed rather than holding one endpoint.
        const context = {
            kind: accessory.kind,
            deviceId: accessory.deviceId,
            host: device?.host ?? '',
            port: device?.port ?? settings_1.DEFAULT_BLUOS_PORT,
            brand: device?.brand ?? 'BluOS',
            model: device?.model ?? 'BluOS Player',
            serialNumber,
            adoptedLegacyUuid,
            sliderService: accessory.sliderService,
        };
        if (accessory.volume !== undefined) {
            context.volume = accessory.volume;
        }
        if (Number.isInteger(previous?.lastNonZeroVolume)) {
            context.lastNonZeroVolume = previous?.lastNonZeroVolume;
        }
        return context;
    }
    /**
     * Build the handler for an accessory from its persisted context.
     *
     * Driven by context rather than configuration so that the same path works when
     * the platform is disabled and there is no valid configuration to consult.
     */
    attachHandler(accessory) {
        let context;
        try {
            context = (0, utils_1.parseAccessoryContext)(accessory);
        }
        catch (error) {
            this.log.warn(`${(0, utils_1.forLog)(accessory.displayName)} cannot be driven: ${(0, utils_1.describeError)(error)}. `
                + 'It is left registered and shown as No Response rather than deleted, so its rooms '
                + 'and automations survive. Remove it in the Homebridge UI if it is no longer wanted');
            // Without this the tile keeps whatever HomeKit last cached and reports it
            // forever, since no handler exists to correct it. No Response is the honest
            // state for an accessory nothing is driving.
            this.markAccessoryUnavailable(accessory);
            return;
        }
        const init = { host: this, accessory, context };
        let handler;
        switch (context.kind) {
            case 'volume':
                handler = new devices_1.VolumeAccessory(init);
                break;
            case 'mute':
                handler = new devices_1.MuteAccessory(init);
                break;
            case 'volumePreset':
                handler = new devices_1.VolumePresetAccessory(init);
                break;
            case 'battery':
                handler = new devices_1.BatteryAccessory(init);
                break;
            case 'reboot':
                handler = new devices_1.RebootAccessory(init);
                break;
            case 'rebootAll':
                handler = new devices_1.RebootAllAccessory(init);
                break;
        }
        const group = this.handlers.get(context.deviceId) ?? [];
        group.push(handler);
        this.handlers.set(context.deviceId, group);
    }
    startPollers() {
        let index = 0;
        for (const device of this.devices) {
            if ((this.handlers.get(device.id) ?? []).length === 0) {
                this.log.debug(`${(0, utils_1.forLog)(device.name)} has no accessories; not polling it`);
                continue;
            }
            const poller = new poller_1.DevicePoller({
                log: this.log,
                client: this.client,
                deviceId: device.id,
                displayName: device.name,
                endpoint: { host: device.host, port: device.port },
                onObservation: (observation, reason) => {
                    this.publish(device.id, observation, reason);
                },
                onUnreachable: (error) => {
                    this.reportUnavailable(device.id, error);
                },
                resolveEndpoint: async (deviceId) => this.discovery.resolveEndpoint(deviceId, this.discoveryTimeoutSec),
                onEndpointChanged: (endpoint) => {
                    this.rememberEndpoint(device.id, endpoint);
                },
            });
            this.pollers.set(device.id, poller);
            const delay = index * POLLER_STAGGER_MS;
            index += 1;
            const timer = setTimeout(() => {
                this.staggerTimers.delete(timer);
                if (!this.shuttingDown) {
                    poller.start();
                }
            }, delay);
            timer.unref?.();
            this.staggerTimers.add(timer);
        }
        this.log.info(`BluOS is watching ${this.pollers.size} zone(s) with ${this.active.size} accessory(s)`);
    }
    /** Correct addresses once at launch, so a DHCP change needs no user action. */
    async correctAddresses() {
        if (this.pollers.size === 0) {
            return;
        }
        try {
            const players = await this.discovery.discover(this.discoveryTimeoutSec);
            if (this.shuttingDown) {
                return;
            }
            for (const player of players) {
                const poller = this.pollers.get(player.id);
                poller?.setEndpoint({ host: player.host, port: player.port });
            }
        }
        catch (error) {
            this.log.debug(`launch discovery failed: ${(0, utils_1.describeError)(error)}`);
        }
    }
    /** Record a new address in accessory context so it survives a restart. */
    rememberEndpoint(deviceId, endpoint) {
        let changed = false;
        for (const accessory of this.active.values()) {
            const context = accessory.context;
            if (context.deviceId !== deviceId) {
                continue;
            }
            if (context.host !== endpoint.host || context.port !== endpoint.port) {
                context.host = endpoint.host;
                context.port = endpoint.port;
                changed = true;
            }
        }
        if (changed) {
            this.persistContext();
        }
    }
    publish(deviceId, observation, reason) {
        // Ends the window only after the box has already gone quiet. A last-gasp
        // reading while the ports are still up must not cancel it, or the real
        // outage that follows is logged as a surprise.
        this.rebootGrace.clearIfRecovered(this.hostOf(deviceId));
        for (const handler of this.handlers.get(deviceId) ?? []) {
            try {
                handler.applyObservation(observation, reason);
            }
            catch (error) {
                this.log.debug(`${(0, utils_1.forLog)(handler.displayName)} could not apply an observation: ${(0, utils_1.describeError)(error)}`);
            }
        }
    }
    reportUnavailable(deviceId, error) {
        const host = this.hostOf(deviceId);
        if (this.rebootGrace.isExpected(host)) {
            this.rebootGrace.noteSilence(host);
            return;
        }
        for (const handler of this.handlers.get(deviceId) ?? []) {
            // Guarded exactly like publish. This runs from inside the poll loop's catch
            // block, so a throw here — a characteristic missing from a hand-edited
            // cached accessory, a service another plugin removed — would escape as an
            // unhandled rejection and end the Homebridge process.
            try {
                handler.noteUnreachable(error);
            }
            catch (failure) {
                this.log.debug(`${(0, utils_1.forLog)(handler.displayName)} could not be marked unavailable: `
                    + (0, utils_1.describeError)(failure));
            }
        }
    }
    /**
     * Put every cached accessory into No Response.
     *
     * Used when configuration is unusable. Handlers are attached first so that the
     * characteristics exist to be marked, which also means HomeKit sees a
     * well-formed accessory that happens to be unreachable rather than a
     * half-registered one.
     */
    reportEverythingUnavailable() {
        for (const accessory of this.restored.values()) {
            this.attachHandler(accessory);
            this.active.set(accessory.UUID, accessory);
        }
        const reason = new Error('the plugin configuration is not usable');
        for (const handlers of this.handlers.values()) {
            for (const handler of handlers) {
                handler.noteUnreachable(reason);
            }
        }
    }
    /**
     * Push No Response onto an accessory that has no handler.
     *
     * Generic rather than per accessory kind, because the reason it is needed is
     * that the context which would have told us the kind could not be read.
     * Accessory Information is left alone so the tile keeps its name and model.
     */
    markAccessoryUnavailable(accessory) {
        const failure = new this.hap.HapStatusError(-70402 /* this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        for (const service of accessory.services) {
            if (service.UUID === this.hap.Service.AccessoryInformation.UUID) {
                continue;
            }
            for (const characteristic of service.characteristics) {
                try {
                    characteristic.updateValue(failure);
                }
                catch (error) {
                    this.log.debug(`${(0, utils_1.forLog)(accessory.displayName)} could not be marked unavailable: `
                        + (0, utils_1.describeError)(error));
                }
            }
        }
    }
    /** True when the platform gave up on its configuration. Exposed for tests. */
    get isDisabled() {
        return this.disabled;
    }
}
exports.BluOSPlatform = BluOSPlatform;
