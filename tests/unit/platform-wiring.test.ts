/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The wiring between the pollers and the accessories, with the poller replaced
 * by a stand-in so the callbacks can be fired on demand. Kept apart from
 * `platform.test.ts` because the substitution has to be made before the module
 * under test is loaded, and the other file wants the real poller's absence of
 * side effects rather than a substitute.
 */

import type { API, PlatformAccessory, PlatformConfig } from 'homebridge'

import type { Endpoint } from '../../src/api/client'
import type { VolumeResult } from '../../src/api/sync-status'
import type { AccessoryContext, PlayerObservation, RefreshReason } from '../../src/types'
import { fakeHap, FakeAccessory, type FakeService, fakeLogger, observation } from '../helpers/hap'

interface PollerOptions {
  deviceId: string
  displayName: string
  endpoint: Endpoint
  onObservation: (observation: PlayerObservation, reason: RefreshReason) => void
  onUnreachable: (error: unknown) => void
  resolveEndpoint: (deviceId: string) => Promise<Endpoint | undefined>
  onEndpointChanged: (endpoint: Endpoint) => void
}

/** Every stand-in poller built during a test, in construction order. */
const built: FakePoller[] = []

class FakePoller {
  started = 0

  stopped = 0

  adopted: VolumeResult[] = []

  endpoint: Endpoint

  lastObservation: PlayerObservation | undefined

  constructor(readonly options: PollerOptions) {
    this.endpoint = options.endpoint
    built.push(this)
  }

  start(): void {
    this.started += 1
  }

  async stop(): Promise<void> {
    this.stopped += 1
  }

  setEndpoint(endpoint: Endpoint): void {
    this.endpoint = endpoint
    this.options.onEndpointChanged(endpoint)
  }

  adoptWriteResult(result: VolumeResult): void {
    this.adopted.push(result)
  }

}

const discovered: { players: unknown[]; failure?: Error } = { players: [] }

// Getters, and no `jest.fn`: the suite resets mocks between tests, which would
// strip an implementation given to a module factory here, leaving a constructor
// that silently produces empty objects.
jest.mock('../../src/poller', () => ({
  get DevicePoller() {
    return FakePoller
  },
}))

class FakeDiscovery {
  static cancelled = 0

  async discover(): Promise<unknown[]> {
    if (discovered.failure !== undefined) {
      throw discovered.failure
    }
    return discovered.players
  }

  async resolveEndpoint(): Promise<Endpoint | undefined> {
    return undefined
  }

  cancelAll(): void {
    FakeDiscovery.cancelled += 1
  }
}

jest.mock('../../src/api/discovery', () => ({
  get BluOSDiscovery() {
    return FakeDiscovery
  },
}))

// Imported after the substitutions above, which jest hoists above this line.
import { BluOSPlatform } from '../../src/platform'
import { PLATFORM_NAME } from '../../src/settings'

class FakePlatformAccessory extends FakeAccessory {
  constructor(displayName: string, readonly UUID: string) {
    super(displayName, {})
  }
}

const device = {
  id: '90:56:82:0A:00:02:11000',
  name: 'Zone One',
  host: '192.168.4.11',
  port: 11_000,
  volumeSlider: true,
  mute: true,
}

function build(config: Partial<PlatformConfig> = { devices: [device] }) {
  const log = fakeLogger()
  const updated: PlatformAccessory[][] = []
  const events = new Map<string, (() => void)[]>()

  const api = {
    hap: { ...fakeHap(), uuid: { generate: (seed: string) => `uuid:${seed}` } },
    platformAccessory: FakePlatformAccessory,
    on: (event: string, listener: () => void) => {
      events.set(event, [...(events.get(event) ?? []), listener])
    },
    registerPlatformAccessories: () => undefined,
    unregisterPlatformAccessories: () => undefined,
    updatePlatformAccessories: (accessories: PlatformAccessory[]) => {
      updated.push(accessories)
    },
  } as unknown as API

  const platform = new BluOSPlatform(
    log as never,
    { platform: PLATFORM_NAME, ...config } as PlatformConfig,
    api,
  )

  return {
    platform,
    log,
    updated,
    launch: () => {
      for (const listener of events.get('didFinishLaunching') ?? []) {
        listener()
      }
    },
    shutdown: () => {
      for (const listener of events.get('shutdown') ?? []) {
        listener()
      }
    },
  }
}

