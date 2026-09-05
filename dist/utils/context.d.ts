/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Validation of the data cached on a restored accessory.
 *
 * Homebridge hands back whatever was persisted when the plugin last ran, which
 * may have been written by an older version with a different shape. Reading it
 * through one checked path means a stale or hand-edited cache produces a clear
 * error for that one accessory instead of an undefined field surfacing much
 * later as a wrong characteristic value.
 */
import type { PlatformAccessory } from 'homebridge';
import { type AccessoryContext } from '../types';
/** Read and validate a restored accessory's context. */
export declare function parseAccessoryContext(accessory: PlatformAccessory): AccessoryContext;
/**
 * Validate a restored accessory's context and make it the accessory's own.
 *
 * What a handler is given has to be the object Homebridge serialises, because
 * handlers remember things in it: a slider's last non-zero level, a brand the
 * player reported that configuration got wrong. {@link parseAccessoryContext}
 * returns a new object by design, so a handler driven by that alone would write
 * those values to a detached copy — thrown away at the next restart, after
 * paying a full accessory-cache rewrite per volume step to save nothing.
 *
 * Kept separate from {@link parseAccessoryContext} so validating a context stays
 * free of side effects for a caller that only wants to know whether it can be
 * read.
 */
export declare function bindAccessoryContext(accessory: PlatformAccessory): AccessoryContext;
