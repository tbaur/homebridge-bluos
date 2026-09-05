/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The set/poll race is the reason the generation counter exists, and it is the
 * hardest behaviour here to verify by hand: a response computed just before a
 * write is indistinguishable from a fresh one by its contents, and getting it
 * wrong shows up only as an occasional slider springing back after being moved.
 */

import type { BluOSClient, Endpoint } from '../../src/api/client'
import { DevicePoller } from '../../src/poller'
import { POLL_BACKOFF_BASE_MS, POLL_BACKOFF_MAX_MS } from '../../src/settings'
import type { PlayerObservation, RefreshReason } from '../../src/types'
import { raceTimeout, TIMED_OUT } from '../../src/utils/timing'
import { fakeLogger, observation } from '../helpers/hap'

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Let the loop run as far as it can without any timer elapsing.
 *
 * Several turns, because one cycle spans a read, the generation check and the
 * start of the next read.
 */
const flush = async (turns = 12): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

interface Setup {
  poller: DevicePoller
  log: ReturnType<typeof fakeLogger>
  reads: Endpoint[]
  polls: { endpoint: Endpoint; etag: string }[]
  observations: { observation: PlayerObservation; reason: RefreshReason }[]
  unreachable: unknown[]
  resolveEndpoint: jest.Mock<Promise<Endpoint | undefined>, [string]>
  endpointChanges: Endpoint[]
  /** Stop the poller, releasing whatever request it is holding. */
  stop: () => Promise<void>
}

/**
 * Build a poller whose reads the test answers one at a time.
 *
 * Once the scripted answers run out the fake holds the request open instead of
 * answering, which is what real hardware does: a long-poll with a current etag
 * holds for the full window. Answering instantly forever would spin the loop,
 * which in production cannot happen because the client enforces the API's
 * one-second gap between requests for the same resource.
 *
 * Pass `repeatLast` for failure cases, where every attempt should fail and the
 * loop's own backoff paces it.
 */
function setup(
  answers: (() => Promise<PlayerObservation>)[],
  options: { repeatLast?: boolean } = {},
): Setup {
  const log = fakeLogger()
  const reads: Endpoint[] = []
  const polls: { endpoint: Endpoint; etag: string }[] = []
  const observations: { observation: PlayerObservation; reason: RefreshReason }[] = []
  const unreachable: unknown[] = []
  const endpointChanges: Endpoint[] = []
  /** Rejections that release a held request at teardown. */
  const holding: (() => void)[] = []
  let index = 0

  const hold = async (signal?: AbortSignal): Promise<PlayerObservation> => (
    new Promise<PlayerObservation>((_resolve, reject) => {
      const release = (): void => reject(new Error('request released'))
      signal?.addEventListener('abort', release, { once: true })
      holding.push(release)
    })
  )

  const next = async (signal?: AbortSignal): Promise<PlayerObservation> => {
    const position = options.repeatLast === true ? Math.min(index, answers.length - 1) : index
    index += 1
    const answer = answers[position]
    return answer === undefined ? hold(signal) : answer()
  }

  const client = {
    readSyncStatus: jest.fn(async (endpoint: Endpoint, signal?: AbortSignal) => {
      reads.push(endpoint)
      return next(signal)
    }),
    pollSyncStatus: jest.fn(async (endpoint: Endpoint, etag: string, signal?: AbortSignal) => {
      polls.push({ endpoint, etag })
      return next(signal)
    }),
  } as unknown as BluOSClient

  const resolveEndpoint = jest.fn<Promise<Endpoint | undefined>, [string]>(
    async () => undefined,
  )

  const poller = new DevicePoller({
    log,
    client,
    deviceId: '90:56:82:0A:00:02:11000',
    displayName: 'Zone One',
    endpoint: { host: '192.168.4.11', port: 11_000 },
    onObservation: (next2, reason) => {
      observations.push({ observation: next2, reason })
    },
    onUnreachable: (error) => {
      unreachable.push(error)
    },
    resolveEndpoint,
    onEndpointChanged: (endpoint) => {
      endpointChanges.push(endpoint)
    },
  })

  const stop = async (): Promise<void> => {
    // `stop` interrupts synchronously, then awaits the loop, so the held request
    // has to be released before that await is joined.
    const stopping = poller.stop()
    for (const release of holding.splice(0)) {
      release()
    }
    await stopping
  }

  return {
    poller,
    log,
    reads,
    polls,
    observations,
    unreachable,
    resolveEndpoint,
    endpointChanges,
    stop,
  }
}

