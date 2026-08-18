/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The failure paths a loopback server cannot produce on demand.
 *
 * `http.test.ts` covers everything a real socket can be made to do. Three paths
 * cannot be provoked that way without a race: the connect deadline (loopback
 * connects too fast to lose), a socket that is already connected when the
 * `socket` event fires, and a response stream that errors after its headers
 * arrived. Those are the paths that only run when the network misbehaves, which
 * is the whole reason this module exists rather than `fetch`, so they are driven
 * here through a stand-in for `node:http`.
 */

import type { EventEmitter } from 'node:events'

import { httpGet } from '../../src/api/http'
import { ConnectionError } from '../../src/utils/errors'

interface FakeRequest extends EventEmitter {
  readonly timeouts: { ms: number, handler?: () => void }[]
  destroyed: boolean
  setTimeout: (ms: number, handler?: () => void) => FakeRequest
  destroy: () => FakeRequest
}

interface FakeResponse extends EventEmitter {
  statusCode?: number
}

jest.mock('node:http', () => {
  // Required inside the factory because jest hoists this above the imports.
  const { EventEmitter: Emitter } = require('node:events') as typeof import('node:events')

  class Request extends Emitter {
    readonly timeouts: { ms: number, handler?: () => void }[] = []

    destroyed = false

    setTimeout(ms: number, handler?: () => void): this {
      this.timeouts.push({ ms, handler })
      return this
    }

    destroy(): this {
      this.destroyed = true
      return this
    }
  }

  const state: {
    request?: Request
    onResponse?: (response: EventEmitter) => void
  } = {}

  return {
    __esModule: true,
    __state: state,
    default: {
      get: (
        _url: string,
        _options: unknown,
        onResponse: (response: EventEmitter) => void,
      ): Request => {
        const request = new Request()
        state.request = request
        state.onResponse = onResponse
        return request
      },
    },
  }
})

const mocked = jest.requireMock('node:http') as {
  __state: { request?: FakeRequest, onResponse?: (response: FakeResponse) => void }
}

const limits = { connectTimeoutMs: 40, totalTimeoutMs: 500, maxBytes: 4_096 }

/** The request the module under test created, once it has created one. */
function request(): FakeRequest {
  const created = mocked.__state.request
  if (created === undefined) {
    throw new Error('no request was made')
  }
  return created
}

/** Hands a response to the module under test, as `node:http` would. */
function respond(): FakeResponse {
  const onResponse = mocked.__state.onResponse
  if (onResponse === undefined) {
    throw new Error('no response listener was registered')
  }
  const response = new (require('node:events') as typeof import('node:events'))
    .EventEmitter() as FakeResponse
  response.statusCode = 200
  onResponse(response)
  return response
}

describe('httpGet when the network misbehaves', () => {
  beforeEach(() => {
    mocked.__state.request = undefined
    mocked.__state.onResponse = undefined
  })

  it('fails a connection that never completes, without waiting out the total deadline', async () => {
    const pending = httpGet('http://192.168.4.10:11000/SyncStatus', limits)
    const connect = request().timeouts[0]

    expect(connect?.ms).toBe(40)
    connect?.handler?.()

    await expect(pending).rejects.toThrow(ConnectionError)
    await expect(pending).rejects.toThrow(/connect timed out after 40ms/)
    expect(request().destroyed).toBe(true)
  })

  it('stops applying the connect deadline to a socket that was already connected', async () => {
    // With `agent: false` the connection is usually still in flight when the
    // socket arrives, but a socket handed over already connected must take the
    // same path: a held long-poll is idle by design and must not be timed out.
    const pending = httpGet('http://192.168.4.10:11000/SyncStatus', limits)
    const setNoDelay = jest.fn()
    request().emit('socket', { connecting: false, setNoDelay, once: jest.fn() })

    expect(request().timeouts.map((entry) => entry.ms)).toEqual([40, 0])
    expect(setNoDelay).toHaveBeenCalledWith(true)

    const response = respond()
    response.emit('end')

    await expect(pending).resolves.toMatchObject({ status: 200, body: '' })
  })

  it('fails a response stream that breaks after its headers arrived', async () => {
    const pending = httpGet('http://192.168.4.10:11000/SyncStatus', limits)
    const response = respond()
    response.emit('data', Buffer.from('<SyncStatus'))
    response.emit('error', new Error('socket hang up'))

    await expect(pending).rejects.toThrow(ConnectionError)
    await expect(pending).rejects.toThrow(/response stream failed/)
    expect(request().destroyed).toBe(true)
  })

  it('keeps the first failure, so a later one cannot change the answer', async () => {
    const pending = httpGet('http://192.168.4.10:11000/SyncStatus', limits)
    const response = respond()
    response.emit('error', new Error('first'))
    request().emit('error', new Error('second'))

    await expect(pending).rejects.toThrow(/response stream failed/)
  })
})
