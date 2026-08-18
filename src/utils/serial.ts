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

import { randomUUID } from 'node:crypto'

import type { PlatformAccessory } from 'homebridge'

/** Generate a fresh opaque serial number. */
export function newAccessorySerialNumber(): string {
  return randomUUID()
}

/**
 * Return this accessory's serial number, generating and persisting one if the
 * cached accessory predates the field.
 */
export function ensureAccessorySerialNumber(accessory: PlatformAccessory): string {
  const context = accessory.context as { serialNumber?: unknown }
  const existing = context.serialNumber
  if (typeof existing === 'string' && existing.length > 0) {
    return existing
  }
  const generated = newAccessorySerialNumber()
  context.serialNumber = generated
  return generated
}
