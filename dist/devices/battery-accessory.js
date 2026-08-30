"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Standalone battery accessory, used only when no other tile exists.
 *
 * HomeKit will not render this in the Home app. Prefer hosting the Battery
 * service on the volume or mute accessory, which resolveAccessories does
 * whenever one of those is enabled. This class remains for a player that
 * exposes battery and nothing else.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatteryAccessory = void 0;
const base_accessory_1 = require("./base-accessory");
const player_battery_1 = require("./player-battery");
/** A battery sensor for one player, with no other HomeKit service beside it. */
class BatteryAccessory extends base_accessory_1.BaseAccessory {
    battery;
    constructor(init) {
        super(init);
        this.battery = new player_battery_1.PlayerBattery({
            hap: this.host.hap,
            accessory: this.accessory,
            displayName: this.displayName,
            warnOnce: (key, message) => this.warnOnce(key, message),
            communicationFailure: () => this.communicationFailure(),
            hasObservedState: () => this.hasObservedState(),
        });
    }
    updateFromObservation(observation, _reason) {
        this.battery.apply(observation);
    }
    markUnavailable() {
        this.battery.markUnavailable();
    }
}
exports.BatteryAccessory = BatteryAccessory;
