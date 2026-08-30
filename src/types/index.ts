/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared types for configuration, accessory identity and the
 * observations read back from a player.
 */

/** The subset of Homebridge's logger this plugin uses. */
export interface PluginLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
}

/**
 * What an accessory does. Part of its identity, and therefore of its UUID.
 *
 * `volume` is the fake slider, `mute` the mute switch, `volumePreset` a
 * one-level switch, `battery` the state-of-charge sensor for portables, and
 * `reboot` a momentary switch that restarts one player. `rebootAll` is the only
 * kind with no player behind it: it belongs to the platform and restarts every
 * player it can find.
 */
export const ACCESSORY_KINDS = [
  'volume',
  'mute',
  'volumePreset',
  'battery',
  'reboot',
  'rebootAll',
] as const

/** @see ACCESSORY_KINDS */
export type AccessoryKind = (typeof ACCESSORY_KINDS)[number]

/** Narrow an unknown value to an {@link AccessoryKind}. */
export function isAccessoryKind(value: unknown): value is AccessoryKind {
  return typeof value === 'string' && (ACCESSORY_KINDS as readonly string[]).includes(value)
}

/**
 * Which HAP service impersonates the volume slider.
 *
 * HomeKit has no first-class speaker volume control that the Home app renders,
 * so a slider has to borrow one. `fan` uses Fanv2 `RotationSpeed`; `lightbulb`
 * uses `Brightness`. They render identically, but a Lightbulb is swept up by
 * "turn off all the lights", which silences the house.
 */
export const SLIDER_SERVICES = ['fan', 'lightbulb'] as const

/** @see SLIDER_SERVICES */
export type SliderService = (typeof SLIDER_SERVICES)[number]

/** Narrow an unknown value to a {@link SliderService}. */
export function isSliderService(value: unknown): value is SliderService {
  return typeof value === 'string' && (SLIDER_SERVICES as readonly string[]).includes(value)
}

/** A named volume level exposed as a switch. */
export interface VolumePresetConfig {
  name: string
  volume: number
}

/** One configured player zone. */
export interface BluOSDeviceConfig {
  /**
   * Stable identity, normally `{normalised-mac}:{port}`.
   *
   * Never contains an IP address, so a DHCP change does not re-create the
   * accessory. Written by the discovery UI; hand-editable but not derived.
   */
  id: string
  name: string
  /** Last known address. Re-resolved at launch and when the player goes silent. */
  host: string
  port?: number
  model?: string
  brand?: string
  volumeSlider?: boolean
  sliderService?: SliderService
  mute?: boolean
  battery?: boolean
  reboot?: boolean
  volumePresets?: VolumePresetConfig[]
}

/** Platform-level tuning. */
export interface BluOSPlatformOptions {
  discoveryTimeoutSec?: number
  sliderService?: SliderService
  /**
   * Expose one switch that restarts every BluOS player on the network.
   *
   * Off by default, and deliberately so: its reach is every player discovery can
   * see, including ones absent from `devices[]`.
   */
  rebootAll?: boolean

  /**
   * What to call that switch in HomeKit.
   *
   * Worth configuring rather than deriving, because this is the one accessory
   * with no room of its own: it belongs to the install, so the only thing that
   * can put it in a sensible room is a name the user chose. Falls back to the
   * platform name followed by "Reboot All".
   */
  rebootAllName?: string
}

/** Shape of one `platforms[]` entry in `config.json`. */
export interface BluOSPlatformConfig {
  platform: string
  name?: string
  devices?: BluOSDeviceConfig[]
  options?: BluOSPlatformOptions
}

/** A configured device after validation and defaulting. */
export interface ResolvedDevice {
  id: string
  name: string
  host: string
  port: number
  model?: string
  brand?: string
  volumeSlider: boolean
  sliderService: SliderService
  mute: boolean
  battery: boolean
  reboot: boolean
  volumePresets: VolumePresetConfig[]
}

