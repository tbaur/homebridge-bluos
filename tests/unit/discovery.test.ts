/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Discovery is driven through an injected mDNS session, so the correlation of
 * PTR, SRV, TXT and A records is tested without a socket. The records used are
 * shaped like the ones a real fleet answered with, including a multi-zone
 * chassis advertising a second zone on `_musp._tcp` with its own SRV port.
 */

import type { Answer } from 'dns-packet'

import { BluOSDiscovery, type MdnsPacket, type MdnsSession } from '../../src/api/discovery'
import type { BluOSClient, Endpoint } from '../../src/api/client'
import { parseSyncStatus } from '../../src/api/sync-status'
import type { PlayerObservation } from '../../src/types'
import { fakeLogger } from '../helpers/hap'
import {
  SYNC_STATUS_BATTERY,
  SYNC_STATUS_CI_S2_ZONE_ONE,
  SYNC_STATUS_CI_S2_ZONE_TWO,
  SYNC_STATUS_FIXED_VOLUME,
} from '../fixtures/responses'

type Listener = (packet: MdnsPacket, remote: { address: string }) => void

/** An mDNS session that replays a scripted packet as soon as it is queried. */
class FakeMdns implements MdnsSession {
  readonly queries: string[] = []

  destroyed = 0

  private queryFailure: Error | undefined

  private destroyFailure: Error | undefined

  private responses: Listener | undefined

  private errors: ((error: Error) => void) | undefined

  private warnings: ((error: Error) => void) | undefined

  constructor(
    private readonly packets: { packet: MdnsPacket; remote: { address: string } }[],
  ) {}

  on(event: 'response' | 'error' | 'warning', listener: never): void {
    if (event === 'response') {
      this.responses = listener as unknown as Listener
    } else if (event === 'error') {
      this.errors = listener as unknown as (error: Error) => void
    } else {
      this.warnings = listener as unknown as (error: Error) => void
    }
  }

  query(request: { questions: { name: string; type: string }[] }): void {
    for (const question of request.questions) {
      this.queries.push(`${question.type} ${question.name}`)
    }
    if (this.queryFailure !== undefined) {
      throw this.queryFailure
    }
    for (const entry of this.packets) {
      this.responses?.(entry.packet, entry.remote)
    }
  }

  destroy(): void {
    this.destroyed += 1
    if (this.destroyFailure !== undefined) {
      throw this.destroyFailure
    }
  }

  rejectQueries(error: Error): void {
    this.queryFailure = error
  }

  rejectDestroy(error: Error): void {
    this.destroyFailure = error
  }

  failFatally(error: Error): void {
    this.errors?.(error)
  }

  warn(error: Error): void {
    this.warnings?.(error)
  }
}

function ptr(service: string, instance: string): Answer {
  return { name: service, type: 'PTR', data: instance } as Answer
}

function srv(instance: string, target: string, port: number): Answer {
  return {
    name: instance,
    type: 'SRV',
    data: { port, target, priority: 0, weight: 0 },
  } as Answer
}

function txt(instance: string, entries: string[]): Answer {
  return { name: instance, type: 'TXT', data: entries.map((entry) => Buffer.from(entry)) } as Answer
}

function a(target: string, address: string): Answer {
  return { name: target, type: 'A', data: address } as Answer
}

const ZONE_ONE = 'Zone One._musc._tcp.local'
const ZONE_TWO = 'Zone Two._musp._tcp.local'

/** A full, well-behaved answer for a two-zone chassis. */
const twoZoneChassis = [{
  remote: { address: '192.168.4.11' },
  packet: {
    answers: [
      ptr('_musc._tcp.local', ZONE_ONE),
      ptr('_musp._tcp.local', ZONE_TWO),
    ],
    additionals: [
      srv(ZONE_ONE, 'ci-s2.local', 11_000),
      srv(ZONE_TWO, 'ci-s2.local', 11_010),
      txt(ZONE_ONE, ['model=CI-S2', 'mac=9056820A0002', 'zs=false']),
      txt(ZONE_TWO, ['model=CI-S2', 'zs=true']),
      a('ci-s2.local', '192.168.4.11'),
    ],
  },
}]

