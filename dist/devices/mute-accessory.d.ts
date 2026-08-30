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
import type { PlayerObservation, RefreshReason } from '../types';
import { BaseAccessory, type AccessoryInit } from './base-accessory';
/** A mute switch for one player. */
export declare class MuteAccessory extends BaseAccessory {
    private readonly service;
    /** Last mute state read from the player. */
    private muted;
    /** Present when this switch also carries the player's battery. */
    private readonly battery;
    constructor(init: AccessoryInit);
    private readOn;
    private writeOn;
    protected updateFromObservation(observation: PlayerObservation, _reason: RefreshReason): void;
    protected markUnavailable(): void;
}
