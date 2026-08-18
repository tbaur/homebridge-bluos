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
