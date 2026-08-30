/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The lifecycle rules are what these tests defend, because getting them wrong
 * destroys work a user cannot recover: an accessory that is replaced rather than
 * adopted drops out of every scene and automation it belonged to, and a plugin
 * that unregisters accessories when it dislikes its own configuration does the
 * same thing permanently.
 */

import type { API, PlatformAccessory, PlatformConfig } from 'homebridge'

import { BluOSPlatform } from '../../src/platform'
import { PLATFORM_DEVICE_ID, PLATFORM_NAME, PLUGIN_NAME, UUID_PREFIX } from '../../src/settings'
import type { AccessoryContext, DiscoveredPlayer } from '../../src/types'
import { fakeHap, FakeAccessory, fakeLogger, FakeService } from '../helpers/hap'

/**
 * Discovery is replaced with an inert stand-in: these tests are about the
 * accessory lifecycle, and multicast has no part in it.
 *
 * A class rather than a `jest.fn`, because the suite resets mocks between tests
 * and would strip an implementation supplied to a module factory.
 */
class SilentDiscovery {
  cancelled = 0

  /** What a sweep answers with. Only the global reboot switch sweeps. */
  static found: DiscoveredPlayer[] = []

  /** Set to make a sweep fail, for the degrade-to-configured path. */
  static failure: Error | undefined

  async discover(): Promise<DiscoveredPlayer[]> {
    if (SilentDiscovery.failure !== undefined) {
      throw SilentDiscovery.failure
    }
    return SilentDiscovery.found
  }

  cancelAll(): void {
    this.cancelled += 1
  }

  async resolveEndpoint(): Promise<undefined> {
    return undefined
  }

  async probe(): Promise<undefined> {
    return undefined
  }
}

jest.mock('../../src/api/discovery', () => ({
  get BluOSDiscovery() {
    return SilentDiscovery
  },
}))

/** A `PlatformAccessory` constructor that behaves like Homebridge's. */
class FakePlatformAccessory extends FakeAccessory {
  constructor(displayName: string, readonly UUID: string) {
    super(displayName, {})
  }
}

interface Fixture {
  platform: BluOSPlatform
  log: ReturnType<typeof fakeLogger>
  registered: PlatformAccessory[]
  unregistered: PlatformAccessory[]
  updated: PlatformAccessory[][]
  launch: () => void
  shutdown: () => void
}

const device = {
  id: '90:56:82:0A:00:02:11000',
  name: 'Zone One',
  host: '192.168.4.11',
  port: 11_000,
  volumeSlider: true,
  mute: true,
}

/** UUIDs are the identity key hashed; here the key is used verbatim. */
function uuidOf(key: string): string {
  return `uuid:${UUID_PREFIX}${key}`
}

function build(config: Partial<PlatformConfig> = {}): Fixture {
  const log = fakeLogger()
  const registered: PlatformAccessory[] = []
  const unregistered: PlatformAccessory[] = []
  const updated: PlatformAccessory[][] = []
  const events = new Map<string, (() => void)[]>()

  const api = {
    hap: {
      ...fakeHap(),
      uuid: { generate: (seed: string) => `uuid:${seed}` },
    },
    platformAccessory: FakePlatformAccessory,
    on: (event: string, listener: () => void) => {
      events.set(event, [...(events.get(event) ?? []), listener])
    },
    registerPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => {
      registered.push(...accessories)
    },
    unregisterPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => {
      unregistered.push(...accessories)
    },
    updatePlatformAccessories: (accessories: PlatformAccessory[]) => {
      updated.push(accessories)
    },
  } as unknown as API

  const platform = new BluOSPlatform(
    log as never,
    { platform: PLATFORM_NAME, ...config } as PlatformConfig,
    api,
  )

  const fire = (event: string): void => {
    for (const listener of events.get(event) ?? []) {
      listener()
    }
  }

  return {
    platform,
    log,
    registered,
    unregistered,
    updated,
    launch: () => fire('didFinishLaunching'),
    shutdown: () => fire('shutdown'),
  }
}

/** A player as discovery would report it. */
function player(id: string, name: string, host: string, port = 11_000): DiscoveredPlayer {
  return { id, name, host, port, fixedVolume: false, hasBattery: false }
}

/** A cached accessory as Homebridge would restore it. */
function cached(uuid: string, displayName: string, context: Partial<AccessoryContext>) {
  const accessory = new FakePlatformAccessory(displayName, uuid)
  accessory.context = context as Record<string, unknown>
  return accessory as unknown as PlatformAccessory
}