/** A client that answers /SyncStatus from a table of endpoints. */
function fakeClient(bodies: Record<string, string>) {
  const asked: string[] = []
  const client = {
    readSyncStatus: jest.fn(async (endpoint: Endpoint): Promise<PlayerObservation> => {
      const key = `${endpoint.host}:${endpoint.port}`
      asked.push(key)
      const body = bodies[key]
      if (body === undefined) {
        throw new Error(`nothing listening on ${key}`)
      }
      return parseSyncStatus(body, key)
    }),
  }
  return { asked, client: client as unknown as BluOSClient, readSyncStatus: client.readSyncStatus }
}

function discovery(
  session: FakeMdns,
  bodies: Record<string, string>,
) {
  const log = fakeLogger()
  const { client, asked, readSyncStatus } = fakeClient(bodies)
  return {
    log,
    asked,
    readSyncStatus,
    instance: new BluOSDiscovery({ log, client, createMdns: () => session }),
  }
}

/**
 * Run a browse to completion without waiting out its window.
 *
 * The window is real time in production; here the timers are advanced, which
 * also fires the scheduled re-queries and follow-up questions.
 */
async function discoverNow(
  instance: BluOSDiscovery,
  timeoutSec = 1,
): Promise<Awaited<ReturnType<BluOSDiscovery['discover']>>> {
  const pending = instance.discover(timeoutSec)
  await jest.advanceTimersByTimeAsync(timeoutSec * 1_000 + 50)
  return pending
}

async function resolveNow(
  instance: BluOSDiscovery,
  playerId: string,
): Promise<Endpoint | undefined> {
  const pending = instance.resolveEndpoint(playerId, 1)
  await jest.advanceTimersByTimeAsync(1_050)
  return pending
}

