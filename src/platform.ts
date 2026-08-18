/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The platform: configuration, accessory lifecycle, orchestration.
 *
 * Two policies here matter more than the mechanics.
 *
 * Accessories are adopted, never replaced. Identity is derived from the player's
 * MAC and zone port and never from its address, so a DHCP lease change leaves
 * every UUID untouched. When a cached accessory carries the right identity in its
 * context but a different UUID — the situation an identity-scheme change would
 * create — it is adopted rather than orphaned, because losing an accessory takes
 * the user's rooms, scenes and automations with it.
 *
 * A broken configuration disables the platform instead of deleting anything. The
 * accessories stay registered and report No Response, which is recoverable; a
 * plugin that unregisters accessories when it cannot parse its own settings
 * destroys work the user cannot get back.
 */

import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge'

import { BluOSClient, type Endpoint } from './api/client'
import { BluOSDiscovery } from './api/discovery'
import { accessoryIdentityKey, hasAccessoryIdentity } from './api/identity'
import type { VolumeResult } from './api/sync-status'
import {
  BatteryAccessory,
  MuteAccessory,
  VolumeAccessory,
  VolumePresetAccessory,
  type AccessoryHost,
  type BaseAccessory,
} from './devices'
import { DevicePoller } from './poller'
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  UUID_PREFIX,
  readPluginVersion,
} from './settings'
import type {
  AccessoryContext,
  PlayerObservation,
  RefreshReason,
  ResolvedAccessory,
  ResolvedDevice,
} from './types'
import {
  describeError,
  describeErrorStack,
  ensureAccessorySerialNumber,
  forLog,
  newAccessorySerialNumber,
  parseAccessoryContext,
  resolveAccessories,
  resolveDiscoveryTimeoutSec,
  validateConfig,
} from './utils'

/** Delay between starting successive pollers, so a fleet does not start as a burst. */
const POLLER_STAGGER_MS = 120

/** The BluOS dynamic platform. */
export class BluOSPlatform implements DynamicPlatformPlugin, AccessoryHost {
  readonly log: Logging

  readonly client: BluOSClient

  readonly pluginVersion: string

  private readonly api: API

  private readonly config: PlatformConfig

  private readonly discovery: BluOSDiscovery

  /** Accessories restored from disk, by UUID. */
  private readonly restored = new Map<string, PlatformAccessory>()

  /** Live accessories, by UUID. */
  private readonly active = new Map<string, PlatformAccessory>()

  /** Accessory handlers grouped by the player they belong to. */
  private readonly handlers = new Map<string, BaseAccessory[]>()

  private readonly pollers = new Map<string, DevicePoller>()

  private devices: ResolvedDevice[] = []

  private discoveryTimeoutSec: number

  /** True when configuration could not be used; nothing is polled. */
  private disabled = false

  private shuttingDown = false

  /** Warnings raised while resolving options in the constructor, logged at start. */
  private readonly discoveryWarnings: string[] = []

  /** Pending poller starts, tracked so a shutdown can clear them. */
  private readonly staggerTimers = new Set<ReturnType<typeof setTimeout>>()

  /** The launch address sweep, tracked so a shutdown can wait for it to end. */
  private launchSweep: Promise<void> | undefined

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log
    this.config = config
    this.api = api
    this.pluginVersion = readPluginVersion(log)
    this.client = new BluOSClient({ log })
    this.discovery = new BluOSDiscovery({ log, client: this.client })
    // Warnings are collected rather than logged here: the constructor runs before
    // Homebridge has finished wiring logging for the platform, and a clamped or
    // unreadable value the user never hears about is a support call.
    this.discoveryTimeoutSec = resolveDiscoveryTimeoutSec(
      config.options?.discoveryTimeoutSec,
      this.discoveryWarnings,
    )

