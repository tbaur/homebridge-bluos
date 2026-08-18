/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Readers for `/SyncStatus` and `/Volume` responses.
 *
 * `/Status` is intentionally never requested. API v1.7 section 2 says
 * "/SyncStatus should be polled if only the name, volume and grouping status of
 * a player is of interest", which is precisely this plugin's scope, and for a
 * group secondary `/Status` reports the *group's* volume while `/SyncStatus`
 * reports that player's own. Polling only `/SyncStatus` is therefore both
 * cheaper and more correct here.
 */

import {
  FIXED_VOLUME_SENTINEL,
  MUTED_DB_SENTINEL,
  VOLUME_MAX,
  VOLUME_MIN,
} from '../settings'
import type { BatteryObservation, PlayerObservation, SyncRole } from '../types'
import { ProtocolError } from '../utils/errors'
import { normalizeMac } from './identity'
import {
  attr,
  attrOrChildText,
  boolAttr,
  child,
  children,
  floatAttr,
  intAttr,
  parseXml,
  type XmlElement,
} from './xml'

/** Clamp a reported level into the documented 0..100 range. */
function clampVolume(value: number): number {
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(value)))
}

/**
 * Work out whether this player leads a group, follows one, or is standalone.
 *
 * `<slave>` children mean it is the primary; a `<master>` pointing anywhere
 * other than itself means it is a secondary. A player can briefly report a
 * `<master>` equal to its own endpoint while regrouping, which is not a
 * following state.
 *
 * "Itself" is the `id` the player reports, falling back to the address we
 * dialled. The distinction matters when a player is configured by hostname: its
 * own `<master>` would then never match the endpoint, and a regrouping player
 * would look like a follower.
 */
function readSyncRole(root: XmlElement, endpoint: string): SyncRole {
  if (children(root, 'slave').length > 0) {
    return 'primary'
  }
  const self = attr(root, 'id') ?? endpoint
  const isSelf = (value: string): boolean => value === self || value === endpoint
  const masterElement = child(root, 'master')
  if (masterElement !== undefined) {
    const host = masterElement.text.trim()
    const port = attr(masterElement, 'port')
    const master = host.includes(':') || port === undefined ? host : `${host}:${port}`
    if (master.length > 0 && !isSelf(master)) {
      return 'secondary'
    }
  }
  const legacyMaster = attr(root, 'master')
  if (legacyMaster !== undefined && !isSelf(legacyMaster)) {
    return 'secondary'
  }
  return 'standalone'
}

/**
 * Decide whether a player is muted.
 *
 * `/Volume` says so outright with `mute="1"`, but `/SyncStatus` carries no mute
 * attribute at all. Verified against BluOS 4.16.6, where the same zone reports:
 *
 * - playing:  `volume="60" db="-32.1"`
 * - muted:    `volume="0" db="-100" muteVolume="60" muteDb="-32.1"`
 * - level 0:  `volume="0" db="-100"`
 *
 * So `db="-100"` is silence, not mute, and the two ways of reaching silence are
 * told apart only by the remembered pre-mute level, which the firmware publishes
 * exclusively while muted. Inferring mute from `db` instead would turn the mute
 * switch on whenever a user dragged the slider to zero.
 */
function readMuted(root: XmlElement): boolean {
  if (attr(root, 'mute') !== undefined) {
    return boolAttr(root, 'mute')
  }
  return attr(root, 'muteVolume') !== undefined || attr(root, 'muteDb') !== undefined
}

function readBattery(root: XmlElement): BatteryObservation | undefined {
  const element = child(root, 'battery')
  if (element === undefined) {
    return undefined
  }
  const level = intAttr(element, 'level')
  if (level === undefined) {
    return undefined
  }
  return {
    level: Math.min(100, Math.max(0, level)),
    charging: boolAttr(element, 'charging'),
  }
}

/**
 * Parse a `/SyncStatus` response.
 *
 * @param endpoint canonical `host:port` this response came from. Used, alongside
 * the response's own `id`, to tell a self-referential `<master>` apart from a
 * real group leader.
 */
