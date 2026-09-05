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

import type { PlatformAccessory } from 'homebridge'

import { DEFAULT_BLUOS_PORT, DEFAULT_BRAND, DEFAULT_MODEL } from '../settings'
import {
  isAccessoryKind,
  isSliderService,
  type AccessoryContext,
  type SliderService,
} from '../types'
import { ConfigValidationError } from './errors'
import { forLog } from './validators'

/** Read and validate a restored accessory's context. */
export function parseAccessoryContext(accessory: PlatformAccessory): AccessoryContext {
  const raw = (accessory.context ?? {}) as Partial<AccessoryContext>

  if (!isAccessoryKind(raw.kind)) {
    throw new ConfigValidationError(
      `cached accessory ${forLog(accessory.displayName)} has an unknown kind ${forLog(raw.kind)}`,
    )
  }
  if (typeof raw.deviceId !== 'string' || raw.deviceId.length === 0) {
    throw new ConfigValidationError(
      `cached accessory ${forLog(accessory.displayName)} has no device id`,
    )
  }
  if (typeof raw.serialNumber !== 'string' || raw.serialNumber.length === 0) {
    throw new ConfigValidationError(
      `cached accessory ${forLog(accessory.displayName)} has no serial number`,
    )
  }
  if (raw.kind === 'volumePreset' && !Number.isInteger(raw.volume)) {
    throw new ConfigValidationError(
      `cached preset ${forLog(accessory.displayName)} has no target volume`,
    )
  }

  const sliderService: SliderService = isSliderService(raw.sliderService) ? raw.sliderService : 'fan'
  const context: AccessoryContext = {
    kind: raw.kind,
    deviceId: raw.deviceId,
    host: typeof raw.host === 'string' ? raw.host : '',
    port: Number.isInteger(raw.port) ? (raw.port as number) : DEFAULT_BLUOS_PORT,
    brand: typeof raw.brand === 'string' && raw.brand.length > 0 ? raw.brand : DEFAULT_BRAND,
    model: typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : DEFAULT_MODEL,
    serialNumber: raw.serialNumber,
    adoptedLegacyUuid: raw.adoptedLegacyUuid === true,
    sliderService,
  }
  if (Number.isInteger(raw.volume)) {
    context.volume = raw.volume
  }
  if (Number.isInteger(raw.lastNonZeroVolume)) {
    context.lastNonZeroVolume = raw.lastNonZeroVolume
  }
  if (raw.hostsBattery === true) {
    context.hostsBattery = true
  }
  return context
}

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
export function bindAccessoryContext(accessory: PlatformAccessory): AccessoryContext {
  const context = parseAccessoryContext(accessory)
  accessory.context = context
  return context
}
