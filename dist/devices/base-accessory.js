"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared accessory behaviour: honesty about unknown state, and
 * writes that answer HomeKit inside its patience.
 *
 * Two rules are implemented once, here, because getting either wrong produces
 * bugs that are very hard to diagnose from a user's description.
 *
 * Never guess a characteristic value. Until a player has actually been read, and
 * whenever it has stopped answering, reads fail with
 * `SERVICE_COMMUNICATION_FAILURE` so the Home app shows No Response. A plausible
 * default is worse than no answer: it makes automations fire against fiction.
 *
 * Never let a write outlive HomeKit's patience. HAP-NodeJS warns at three
 * seconds and abandons a write at nine, discarding the eventual result. A set
 * handler therefore returns within {@link HOMEKIT_WRITE_BUDGET_MS} and finishes
 * anything slower in the background, where its outcome still reaches HomeKit
 * through the normal update path.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseAccessory = void 0;
const settings_1 = require("../settings");
const utils_1 = require("../utils");
/** Base class for every accessory this plugin exposes. */
class BaseAccessory {
    host;
    accessory;
    context;
    /** True once a real observation has been applied. */
    observed = false;
    /** True while the player is not answering. */
    offline = false;
    /** Throttles repeated warnings about the same persistent failure. */
    lastWarningAt = 0;
    /** Ensures a one-time explanation is logged only once. */
    warnedOnce = new Set();
    constructor(init) {
        this.host = init.host;
        this.accessory = init.accessory;
        this.context = init.context;
        this.configureAccessoryInformation();
    }
    get deviceId() {
        return this.context.deviceId;
    }
    get displayName() {
        return this.accessory.displayName;
    }
    /** Apply a fresh observation, and remember that state is now known. */
    applyObservation(observation, reason) {
        if (this.offline) {
            // Every outage warns on its way in, so it gets a matching line on its way
            // out: without one, a log shows a player failing and never recovering, and
            // an outage that healed reads exactly like one still in progress.
            this.host.log.info(`${(0, utils_1.forLog)(this.displayName)} [${(0, utils_1.forLog)(this.deviceId)}] is responding again`);
        }
        this.offline = false;
        this.observed = true;
        this.lastWarningAt = 0;
        this.refreshAccessoryInformation(observation);
        this.updateFromObservation(observation, reason);
    }
    /**
     * Report that the player could not be reached.
     *
     * Characteristic values are left untouched rather than zeroed: HomeKit is told
     * the accessory is unreachable, and inventing a value on the way out would
     * defeat that.
     */
    noteUnreachable(error) {
        const wasOnline = !this.offline;
        this.offline = true;
        const now = Date.now();
        if (wasOnline || now - this.lastWarningAt > settings_1.POLL_FAILURE_REWARN_MS) {
            this.lastWarningAt = now;
            // The player id is included because two accessories may legitimately share a
            // display name, and this is the line a user pastes into a bug report.
            this.host.log.warn(`${(0, utils_1.forLog)(this.displayName)} [${(0, utils_1.forLog)(this.deviceId)}] is not responding: `
                + (0, utils_1.describeError)(error));
        }
        else {
            this.host.log.debug(`${(0, utils_1.forLog)(this.displayName)} [${(0, utils_1.forLog)(this.deviceId)}] still not responding: `
                + (0, utils_1.describeError)(error));
        }
        this.markUnavailable();
    }
    /** True once this accessory has seen a real reading. */
    hasObservedState() {
        return this.observed && !this.offline;
    }
    /**
     * The error to return from a read when the true value is unknown.
     *
     * `SERVICE_COMMUNICATION_FAILURE` is what makes the Home app render No
     * Response, which is the honest answer before the first successful poll.
     */
    communicationFailure() {
        return new this.host.hap.HapStatusError(-70402 /* this.host.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
    }
    /** Throw if this accessory has no observed state to report. */
    requireObservedState() {
        if (!this.hasObservedState()) {
            throw this.communicationFailure();
        }
    }
    /**
     * How far this accessory's volume writes should reach.
     *
     * A zone that leads a group carries its followers with it, matching what the
     * BluOS app does when you move a leader's slider: the tile is the group's
     * control while the group exists. Every other zone — standalone, or a follower
     * addressed directly — moves alone, because a tile labelled one room must not
     * quietly change another.
     *
     * Derived from the last observation rather than remembered, so ungrouping takes
     * effect on the next poll without any bookkeeping here. When a player reports
     * no grouping at all the answer is false, which is the pre-grouping behaviour.
     */
    writeScope() {
        const leads = this.host.observationFor(this.deviceId)?.syncRole === 'primary';
        return { tellSlaves: leads };
    }
    /** One info line after a HomeKit write reached the player. */
    logAction(action, scope) {
        const suffix = scope.tellSlaves ? ' (group)' : '';
        this.host.log.info(`${(0, utils_1.forLog)(this.displayName)}: ${action}${suffix}`);
    }
    /** Log an explanation the first time a condition is met, then stay quiet. */
    warnOnce(key, message) {
        if (this.warnedOnce.has(key)) {
            this.host.log.debug(message);
            return;
        }
        this.warnedOnce.add(key);
        this.host.log.warn(message);
    }
    /**
     * Run a HomeKit write, returning once it finishes or the budget expires.
     *
     * Slow work is not cancelled when the budget runs out, only stopped being
     * waited on: the player will still apply the change, and the resulting state
     * reaches HomeKit through the poll that our own write triggers.
     */
    async completeWithinBudget(label, work) {
        let finished = false;
        const tracked = work()
            .catch((error) => {
            this.host.log.warn(`${(0, utils_1.forLog)(this.displayName)} ${label} failed: ${(0, utils_1.describeError)(error)}`);
            if (!finished) {
                // Surfaces to HomeKit as a failed write when we are still inside the
                // budget; afterwards HAP has stopped listening and the log is all we
                // have, which is why the message above is unconditional.
                throw error;
            }
        })
            .finally(() => {
            finished = true;
        });
        const outcome = await (0, utils_1.raceTimeout)(tracked, settings_1.HOMEKIT_WRITE_BUDGET_MS);
        if (outcome === utils_1.TIMED_OUT) {
            this.host.log.debug(`${(0, utils_1.forLog)(this.displayName)} ${label} exceeded ${settings_1.HOMEKIT_WRITE_BUDGET_MS}ms; `
                + 'completing in the background');
            // Prevents an unhandled rejection once nothing is awaiting this any more.
            tracked.catch(() => undefined);
        }
    }
    /**
     * The service this accessory's state lives on, created if necessary.
     *
     * Reusing a restored service rather than replacing it is what preserves the
     * user's HomeKit room assignment, name and automations across a restart.
     */
    requireService(type) {
        // Matched by UUID against the restored service list rather than through
        // `getService`, whose generic signature does not admit a concrete service
        // subclass without a cast.
        const existing = this.accessory.services.find((service) => service.UUID === type.UUID);
        return existing ?? this.accessory.addService(new type(this.displayName));
    }
    /**
     * Remove a service this accessory no longer represents.
     *
     * Needed when a setting changes which service carries the state, since the
     * accessory itself is adopted rather than recreated and would otherwise keep
     * both — one of them unbound to any handler.
     */
    dropService(type) {
        const stale = this.accessory.services.find((service) => service.UUID === type.UUID);
        if (stale === undefined) {
            return;
        }
        this.host.log.info(`${(0, utils_1.forLog)(this.displayName)} changed control style; removing the previous control`);
        this.accessory.removeService(stale);
    }
    /**
     * Publish identity to HomeKit.
     *
     * SerialNumber is the opaque generated value rather than the player's MAC: the
     * Home app displays it, so it ends up in screenshots and bug reports, and on a
     * multi-zone chassis a MAC is shared between zones anyway.
     */
    configureAccessoryInformation() {
        const { Characteristic, Service: HapService } = this.host.hap;
        const information = this.accessory.getService(HapService.AccessoryInformation)
            ?? this.accessory.addService(HapService.AccessoryInformation);
        information
            .setCharacteristic(Characteristic.Manufacturer, this.context.brand)
            .setCharacteristic(Characteristic.Model, this.context.model)
            .setCharacteristic(Characteristic.SerialNumber, this.context.serialNumber)
            .setCharacteristic(Characteristic.FirmwareRevision, this.host.pluginVersion)
            .setCharacteristic(Characteristic.Name, this.displayName);
    }
    /** Update identity from a live reading, when the player knows better. */
    refreshAccessoryInformation(observation) {
        const { Characteristic, Service: HapService } = this.host.hap;
        const information = this.accessory.getService(HapService.AccessoryInformation);
        if (information === undefined) {
            return;
        }
        // Sanitised on the way in, exactly like the same fields from configuration:
        // these come off the wire from an unauthenticated endpoint, they can be as
        // long as the whole response body, and they land in HomeKit characteristics
        // and in the on-disk accessory cache.
        const brand = observation.brand === undefined ? undefined : (0, utils_1.forDisplay)(observation.brand);
        const rawModel = observation.modelName ?? observation.model;
        const model = rawModel === undefined ? undefined : (0, utils_1.forDisplay)(rawModel);
        if (brand !== undefined && brand !== this.context.brand) {
            this.context.brand = brand;
            information.updateCharacteristic(Characteristic.Manufacturer, brand);
        }
        if (model !== undefined && model !== this.context.model) {
            this.context.model = model;
            information.updateCharacteristic(Characteristic.Model, model);
        }
    }
}
exports.BaseAccessory = BaseAccessory;
