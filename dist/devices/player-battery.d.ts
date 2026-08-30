/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The HAP Battery service for one player.
 *
 * HomeKit will not render a Battery accessory on its own: the Home app parks
 * that tile under Other and says Not Supported. The service has to sit on a
 * tile Home already understands, which for this plugin is the volume slider or
 * the mute switch. A player that exposes neither still gets a standalone
 * Battery accessory, and Home will keep saying Not Supported for that one.
 *
 * `/SyncStatus` already carries `<battery level charging/>` when a pack is
 * fitted, so this costs no extra traffic. A player without a pack never reports
 * the element, and the service then reports No Response rather than inventing
 * a charge level.
 */
import type { API, PlatformAccessory } from 'homebridge';
import type { PlayerObservation } from '../types';
/** Collaborators for one Battery service. */
export interface PlayerBatteryInit {
    hap: API['hap'];
    accessory: PlatformAccessory;
    displayName: string;
    warnOnce: (key: string, message: string) => void;
    communicationFailure: () => Error;
    hasObservedState: () => boolean;
}
/** Charge level, charging state and low-battery on one HAP Battery service. */
export declare class PlayerBattery {
    private readonly init;
    private readonly service;
    private level;
    private charging;
    constructor(init: PlayerBatteryInit);
    apply(observation: PlayerObservation): void;
    markUnavailable(): void;
    private readLevel;
    private readLowBattery;
    private readChargingState;
    private requireBattery;
}
/** Bind a Battery service, or drop a leftover one when this tile no longer hosts it. */
export declare function attachHostedBattery(init: PlayerBatteryInit, hosts: boolean): PlayerBattery | undefined;
/** Drop a leftover Battery service when this accessory no longer hosts one. */
export declare function dropPlayerBattery(accessory: PlatformAccessory, hap: API['hap']): void;
