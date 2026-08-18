/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opaque HomeKit serial numbers.
 *
 * The player's MAC address is the obvious candidate and the wrong one. HomeKit
 * shows SerialNumber in the Home app and it ends up in screenshots and bug
 * reports, and a MAC is both identifying and, on a multi-zone chassis, shared
 * between zones. A random value generated once and persisted in accessory
 * context is stable across restarts without disclosing anything.
 */
import type { PlatformAccessory } from 'homebridge';
/** Generate a fresh opaque serial number. */
export declare function newAccessorySerialNumber(): string;
/**
 * Return this accessory's serial number, generating and persisting one if the
 * cached accessory predates the field.
 */
export declare function ensureAccessorySerialNumber(accessory: PlatformAccessory): string;