describe('DevicePoller', () => {
  it('reads plainly first, then long-polls with the etag it was given', async () => {
    const test = setup([async () => observation({ etag: '95' })])

    test.poller.start()
    await flush()
    await test.stop()

    expect(test.reads).toEqual([{ host: '192.168.4.11', port: 11_000 }])
    expect(test.polls[0]).toMatchObject({ etag: '95' })
  })

  it('labels the first observation as startup and later ones as polls', async () => {
    const test = setup([
      async () => observation({ etag: '95' }),
      async () => observation({ etag: '96' }),
    ])

    test.poller.start()
    await flush()
    await test.stop()

    expect(test.observations[0]?.reason).toBe('startup')
    expect(test.observations[1]?.reason).toBe('poll')
  })

  it('exposes the last observation', async () => {
    const test = setup([async () => observation({ volume: 33 })])

    test.poller.start()
    await flush()
    await test.stop()

    expect(test.poller.lastObservation?.volume).toBe(33)
  })

  it('is safe to start twice', async () => {
    const test = setup([async () => observation()])

    test.poller.start()
    test.poller.start()
    await flush()
    await test.stop()

    expect(test.reads).toHaveLength(1)
  })

  describe('the set/poll race', () => {
    it('discards a response that crossed a write, and re-reads', async () => {
      const held = deferred<PlayerObservation>()
      const test = setup([
        async () => held.promise,
        async () => observation({ volume: 90, etag: '96' }),
      ])

      test.poller.start()
      await flush()

      // A write lands while the read is in flight, then the read answers with
      // state from before it.
      test.poller.adoptWriteResult({ level: 90, fixedVolume: false, muted: false })
      held.resolve(observation({ volume: 60, etag: '95' }))
      await flush()
      await test.stop()

      const volumes = test.observations.map((entry) => entry.observation.volume)
      // The stale 60 never reaches HomeKit; the tile does not spring back.
      expect(volumes).not.toContain(60)
      expect(test.observations.some((entry) => entry.reason === 'post-set')).toBe(true)
      expect(test.log.calls.some((line) => line.includes('crossed a write'))).toBe(true)
    })

    it('publishes the write result immediately, since the player clamps it', async () => {
      const test = setup([async () => observation()])

      test.poller.adoptWriteResult({ level: 65, fixedVolume: false, muted: false, db: -20 })

      expect(test.observations[0]?.observation).toMatchObject({
        volume: 65,
        muted: false,
        db: -20,
      })
      expect(test.observations[0]?.reason).toBe('post-set')
    })

    it('merges a write result into what was already known', async () => {
      const test = setup([async () => observation({ name: 'Zone One', volume: 60 })])
      test.poller.start()
      await flush()

      test.poller.adoptWriteResult({ level: 0, fixedVolume: false, muted: true, muteVolume: 60 })
      await test.stop()

      const last = test.observations[test.observations.length - 1]?.observation
      expect(last).toMatchObject({
        name: 'Zone One',
        volume: 0,
        muted: true,
        muteVolume: 60,
        syncRole: 'standalone',
      })
    })

    it('forgets the pre-mute level once a write reports the player unmuted', async () => {
      const test = setup([async () => observation({ volume: 0, muted: true, muteVolume: 60 })])
      test.poller.start()
      await flush()

      // The firmware only publishes muteVolume while muted, so carrying it past an
      // unmute would let 60 win the next restore instead of whatever the user
      // actually set.
      test.poller.adoptWriteResult({ level: 20, fixedVolume: false, muted: false })
      await test.stop()

      const last = test.observations[test.observations.length - 1]?.observation
      expect(last).toMatchObject({ volume: 20, muted: false })
      expect(last?.muteVolume).toBeUndefined()
    })

    it('keeps the pre-mute level while the player is still muted', async () => {
      const test = setup([async () => observation({ volume: 0, muted: true, muteVolume: 60 })])
      test.poller.start()
      await flush()

      test.poller.adoptWriteResult({ level: 0, fixedVolume: false, muted: true })
      await test.stop()

      const last = test.observations[test.observations.length - 1]?.observation
      expect(last?.muteVolume).toBe(60)
    })

    it('drops the etag after a write, since a /Volume etag is not a /SyncStatus one', async () => {
      const test = setup([
        async () => observation({ etag: '95' }),
        async () => observation({ etag: '96' }),
      ])
      test.poller.start()
      await flush()
      const pollsBefore = test.polls.length

      test.poller.adoptWriteResult({ level: 10, fixedVolume: false, muted: false })
      await flush()
      await test.stop()

      // The next cycle is a plain read, not a poll with a borrowed token.
      expect(test.reads.length).toBeGreaterThan(1)
      expect(test.polls.length).toBe(pollsBefore)
    })

    it('does not count its own cancelled poll as a failure', async () => {
      // Dropping the poll in flight is how a write gets read back promptly. If
      // that rejection were treated as a network failure, three writes in a row
      // would show the player as No Response and each would pay a backoff first.
      const test = setup([
        async () => observation({ etag: '95' }),
        async () => observation({ etag: '96' }),
        async () => observation({ etag: '97' }),
        async () => observation({ etag: '98' }),
      ])
      test.poller.start()
      await flush()

      for (let write = 0; write < 3; write += 1) {
        test.poller.adoptWriteResult({ level: 10 + write, fixedVolume: false, muted: false })
        await flush()
      }
      await test.stop()

      expect(test.unreachable).toEqual([])
      expect(test.log.calls.some((line) => line.includes('poll failed'))).toBe(false)
    })

    it('forces a plain read after adopting a write result', async () => {
      const test = setup([
        async () => observation({ etag: '95' }),
        async () => observation({ etag: '96' }),
      ])
      test.poller.start()
      await flush()

      // A /Volume etag is not a /SyncStatus etag, so the next read has to be a
      // plain one rather than a long poll against a token from another resource.
      test.poller.adoptWriteResult({ level: 30, fixedVolume: false, muted: false })
      await flush()
      await test.stop()

      expect(test.reads.length).toBeGreaterThan(1)
    })
  })

  describe('failure handling', () => {
    // Backoff is real time the loop genuinely waits, so it is advanced rather
    // than slept through.
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    /** Enough advancing for several failures and their jittered backoffs. */
    const throughBackoffs = async (): Promise<void> => {
      await jest.advanceTimersByTimeAsync(30_000)
    }

    it('stays quiet about a single failure, then reports the player unreachable', async () => {
      const test = setup([async () => {
        throw new Error('ETIMEDOUT')
      }], { repeatLast: true })

      test.poller.start()
      await throughBackoffs()
      await test.stop()

      // One blip is normal on a LAN; three in a row is worth telling HomeKit about.
      expect(test.unreachable.length).toBeGreaterThan(0)
      expect(test.log.calls.filter((line) => line.includes('poll failed'))).toHaveLength(1)
    })

    it('re-resolves the address after repeated failures, which is what a DHCP move looks like', async () => {
      const test = setup([async () => {
        throw new Error('EHOSTUNREACH')
      }], { repeatLast: true })
      test.resolveEndpoint.mockResolvedValue({ host: '192.168.4.99', port: 11_000 })

      test.poller.start()
      await throughBackoffs()
      await test.stop()

      expect(test.resolveEndpoint).toHaveBeenCalledWith('90:56:82:0A:00:02:11000')
      expect(test.poller.endpoint).toEqual({ host: '192.168.4.99', port: 11_000 })
      expect(test.endpointChanges).toEqual([{ host: '192.168.4.99', port: 11_000 }])
    })

    it('only looks for an address once per interval, so an absent player is not a sweep', async () => {
      const test = setup([async () => {
        throw new Error('EHOSTUNREACH')
      }], { repeatLast: true })

      test.poller.start()
      await throughBackoffs()
      await test.stop()

      // Many failures, but the interval allows only one lookup.
      expect(test.resolveEndpoint.mock.calls.length).toBe(1)
    })

    it('survives a lookup that itself fails', async () => {
      const test = setup([async () => {
        throw new Error('EHOSTUNREACH')
      }], { repeatLast: true })
      test.resolveEndpoint.mockRejectedValue(new Error('mDNS unavailable'))

      test.poller.start()
      await throughBackoffs()
      await test.stop()

      expect(test.log.calls.some((line) => line.includes('address lookup failed'))).toBe(true)
    })

    it('waits before retrying, and stops retrying while it waits', async () => {
      const test = setup([async () => {
        throw new Error('ETIMEDOUT')
      }], { repeatLast: true })

      test.poller.start()
      // Less than the minimum jittered backoff, so only the first attempt ran.
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_BASE_MS / 2 - 1)
      const early = test.reads.length

      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_BASE_MS * 2)
      await test.stop()

      expect(early).toBe(1)
      expect(test.reads.length).toBeGreaterThan(1)
    })

    it('retries at once when the address turned out to have changed', async () => {
      const test = setup([async () => {
        throw new Error('EHOSTUNREACH')
      }], { repeatLast: true })
      test.resolveEndpoint.mockResolvedValue({ host: '192.168.4.99', port: 11_000 })

      test.poller.start()
      // Long enough for three failures and their backoffs, so the move happens,
      // but far short of the ceiling the backoff would otherwise have reached.
      await jest.advanceTimersByTimeAsync(15_000)
      const beforeMove = test.reads.filter((endpoint) => endpoint.host === '192.168.4.99').length
      await test.stop()

      // Waiting out a delay of up to a minute after learning the new address would
      // leave the player No Response for no reason.
      expect(beforeMove).toBeGreaterThan(0)
    })

    it('grows the delay so a long outage is not retried every two seconds', async () => {
      const test = setup([async () => {
        throw new Error('ETIMEDOUT')
      }], { repeatLast: true })

      test.poller.start()
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MAX_MS)
      const afterFirstMinute = test.reads.length
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MAX_MS)
      await test.stop()

      // Doubling means a minute buys a handful of attempts, not thirty.
      expect(afterFirstMinute).toBeLessThan(10)
      expect(test.reads.length).toBeGreaterThan(afterFirstMinute)
    })
  })

  describe('refreshNow', () => {
    it('drops a held long-poll and starts a plain read', async () => {
      const test = setup([async () => observation({ etag: '95', volume: 60 })])
      test.poller.start()
      await flush()
      const readsAfterStart = test.reads.length
      expect(test.polls).toHaveLength(1)

      test.poller.refreshNow()
      await flush()
      await test.stop()

      expect(test.reads.length).toBeGreaterThan(readsAfterStart)
    })
  })

  describe('endpoint changes', () => {
    it('ignores a move to the same address', async () => {
      const test = setup([async () => observation()])

      test.poller.setEndpoint({ host: '192.168.4.11', port: 11_000 })

      expect(test.endpointChanges).toEqual([])
    })

    it('reports a move and starts polling the new address', async () => {
      const test = setup([
        async () => observation({ etag: '95' }),
        async () => observation({ etag: '96' }),
      ])
      test.poller.start()
      await flush()

      test.poller.setEndpoint({ host: '192.168.4.50', port: 11_010 })
      await flush()
      await test.stop()

      expect(test.log.calls.some((line) => line.includes('moved to 192.168.4.50:11010'))).toBe(true)
      expect(test.reads.some((endpoint) => endpoint.host === '192.168.4.50')).toBe(true)
    })
  })

  it('stops without waiting out a backoff delay', async () => {
    const test = setup([async () => {
      throw new Error('ETIMEDOUT')
    }], { repeatLast: true })

    test.poller.start()
    await flush()
    const started = Date.now()
    await test.stop()

    // Real time, deliberately: the delay is cleared rather than waited out, so
    // shutting Homebridge down does not sit through a backoff that no longer
    // matters. Without the clear this would take at least a second.
    expect(Date.now() - started).toBeLessThan(POLL_BACKOFF_BASE_MS / 4)
  })

  it('is safe to stop when it was never started', async () => {
    const test = setup([async () => observation()])

    await expect(test.stop()).resolves.toBeUndefined()
  })

  it('stops without waiting out a plain status read', async () => {
    // The read an unreachable player is on, because a failure clears the etag,
    // and it holds for the whole status timeout against a box that is not
    // answering. The platform awaits every poller at shutdown, so a read nothing
    // can cancel is six seconds of shutdown per silent player.
    const test = setup([])
    test.poller.start()
    await flush()
    expect(test.reads).toHaveLength(1)
    expect(test.polls).toEqual([])

    // Deliberately not `test.stop`, which releases held requests by hand: the
    // poller's own abort has to be what ends this one.
    const outcome = await raceTimeout(test.poller.stop(), 500)

    expect(outcome).not.toBe(TIMED_OUT)
  })

  it('stops promptly while an address lookup is still running', async () => {
    const test = setup([async () => {
      throw new Error('EHOSTUNREACH')
    }], { repeatLast: true })
    const lookup = deferred<Endpoint | undefined>()
    test.resolveEndpoint.mockReturnValue(lookup.promise)

    jest.useFakeTimers()
    try {
      test.poller.start()
      await jest.advanceTimersByTimeAsync(10_000)
      expect(test.resolveEndpoint).toHaveBeenCalled()

      // A real sweep is a multicast browse holding a socket for up to 30 s. The
      // platform cancels discovery before awaiting the pollers, which is what makes
      // this resolve; the poller's own part is to not re-point itself afterwards.
      const stopping = test.stop()
      lookup.resolve({ host: '192.168.4.99', port: 11_000 })
      await jest.advanceTimersByTimeAsync(0)
      await expect(stopping).resolves.toBeUndefined()
    } finally {
      jest.useRealTimers()
    }

    expect(test.endpointChanges).toEqual([])
  })

  it('logs rather than crashing the process when the loop itself throws', async () => {
    const test = setup([async () => observation()])
    // Nothing awaits the loop promise, so an unguarded throw here would surface as
    // an unhandled rejection and end the Homebridge process.
    const broken = new Error('handler exploded')
    const poller = test.poller as unknown as { run: () => Promise<void> }
    poller.run = async () => {
      throw broken
    }

    test.poller.start()
    await flush()

    expect(test.log.calls.some((line) => line.includes('polling stopped after an unexpected error')))
      .toBe(true)
  })
})