describe('BluOSPlatform poller wiring', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    built.length = 0
    discovered.players = []
    delete discovered.failure
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('builds one poller per device and starts them staggered', () => {
    const second = { ...device, id: '90:56:82:0A:00:02:11010', port: 11_010, name: 'Zone Two' }
    const test = build({ devices: [device, second] })

    test.launch()

    expect(built.map((poller) => poller.options.deviceId)).toEqual([device.id, second.id])
    expect(built.map((poller) => poller.started)).toEqual([0, 0])

    jest.advanceTimersByTime(0)
    expect(built[0]?.started).toBe(1)
    expect(built[1]?.started).toBe(0)

    jest.advanceTimersByTime(200)
    expect(built[1]?.started).toBe(1)
  })

  it('does not start a poller when shutdown arrives first', () => {
    const test = build()
    test.launch()

    test.shutdown()
    jest.advanceTimersByTime(500)

    expect(built[0]?.started).toBe(0)
  })

  it('stops every poller on shutdown', async () => {
    const test = build()
    test.launch()
    jest.advanceTimersByTime(500)

    test.shutdown()
    await Promise.resolve()

    expect(built[0]?.stopped).toBe(1)
  })

  it('hands observations to the accessories of that device only', () => {
    const other = { ...device, id: '90:56:82:0A:00:02:11010', port: 11_010, name: 'Zone Two' }
    const test = build({ devices: [device, other] })
    test.launch()

    built[0]?.options.onObservation(observation({ volume: 25 }), 'poll')

    expect(test.platform.observationFor(device.id)).toBeUndefined()
    // The stand-in does not record observations itself; what matters is that the
    // slider for the first zone moved and the second zone's did not.
    const [first, second] = sliders(test)
    expect(first?.lastValue('RotationSpeed')).toBe(25)
    expect(second?.lastValue('RotationSpeed')).toBeUndefined()
  })

  it('survives an accessory that throws while applying an observation', () => {
    const test = build()
    test.launch()
    const service = sliders(test)[0]
    const characteristic = service?.getCharacteristic('RotationSpeed')
    if (characteristic !== undefined) {
      Object.defineProperty(characteristic, 'updates', {
        get() {
          throw new Error('HAP is unhappy')
        },
      })
    }

    expect(() => built[0]?.options.onObservation(observation(), 'poll')).not.toThrow()
    expect(test.log.calls.some((line) => line.includes('could not apply an observation'))).toBe(true)
  })

  it('marks the accessories of an unreachable device as No Response', () => {
    const test = build()
    test.launch()

    built[0]?.options.onUnreachable(new Error('host is down'))

    expect(sliders(test)[0]?.lastValue('RotationSpeed')).toBeInstanceOf(Error)
  })

  it('survives an accessory that throws while being marked unreachable', () => {
    const test = build()
    test.launch()
    const service = sliders(test)[0]
    const characteristic = service?.getCharacteristic('RotationSpeed')
    if (characteristic !== undefined) {
      Object.defineProperty(characteristic, 'updates', {
        get() {
          throw new Error('HAP is unhappy')
        },
      })
    }

    // This runs inside the poll loop's catch block: an escaping throw here would
    // become an unhandled rejection and take the Homebridge process with it.
    expect(() => built[0]?.options.onUnreachable(new Error('host is down'))).not.toThrow()
    expect(test.log.calls.some((line) => line.includes('could not be marked unavailable')))
      .toBe(true)
  })

  it('cancels discovery before waiting for the pollers to stop', async () => {
    const test = build()
    test.launch()
    jest.advanceTimersByTime(500)
    const before = FakeDiscovery.cancelled

    test.shutdown()
    await Promise.resolve()

    // A poller inside an address lookup is waiting on a browse window nothing else
    // can end, so without this the process cannot exit until the window elapses.
    expect(FakeDiscovery.cancelled).toBe(before + 1)
  })

  it('does not start a poller whose stagger timer was cleared at shutdown', () => {
    const second = { ...device, id: '90:56:82:0A:00:02:11010', port: 11_010, name: 'Zone Two' }
    const test = build({ devices: [device, second] })
    test.launch()

    jest.advanceTimersByTime(0)
    test.shutdown()
    jest.advanceTimersByTime(1_000)

    expect(built[0]?.started).toBe(1)
    expect(built[1]?.started).toBe(0)
  })

  it('reads the poller for the endpoint, observation and writes', () => {
    const test = build()
    test.launch()
    const poller = built[0]
    if (poller === undefined) {
      throw new Error('no poller was built')
    }
    poller.lastObservation = observation({ volume: 12 })

    expect(test.platform.endpointFor(device.id)).toEqual({ host: device.host, port: device.port })
    expect(test.platform.observationFor(device.id)?.volume).toBe(12)

    test.platform.adoptWriteResult(device.id, { level: 30, fixedVolume: false, muted: false })

    expect(poller.adopted).toEqual([{ level: 30, fixedVolume: false, muted: false }])
  })

  it('corrects an address found at launch', async () => {
    discovered.players = [{ id: device.id, host: '192.168.4.99', port: 11_000 }]
    const test = build()

    test.launch()
    await jest.advanceTimersByTimeAsync(0)

    expect(built[0]?.endpoint).toEqual({ host: '192.168.4.99', port: 11_000 })
  })

  it('remembers a corrected address in context so it survives a restart', async () => {
    discovered.players = [{ id: device.id, host: '192.168.4.99', port: 11_000 }]
    const test = build()

    test.launch()
    await jest.advanceTimersByTimeAsync(0)

    const contexts = test.updated.flat().map((accessory) => accessory.context as AccessoryContext)
    expect(contexts.every((context) => context.host === '192.168.4.99')).toBe(true)
  })

  it('does not rewrite context when the address has not moved', async () => {
    discovered.players = [{ id: device.id, host: device.host, port: device.port }]
    const test = build()

    test.launch()
    const before = test.updated.length
    await jest.advanceTimersByTimeAsync(0)

    expect(test.updated.length).toBe(before)
  })

  it('ignores an address for a device it does not have', async () => {
    discovered.players = [{ id: 'someone:else:11000', host: '192.168.4.99', port: 11_000 }]
    const test = build()

    test.launch()
    await jest.advanceTimersByTimeAsync(0)

    expect(built[0]?.endpoint).toEqual({ host: device.host, port: device.port })
  })

  it('keeps polling when launch discovery fails', async () => {
    discovered.failure = new Error('no multicast route')
    const test = build()

    test.launch()
    await jest.advanceTimersByTimeAsync(0)
    jest.advanceTimersByTime(500)

    expect(built[0]?.started).toBe(1)
    expect(test.log.calls.some((line) => line.includes('launch discovery failed'))).toBe(true)
  })

  it('does not run launch discovery when there is nothing to poll', async () => {
    discovered.players = [{ id: device.id, host: '192.168.4.99', port: 11_000 }]
    const test = build({ devices: [{ ...device, volumeSlider: false, mute: false }] })

    test.launch()
    await jest.advanceTimersByTimeAsync(0)

    expect(built).toEqual([])
  })

  it('applies a resolved endpoint asked for by a poller', async () => {
    const test = build()
    test.launch()

    await expect(built[0]?.options.resolveEndpoint(device.id)).resolves.toBeUndefined()
    expect(test.platform.isDisabled).toBe(false)
  })

  it('reports a failure to start rather than letting it escape', () => {
    const test = build({ devices: [device] })
    // A context that cannot be built is the one failure the start path can hit
    // after validation has passed.
    jest.spyOn(test.platform as never, 'syncAccessories' as never).mockImplementation(() => {
      throw new Error('registration exploded')
    })

    expect(() => test.launch()).not.toThrow()
    expect(test.log.calls.some((line) => line.startsWith('error')
      && line.includes('BluOS failed to start'))).toBe(true)
  })
})

/** The volume sliders of the live accessories, in registration order. */
function sliders(test: { platform: BluOSPlatform }): FakeService[] {
  const platform = test.platform as unknown as { active: Map<string, FakeAccessory> }
  return [...platform.active.values()]
    .map((accessory) => accessory.getService('Fanv2'))
    .filter((service): service is FakeService => service !== undefined)
}
