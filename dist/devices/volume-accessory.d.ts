/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The volume slider.
 *
 * HomeKit has no speaker volume control that the Home app renders, so the slider
 * borrows one. Fanv2 `RotationSpeed` is the default and a Lightbulb's
 * `Brightness` is offered as an alternative; they look identical in the Home app.
 * The default is the fan because "turn off all the lights" and "set the lights to
 * 100%" both sweep up a Lightbulb, and a speaker jumping to full volume because
 * someone addressed the lights is a genuinely bad outcome. Every mature plugin in
 * this space carries the same warning.
 *
 * Mapping to BluOS:
 *
 * - The slider position is the player's 0..100 level. The player converts that to
 *   its own configured dB range, which differs per player and per configuration —
 *   two identical PULSE FLEX 2i units measured 0.7 dB apart at levels 26 and 35 —
 *   so the level is deliberately passed through rather than scaled here.
 * - Off means level zero. A muted player reports `volume="0"`, so an external mute
 *   shows up as Off without this accessory having to know about mute at all.
 * - Any explicit level write unmutes first, because a slider that appears to move
 *   while the player stays silent is indistinguishable from a broken plugin.
 */
import type { PlayerObservation, RefreshReason } from '../types';
import { BaseAccessory, type AccessoryInit } from './base-accessory';
/** A volume slider for one player. */
export declare class VolumeAccessory extends BaseAccessory {
    private readonly surface;
    /** Last level read from the player. Undefined until the first observation. */
    private level;
    /** True when the player reports a fixed output level. */
    private fixedVolume;
    /** Level awaiting a coalesced write. */
    private pendingLevel;
    /** In-flight coalesced write, shared by every handler that queued into it. */
    private flush;
    constructor(init: AccessoryInit);
    private buildSurface;
    private bindHandlers;
    private readActive;
    private readLevel;
    /**
     * Refuse a read when the value would be a guess.
     *
     * A fixed-output player is treated the same as an unreachable one: there is no
     * level to report and writing one would do nothing, so No Response is the
     * truthful answer rather than a slider that silently ignores input.
     */
    private requireSlider;
    private writeActive;
    private writeLevel;
    /**
     * Record the intended level and write it once the coalescing window closes.
     *
     * The most recent request wins, which is what makes the `Active` + level pair
     * that HomeKit sends when a slider leaves zero result in a single write.
     */
    private queueLevel;
    private applyPendingLevel;
    protected updateFromObservation(observation: PlayerObservation, _reason: RefreshReason): void;
    protected markUnavailable(): void;
}
