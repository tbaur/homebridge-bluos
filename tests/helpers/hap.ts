/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A HAP stand-in for accessory tests.
 *
 * Enough of HAP to exercise real accessory code without HAP-NodeJS: services
 * that remember their characteristics, characteristics that remember their
 * handlers and their last pushed value, and an accessory that behaves like a
 * restored one. Handlers are invoked directly, the way HomeKit would, so the
 * tests assert on the plugin's behaviour rather than on mock bookkeeping.
 */

import type { HAP, PlatformAccessory, Service } from 'homebridge'

import type { BluOSClient, Endpoint, RebootResult, WriteScope } from '../../src/api/client'
import type { VolumeResult } from '../../src/api/sync-status'
import type { AccessoryHost, RebootTarget } from '../../src/devices/host'
import type { AccessoryContext, PlayerObservation, PluginLogger } from '../../src/types'

/** A recorded characteristic. */
export class FakeCharacteristic {
  getHandler: (() => unknown) | undefined

  setHandler: ((value: unknown) => Promise<void>) | undefined

  /** Every value pushed with `updateCharacteristic`, in order. */
  readonly updates: unknown[] = []

  props: Record<string, unknown> = {}

  constructor(readonly name: string) {}

  onGet(handler: () => unknown): this {
    this.getHandler = handler
    return this
  }

  onSet(handler: (value: unknown) => Promise<void>): this {
    this.setHandler = handler
    return this
  }

  setProps(props: Record<string, unknown>): this {
    this.props = { ...this.props, ...props }
    return this
  }

  /** What HAP offers for pushing a value straight onto a characteristic. */
  updateValue(value: unknown): this {
    this.updates.push(value)
    return this
  }

  /** Most recent pushed value. */
  get value(): unknown {
    return this.updates[this.updates.length - 1]
  }

  /** Invoke the read handler the way HomeKit would. */
  read(): unknown {
    if (this.getHandler === undefined) {
      throw new Error(`${this.name} has no read handler`)
    }
    return this.getHandler()
  }

  /** Invoke the write handler the way HomeKit would. */
  async write(value: unknown): Promise<void> {
    if (this.setHandler === undefined) {
      throw new Error(`${this.name} has no write handler`)
    }
    await this.setHandler(value)
  }
}

/**
 * A service that remembers its characteristics.
 *
 * Keys are coerced with `String`, because the characteristics below carry their
 * enum constants (`Active.ACTIVE`) and so have to be String objects, which are
 * never equal to the plain strings a test looks them up with.
 */
export class FakeService {
  private readonly byName = new Map<string, FakeCharacteristic>()

  constructor(readonly UUID: string, public displayName?: string) {}

  /** An array, as HAP's own `Service.characteristics` is. */
  get characteristics(): FakeCharacteristic[] {
    return [...this.byName.values()]
  }

  getCharacteristic(name: unknown): FakeCharacteristic {
    const key = String(name)
    const existing = this.byName.get(key)
    if (existing !== undefined) {
      return existing
    }
    const created = new FakeCharacteristic(key)
    this.byName.set(key, created)
    return created
  }

  setCharacteristic(name: unknown, value: unknown): this {
    this.getCharacteristic(name).updates.push(value)
    return this
  }

  updateCharacteristic(name: unknown, value: unknown): this {
    this.getCharacteristic(name).updates.push(value)
    return this
  }

  /** The last value pushed to a characteristic. */
  lastValue(name: unknown): unknown {
    return this.byName.get(String(name))?.value
  }
}

/** Thrown in place of HAP's own, so tests can recognise a refused read. */
export class FakeHapStatusError extends Error {
  constructor(readonly hapStatus: number) {
    super(`HapStatusError:${hapStatus}`)
    this.name = 'HapStatusError'
  }
}

/**
 * Service constructors keyed by name.
 *
 * Each is a real constructor with a `UUID`, because `requireService` matches a
 * restored service by UUID and then constructs one if it finds none.
 */
function serviceConstructor(name: string): new (displayName?: string) => Service {
  const constructor = class extends FakeService {
    static readonly UUID = name

    constructor(displayName?: string) {
      super(name, displayName)
    }
  }
  Object.defineProperty(constructor, 'UUID', { value: name })
  return constructor as unknown as new (displayName?: string) => Service
}

const SERVICE_NAMES = [
  'AccessoryInformation',
  'Battery',
  'Fanv2',
  'Lightbulb',
  'Switch',
] as const

/** HAP's `Characteristic` namespace, reduced to the names this plugin uses. */
export const characteristics = {
  Active: Object.assign('Active', { ACTIVE: 1, INACTIVE: 0 }),
  BatteryLevel: 'BatteryLevel',
  Brightness: 'Brightness',
  ChargingState: Object.assign('ChargingState', { CHARGING: 1, NOT_CHARGING: 0 }),
  FirmwareRevision: 'FirmwareRevision',
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  Name: 'Name',
  On: 'On',
  RotationSpeed: 'RotationSpeed',
  SerialNumber: 'SerialNumber',
  StatusLowBattery: Object.assign('StatusLowBattery', {
    BATTERY_LEVEL_LOW: 1,
    BATTERY_LEVEL_NORMAL: 0,
  }),
}

/** The HAP status code that makes the Home app show No Response. */
export const SERVICE_COMMUNICATION_FAILURE = -70402

export function fakeHap(): HAP {
  const services: Record<string, unknown> = {}
  for (const name of SERVICE_NAMES) {
    services[name] = serviceConstructor(name)
  }
  return {
    Service: services,
    Characteristic: characteristics,
    HapStatusError: FakeHapStatusError,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE },
  } as unknown as HAP
}

