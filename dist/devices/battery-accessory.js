"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview State of charge for a portable player.
 *
 * `/SyncStatus` already carries `<battery level charging/>` on players with a
 * battery pack fitted, so this costs one service and no extra traffic. A player
 * without a pack never reports the element, and the accessory then reports No
 * Response rather than inventing a charge level.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatteryAccessory = void 0;
const utils_1 = require("../utils");
const base_accessory_1 = require("./base-accessory");
/** Below this percentage HomeKit is told the battery is low. */
const LOW_BATTERY_THRESHOLD = 20;
/** A battery sensor for one player. */
class BatteryAccessory extends base_accessory_1.BaseAccessory {
    service;
    level;
    charging = false;
    constructor(init) {
        super(init);
        const { Characteristic: Char, Service: HapService } = this.host.hap;
        this.service = this.requireService(HapService.Battery);
        this.service.setCharacteristic(Char.Name, this.displayName);
        this.service.getCharacteristic(Char.BatteryLevel).onGet(() => this.readLevel());
        this.service.getCharacteristic(Char.StatusLowBattery).onGet(() => this.readLowBattery());
        this.service.getCharacteristic(Char.ChargingState).onGet(() => this.readChargingState());
    }
    readLevel() {
        this.requireBattery();
        return this.level ?? 0;
    }
    readLowBattery() {
        this.requireBattery();
        const { Characteristic: Char } = this.host.hap;
        return (this.level ?? 100) <= LOW_BATTERY_THRESHOLD
            ? Char.StatusLowBattery.BATTERY_LEVEL_LOW
            : Char.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
    readChargingState() {
        this.requireBattery();
        const { Characteristic: Char } = this.host.hap;
        return this.charging ? Char.ChargingState.CHARGING : Char.ChargingState.NOT_CHARGING;
    }
    requireBattery() {
        this.requireObservedState();
        if (this.level === undefined) {
            throw this.communicationFailure();
        }
    }
    updateFromObservation(observation, _reason) {
        const battery = observation.battery;
        if (battery === undefined) {
            if (this.level !== undefined) {
                this.level = undefined;
            }
            this.warnOnce('no-battery', `${(0, utils_1.forLog)(this.displayName)} reports no battery pack; disable the battery sensor `
                + 'for this player in the plugin settings');
            this.markUnavailable();
            return;
        }
        this.level = battery.level;
        this.charging = battery.charging;
        const { Characteristic: Char } = this.host.hap;
        this.service.updateCharacteristic(Char.BatteryLevel, battery.level);
        this.service.updateCharacteristic(Char.StatusLowBattery, battery.level <= LOW_BATTERY_THRESHOLD
            ? Char.StatusLowBattery.BATTERY_LEVEL_LOW
            : Char.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        this.service.updateCharacteristic(Char.ChargingState, battery.charging ? Char.ChargingState.CHARGING : Char.ChargingState.NOT_CHARGING);
    }
    markUnavailable() {
        const { Characteristic: Char } = this.host.hap;
        const error = this.communicationFailure();
        this.service.updateCharacteristic(Char.BatteryLevel, error);
        this.service.updateCharacteristic(Char.StatusLowBattery, error);
        this.service.updateCharacteristic(Char.ChargingState, error);
    }
}
exports.BatteryAccessory = BatteryAccessory;
