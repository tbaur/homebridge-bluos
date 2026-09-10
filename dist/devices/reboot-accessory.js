"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A momentary switch that restarts one player.
 *
 * Two departures from how every other accessory here behaves, both deliberate.
 *
 * It is momentary, never stateful. Turning it on fires the reboot, the tile
 * springs back once the request has been sent, and turning it off does nothing.
 * There is no such thing as an un-reboot, so an off has nothing to mean. This is
 * also what makes the switch safe to leave in a house full of scenes: "turn
 * everything off" and a scene that sets switches off both write false, and false
 * does nothing here. A stateful reboot switch would restart the stereo every time
 * someone said goodnight.
 *
 * `On` reads true only while a press this switch started is still being sent.
 * That is a fact about this switch rather than a reading off the player, so it
 * does not break the rule against inventing state. It matters because a HomeKit
 * write must answer inside the write budget while the reboot itself can take
 * longer: a tile that springs back before anything is logged looks like a press
 * that did nothing, and gets pressed again.
 *
 * It stays pressable when the player is unreachable, which breaks the plugin's
 * "unknown is No Response" rule. That rule exists so automations cannot fire
 * against invented *readings*, and this switch reports no reading: false is the
 * state of a button, and a button that has not been pressed is honestly not
 * pressed whether or not the player is answering. Enforcing the rule here would
 * grey out the tile in exactly the situation it is for — a player wedged badly
 * enough to have stopped answering is a player you want to restart.
 *
 * One thing this switch cannot do, which its name implies it can: restart a
 * single zone of a multi-zone chassis. Reboot is served on port 80, and port 80
 * is one server per box, so "Zone One Reboot" on a CI S2 also takes down
 * the other zone. The constructor says so once at startup, naming the rooms,
 * because the alternative is finding out by silencing one.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RebootAccessory = void 0;
const settings_1 = require("../settings");
const utils_1 = require("../utils");
const base_accessory_1 = require("./base-accessory");
/** A restart button for one player. */
class RebootAccessory extends base_accessory_1.BaseAccessory {
    service;
    resetTimer;
    /** True from a press until the tile springs back. @see writeOn */
    rebooting = false;
    constructor(init) {
        super(init);
        const { Characteristic: Char, Service: HapService } = this.host.hap;
        this.service = this.requireService(HapService.Switch);
        this.service.setCharacteristic(Char.Name, this.displayName);
        this.service
            .getCharacteristic(Char.On)
            .onGet(() => this.rebooting)
            .onSet(async (value) => this.writeOn(value));
        const shared = this.host.playersSharingAddress(this.deviceId);
        if (shared.length > 0) {
            this.host.log.warn(`${(0, utils_1.forLog)(this.displayName)}: will also reboot ${shared.map(utils_1.forLog).join(', ')}: `
                + 'they are zones of one chassis, and BluOS reboots the whole box');
        }
    }
    async writeOn(value) {
        if (value !== true) {
            return;
        }
        if (this.rebooting) {
            // A press that arrives while one is still being sent is a duplicate, not a
            // second instruction: the box can only be restarted once.
            this.host.log.info(`${(0, utils_1.forLog)(this.displayName)}: a restart is already under way; ignoring this press`);
            return;
        }
        this.rebooting = true;
        await this.completeWithinBudget('reboot', async () => {
            try {
                await this.sendReboot();
            }
            finally {
                // Inside the work rather than around the budget, so the tile springs back
                // when the reboot is actually done instead of when HomeKit stopped
                // waiting for it. A failed reboot resets too: a tile left on would
                // suggest something is still happening.
                this.scheduleReset();
            }
        });
    }
    /** Send the reboot, unless this box is already on its way down. */
    async sendReboot() {
        const endpoint = this.host.endpointFor(this.deviceId);
        if (endpoint === undefined) {
            throw new Error('player is no longer configured');
        }
        if (this.host.isRebooting(endpoint.host)) {
            // Not an error, and deliberately not a second request. Port 80 is down
            // while the box boots, so this would fail and be reported as a reboot that
            // did not work, when in fact one is in progress.
            this.host.log.info(`${(0, utils_1.forLog)(this.displayName)}: ${endpoint.host} is already restarting; nothing sent`);
            return;
        }
        // The host only: reboot lives on port 80, not on the zone's control port.
        const result = await this.host.client.reboot(endpoint.host);
        // The box is going down. Tell the platform so the other accessories
        // stay quiet, and so the next poll is what HomeKit shows.
        this.host.expectReboot(endpoint.host);
        // Never a group operation. Grouping decides where a *volume* change
        // reaches; a reboot restarts a box and has no notion of followers.
        this.logAction(result.acknowledged ? 'REBOOT' : 'REBOOT (sent; the player stopped answering, as expected)', { tellSlaves: false });
    }
    /**
     * Spring the tile back to off, the way a real button returns.
     *
     * Clearing {@link rebooting} here rather than when the work finishes keeps the
     * reported value and the pushed value in step: HomeKit is told off at the same
     * moment a read would start answering off.
     */
    scheduleReset() {
        if (this.resetTimer !== undefined) {
            clearTimeout(this.resetTimer);
        }
        this.resetTimer = setTimeout(() => {
            this.resetTimer = undefined;
            this.rebooting = false;
            this.service.updateCharacteristic(this.host.hap.Characteristic.On, false);
        }, settings_1.MOMENTARY_RESET_MS);
        // Nothing is waiting on this, so it must not hold Homebridge open at shutdown.
        this.resetTimer.unref?.();
    }
    /**
     * Nothing to apply.
     *
     * A button has no reading to refresh. Declared rather than inherited because
     * the base class requires it, and an empty body with a reason is clearer than
     * a subclass that quietly does nothing.
     */
    updateFromObservation(_observation, _reason) {
        // Intentionally empty. See the note above.
    }
    /**
     * Stay available even when the player is not answering.
     *
     * See the file header: this is the one accessory that must remain pressable
     * while its player is unreachable, because that is when it is needed.
     */
    markUnavailable() {
        // Intentionally empty. See the note above.
    }
}
exports.RebootAccessory = RebootAccessory;