/** One accessory to expose, derived from a {@link ResolvedDevice}. */
export interface ResolvedAccessory {
  kind: AccessoryKind
  /** Owning device's stable id. */
  deviceId: string
  /** HomeKit display name. */
  name: string
  sliderService: SliderService
  /** Target level, for `volumePreset` only. */
  volume?: number
}

/**
 * What gets persisted in `PlatformAccessory.context`.
 *
 * Survives restarts, so anything needed to serve HomeKit before the first poll
 * completes belongs here.
 */
export interface AccessoryContext {
  kind: AccessoryKind
  deviceId: string
  /** Last known address. Informational only; never part of identity. */
  host: string
  port: number
  brand: string
  model: string
  /** Opaque, stable, generated once. Not the MAC: that would leak and churn. */
  serialNumber: string
  /** True when this accessory was adopted from a different UUID scheme. */
  adoptedLegacyUuid: boolean
  sliderService: SliderService
  /** Target level, for `volumePreset` only. */
  volume?: number
  /**
   * Last level seen above zero, used to restore the slider when switched on.
   *
   * Only a fallback: a player that was muted reports `muteVolume`, which is
   * authoritative and preferred.
   */
  lastNonZeroVolume?: number
}

/**
 * How a player relates to a runtime sync group.
 *
 * A union rather than a const array plus a narrower, because nothing has to
 * validate an incoming value against it: the role is derived from the shape of a
 * `/SyncStatus` response, never read from configuration.
 */
export type SyncRole = 'standalone' | 'primary' | 'secondary'

/** Battery state, present only on players with a battery pack. */
export interface BatteryObservation {
  level: number
  charging: boolean
}

/**
 * A parsed `/SyncStatus` response.
 *
 * `/Status` is deliberately not used: the specification points at `/SyncStatus`
 * when "only the name, volume and grouping status of a player is of interest",
 * and for a group secondary it is the only endpoint that reports that player's
 * own volume rather than the group's.
 */
export interface PlayerObservation {
  name: string
  brand?: string
  /** Model code, e.g. `CI-S2`. */
  model?: string
  /** Display model name, e.g. `CI S2`. */
  modelName?: string
  firmware?: string
  /** Normalised chassis MAC with no zone-port suffix, upper case. */
  mac?: string
  /** Level 0..100, or undefined when the player reports fixed volume. */
  volume?: number
  /** True when fixed-output; a slider must not be exposed. */
  fixedVolume: boolean
  muted: boolean
  /** Pre-mute level, present only while muted. */
  muteVolume?: number
  /**
   * Output level in dB. Absent or sentinel while muted.
   *
   * Parsed and carried but not yet acted on: no accessory needs it, because
   * HomeKit has no decibel characteristic. Kept because it is the only reading
   * that describes the actual output of a player whose 0-100 level is mapped onto
   * a restricted dB range, which is what a future dB-aware control would need.
   */
  db?: number
  syncRole: SyncRole
  battery?: BatteryObservation
  /** Opaque long-poll token from the response root. */
  etag?: string
  /**
   * Opaque sync-generation token from the response root.
   *
   * Parsed and carried but not yet acted on: grouping is derived from the
   * `<master>` and `<slave>` elements instead. Kept because it changes whenever
   * group membership does, which is the cheap way to notice a regrouping without
   * comparing element lists.
   */
  syncStat?: string
}

/** A player found by discovery and confirmed to answer `/SyncStatus`. */
export interface DiscoveredPlayer {
  id: string
  name: string
  host: string
  port: number
  brand?: string
  model?: string
  modelName?: string
  firmware?: string
  mac?: string
  fixedVolume: boolean
  hasBattery: boolean
}

/** Why a refresh was requested, for logging and coalescing. */
export type RefreshReason = 'poll' | 'post-set' | 'startup'

/** An accessory handler the platform can drive. */
export interface RefreshableAccessory {
  readonly deviceId: string
  readonly displayName: string
  /** Apply a fresh observation to HomeKit characteristics. */
  applyObservation(observation: PlayerObservation, reason: RefreshReason): void
  /** Report that the player could not be reached. */
  noteUnreachable(error: unknown): void
}
