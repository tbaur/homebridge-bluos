/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The scheduling rules are the point of this class, and they are invisible in
 * normal operation: a violated one-second gap or an unserialised write to a
 * shared chassis shows up as an occasional missed command, which is exactly the
 * kind of fault that never reproduces on demand. So they are asserted here with
 * an injected clock rather than left to integration testing.
 */

import { BluOSClient } from '../../src/api/client'
import type { HttpGet, HttpGetOptions, HttpPost } from '../../src/api/http'
import {
  CONTROL_RATE_LIMIT_MS,
  LONG_POLL_SEC,
  SAME_RESOURCE_MIN_GAP_MS,
} from '../../src/settings'
import { ConnectionError, ProtocolError } from '../../src/utils/errors'
import type { PluginLogger } from '../../src/types'
import {
  SYNC_STATUS_CI_S2_ZONE_TWO,
  VOLUME_CI_S2_ZONE_TWO,
  VOLUME_MUTED,
} from '../fixtures/responses'

function logger(): PluginLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}

/** A clock the test advances by hand, plus a sleep that advances it. */
function fakeTiming() {
  let now = 1_000_000
  const sleeps: number[] = []
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
    sleeps,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms)
      now += ms
      await Promise.resolve()
    },
  }
}

interface Call {
  url: string
  options: HttpGetOptions
}

function recordingHttp(body: string | ((url: string) => string), status = 200) {
  const calls: Call[] = []
  const httpGet: HttpGet = async (url, options) => {
    calls.push({ url, options })
    await Promise.resolve()
    return { status, body: typeof body === 'string' ? body : body(url) }
  }
  return { calls, httpGet }
}

function recordingPost(body = '', status = 200) {
  const calls: { url: string, form: Record<string, string>, options: HttpGetOptions }[] = []
  const httpPost: HttpPost = async (url, form, options) => {
    calls.push({ url, form, options })
    await Promise.resolve()
    return { status, body }
  }
  return { calls, httpPost }
}

const endpoint = { host: '192.168.4.11', port: 11_010 }

