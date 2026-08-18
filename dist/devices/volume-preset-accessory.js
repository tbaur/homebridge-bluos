"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A switch that sets one specific volume level.
 *
 * This is the automation-safe counterpart to the slider. A scene or a Siri phrase
 * can only ever put the player at the configured level, so there is no way for a
 * misfiring automation or a misheard command to land on full volume at three in
 * the morning. It is also the only control here that is meaningfully addressable
 * by voice without a number: "turn on Bedtime Volume".
 *
 * On means the player is currently at this level and not muted. Turning the switch
 * off has no meaning — there is no opposite of "be at 30" — so it is a no-op that
 * re-asserts the real state.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VolumePresetAccessory = void 0;
const settings_1 = require("../settings");
const utils_1 = require("../utils");
const base_accessory_1 = require("./base-accessory");
/** A one-level volume switch for one player. */
class VolumePresetAccessory extends base_accessory_1.BaseAccessory {
    service;
    target;
    /** Whether the player is currently sitting at this preset's level. */
    applied;
    constructor(init) {
        super(init);
        this.target = init.context.volume ?? settings_1.VOLUME_MIN;
        const { Characteristic: Char, Service: HapService } = this.host.hap;
        this.service = this.requireService(HapService.Switch);
        this.service.setCharacteristic(Char.Name, this.displayName);
        this.service
            .getCharacteristic(Char.On)
            .onGet(() => this.readOn())
            .onSet(async (value) => this.writeOn(value));
    }
    readOn() {
        this.requireObservedState();
        return this.applied === true;
    }
    async writeOn(value) {
        if (value !== true) {
            // Nothing to undo. Re-assert observed state so the tile stops showing the
            // user's tap rather than the player's reality.
            const observation = this.host.observationFor(this.deviceId);
            if (observation !== undefined) {
                this.updateFromObservation(observation, 'post-set');
            }
            return;
        }
        await this.completeWithinBudget('preset write', async () => {
            const endpoint = this.host.endpointFor(this.deviceId);
            if (endpoint === undefined) {
                throw new Error('player is no longer configured');
            }
            const observation = this.host.observationFor(this.deviceId);
            const scope = this.writeScope();
            // A preset that leaves the room silent would look like it had failed.
            if (this.target > settings_1.VOLUME_MIN && observation?.muted === true) {
                this.host.adoptWriteResult(this.deviceId, await this.host.client.setMute(endpoint, false, scope));
            }
            const result = await this.host.client.setVolume(endpoint, this.target, scope);
            this.host.adoptWriteResult(this.deviceId, result);
            this.logAction(`SET ${result.level ?? this.target}`, scope);
            if (result.level !== undefined && result.level !== this.target) {
                // The player's configured range can make a preset unreachable, in which
                // case the switch would otherwise sit off forever with no explanation.
                this.warnOnce('unreachable-preset', `${(0, utils_1.forLog)(this.displayName)} asked for volume ${this.target} but the player `
                    + `settled at ${result.level}; its configured volume range cannot reach ${this.target}`);
            }
        });
    }
    updateFromObservation(observation, _reason) {
        const applied = !observation.muted
            && !observation.fixedVolume
            && observation.volume === this.target;
        this.applied = applied;
        this.service.updateCharacteristic(this.host.hap.Characteristic.On, applied);
    }
    markUnavailable() {
        this.service.updateCharacteristic(this.host.hap.Characteristic.On, this.communicationFailure());
    }
}
exports.VolumePresetAccessory = VolumePresetAccessory;