describe('BluOSPlatform', () => {
  // Timers are held, never advanced: the pollers are staggered behind a timer,
  // so nothing here ever reaches for the network.
  beforeEach(() => {
    jest.useFakeTimers()
    SilentDiscovery.found = []
    SilentDiscovery.failure = undefined
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('a first run', () => {
    it('creates one accessory per enabled feature', () => {
      const test = build({ devices: [device] })

      test.launch()

      expect(test.registered.map((accessory) => accessory.displayName))
        .toEqual(['Zone One Volume', 'Zone One Mute'])
      expect(test.unregistered).toEqual([])
    })

    it('keys accessories on identity, with no address in the seed', () => {
      const test = build({ devices: [device] })

      test.launch()

      expect(test.registered.map((accessory) => accessory.UUID)).toEqual([
        uuidOf('90:56:82:0A:00:02:11000:volume'),
        uuidOf('90:56:82:0A:00:02:11000:mute'),
      ])
      expect(test.registered.every((accessory) => !accessory.UUID.includes('192.168'))).toBe(true)
    })

    it('gives each accessory its own opaque serial number', () => {
      const test = build({ devices: [device] })

      test.launch()

      const serials = test.registered.map(
        (accessory) => (accessory.context as AccessoryContext).serialNumber,
      )
      expect(new Set(serials).size).toBe(2)
      expect(serials.every((serial) => !/([0-9A-F]{2}:){5}/i.test(serial))).toBe(true)
    })

    it('separates presets by level', () => {
      const test = build({
        devices: [{
          ...device,
          volumeSlider: false,
          mute: false,
          volumePresets: [{ name: 'Quiet', volume: 15 }, { name: 'Loud', volume: 80 }],
        }],
      })

      test.launch()

      expect(test.registered.map((accessory) => accessory.UUID)).toEqual([
        uuidOf('90:56:82:0A:00:02:11000:volumePreset:15'),
        uuidOf('90:56:82:0A:00:02:11000:volumePreset:80'),
      ])
    })

    it('says what it is watching', () => {
      const test = build({ devices: [device] })

      test.launch()

      expect(test.log.calls.some((line) => line.includes('watching 1 zone(s)'))).toBe(true)
    })

    it('does not poll a device with nothing exposed', () => {
      const test = build({
        devices: [{ ...device, volumeSlider: false, mute: false }],
      })

      test.launch()

      expect(test.log.calls.some((line) => line.includes('watching 0 zone(s)'))).toBe(true)
    })
  })

  describe('a restart', () => {
    it('reuses a cached accessory instead of registering a new one', () => {
      const test = build({ devices: [{ ...device, mute: false }] })
      const uuid = uuidOf('90:56:82:0A:00:02:11000:volume')
      test.platform.configureAccessory(cached(uuid, 'Zone One', {
        kind: 'volume',
        deviceId: device.id,
        serialNumber: 'kept',
        sliderService: 'fan',
      }))

      test.launch()

      expect(test.registered).toEqual([])
      expect(test.unregistered).toEqual([])
      expect(test.updated.flat().map((accessory) => accessory.UUID)).toContain(uuid)
    })

    it('keeps the serial number, which HomeKit treats as the hardware identity', () => {
      const test = build({ devices: [{ ...device, mute: false }] })
      const uuid = uuidOf('90:56:82:0A:00:02:11000:volume')
      test.platform.configureAccessory(cached(uuid, 'Zone One', {
        kind: 'volume',
        deviceId: device.id,
        serialNumber: 'kept',
        sliderService: 'fan',
      }))

      test.launch()

      expect((test.updated.flat()[0]?.context as AccessoryContext).serialNumber).toBe('kept')
    })

    it('carries the remembered level across the restart', () => {
      const test = build({ devices: [{ ...device, mute: false }] })
      const uuid = uuidOf('90:56:82:0A:00:02:11000:volume')
      test.platform.configureAccessory(cached(uuid, 'Zone One', {
        kind: 'volume',
        deviceId: device.id,
        serialNumber: 'kept',
        sliderService: 'fan',
        lastNonZeroVolume: 44,
      }))

      test.launch()

      expect((test.updated.flat()[0]?.context as AccessoryContext).lastNonZeroVolume).toBe(44)
    })

    it('adopts an accessory whose UUID scheme changed, rather than replacing it', () => {
      // The safety net: a replacement would drop the accessory out of every
      // scene and automation it belongs to.
      const test = build({ devices: [{ ...device, mute: false }] })
      test.platform.configureAccessory(cached('uuid:legacy-scheme', 'Zone One', {
        kind: 'volume',
        deviceId: device.id,
        serialNumber: 'kept',
        sliderService: 'fan',
      }))

      test.launch()

      expect(test.registered).toEqual([])
      expect(test.unregistered).toEqual([])
      expect(test.log.calls.some((line) => line.includes('adopting cached accessory'))).toBe(true)
      expect((test.updated.flat()[0]?.context as AccessoryContext).adoptedLegacyUuid).toBe(true)
    })

    it('mentions an adoption once, not on every launch afterwards', () => {
      // A HAP UUID is immutable, so adoption is permanent and the identity path is
      // taken forever. The notice describes a migration that has already happened.
      const test = build({ devices: [{ ...device, mute: false }] })
      test.platform.configureAccessory(cached('uuid:legacy-scheme', 'Zone One', {
        kind: 'volume',
        deviceId: device.id,
        serialNumber: 'kept',
        sliderService: 'fan',
        adoptedLegacyUuid: true,
      }))

      test.launch()

      expect(test.log.calls.some((line) => line.includes('adopting cached accessory'))).toBe(false)
      expect(test.unregistered).toEqual([])
    })

    it('does not let one wanted accessory claim another\'s cached entry', () => {
      const test = build({ devices: [device] })
      test.platform.configureAccessory(cached('uuid:legacy-volume', 'Zone One', {
        kind: 'volume',
        deviceId: device.id,
        serialNumber: 'volume-serial',
        sliderService: 'fan',
      }))
      test.platform.configureAccessory(cached('uuid:legacy-mute', 'Zone One Mute', {
        kind: 'mute',
        deviceId: device.id,
        serialNumber: 'mute-serial',
        sliderService: 'fan',
      }))

      test.launch()

      const serials = test.updated.flat().map(
        (accessory) => (accessory.context as AccessoryContext).serialNumber,
      )
      expect(serials.sort()).toEqual(['mute-serial', 'volume-serial'])
      expect(test.unregistered).toEqual([])
    })

    it('renames an accessory the user renamed in configuration', () => {
      const test = build({ devices: [{ ...device, name: 'Study', mute: false }] })
      test.platform.configureAccessory(cached(
        uuidOf('90:56:82:0A:00:02:11000:volume'),
        'Zone One',
        { kind: 'volume', deviceId: device.id, serialNumber: 'kept', sliderService: 'fan' },
      ))

      test.launch()

      expect(test.log.calls.some((line) => line.includes('is now named Study Volume'))).toBe(true)
      expect(test.updated.flat()[0]?.displayName).toBe('Study Volume')
    })

    it('removes an accessory the configuration no longer asks for', () => {
      const test = build({ devices: [{ ...device, mute: false }] })
      test.platform.configureAccessory(cached(
        uuidOf('90:56:82:0A:00:02:11000:mute'),
        'Zone One Mute',
        { kind: 'mute', deviceId: device.id, serialNumber: 'gone', sliderService: 'fan' },
      ))

      test.launch()

      expect(test.unregistered.map((accessory) => accessory.displayName)).toEqual(['Zone One Mute'])
    })

    it('skips a cached accessory whose context cannot be read, without deleting it', () => {
      const test = build({ devices: [{ ...device, mute: false }] })
      test.platform.configureAccessory(cached(
        uuidOf('90:56:82:0A:00:02:11000:volume'),
        'Zone One',
        { kind: 'volume', deviceId: device.id, sliderService: 'fan' },
      ))

      test.launch()

      // No serial number in the cache: a fresh one is generated rather than the
      // accessory being discarded.
      expect(test.unregistered).toEqual([])
      expect((test.updated.flat()[0]?.context as AccessoryContext).serialNumber)
        .toEqual(expect.any(String))
    })
  })

  describe('a configuration it cannot use', () => {
    it('disables itself and keeps every cached accessory', () => {
      const test = build({ devices: 'everything' as never })
      test.platform.configureAccessory(cached('uuid:kept', 'Zone One', {
        kind: 'volume',
        deviceId: device.id,
        serialNumber: 'kept',
        sliderService: 'fan',
      }))

      test.launch()

      expect(test.platform.isDisabled).toBe(true)
      expect(test.unregistered).toEqual([])
      expect(test.registered).toEqual([])
    })

    it('shows the kept accessories as No Response rather than as stale values', () => {
      const test = build({ devices: 'everything' as never })
      const accessory = cached('uuid:kept', 'Zone One', {
        kind: 'volume',
        deviceId: device.id,
        serialNumber: 'kept',
        sliderService: 'fan',
      })
      test.platform.configureAccessory(accessory)

      test.launch()

      const fan = (accessory as unknown as FakeAccessory).getService('Fanv2')
      expect(fan?.lastValue('RotationSpeed')).toBeInstanceOf(Error)
    })

    it('shows an accessory it cannot drive as No Response, and says what to do', () => {
      const test = build({ devices: 'everything' as never })
      const accessory = cached('uuid:unreadable', 'Zone One', {
        deviceId: device.id,
        serialNumber: 'kept',
        sliderService: 'fan',
      })
      // No kind, so no handler can be built. The accessory is deliberately kept —
      // deleting it would take its rooms and automations with it — but a tile with
      // nothing driving it must not keep reporting whatever HomeKit last cached.
      const restoredService = (accessory as unknown as FakeAccessory)
        .addService(new FakeService('Fanv2'))
      restoredService.getCharacteristic('Active')
      restoredService.getCharacteristic('RotationSpeed')
      test.platform.configureAccessory(accessory)

      test.launch()

      const fan = (accessory as unknown as FakeAccessory).getService('Fanv2')
      expect(fan?.lastValue('Active')).toBeInstanceOf(Error)
      expect(test.unregistered).toEqual([])
      expect(test.log.calls.some((line) => line.startsWith('warn')
        && line.includes('cannot be driven')
        && line.includes('Remove it in the Homebridge UI'))).toBe(true)
    })

    it('explains that nothing was lost', () => {
      const test = build({ devices: 'everything' as never })

      test.launch()

      expect(test.log.calls.some((line) => line.startsWith('error')
        && line.includes('rooms and automations are not lost'))).toBe(true)
    })

    it('reports a missing devices list as an error, not a crash', () => {
      const test = build({})

      test.launch()

      expect(test.platform.isDisabled).toBe(true)
      expect(test.log.calls.some((line) => line.startsWith('error')
        && line.includes('no "devices" list'))).toBe(true)
    })

    it('starts Homebridge verification CI scenarios without throwing', () => {
      // The checker constructs the platform for `{ platform: "BluOS" }`, for
      // the schema's required fields only, and for a fully generated config.
      // Homebridge must stay up in every case; the plugin may disable itself.
      const platformOnly = build({})
      platformOnly.launch()
      expect(platformOnly.platform.isDisabled).toBe(true)

      const minimalRequired = build({ name: 'BluOS' })
      minimalRequired.launch()
      expect(minimalRequired.platform.isDisabled).toBe(true)

      const full = build({
        name: 'BluOS',
        options: { sliderService: 'fan', discoveryTimeoutSec: 5 },
        devices: [{
          id: 'test-value',
          name: 'test-value',
            host: '192.168.4.11',
          port: 11_000,
          volumeSlider: true,
          sliderService: '',
          mute: false,
          battery: false,
          volumePresets: [{ name: 'test-value', volume: 0 }],
        }],
      })
      full.launch()
      expect(full.platform.isDisabled).toBe(false)
      expect(full.registered.length).toBeGreaterThan(0)
    })

    it('stays enabled when one device out of two is unusable', () => {
      const test = build({ devices: [device, { name: 'Broken' }] })

      test.launch()

      expect(test.platform.isDisabled).toBe(false)
      expect(test.registered).toHaveLength(2)
      expect(test.log.calls.some((line) => line.startsWith('warn'))).toBe(true)
    })
  })

  describe('the accessory host contract', () => {
    it('has no endpoint or observation for an unknown device', () => {
      const test = build({ devices: [device] })

      test.launch()

      expect(test.platform.endpointFor('nope')).toBeUndefined()
      expect(test.platform.observationFor('nope')).toBeUndefined()
    })

    it('offers the configured endpoint for a known device', () => {
      const test = build({ devices: [device] })

      test.launch()

      expect(test.platform.endpointFor(device.id)).toEqual({
        host: '192.168.4.11',
        port: 11_000,
      })
    })

    it('ignores a write result for an unknown device', () => {
      const test = build({ devices: [device] })
      test.launch()

      expect(() => {
        test.platform.adoptWriteResult('nope', { fixedVolume: false, muted: false })
      }).not.toThrow()
    })

    it('persists nothing when there is nothing active', () => {
      const test = build({ devices: [] })
      test.launch()

      test.platform.persistContext()

      expect(test.updated).toEqual([])
    })

    it('reports the plugin version to HomeKit', () => {
      const test = build({ devices: [device] })

      expect(test.platform.pluginVersion).toMatch(/^\d+\.\d+\.\d+/)
    })
  })

  describe('the global reboot switch', () => {
    const withGlobal = { devices: [device], options: { rebootAll: true } }

    it('registers with an identity that belongs to no player', () => {
      const test = build(withGlobal)

      test.launch()

      expect(test.registered.map((accessory) => accessory.displayName))
        .toEqual(['Zone One Volume', 'Zone One Mute', 'BluOS Reboot All'])
      expect(test.registered[2]?.UUID).toBe(uuidOf(`${PLATFORM_DEVICE_ID}:rebootAll`))
    })

    it('registers even when no player is configured', () => {
      // The case it is most needed in: a network that filters multicast leaves
      // discovery empty, and a switch that never appeared could not help.
      const test = build({ devices: [], options: { rebootAll: true } })

      test.launch()

      expect(test.registered.map((accessory) => accessory.displayName))
        .toEqual(['BluOS Reboot All'])
    })

    it('takes its name from the platform alias', () => {
      const test = build({ ...withGlobal, name: 'Upstairs BluOS' })

      test.launch()

      expect(test.registered.map((accessory) => accessory.displayName))
        .toContain('Upstairs BluOS Reboot All')
    })

    it('unions configured players with whatever the sweep finds', async () => {
      SilentDiscovery.found = [player('90:56:82:0A:00:03:11000', 'Kitchen', '192.168.4.12')]
      const test = build(withGlobal)
      test.launch()

      const targets = await test.platform.rebootTargets()

      expect(targets).toEqual([
        { host: '192.168.4.11', names: ['Zone One'] },
        { host: '192.168.4.12', names: ['Kitchen'] },
      ])
    })

    it('sends one reboot when a player is both configured and discovered', async () => {
      SilentDiscovery.found = [player(device.id, 'Zone One (BluOS app name)', device.host)]
      const test = build(withGlobal)
      test.launch()

      const targets = await test.platform.rebootTargets()

      // One target, under the name the user chose rather than the app's.
      expect(targets).toEqual([{ host: '192.168.4.11', names: ['Zone One'] }])
    })

    it('collapses both zones of one chassis into a single target', async () => {
      // Reboot is served on port 80, one server per box, so a second request
      // would only land on a chassis already going down.
      SilentDiscovery.found = [
        player('90:56:82:0A:00:02:11010', 'Zone Two', '192.168.4.11', 11_010),
      ]
      const test = build(withGlobal)
      test.launch()

      const targets = await test.platform.rebootTargets()

      expect(targets).toEqual([{ host: '192.168.4.11', names: ['Zone One', 'Zone Two'] }])
    })

    it('names the rooms that share a chassis with a given player', async () => {
      const test = build({
        devices: [device, { ...device, id: 'zone-two', name: 'Zone Two', port: 11_010 }],
        options: { rebootAll: true },
      })
      test.launch()

      expect(test.platform.playersSharingAddress(device.id)).toEqual(['Zone Two'])
      expect(test.platform.playersSharingAddress('zone-two')).toEqual(['Zone One'])
    })

    it('names nobody for a player alone on its address', () => {
      const test = build(withGlobal)
      test.launch()

      expect(test.platform.playersSharingAddress(device.id)).toEqual([])
      expect(test.platform.playersSharingAddress('not-configured')).toEqual([])
    })

    it('falls back to the configured players when the sweep fails', async () => {
      SilentDiscovery.failure = new Error('no multicast route')
      const test = build(withGlobal)
      test.launch()

      const targets = await test.platform.rebootTargets()

      expect(targets).toHaveLength(1)
      expect(test.log.calls.some((line) => line.startsWith('warn')
        && line.includes('could not sweep the network'))).toBe(true)
    })
  })

  it('stops polling on shutdown', () => {
    const test = build({ devices: [device] })
    test.launch()

    expect(() => test.shutdown()).not.toThrow()
  })

  it('registers under the names Homebridge expects', () => {
    // A mismatch here means Homebridge silently loads nothing.
    expect(PLUGIN_NAME).toBe('homebridge-bluos')
    expect(PLATFORM_NAME).toBe('BluOS')
  })
})
