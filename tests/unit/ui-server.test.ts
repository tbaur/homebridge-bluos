/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The configuration UI backend. It runs in its own process, so nothing else
 * catches its mistakes: an unvalidated host here would make the settings page a
 * way to have the Homebridge machine issue requests of someone else's choosing,
 * and a wrong default would write ids into configuration that the platform can
 * never match to a player.
 *
 * `homebridge-ui/server.js` is plain JavaScript loaded by Homebridge as a child
 * process, and it constructs itself on require, so each test loads a fresh copy.
 */

import {
  DEFAULT_DISCOVERY_TIMEOUT_SEC,
  DOCUMENTED_BLUOS_PORTS,
  MAX_DISCOVERY_TIMEOUT_SEC,
  MIN_DISCOVERY_TIMEOUT_SEC,
} from '../../src/settings'
import { isProbeableHost, isValidHost } from '../../src/utils/validators'

interface UiRequestHandler {
  (payload: unknown): Promise<unknown>
}

/** Stands in for the base class the real server extends. */
class FakeUiServer {
  static latest: FakeUiServer | undefined

  readonly handlers = new Map<string, UiRequestHandler>()

  readied = 0

  constructor() {
    FakeUiServer.latest = this
  }

  onRequest(path: string, handler: UiRequestHandler): void {
    this.handlers.set(path, handler)
  }

  ready(): void {
    this.readied += 1
  }
}

class FakeRequestError extends Error {
  constructor(message: string, readonly context?: Record<string, unknown>) {
    super(message)
    this.name = 'RequestError'
  }
}

jest.mock('@homebridge/plugin-ui-utils', () => ({
  get HomebridgePluginUiServer() {
    return FakeUiServer
  },
  get RequestError() {
    return FakeRequestError
  },
}))

/** What the fake discovery should do, set per test. */
const behaviour: {
  players: unknown[]
  probed: { host: string; port: number }[]
  probeAnswers: Map<number, unknown>
  discoverTimeouts: number[]
  failure?: Error
} = {
  players: [],
  probed: [],
  probeAnswers: new Map(),
  discoverTimeouts: [],
}

class FakeDiscovery {
  async discover(timeoutSec: number): Promise<unknown[]> {
    behaviour.discoverTimeouts.push(timeoutSec)
    if (behaviour.failure !== undefined) {
      throw behaviour.failure
    }
    return behaviour.players
  }

  async probe(endpoint: { host: string; port: number }): Promise<unknown> {
    behaviour.probed.push(endpoint)
    return behaviour.probeAnswers.get(endpoint.port)
  }
}

// The real validators and port list are used, so this test fails if the UI and
// the platform ever start disagreeing about what a valid host is.
jest.mock(
  '../../dist/ui-api',
  () => ({
    BluOSClient: class {},
    get BluOSDiscovery() {
      return FakeDiscovery
    },
    isValidHost,
    isProbeableHost,
    DOCUMENTED_BLUOS_PORTS,
    DEFAULT_DISCOVERY_TIMEOUT_SEC,
    MIN_DISCOVERY_TIMEOUT_SEC,
    MAX_DISCOVERY_TIMEOUT_SEC,
    makeGeneratedPlayerId: () => 'bluos-generated-abc',
  }),
  { virtual: true },
)

const SERVER = '../../homebridge-ui/server.js'

function load(): FakeUiServer {
  jest.resetModules()
  FakeUiServer.latest = undefined
  require(SERVER)
  const server = FakeUiServer.latest
  if (server === undefined) {
    throw new Error('the UI server did not construct itself on load')
  }
  return server
}

function handler(server: FakeUiServer, path: string): UiRequestHandler {
  const found = server.handlers.get(path)
  if (found === undefined) {
    throw new Error(`no handler is registered for ${path}`)
  }
  return found
}

const player = {
  id: '90:56:82:0A:00:02:11000',
  name: 'Zone One',
  host: '192.168.4.11',
  port: 11_000,
  brand: 'NAD',
  model: 'CI-S2',
  modelName: 'CI S2',
  firmware: '4.16.6',
  mac: '90:56:82:0A:00:02',
  fixedVolume: false,
  hasBattery: false,
}

