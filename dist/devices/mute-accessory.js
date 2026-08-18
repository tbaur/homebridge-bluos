"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The mute switch.
 *
 * On means muted, which reads correctly in an automation: "turn on Study Mute"
 * silences the study.
 *
 * Mute is deliberately kept independent of the volume slider. Switching the
 * slider off writes level zero instead of muting, so the two controls never fight
 * over one piece of state, and a scene can mute a room without disturbing the
 * level it will return to. That works because the player remembers the pre-mute
 * level itself: measured on firmware 4.16.6, `mute=1` reports
 * `volume="0" muteVolume="72"` and unmuting restores 72 unaided.
 *
 * Muting a zone that leads a group mutes the group, for the same reason its
 * slider moves the group: while the group exists, the leader's tile is the
 * group's control. Muting a follower directly silences only that follower.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MuteAccessory = void 0;
const utils_1 = require("../utils");
const base_accessory_1 = require("./base-accessory");
/** A mute switch for one player. */
class MuteAccessory extends base_accessory_1.BaseAccessory {
    service;
    /** Last mute state read from the player. */
    muted;
    constructor(init) {
        super(init);
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
        return this.muted === true;
    }
    async writeOn(value) {
        const shouldMute = value === true;
        await this.completeWithinBudget('mute write', async () => {
            const endpoint = this.host.endpointFor(this.deviceId);
            if (endpoint === undefined) {
                throw new Error('player is no longer configured');
            }
            const scope = this.writeScope();
            const result = await this.host.client.setMute(endpoint, shouldMute, scope);
            this.host.adoptWriteResult(this.deviceId, result);
            this.logAction(shouldMute ? 'ON' : 'OFF', scope);
            if (result.muted !== shouldMute) {
                this.warnOnce('mute-refused', `${(0, utils_1.forLog)(this.displayName)} did not accept mute=${shouldMute ? 1 : 0}`);
            }
        });
    }
    updateFromObservation(observation, _reason) {
        this.muted = observation.muted;
        this.service.updateCharacteristic(this.host.hap.Characteristic.On, observation.muted);
    }
    markUnavailable() {
        this.service.updateCharacteristic(this.host.hap.Characteristic.On, this.communicationFailure());
    }
}
exports.MuteAccessory = MuteAccessory;
