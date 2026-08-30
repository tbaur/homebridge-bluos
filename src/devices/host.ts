/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The contract between an accessory and the platform.
 *
 * Accessories depend on this narrow interface rather than on the platform class,
 * which keeps the import graph acyclic and lets a test drive an accessory with a
 * handful of stubs instead of a whole platform.
 */

import type { HAP, PlatformAccessory } from 'homebridge'

import type { BluOSClient, Endpoint } from '../api/client'
import type { PlayerObservation, PluginLogger } from '../types'
import type { VolumeResult } from '../api/sync-status'

/**
 * One address the global reboot switch should restart.
 *
 * An address rather than a player, because reboot is served on port 80 and port
 * 80 is one server per chassis: the zones of a CI S2 cannot be restarted
 * separately. `names` therefore holds every player known to be behind this
 * address, so the log line before the reboot can say what is really about to go
 * down rather than naming one zone of two.
 */
export interface RebootTarget {
  host: string
  names: readonly string[]
}

/** What an accessory may ask of the platform. */
export interface AccessoryHost {
  readonly log: PluginLogger

  readonly hap: HAP

  /** Shared client, so every request goes through one set of rate limits. */
  readonly client: BluOSClient

  /** Plugin version, reported to HomeKit as FirmwareRevision. */
  readonly pluginVersion: string

  /** Current address of a player, or undefined when it is not configured. */
  endpointFor(deviceId: string): Endpoint | undefined

  /** Latest observation for a player, if one has been made since launch. */
  observationFor(deviceId: string): PlayerObservation | undefined

  /**
   * Adopt the authoritative state returned by a write.
   *
   * Also invalidates any long-poll response already in flight for that player,
   * so a reply that was computed before the write cannot overwrite the result of
   * it. This is the whole set/poll race defence, and it lives here so that every
   * accessory gets it without having to reimplement it.
   */
  adoptWriteResult(deviceId: string, result: VolumeResult): void

  /**
   * Persist accessory context after a change worth surviving a restart.
   *
   * Pass the accessory whose context changed. Omitting it rewrites the context of
   * every active accessory, which is only wanted when several changed at once.
   */
  persistContext(accessory?: PlatformAccessory): void

  /**
   * Every address the global reboot switch should restart.
   *
   * Resolved by the platform because both halves live there: the configured
   * device list, and discovery. The union of the two is deliberate. Discovery
   * alone would silently do nothing on a network that filters multicast, which
   * the manual-address fallback exists for; the configured list alone would miss
   * the players this switch is advertised as reaching.
   */
  rebootTargets(): Promise<readonly RebootTarget[]>

  /**
   * Other configured players that would go down with this one.
   *
   * Empty for a standalone player. Non-empty for a zone of a multi-zone chassis,
   * because reboot is per address and cannot be aimed at one zone — which makes
   * a switch named for one room able to silence another, and is worth saying out
   * loud rather than letting someone discover it.
   */
  playersSharingAddress(deviceId: string): readonly string[]
}