describe('the configuration UI backend', () => {
  beforeEach(() => {
    behaviour.players = []
    behaviour.probed = []
    behaviour.probeAnswers = new Map()
    behaviour.discoverTimeouts = []
    delete behaviour.failure
  })

  it('registers its endpoints and only then reports itself ready', () => {
    const server = load()

    expect([...server.handlers.keys()]).toEqual(['/discover', '/probe'])
    expect(server.readied).toBe(1)
  })

  describe('/discover', () => {
    it('returns each answering zone with the log of the attempt', async () => {
      behaviour.players = [player]
      const server = load()

      const result = await handler(server, '/discover')({ timeoutSec: 5 }) as {
        players: { id: string; name: string }[]
        log: string[]
      }

      expect(result.players).toHaveLength(1)
      expect(result.players[0]?.id).toBe(player.id)
      expect(result.log).toEqual([])
    })

    it('clamps an absurd timeout instead of honouring it', async () => {
      const server = load()

      await handler(server, '/discover')({ timeoutSec: 9_000 })
      await handler(server, '/discover')({ timeoutSec: -4 })
      await handler(server, '/discover')({ timeoutSec: 'soon' })
      await handler(server, '/discover')(undefined)

      expect(behaviour.discoverTimeouts).toEqual([
        MAX_DISCOVERY_TIMEOUT_SEC,
        MIN_DISCOVERY_TIMEOUT_SEC,
        DEFAULT_DISCOVERY_TIMEOUT_SEC,
        DEFAULT_DISCOVERY_TIMEOUT_SEC,
      ])
    })

    it('rounds a fractional timeout', async () => {
      const server = load()

      await handler(server, '/discover')({ timeoutSec: 7.6 })

      expect(behaviour.discoverTimeouts).toEqual([8])
    })

    it('reports a failure as a request error carrying the reason', async () => {
      behaviour.failure = new Error('no multicast route')
      const server = load()

      await expect(handler(server, '/discover')({})).rejects.toMatchObject({
        name: 'RequestError',
        message: 'Discovery failed.',
        context: { message: 'no multicast route' },
      })
    })

    it('never suggests a volume slider, which is opt-in', async () => {
      behaviour.players = [player, { ...player, id: 'fixed:11000', fixedVolume: true }]
      const server = load()

      const result = await handler(server, '/discover')({}) as {
        players: { fixedVolume: boolean; suggested: { volumeSlider: boolean } }[]
      }

      expect(result.players.map((entry) => entry.suggested.volumeSlider)).toEqual([false, false])
      expect(result.players.map((entry) => entry.fixedVolume)).toEqual([false, true])
    })

    it('suggests a battery accessory only for a player that has one', async () => {
      behaviour.players = [player, { ...player, id: 'portable:11000', hasBattery: true }]
      const server = load()

      const result = await handler(server, '/discover')({}) as {
        players: { suggested: { battery: boolean } }[]
      }

      expect(result.players.map((entry) => entry.suggested.battery)).toEqual([false, true])
    })

    it('never suggests a mute switch, which is opt-in', async () => {
      behaviour.players = [player]
      const server = load()

      const result = await handler(server, '/discover')({}) as {
        players: { suggested: { mute: boolean } }[]
      }

      expect(result.players[0]?.suggested.mute).toBe(false)
    })

    it('mints a stable id for a player with no usable MAC, and says so', async () => {
      behaviour.players = [{ ...player, id: '', mac: '' }]
      const server = load()

      const result = await handler(server, '/discover')({}) as {
        players: { id: string; derivedIdentity: boolean }[]
      }

      expect(result.players[0]?.id).toBe('bluos-generated-abc')
      expect(result.players[0]?.derivedIdentity).toBe(true)
    })

    it('fills in a name for the brand and model when the player gives none', async () => {
      behaviour.players = [{ ...player, brand: '', model: '', modelName: '', firmware: '' }]
      const server = load()

      const result = await handler(server, '/discover')({}) as {
        players: { brand: string; model: string; firmware: string }[]
      }

      expect(result.players[0]).toMatchObject({
        brand: 'BluOS',
        model: 'BluOS Player',
        firmware: '',
      })
    })

    it('prefers the friendly model name over the model code', async () => {
      behaviour.players = [player]
      const server = load()

      const result = await handler(server, '/discover')({}) as { players: { model: string }[] }

      expect(result.players[0]?.model).toBe('CI S2')
    })
  })

  describe('/probe', () => {
    it('refuses a host that is not an address or a hostname', async () => {
      const server = load()

      for (const host of ['', '   ', 'not a host', '192.168.4.11; rm -rf /', 'http://x/y', 999]) {
        await expect(handler(server, '/probe')({ host })).rejects.toMatchObject({
          name: 'RequestError',
          message: 'Enter a valid IP address or hostname.',
        })
      }
      expect(behaviour.probed).toEqual([])
    })

    it('trims a host the user pasted with whitespace', async () => {
      behaviour.probeAnswers.set(11_000, player)
      const server = load()

      await handler(server, '/probe')({ host: '  192.168.4.11  ', port: 11_000 })

      expect(behaviour.probed).toEqual([{ host: '192.168.4.11', port: 11_000 }])
    })

    it('tries every documented port when none is given, and nothing else', async () => {
      behaviour.probeAnswers.set(11_000, player)
      const server = load()

      await handler(server, '/probe')({ host: '192.168.4.11' })

      expect(behaviour.probed.map((endpoint) => endpoint.port)).toEqual([...DOCUMENTED_BLUOS_PORTS])
    })

    it('tries only the port the user asked for', async () => {
      behaviour.probeAnswers.set(11_020, player)
      const server = load()

      await handler(server, '/probe')({ host: '192.168.4.11', port: 11_020 })

      expect(behaviour.probed).toEqual([{ host: '192.168.4.11', port: 11_020 }])
    })

    it('refuses a port BluOS does not use, rather than probing it', async () => {
      // Otherwise this endpoint is a port scanner that runs from the Homebridge
      // host's position on the network.
      const server = load()

      for (const port of [22, 70_000, 0, 8_080]) {
        await expect(handler(server, '/probe')({ host: '192.168.4.11', port }))
          .rejects.toMatchObject({
            name: 'RequestError',
            message: expect.stringContaining('is not a BluOS control port'),
          })
      }
      expect(behaviour.probed).toEqual([])
    })

    it('refuses an address or name outside the local network', async () => {
      const server = load()

      for (const host of ['8.8.8.8', '203.0.113.7', 'example.com', 'player.example.org']) {
        await expect(handler(server, '/probe')({ host })).rejects.toMatchObject({
          name: 'RequestError',
          message: expect.stringContaining('outside your local network'),
        })
      }
      expect(behaviour.probed).toEqual([])
    })

    it('accepts a CGNAT / Tailscale address', async () => {
      behaviour.probeAnswers.set(11_000, player)
      const server = load()

      await handler(server, '/probe')({ host: '100.64.1.10', port: 11_000 })

      expect(behaviour.probed).toEqual([{ host: '100.64.1.10', port: 11_000 }])
    })

    it('returns every zone that answered on the chassis', async () => {
      behaviour.probeAnswers.set(11_000, player)
      behaviour.probeAnswers.set(11_010, { ...player, id: 'zone:11010', port: 11_010 })
      const server = load()

      const result = await handler(server, '/probe')({ host: '192.168.4.11' }) as {
        players: { port: number }[]
      }

      expect(result.players.map((entry) => entry.port)).toEqual([11_000, 11_010])
    })

    it('says what it tried when nothing answered', async () => {
      const server = load()

      await expect(handler(server, '/probe')({ host: '192.168.4.11', port: 11_000 }))
        .rejects.toMatchObject({
          name: 'RequestError',
          message: 'Nothing answered at 192.168.4.11 on port 11000.',
        })
    })

    it('accepts a hostname as well as an address', async () => {
      behaviour.probeAnswers.set(11_000, player)
      const server = load()

      await handler(server, '/probe')({ host: 'bluesound.local', port: 11_000 })

      expect(behaviour.probed).toEqual([{ host: 'bluesound.local', port: 11_000 }])
    })
  })

  describe('when the plugin has not been built', () => {
    it('says so, rather than failing to open the settings page', async () => {
      jest.resetModules()
      jest.doMock('../../dist/ui-api', () => {
        throw new Error("Cannot find module '../dist/ui-api'")
      }, { virtual: true })
      FakeUiServer.latest = undefined
      require(SERVER)
      const server = FakeUiServer.latest
      if (server === undefined) {
        throw new Error('the UI server did not construct itself on load')
      }

      await expect(handler(server, '/discover')({})).rejects.toMatchObject({
        name: 'RequestError',
        message: 'The plugin is not built. Run "npm run build" in the plugin directory.',
      })

      jest.dontMock('../../dist/ui-api')
    })
  })
})