export function parseSyncStatus(body: string, endpoint: string): PlayerObservation {
  const root = parseXml(body)
  // Firmware has shipped both `SyncStatus` and lowercase variants; matching
  // case-insensitively costs nothing and avoids a needless incompatibility.
  if (root.name.toLowerCase() !== 'syncstatus') {
    throw new ProtocolError(`expected a SyncStatus response, got <${root.name}>`)
  }

  const rawVolume = intAttr(root, 'volume')
  const fixedVolume = rawVolume === FIXED_VOLUME_SENTINEL
  const muted = readMuted(root)
  const rawDb = floatAttr(root, 'db')

  const observation: PlayerObservation = {
    name: attr(root, 'name') ?? '',
    brand: attr(root, 'brand'),
    model: attr(root, 'model'),
    modelName: attr(root, 'modelName'),
    firmware: attr(root, 'version'),
    mac: normalizeMac(attr(root, 'mac')),
    fixedVolume,
    muted,
    syncRole: readSyncRole(root, endpoint),
    etag: attr(root, 'etag'),
    syncStat: attrOrChildText(root, 'syncStat'),
  }

  if (rawVolume !== undefined && !fixedVolume) {
    observation.volume = clampVolume(rawVolume)
  }
  const muteVolume = intAttr(root, 'muteVolume')
  if (muteVolume !== undefined) {
    observation.muteVolume = clampVolume(muteVolume)
  }
  // `db="-100"` is the mute sentinel rather than a real output level, so it is
  // dropped instead of being reported as if the amplifier were at -100 dB.
  if (rawDb !== undefined && !(muted && rawDb <= MUTED_DB_SENTINEL)) {
    observation.db = rawDb
  }
  const battery = readBattery(root)
  if (battery !== undefined) {
    observation.battery = battery
  }
  return observation
}

/** A parsed `/Volume` response. */
export interface VolumeResult {
  /** Level 0..100, or undefined when the player reports fixed volume. */
  level?: number
  fixedVolume: boolean
  muted: boolean
  /** Pre-mute level, present only while muted. */
  muteVolume?: number
  db?: number
}

/**
 * Parse a `/Volume` response.
 *
 * The level is the element's text content rather than an attribute:
 * `<volume db="-39.8" mute="0" ...>35</volume>`.
 */
export function parseVolume(body: string): VolumeResult {
  const root = parseXml(body)
  if (root.name.toLowerCase() !== 'volume') {
    throw new ProtocolError(`expected a Volume response, got <${root.name}>`)
  }
  const rawLevel = Number.parseInt(root.text, 10)
  const fixedVolume = rawLevel === FIXED_VOLUME_SENTINEL
  const muted = boolAttr(root, 'mute')
  const rawDb = floatAttr(root, 'db')

  const result: VolumeResult = { fixedVolume, muted }
  if (Number.isInteger(rawLevel) && !fixedVolume) {
    result.level = clampVolume(rawLevel)
  }
  const muteVolume = intAttr(root, 'muteVolume')
  if (muteVolume !== undefined) {
    result.muteVolume = clampVolume(muteVolume)
  }
  if (rawDb !== undefined && !(muted && rawDb <= MUTED_DB_SENTINEL)) {
    result.db = rawDb
  }
  return result
}

/**
 * The level to restore when a muted or zeroed player is switched back on.
 *
 * `muteVolume` is preferred because the player itself remembers the pre-mute
 * level, which makes an unmute lossless without any state of our own. The
 * remembered level is only a fallback for the other way of reaching silence,
 * writing `level=0`, which the player cannot undo for us.
 */
export function restoreLevelFrom(
  observation: Pick<PlayerObservation, 'muteVolume'>,
  remembered: number | undefined,
  fallback: number,
): number {
  const candidates = [observation.muteVolume, remembered, fallback]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate > VOLUME_MIN && candidate <= VOLUME_MAX) {
      return candidate
    }
  }
  return fallback
}