describe('BluOSDiscovery', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('finds both zones of a chassis, each on the port its SRV record gives', async () => {
    const session = new FakeMdns(twoZoneChassis)
    const test = discovery(session, {
      '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE,
      '192.168.4.11:11010': SYNC_STATUS_CI_S2_ZONE_TWO,
    })

    const players = await discoverNow(test.instance)

    expect(players).toHaveLength(2)
    expect(players.map((player) => [player.name, player.port])).toEqual([
      ['Zone One', 11_000],
      ['Zone Two', 11_010],
    ])
  })

  it('browses both service types, since a secondary zone only answers on _musp', async () => {
    const session = new FakeMdns(twoZoneChassis)
    const test = discovery(session, {})

    await discoverNow(test.instance)

    expect(session.queries).toContain('PTR _musc._tcp.local')
    expect(session.queries).toContain('PTR _musp._tcp.local')
  })

  it('derives identity from MAC and port, not from the address', async () => {
    const session = new FakeMdns(twoZoneChassis)
    const test = discovery(session, {
      '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE,
      '192.168.4.11:11010': SYNC_STATUS_CI_S2_ZONE_TWO,
    })

    const players = await discoverNow(test.instance)

    expect(players.map((player) => player.id)).toEqual([
      '90:56:82:0A:00:02:11000',
      '90:56:82:0A:00:02:11010',
    ])
    expect(players.every((player) => !player.id.includes('192.168'))).toBe(true)
  })

  it('reports what the settings page needs to offer sensible defaults', async () => {
    const session = new FakeMdns([{
      remote: { address: '192.168.4.13' },
      packet: {
        answers: [ptr('_musc._tcp.local', 'Portable._musc._tcp.local')],
        additionals: [
          srv('Portable._musc._tcp.local', 'flex.local', 11_000),
          a('flex.local', '192.168.4.13'),
        ],
      },
    }])
    const test = discovery(session, { '192.168.4.13:11000': SYNC_STATUS_BATTERY })

    const [player] = await discoverNow(test.instance)

    expect(player).toMatchObject({
      brand: 'Bluesound',
      model: 'P125',
      modelName: 'PULSE FLEX 2i',
      firmware: '4.16.6',
      hasBattery: true,
      fixedVolume: false,
    })
  })

  it('flags a fixed-output player, so the UI can refuse to offer it a slider', async () => {
    const session = new FakeMdns([{
      remote: { address: '192.168.4.23' },
      packet: {
        answers: [ptr('_musc._tcp.local', 'Fixed._musc._tcp.local')],
        additionals: [
          srv('Fixed._musc._tcp.local', 'ci580.local', 11_000),
          a('ci580.local', '192.168.4.23'),
        ],
      },
    }])
    const test = discovery(session, { '192.168.4.23:11000': SYNC_STATUS_FIXED_VOLUME })

    const [player] = await discoverNow(test.instance)

    expect(player?.fixedVolume).toBe(true)
  })

  it('falls back to the responder\'s address when no A record is offered', async () => {
    const session = new FakeMdns([{
      remote: { address: '192.168.4.11' },
      packet: {
        answers: [ptr('_musc._tcp.local', ZONE_ONE)],
        additionals: [srv(ZONE_ONE, 'ci-s2.local', 11_000)],
      },
    }])
    const test = discovery(session, { '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE })

    const players = await discoverNow(test.instance)

    expect(players).toHaveLength(1)
    expect(players[0]?.host).toBe('192.168.4.11')
  })

  it('chases a missing SRV record rather than dropping the instance', async () => {
    const session = new FakeMdns([{
      remote: { address: '192.168.4.11' },
      packet: { answers: [ptr('_musc._tcp.local', ZONE_ONE)] },
    }])
    const test = discovery(session, {})

    await discoverNow(test.instance, 2)

    expect(session.queries).toContain(`SRV ${ZONE_ONE}`)
    expect(session.queries).toContain(`TXT ${ZONE_ONE}`)
  })

  it('skips an instance whose port never arrives', async () => {
    const session = new FakeMdns([{
      remote: { address: '192.168.4.11' },
      packet: { answers: [ptr('_musc._tcp.local', ZONE_ONE)] },
    }])
    const test = discovery(session, { '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE })

    // Without an SRV record the zone's port is unknown, and guessing 11000 would
    // silently attach a secondary zone to the wrong endpoint.
    await expect(discoverNow(test.instance)).resolves.toEqual([])
    expect(test.log.calls.some((line) => line.includes('no SRV record'))).toBe(true)
  })

  it('does not offer a player that never answered /SyncStatus', async () => {
    const session = new FakeMdns(twoZoneChassis)
    const test = discovery(session, { '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE })

    const players = await discoverNow(test.instance)

    // An advertisement is a claim; answering the API is proof.
    expect(players.map((player) => player.port)).toEqual([11_000])
  })

  it('keeps the rest of the fleet when one player is unreachable', async () => {
    const session = new FakeMdns(twoZoneChassis)
    const test = discovery(session, { '192.168.4.11:11010': SYNC_STATUS_CI_S2_ZONE_TWO })

    await expect(discoverNow(test.instance)).resolves.toHaveLength(1)
  })

  it('asks each endpoint only once, however many packets repeat it', async () => {
    const session = new FakeMdns([...twoZoneChassis, ...twoZoneChassis])
    const test = discovery(session, {
      '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE,
      '192.168.4.11:11010': SYNC_STATUS_CI_S2_ZONE_TWO,
    })

    await discoverNow(test.instance)

    expect(test.asked.sort()).toEqual(['192.168.4.11:11000', '192.168.4.11:11010'])
  })

  it('tears the session down even when nothing was found', async () => {
    const session = new FakeMdns([])
    const test = discovery(session, {})

    await discoverNow(test.instance)

    expect(session.destroyed).toBe(1)
  })

  it('degrades to nothing when the socket cannot be created', async () => {
    const log = fakeLogger()
    const { client } = fakeClient({})
    const instance = new BluOSDiscovery({
      log,
      client,
      createMdns: () => {
        throw new Error('EACCES')
      },
    })

    await expect(discoverNow(instance)).resolves.toEqual([])
    expect(log.calls.some((line) => line.startsWith('warn')
      && line.includes('discovery unavailable'))).toBe(true)
  })

  it('gives up early, rather than crashing, when the socket fails fatally', async () => {
    // An unheard `error` event on an EventEmitter is thrown, which would take
    // Homebridge down with it.
    const session = new FakeMdns([])
    const test = discovery(session, {})

    const pending = discoverNow(test.instance, 30)
    session.failFatally(Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' }))

    await expect(pending).resolves.toEqual([])
    expect(test.log.calls.some((line) => line.startsWith('warn')
      && line.includes('mDNS unavailable'))).toBe(true)
  })

  it('logs a recoverable warning without abandoning the browse', async () => {
    const session = new FakeMdns(twoZoneChassis)
    const test = discovery(session, {
      '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE,
      '192.168.4.11:11010': SYNC_STATUS_CI_S2_ZONE_TWO,
    })

    const pending = discoverNow(test.instance)
    session.warn(new Error('undecodable packet'))

    await expect(pending).resolves.toHaveLength(2)
  })

  it('carries on when the socket refuses a query', async () => {
    const session = new FakeMdns(twoZoneChassis)
    session.rejectQueries(new Error('ENETUNREACH'))
    const test = discovery(session, {})

    await expect(discoverNow(test.instance)).resolves.toEqual([])
    expect(test.log.calls.some((line) => line.includes('mDNS query failed'))).toBe(true)
  })

  it('carries on when the socket cannot be torn down', async () => {
    const session = new FakeMdns(twoZoneChassis)
    session.rejectDestroy(new Error('already closed'))
    const test = discovery(session, {
      '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE,
      '192.168.4.11:11010': SYNC_STATUS_CI_S2_ZONE_TWO,
    })

    await expect(discoverNow(test.instance)).resolves.toHaveLength(2)
    expect(test.log.calls.some((line) => line.includes('mDNS teardown failed'))).toBe(true)
  })

  it('ignores a TXT entry that is not a key and a value', async () => {
    const session = new FakeMdns([{
      remote: { address: '192.168.4.11' },
      packet: {
        answers: [ptr('_musc._tcp.local', ZONE_ONE)],
        additionals: [
          srv(ZONE_ONE, 'ci-s2.local', 11_000),
          // Seen in the field from third-party responders sharing the domain.
          txt(ZONE_ONE, ['flag', '=leading', 'mac=9056820A0002']),
          a('ci-s2.local', '192.168.4.11'),
        ],
      },
    }])
    const test = discovery(session, { '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE })

    await expect(discoverNow(test.instance)).resolves.toHaveLength(1)
  })

  it('reads a TXT record that arrives as plain strings', async () => {
    const session = new FakeMdns([{
      remote: { address: '192.168.4.11' },
      packet: {
        answers: [ptr('_musc._tcp.local', ZONE_ONE)],
        additionals: [
          srv(ZONE_ONE, 'ci-s2.local', 11_000),
          { name: ZONE_ONE, type: 'TXT', data: 'mac=9056820A0002' } as Answer,
          a('ci-s2.local', '192.168.4.11'),
        ],
      },
    }])
    const test = discovery(session, { '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE })

    await expect(discoverNow(test.instance)).resolves.toHaveLength(1)
  })

  it('falls back to the default port when the SRV record gives none', async () => {
    const session = new FakeMdns([{
      remote: { address: '192.168.4.11' },
      packet: {
        answers: [ptr('_musc._tcp.local', ZONE_ONE)],
        additionals: [srv(ZONE_ONE, 'ci-s2.local', 0), a('ci-s2.local', '192.168.4.11')],
      },
    }])
    const test = discovery(session, { '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE })

    await expect(discoverNow(test.instance)).resolves.toMatchObject([{ port: 11_000 }])
  })

  it('skips an instance with no usable IPv4 address', async () => {
    const session = new FakeMdns([{
      // No responder address and an AAAA-only host: nothing to connect to.
      remote: { address: 'fe80::1' },
      packet: {
        answers: [ptr('_musc._tcp.local', ZONE_ONE)],
        additionals: [srv(ZONE_ONE, 'ci-s2.local', 11_000)],
      },
    }])
    const test = discovery(session, { '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE })

    await expect(discoverNow(test.instance)).resolves.toEqual([])
    expect(test.log.calls.some((line) => line.includes('no IPv4 address'))).toBe(true)
  })

  it('reports a player with no readable MAC without an identity', async () => {
    const session = new FakeMdns([{
      remote: { address: '192.168.4.11' },
      packet: {
        answers: [ptr('_musp._tcp.local', ZONE_TWO)],
        additionals: [
          srv(ZONE_TWO, 'ci-s2.local', 11_010),
          txt(ZONE_TWO, ['model=CI-S2']),
          a('ci-s2.local', '192.168.4.11'),
        ],
      },
    }])
    // A body with no `mac` attribute at all, which is what a player behind a
    // proxy looks like. The UI mints a generated id for these.
    const test = discovery(session, {
      '192.168.4.11:11010': '<SyncStatus etag="1" name="Zone Two" volume="30"/>',
    })

    await expect(discoverNow(test.instance)).resolves.toMatchObject([{ id: '', name: 'Zone Two' }])
  })

  it('names a nameless player after its address', async () => {
    const session = new FakeMdns(twoZoneChassis)
    const test = discovery(session, {
      '192.168.4.11:11000': '<SyncStatus etag="1" volume="30"/>',
    })

    await expect(discoverNow(test.instance))
      .resolves.toMatchObject([{ name: '192.168.4.11:11000' }])
  })

  describe('resolveEndpoint', () => {
    it('finds the current address of a known player', async () => {
      const session = new FakeMdns(twoZoneChassis)
      const test = discovery(session, {
        '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE,
        '192.168.4.11:11010': SYNC_STATUS_CI_S2_ZONE_TWO,
      })

      await expect(resolveNow(test.instance, '90:56:82:0A:00:02:11010'))
        .resolves.toEqual({ host: '192.168.4.11', port: 11_010 })
    })

    it('returns nothing for a player that is not on the network', async () => {
      const session = new FakeMdns(twoZoneChassis)
      const test = discovery(session, {
        '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE,
      })

      await expect(resolveNow(test.instance, '90:56:82:0A:00:0F:11000'))
        .resolves.toBeUndefined()
    })
  })

  describe('bounds', () => {
    it('verifies candidates a few at a time rather than all at once', async () => {
      // Anything on the segment can advertise, and nothing throttles distinct
      // endpoints against each other, so the count of advertisements must not
      // decide how many sockets this plugin opens at one moment.
      const many = Array.from({ length: 30 }, (_unused, index) => index)
      const session = new FakeMdns([{
        remote: { address: '192.168.4.11' },
        packet: {
          answers: many.map((index) => ptr('_musc._tcp.local', `Zone ${index}._musc._tcp.local`)),
          additionals: [
            ...many.map((index) => srv(`Zone ${index}._musc._tcp.local`, 'ci-s2.local', 11_000 + index)),
            a('ci-s2.local', '192.168.4.11'),
          ],
        },
      }])
      const test = discovery(session, {})
      let live = 0
      let peak = 0
      test.readSyncStatus.mockImplementation(async () => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((resolve) => setImmediate(resolve))
        live -= 1
        throw new Error('nothing listening')
      })

      await discoverNow(test.instance)

      expect(test.readSyncStatus.mock.calls.length).toBe(30)
      expect(peak).toBeLessThanOrEqual(6)
    })

    it('stops verifying past the candidate ceiling, and says so', async () => {
      const many = Array.from({ length: 70 }, (_unused, index) => index)
      const session = new FakeMdns([{
        remote: { address: '192.168.4.11' },
        packet: {
          answers: many.map((index) => ptr('_musc._tcp.local', `Zone ${index}._musc._tcp.local`)),
          additionals: [
            ...many.map((index) => srv(`Zone ${index}._musc._tcp.local`, `host-${index}.local`, 11_000)),
            ...many.map((index) => a(`host-${index}.local`, `192.168.4.${index + 10}`)),
          ],
        },
      }])
      const test = discovery(session, {})

      await discoverNow(test.instance)

      expect(test.readSyncStatus.mock.calls.length).toBe(64)
      expect(test.log.calls.some((line) => line.includes('candidate endpoints'))).toBe(true)
    })

    it('ignores SRV and TXT records for services it did not browse', async () => {
      const session = new FakeMdns([{
        remote: { address: '192.168.4.11' },
        packet: {
          answers: [ptr('_musc._tcp.local', ZONE_ONE)],
          additionals: [
            srv(ZONE_ONE, 'ci-s2.local', 11_000),
            srv('Printer._ipp._tcp.local', 'printer.local', 631),
            txt('Printer._ipp._tcp.local', ['rp=ipp/print']),
            a('ci-s2.local', '192.168.4.11'),
          ],
        },
      }])
      const test = discovery(session, { '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE })

      const players = await discoverNow(test.instance)

      expect(players.map((player) => player.port)).toEqual([11_000])
      expect(test.asked).toEqual(['192.168.4.11:11000'])
    })

    it('abandons a browse in flight when it is cancelled', async () => {
      const session = new FakeMdns(twoZoneChassis)
      const test = discovery(session, {
        '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE,
      })

      // A browse window is a referenced timer holding a bound socket, so a
      // shutdown mid-sweep would otherwise wait the whole window out.
      const pending = test.instance.discover(30)
      await jest.advanceTimersByTimeAsync(10)
      test.instance.cancelAll()
      await expect(pending).resolves.toEqual([])
      expect(session.destroyed).toBe(1)
    })

    it('refuses to start a browse once cancelled', async () => {
      const session = new FakeMdns(twoZoneChassis)
      const test = discovery(session, {})
      test.instance.cancelAll()

      await expect(discoverNow(test.instance)).resolves.toEqual([])
      expect(session.queries).toEqual([])
    })
  })

  describe('probe', () => {
    it('confirms a manually entered address', async () => {
      const session = new FakeMdns([])
      const test = discovery(session, { '192.168.4.11:11010': SYNC_STATUS_CI_S2_ZONE_TWO })

      const player = await test.instance.probe({ host: '192.168.4.11', port: 11_010 })

      expect(player).toMatchObject({ name: 'Zone Two', id: '90:56:82:0A:00:02:11010' })
    })

    it('returns nothing when the address does not answer', async () => {
      const session = new FakeMdns([])
      const test = discovery(session, {})

      await expect(test.instance.probe({ host: '192.168.4.99', port: 11_000 }))
        .resolves.toBeUndefined()
    })

    it('does not touch mDNS at all', async () => {
      const session = new FakeMdns([])
      const test = discovery(session, { '192.168.4.11:11000': SYNC_STATUS_CI_S2_ZONE_ONE })

      await test.instance.probe({ host: '192.168.4.11', port: 11_000 })

      expect(session.queries).toEqual([])
    })
  })
})
