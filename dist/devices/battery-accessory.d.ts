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
import type { PlayerObservation, RefreshReason } from '../types';
import { BaseAccessory, type AccessoryInit } from './base-accessory';
/** A battery sensor for one player, with no other HomeKit service beside it. */
export declare class BatteryAccessory extends BaseAccessory {
    private readonly battery;
    constructor(init: AccessoryInit);
    protected updateFromObservation(observation: PlayerObservation, _reason: RefreshReason): void;
    protected markUnavailable(): void;
}
