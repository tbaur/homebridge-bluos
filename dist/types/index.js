"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared types for configuration, accessory identity and the
 * observations read back from a player.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SLIDER_SERVICES = exports.ACCESSORY_KINDS = void 0;
exports.isAccessoryKind = isAccessoryKind;
exports.isSliderService = isSliderService;
/**
 * What an accessory does. Part of its identity, and therefore of its UUID.
 *
 * `volume` is the fake slider, `mute` the mute switch, `volumePreset` a
 * one-level switch, and `battery` the state-of-charge sensor for portables.
 */
exports.ACCESSORY_KINDS = ['volume', 'mute', 'volumePreset', 'battery'];
/** Narrow an unknown value to an {@link AccessoryKind}. */
function isAccessoryKind(value) {
    return typeof value === 'string' && exports.ACCESSORY_KINDS.includes(value);
}
/**
 * Which HAP service impersonates the volume slider.
 *
 * HomeKit has no first-class speaker volume control that the Home app renders,
 * so a slider has to borrow one. `fan` uses Fanv2 `RotationSpeed`; `lightbulb`
 * uses `Brightness`. They render identically, but a Lightbulb is swept up by
 * "turn off all the lights", which silences the house.
 */
exports.SLIDER_SERVICES = ['fan', 'lightbulb'];
/** Narrow an unknown value to a {@link SliderService}. */
function isSliderService(value) {
    return typeof value === 'string' && exports.SLIDER_SERVICES.includes(value);
}