    this.api.on('didFinishLaunching', () => {
      // Startup is synchronous up to the point where polling begins, so a
      // configuration problem is reported before Homebridge finishes launching.
      // Anything slower — address correction, the poll loops themselves — is
      // started in the background from within.
      try {
        this.start()
      } catch (error) {
        this.log.error(`BluOS failed to start: ${describeError(error)}`)
        // The stack only at debug level: a startup fault this unexpected is a bug
        // in the plugin, and the report is useless without one.
        this.log.debug(describeErrorStack(error))
      }
    })
    this.api.on('shutdown', () => {
      void this.stop()
    })
  }

  get hap(): API['hap'] {
    return this.api.hap
  }

  /** Homebridge hands back every accessory it restored from disk. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`restoring cached accessory ${forLog(accessory.displayName)}`)
    this.restored.set(accessory.UUID, accessory)
  }

  // --- AccessoryHost --------------------------------------------------------

  endpointFor(deviceId: string): Endpoint | undefined {
    return this.pollers.get(deviceId)?.endpoint
  }

  observationFor(deviceId: string): PlayerObservation | undefined {
    return this.pollers.get(deviceId)?.lastObservation
  }

  adoptWriteResult(deviceId: string, result: VolumeResult): void {
    this.pollers.get(deviceId)?.adoptWriteResult(result)
  }

  /**
   * Write accessory context back to the Homebridge cache.
   *
   * One accessory by default, because `updatePlatformAccessories` makes
   * Homebridge serialise and rewrite the whole cache file: a front-panel volume
   * knob produces a stream of observations, and writing every accessory's context
   * for each of them is sustained disk churn on the SD card of a typical host.
   */
  persistContext(accessory?: PlatformAccessory): void {
    if (accessory !== undefined) {
      this.api.updatePlatformAccessories([accessory])
      return
    }
    if (this.active.size === 0) {
      return
    }
    this.api.updatePlatformAccessories([...this.active.values()])
  }

  // --- Lifecycle ------------------------------------------------------------

  private start(): void {
    const result = validateConfig(this.config)
    for (const warning of result.warnings) {
      this.log.warn(warning)
    }
    for (const warning of this.discoveryWarnings) {
      this.log.warn(warning)
    }

    if (result.errors.length > 0) {
      this.disabled = true
      for (const error of result.errors) {
        this.log.error(error)
      }
      this.log.error(
        'BluOS is disabled until its configuration is fixed. Cached accessories are kept '
        + 'and will show as No Response, so rooms and automations are not lost.',
      )
      this.reportEverythingUnavailable()
      return
    }

    this.devices = result.devices
    const accessoryWarnings: string[] = []
    const wanted = resolveAccessories(this.devices, accessoryWarnings)
    for (const warning of accessoryWarnings) {
      this.log.warn(warning)
    }

    this.syncAccessories(wanted)
    this.startPollers()
    // Address correction runs alongside polling rather than before it: a player
    // that has not moved should not have startup delayed by a multicast sweep.
    // The promise is kept so a shutdown can wait for it instead of leaving a
    // bound multicast socket behind.
    this.launchSweep = this.correctAddresses()
  }

  private async stop(): Promise<void> {
    this.shuttingDown = true
    for (const timer of this.staggerTimers) {
      clearTimeout(timer)
    }
    this.staggerTimers.clear()
    // Cancelled before the pollers are awaited: a poller inside an address
    // re-resolution is waiting on a browse window that nothing else can end, so
    // without this the process cannot exit until the window elapses — up to 30 s
    // for every player that happened to be unreachable.
    this.discovery.cancelAll()
    const pollers = [...this.pollers.values()]
    this.pollers.clear()
    const sweep = this.launchSweep
    this.launchSweep = undefined
    await Promise.all([
      ...pollers.map(async (poller) => poller.stop()),
      sweep ?? Promise.resolve(),
    ])
    this.log.debug('BluOS polling stopped')
  }

  /**
   * Bring the registered accessory set in line with configuration.
   *
   * Creates what is missing, adopts what matches by identity, and unregisters
   * only what configuration no longer asks for.
   */
  private syncAccessories(wanted: readonly ResolvedAccessory[]): void {
    const claimed = new Set<string>()
    const byId = new Map(this.devices.map((device) => [device.id, device]))

    for (const accessory of wanted) {
      const uuid = this.uuidFor(accessory)
      // Every wanted accessory was expanded from one of these devices, so a miss
      // is impossible rather than merely unlikely; the map exists to keep startup
      // linear in accessory count.
      const device = byId.get(accessory.deviceId)
      if (device === undefined) {
        continue
      }
      const existing = this.restored.get(uuid) ?? this.findByIdentity(accessory, claimed)
      if (existing === undefined) {
        this.createAccessory(uuid, accessory, device)
        continue
      }
      claimed.add(existing.UUID)
      this.adoptAccessory(existing, uuid, accessory, device)
    }

    for (const [uuid, accessory] of this.restored) {
      if (claimed.has(uuid) || this.active.has(uuid)) {
        continue
      }
      this.log.info(`removing ${forLog(accessory.displayName)}, no longer in the configuration`)
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    }
  }

  private uuidFor(accessory: ResolvedAccessory): string {
    return this.api.hap.uuid.generate(`${UUID_PREFIX}${accessoryIdentityKey(accessory)}`)
  }

  /**
   * Find a cached accessory that describes this one but under a different UUID.
   *
   * The safety net for an identity-scheme change: matching on the persisted
   * context lets the accessory be adopted instead of being replaced by a fresh
   * one, which would silently drop it out of every scene it belongs to.
   */
  private findByIdentity(
    accessory: ResolvedAccessory,
    claimed: ReadonlySet<string>,
  ): PlatformAccessory | undefined {
    for (const [uuid, candidate] of this.restored) {
      if (claimed.has(uuid)) {
        continue
      }
      const context = candidate.context as Partial<AccessoryContext>
      if (hasAccessoryIdentity(context, accessory)) {
        return candidate
      }
    }
    return undefined
  }

  private createAccessory(
    uuid: string,
    accessory: ResolvedAccessory,
    device: ResolvedDevice,
  ): void {
    this.log.info(`adding ${forLog(accessory.name)}`)
    const platformAccessory = new this.api.platformAccessory(accessory.name, uuid)
    platformAccessory.context = this.buildContext({
      accessory,
      device,
      serialNumber: newAccessorySerialNumber(),
      adoptedLegacyUuid: false,
    })
    this.attachHandler(platformAccessory)
    this.active.set(uuid, platformAccessory)
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory])
  }

  private adoptAccessory(
    existing: PlatformAccessory,
    expectedUuid: string,
    accessory: ResolvedAccessory,
    device: ResolvedDevice,
  ): void {
    const adopted = existing.UUID !== expectedUuid
    const alreadyAdopted = (existing.context as Partial<AccessoryContext>).adoptedLegacyUuid === true
    // A HAP UUID is immutable, so an adopted accessory keeps its old one and takes
    // this path on every launch. The flag is what makes the notice a migration
    // notice rather than a line the user reads forever.
    if (adopted && !alreadyAdopted) {
      this.log.info(
        `adopting cached accessory ${forLog(existing.displayName)} by identity; `
        + 'its rooms and automations are preserved',
      )
    }
    // The serial number is carried over rather than regenerated: HomeKit treats a
    // changed serial as a different piece of hardware.
    const serialNumber = ensureAccessorySerialNumber(existing)
    existing.context = this.buildContext({
      accessory,
      device,
      serialNumber,
      adoptedLegacyUuid: adopted || alreadyAdopted,
    })
    if (existing.displayName !== accessory.name) {
      this.log.info(
        `${forLog(existing.displayName)} is now named ${forLog(accessory.name)}`,
      )
      existing.displayName = accessory.name
    }
    this.attachHandler(existing)
    this.active.set(existing.UUID, existing)
    this.api.updatePlatformAccessories([existing])
  }

  private buildContext(input: {
    accessory: ResolvedAccessory
    device: ResolvedDevice
    serialNumber: string
    adoptedLegacyUuid: boolean
  }): AccessoryContext {
    const { accessory, device, serialNumber, adoptedLegacyUuid } = input
    const previous = this.restored.get(this.uuidFor(accessory))?.context as
      | Partial<AccessoryContext>
      | undefined
    const context: AccessoryContext = {
      kind: accessory.kind,
      deviceId: accessory.deviceId,
      host: device.host,
      port: device.port,
      brand: device.brand ?? 'BluOS',
      model: device.model ?? 'BluOS Player',
      serialNumber,
      adoptedLegacyUuid,
      sliderService: accessory.sliderService,
    }
    if (accessory.volume !== undefined) {
      context.volume = accessory.volume
    }
    if (Number.isInteger(previous?.lastNonZeroVolume)) {
      context.lastNonZeroVolume = previous?.lastNonZeroVolume
    }
    return context
  }

  /**
   * Build the handler for an accessory from its persisted context.
   *
   * Driven by context rather than configuration so that the same path works when
   * the platform is disabled and there is no valid configuration to consult.
   */
  private attachHandler(accessory: PlatformAccessory): void {
    let context: AccessoryContext
    try {
      context = parseAccessoryContext(accessory)
    } catch (error) {
      this.log.warn(
        `${forLog(accessory.displayName)} cannot be driven: ${describeError(error)}. `
        + 'It is left registered and shown as No Response rather than deleted, so its rooms '
        + 'and automations survive. Remove it in the Homebridge UI if it is no longer wanted',
      )
      // Without this the tile keeps whatever HomeKit last cached and reports it
      // forever, since no handler exists to correct it. No Response is the honest
      // state for an accessory nothing is driving.
      this.markAccessoryUnavailable(accessory)
      return
    }
    const init = { host: this, accessory, context }
    let handler: BaseAccessory
    switch (context.kind) {
      case 'volume':
        handler = new VolumeAccessory(init)
        break
      case 'mute':
        handler = new MuteAccessory(init)
        break
      case 'volumePreset':
        handler = new VolumePresetAccessory(init)
        break
      case 'battery':
        handler = new BatteryAccessory(init)
        break
    }
    const group = this.handlers.get(context.deviceId) ?? []
    group.push(handler)
    this.handlers.set(context.deviceId, group)
  }

  private startPollers(): void {
    let index = 0
    for (const device of this.devices) {
      if ((this.handlers.get(device.id) ?? []).length === 0) {
        this.log.debug(`${forLog(device.name)} has no accessories; not polling it`)
        continue
      }
      const poller = new DevicePoller({
        log: this.log,
        client: this.client,
        deviceId: device.id,
        displayName: device.name,
        endpoint: { host: device.host, port: device.port },
        onObservation: (observation, reason) => {
          this.publish(device.id, observation, reason)
        },
        onUnreachable: (error) => {
          this.reportUnavailable(device.id, error)
        },
        resolveEndpoint: async (deviceId) => this.discovery.resolveEndpoint(deviceId, this.discoveryTimeoutSec),
        onEndpointChanged: (endpoint) => {
          this.rememberEndpoint(device.id, endpoint)
        },
      })
      this.pollers.set(device.id, poller)

      const delay = index * POLLER_STAGGER_MS
      index += 1
      const timer = setTimeout(() => {
        this.staggerTimers.delete(timer)
        if (!this.shuttingDown) {
          poller.start()
        }
      }, delay)
      timer.unref?.()
      this.staggerTimers.add(timer)
    }
    this.log.info(
      `BluOS is watching ${this.pollers.size} zone(s) with ${this.active.size} accessory(s)`,
    )
  }

  /** Correct addresses once at launch, so a DHCP change needs no user action. */
  private async correctAddresses(): Promise<void> {
    if (this.pollers.size === 0) {
      return
    }
    try {
      const players = await this.discovery.discover(this.discoveryTimeoutSec)
      if (this.shuttingDown) {
        return
      }
      for (const player of players) {
        const poller = this.pollers.get(player.id)
        poller?.setEndpoint({ host: player.host, port: player.port })
      }
    } catch (error) {
      this.log.debug(`launch discovery failed: ${describeError(error)}`)
    }
  }

  /** Record a new address in accessory context so it survives a restart. */
  private rememberEndpoint(deviceId: string, endpoint: Endpoint): void {
    let changed = false
    for (const accessory of this.active.values()) {
      const context = accessory.context as Partial<AccessoryContext>
      if (context.deviceId !== deviceId) {
        continue
      }
      if (context.host !== endpoint.host || context.port !== endpoint.port) {
        context.host = endpoint.host
        context.port = endpoint.port
        changed = true
      }
    }
    if (changed) {
      this.persistContext()
    }
  }

  private publish(deviceId: string, observation: PlayerObservation, reason: RefreshReason): void {
    for (const handler of this.handlers.get(deviceId) ?? []) {
      try {
        handler.applyObservation(observation, reason)
      } catch (error) {
        this.log.debug(
          `${forLog(handler.displayName)} could not apply an observation: ${describeError(error)}`,
        )
      }
    }
  }

  private reportUnavailable(deviceId: string, error: unknown): void {
    for (const handler of this.handlers.get(deviceId) ?? []) {
      // Guarded exactly like publish. This runs from inside the poll loop's catch
      // block, so a throw here — a characteristic missing from a hand-edited
      // cached accessory, a service another plugin removed — would escape as an
      // unhandled rejection and end the Homebridge process.
      try {
        handler.noteUnreachable(error)
      } catch (failure) {
        this.log.debug(
          `${forLog(handler.displayName)} could not be marked unavailable: `
          + describeError(failure),
        )
      }
    }
  }

  /**
   * Put every cached accessory into No Response.
   *
   * Used when configuration is unusable. Handlers are attached first so that the
   * characteristics exist to be marked, which also means HomeKit sees a
   * well-formed accessory that happens to be unreachable rather than a
   * half-registered one.
   */
  private reportEverythingUnavailable(): void {
    for (const accessory of this.restored.values()) {
      this.attachHandler(accessory)
      this.active.set(accessory.UUID, accessory)
    }
    const reason = new Error('the plugin configuration is not usable')
    for (const handlers of this.handlers.values()) {
      for (const handler of handlers) {
        handler.noteUnreachable(reason)
      }
    }
  }

  /**
   * Push No Response onto an accessory that has no handler.
   *
   * Generic rather than per accessory kind, because the reason it is needed is
   * that the context which would have told us the kind could not be read.
   * Accessory Information is left alone so the tile keeps its name and model.
   */
  private markAccessoryUnavailable(accessory: PlatformAccessory): void {
    const failure = new this.hap.HapStatusError(
      this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    )
    for (const service of accessory.services) {
      if (service.UUID === this.hap.Service.AccessoryInformation.UUID) {
        continue
      }
      for (const characteristic of service.characteristics) {
        try {
          characteristic.updateValue(failure)
        } catch (error) {
          this.log.debug(
            `${forLog(accessory.displayName)} could not be marked unavailable: `
            + describeError(error),
          )
        }
      }
    }
  }

  /** True when the platform gave up on its configuration. Exposed for tests. */
  get isDisabled(): boolean {
    return this.disabled
  }
}
