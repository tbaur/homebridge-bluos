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
import type { PlayerObservation, RefreshReason } from '../types';
import { BaseAccessory, type AccessoryInit } from './base-accessory';
/** A one-level volume switch for one player. */
export declare class VolumePresetAccessory extends BaseAccessory {
    private readonly service;
    private readonly target;
    /** Whether the player is currently sitting at this preset's level. */
    private applied;
    constructor(init: AccessoryInit);
    private readOn;
    private writeOn;
    protected updateFromObservation(observation: PlayerObservation, _reason: RefreshReason): void;
    protected markUnavailable(): void;
}