describe('BluOSClient', () => {
  describe('reads', () => {
    it('reads /SyncStatus and resolves identity against the endpoint it asked', async () => {
      const { calls, httpGet } = recordingHttp(SYNC_STATUS_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      const observation = await client.readSyncStatus(endpoint)

      expect(calls[0]?.url).toBe('http://192.168.4.11:11010/SyncStatus')
      expect(observation.name).toBe('Zone Two')
      expect(observation.syncRole).toBe('standalone')
    })

    it('long-polls with the etag and a read deadline beyond the poll window', async () => {
      const { calls, httpGet } = recordingHttp(SYNC_STATUS_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await client.pollSyncStatus(endpoint, '95')

      expect(calls[0]?.url).toBe(
        `http://192.168.4.11:11010/SyncStatus?timeout=${LONG_POLL_SEC}&etag=95`,
      )
      // The socket must outlast the hold the player is honouring.
      expect(calls[0]?.options.totalTimeoutMs).toBeGreaterThan(LONG_POLL_SEC * 1_000)
    })

    it('passes an abort signal through, so a shutdown can drop a held poll', async () => {
      const { calls, httpGet } = recordingHttp(SYNC_STATUS_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })
      const controller = new AbortController()

      await client.pollSyncStatus(endpoint, '95', controller.signal)

      expect(calls[0]?.options.signal).toBe(controller.signal)
    })

    it('reads /Volume', async () => {
      const { httpGet } = recordingHttp(VOLUME_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await expect(client.readVolume(endpoint)).resolves.toMatchObject({ level: 60, muted: false })
    })
  })

  describe('writes', () => {
    it('confines a level to the addressed zone unless told otherwise', async () => {
      const { calls, httpGet } = recordingHttp(VOLUME_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await client.setVolume(endpoint, 60)

      expect(calls[0]?.url).toBe('http://192.168.4.11:11010/Volume?level=60&tell_slaves=0')
    })

    it('carries a level to grouped followers when the caller asks for it', async () => {
      const { calls, httpGet } = recordingHttp(VOLUME_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await client.setVolume(endpoint, 60, { tellSlaves: true })

      expect(calls[0]?.url).toBe('http://192.168.4.11:11010/Volume?level=60&tell_slaves=1')
    })

    it('returns the player\'s own answer, which may differ from the request', async () => {
      // The player clamps into its configured dB range, so its reply is the truth.
      const { httpGet } = recordingHttp(VOLUME_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await expect(client.setVolume(endpoint, 95)).resolves.toMatchObject({ level: 60 })
    })

    it.each([-1, 101, 12.5, Number.NaN])('rejects an out-of-range level %s', async (level) => {
      const { calls, httpGet } = recordingHttp(VOLUME_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await expect(client.setVolume(endpoint, level)).rejects.toThrow(RangeError)
      expect(calls).toHaveLength(0)
    })

    it('mutes with mute=1, as the firmware behaves rather than as the table reads', async () => {
      const { calls, httpGet } = recordingHttp(VOLUME_MUTED)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      const result = await client.setMute(endpoint, true)

      expect(calls[0]?.url).toBe('http://192.168.4.11:11010/Volume?mute=1&tell_slaves=0')
      expect(result).toMatchObject({ muted: true, muteVolume: 60 })
    })

    it('unmutes with mute=0', async () => {
      const { calls, httpGet } = recordingHttp(VOLUME_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await client.setMute(endpoint, false)

      expect(calls[0]?.url).toBe('http://192.168.4.11:11010/Volume?mute=0&tell_slaves=0')
    })

    it('states the scope on a mute rather than leaving it to the firmware default', async () => {
      // Left implicit, a mute would follow whatever default the firmware applies,
      // which would not necessarily match what the slider on the same tile does.
      const { calls, httpGet } = recordingHttp(VOLUME_MUTED)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await client.setMute(endpoint, true, { tellSlaves: true })

      expect(calls[0]?.url).toBe('http://192.168.4.11:11010/Volume?mute=1&tell_slaves=1')
    })
  })

  describe('scheduling', () => {
    it('waits out the API\'s one-second gap between requests for the same resource', async () => {
      const timing = fakeTiming()
      const { httpGet } = recordingHttp(SYNC_STATUS_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...timing })

      await client.readSyncStatus(endpoint)
      await client.readSyncStatus(endpoint)

      expect(timing.sleeps).toEqual([SAME_RESOURCE_MIN_GAP_MS])
    })

    it('does not delay a different resource on the same endpoint', async () => {
      const timing = fakeTiming()
      const { httpGet } = recordingHttp((url) => (
        url.includes('SyncStatus') ? SYNC_STATUS_CI_S2_ZONE_TWO : VOLUME_CI_S2_ZONE_TWO
      ))
      const client = new BluOSClient({ log: logger(), httpGet, ...timing })

      await client.readSyncStatus(endpoint)
      await client.readVolume(endpoint)

      expect(timing.sleeps).toEqual([])
    })

    it('does not delay the same resource on a different zone of one chassis', async () => {
      const timing = fakeTiming()
      const { httpGet } = recordingHttp(SYNC_STATUS_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...timing })

      await client.readSyncStatus({ host: '192.168.4.11', port: 11_000 })
      await client.readSyncStatus({ host: '192.168.4.11', port: 11_010 })

      // Per the specification the gap is per resource, and a zone is its own
      // resource; sharing an IP does not make them the same one.
      expect(timing.sleeps).toEqual([])
    })

    it('waits only the remaining part of the gap', async () => {
      const timing = fakeTiming()
      const { httpGet } = recordingHttp(SYNC_STATUS_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...timing })

      await client.readSyncStatus(endpoint)
      timing.advance(600)
      await client.readSyncStatus(endpoint)

      expect(timing.sleeps).toEqual([SAME_RESOURCE_MIN_GAP_MS - 600])
    })

    it('spaces consecutive control calls', async () => {
      const timing = fakeTiming()
      const { httpGet } = recordingHttp(VOLUME_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...timing })

      await client.setMute(endpoint, true)
      await client.setMute(endpoint, false)

      // The control spacing, then the resource gap for the second /Volume request.
      expect(timing.sleeps).toContain(CONTROL_RATE_LIMIT_MS)
    })

    it('serialises writes to one chassis while leaving other chassis parallel', async () => {
      const order: string[] = []
      let releaseFirst = (): void => {}
      const firstInFlight = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      const httpGet: HttpGet = async (url) => {
        order.push(`start ${url}`)
        if (url.startsWith('http://192.168.4.11:11000/')) {
          await firstInFlight
        }
        order.push(`end ${url}`)
        return { status: 200, body: VOLUME_CI_S2_ZONE_TWO }
      }
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      const sameChassisFirst = client.setVolume({ host: '192.168.4.11', port: 11_000 }, 10)
      const sameChassisSecond = client.setVolume({ host: '192.168.4.11', port: 11_010 }, 20)
      const otherChassis = client.setVolume({ host: '192.168.4.12', port: 11_000 }, 30)

      await otherChassis
      // A different box is not held up by the stalled write.
      expect(order).toContain('end http://192.168.4.12:11000/Volume?level=30&tell_slaves=0')
      // The second zone of the same box has not even started.
      expect(order).not.toContain('start http://192.168.4.11:11010/Volume?level=20&tell_slaves=0')

      releaseFirst()
      await Promise.all([sameChassisFirst, sameChassisSecond])

      expect(order.indexOf('end http://192.168.4.11:11000/Volume?level=10&tell_slaves=0'))
        .toBeLessThan(order.indexOf('start http://192.168.4.11:11010/Volume?level=20&tell_slaves=0'))
    })

    it('lets a later write through after an earlier one to the same chassis failed', async () => {
      let attempt = 0
      const httpGet: HttpGet = async () => {
        attempt += 1
        if (attempt === 1) {
          throw new ConnectionError('boom')
        }
        return { status: 200, body: VOLUME_CI_S2_ZONE_TWO }
      }
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      const failing = client.setVolume(endpoint, 10)
      const following = client.setVolume(endpoint, 20)

      await expect(failing).rejects.toThrow(ConnectionError)
      await expect(following).resolves.toMatchObject({ level: 60 })
    })
  })

  describe('reboot', () => {
    it('POSTs to port 80, not to the zone\'s control port', async () => {
      // /reboot is served on port 80 and answers 404 on the control ports, so
      // targeting the endpoint's own port reaches nothing at all.
      const { calls, httpPost } = recordingPost()
      const client = new BluOSClient({ log: logger(), httpPost, ...fakeTiming() })

      await expect(client.reboot('192.168.4.11')).resolves.toEqual({ acknowledged: true })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe('http://192.168.4.11/reboot')
      expect(calls[0]?.form).toEqual({ noheader: '0', yes: '1' })
    })

    it('treats a lost connection as success once the player had the request', async () => {
      // A player that is restarting cannot finish answering. Insisting on a clean
      // response would report failure exactly when the command worked.
      const httpPost = async (): Promise<never> => {
        throw new ConnectionError('request failed', { delivered: true })
      }
      const client = new BluOSClient({ log: logger(), httpPost, ...fakeTiming() })

      await expect(client.reboot('192.168.4.11')).resolves.toEqual({ acknowledged: false })
    })

    it('still fails when it never reached the player', async () => {
      const httpPost = async (): Promise<never> => {
        throw new ConnectionError('connect timed out after 2000ms')
      }
      const client = new BluOSClient({ log: logger(), httpPost, ...fakeTiming() })

      await expect(client.reboot('192.168.4.11')).rejects.toThrow(ConnectionError)
    })

    it('treats a non-200 answer as a protocol error', async () => {
      const { httpPost } = recordingPost('404 page not found', 404)
      const client = new BluOSClient({ log: logger(), httpPost, ...fakeTiming() })

      await expect(client.reboot('192.168.4.11')).rejects.toThrow(ProtocolError)
    })

    it('applies the same host check as every other call', async () => {
      const { calls, httpPost } = recordingPost()
      const client = new BluOSClient({ log: logger(), httpPost, ...fakeTiming() })

      await expect(client.reboot('192.168.4.11/x')).rejects.toThrow(ConnectionError)
      expect(calls).toHaveLength(0)
    })

    it('waits out the same-resource gap between two presses on one box', async () => {
      const { httpPost } = recordingPost()
      const timing = fakeTiming()
      const client = new BluOSClient({ log: logger(), httpPost, ...timing })

      await client.reboot('192.168.4.11')
      await client.reboot('192.168.4.11')

      expect(timing.sleeps.some((ms) => ms > 0 && ms <= SAME_RESOURCE_MIN_GAP_MS)).toBe(true)
    })

    it('does not serialise behind a volume write to the same box', async () => {
      // Reboot skips the per-chassis lock on purpose: a box holding its socket
      // until timeout must not delay anything queued behind it.
      let release: (() => void) | undefined
      const httpGet: HttpGet = async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { status: 200, body: VOLUME_CI_S2_ZONE_TWO }
      }
      const { httpPost } = recordingPost()
      const client = new BluOSClient({ log: logger(), httpGet, httpPost, ...fakeTiming() })

      const held = client.setVolume(endpoint, 10)
      const rebooting = client.reboot('192.168.4.11')

      await expect(rebooting).resolves.toEqual({ acknowledged: true })
      release?.()
      await expect(held).resolves.toMatchObject({ level: 60 })
    })
  })

  describe('refusals', () => {
    it.each([
      ['a host with a slash', '192.168.4.11/x'],
      ['a host with a query', '192.168.4.11?a=b'],
      ['a host with a colon', '192.168.4.11:11000'],
      ['a host with a space', 'my player'],
      ['an empty host', ''],
    ])('refuses to contact %s', async (_label, host) => {
      const { calls, httpGet } = recordingHttp(SYNC_STATUS_CI_S2_ZONE_TWO)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await expect(client.readSyncStatus({ host, port: 11_000 }))
        .rejects.toThrow(ConnectionError)
      expect(calls).toHaveLength(0)
    })

    it('treats a non-200 answer as a protocol error', async () => {
      const { httpGet } = recordingHttp('<html>not found</html>', 404)
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await expect(client.readSyncStatus(endpoint)).rejects.toThrow(ProtocolError)
    })

    it('surfaces an unparseable body as a protocol error', async () => {
      const { httpGet } = recordingHttp('<html>hello</html>')
      const client = new BluOSClient({ log: logger(), httpGet, ...fakeTiming() })

      await expect(client.readSyncStatus(endpoint)).rejects.toThrow(ProtocolError)
    })
  })
})