/** A restored `PlatformAccessory`, with services that persist across handlers. */
export class FakeAccessory {
  readonly services: FakeService[] = []

  constructor(
    public displayName: string,
    public context: Record<string, unknown>,
  ) {}

  getService(type: unknown): FakeService | undefined {
    const uuid = typeof type === 'string' ? type : (type as { UUID: string }).UUID
    return this.services.find((service) => service.UUID === uuid)
  }

  addService(service: unknown): FakeService {
    // Homebridge accepts either an instance or a constructor; both appear here.
    const instance = typeof service === 'function'
      ? new (service as new () => FakeService)()
      : service as FakeService
    this.services.push(instance)
    return instance
  }

  removeService(service: FakeService): void {
    const index = this.services.indexOf(service)
    if (index >= 0) {
      this.services.splice(index, 1)
    }
  }
}

export function fakeLogger(): PluginLogger & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    info: (message: string) => calls.push(`info ${message}`),
    warn: (message: string) => calls.push(`warn ${message}`),
    error: (message: string) => calls.push(`error ${message}`),
    debug: (message: string) => calls.push(`debug ${message}`),
  }
}

/** Everything a test needs to drive one accessory. */
export interface Harness {
  host: AccessoryHost
  accessory: PlatformAccessory
  context: AccessoryContext
  log: PluginLogger & { calls: string[] }
  client: {
    setVolume: jest.Mock<Promise<VolumeResult>, [Endpoint, number, WriteScope?]>
    setMute: jest.Mock<Promise<VolumeResult>, [Endpoint, boolean, WriteScope?]>
    reboot: jest.Mock<Promise<RebootResult>, [string]>
  }
  /** Targets the global reboot switch is told about. */
  rebootTargets: jest.Mock<Promise<readonly RebootTarget[]>, []>
  adopted: VolumeResult[]
  persisted: number
  /** Accessories whose context was written back, in order. */
  persistedAccessories: (PlatformAccessory | undefined)[]
  /** Set the observation the host reports for this device. */
  setObservation(observation: PlayerObservation | undefined): void
  service(name: string): FakeService
}

const defaultContext: AccessoryContext = {
  kind: 'volume',
  deviceId: '90:56:82:0A:00:02:11000',
  host: '192.168.4.11',
  port: 11_000,
  brand: 'NAD',
  model: 'CI S2',
  serialNumber: 'serial-1',
  adoptedLegacyUuid: false,
  sliderService: 'fan',
}

/** Build a harness. `overrides.context` is merged over a working default. */
export function harness(overrides: {
  context?: Partial<AccessoryContext>
  displayName?: string
  observation?: PlayerObservation
  endpoint?: Endpoint | undefined
  volumeResult?: VolumeResult
  muteResult?: VolumeResult
  rebootResult?: RebootResult
  rebootTargets?: readonly RebootTarget[]
  /** Other configured players behind this one's address. */
  sharingAddress?: readonly string[]
} = {}): Harness {
  const context: AccessoryContext = { ...defaultContext, ...overrides.context }
  const accessory = new FakeAccessory(
    overrides.displayName ?? 'Zone One',
    context as unknown as Record<string, unknown>,
  )
  const log = fakeLogger()
  const adopted: VolumeResult[] = []
  const persistedAccessories: (PlatformAccessory | undefined)[] = []
  let observation = overrides.observation
  let persisted = 0

  const client = {
    setVolume: jest.fn(async (_endpoint: Endpoint, level: number, _scope?: WriteScope) => (
      overrides.volumeResult ?? { level, fixedVolume: false, muted: false }
    )),
    setMute: jest.fn(async (_endpoint: Endpoint, muted: boolean, _scope?: WriteScope) => (
      overrides.muteResult ?? { level: muted ? 0 : 40, fixedVolume: false, muted }
    )),
    reboot: jest.fn(async (_host: string) => (
      overrides.rebootResult ?? { acknowledged: true }
    )),
  }

  const rebootTargets = jest.fn(async () => overrides.rebootTargets ?? [])

  const endpoint = 'endpoint' in overrides
    ? overrides.endpoint
    : { host: context.host, port: context.port }

  const host: AccessoryHost = {
    log,
    hap: fakeHap(),
    client: client as unknown as BluOSClient,
    pluginVersion: '1.2.3',
    endpointFor: () => endpoint,
    observationFor: () => observation,
    adoptWriteResult: (_deviceId: string, result: VolumeResult) => {
      adopted.push(result)
    },
    persistContext: (target?: PlatformAccessory) => {
      persisted += 1
      persistedAccessories.push(target)
    },
    rebootTargets,
    playersSharingAddress: () => overrides.sharingAddress ?? [],
  }

  return {
    host,
    accessory: accessory as unknown as PlatformAccessory,
    context,
    log,
    client,
    rebootTargets,
    adopted,
    get persisted() {
      return persisted
    },
    persistedAccessories,
    setObservation: (next) => {
      observation = next
    },
    service: (name: string) => {
      const found = accessory.getService(name)
      if (found === undefined) {
        throw new Error(`no ${name} service was created`)
      }
      return found
    },
  }
}

/** A complete observation, overridable per test. */
export function observation(overrides: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    name: 'Zone One',
    brand: 'NAD',
    model: 'CI-S2',
    modelName: 'CI S2',
    firmware: '4.16.6',
    mac: '90:56:82:0A:00:02',
    volume: 60,
    fixedVolume: false,
    muted: false,
    db: -32.1,
    syncRole: 'standalone',
    etag: '95',
    syncStat: '95',
    ...overrides,
  }
}
