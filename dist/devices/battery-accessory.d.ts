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
import type { PlayerObservation, RefreshReason } from '../types';
import { BaseAccessory, type AccessoryInit } from './base-accessory';
/** A battery sensor for one player. */
export declare class BatteryAccessory extends BaseAccessory {
    private readonly service;
    private level;
    private charging;
    constructor(init: AccessoryInit);
    private readLevel;
    private readLowBattery;
    private readChargingState;
    private requireBattery;
    protected updateFromObservation(observation: PlayerObservation, _reason: RefreshReason): void;
    protected markUnavailable(): void;
}
