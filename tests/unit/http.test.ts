/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Exercised against a loopback server rather than a mocked `node:http`, because
 * what is being tested is socket behaviour: that the connect deadline stops
 * applying once a long-poll goes idle, that the total deadline still bounds it,
 * and that a fresh connection is used per request so a write is never queued
 * behind a held poll.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { httpGet, httpPost } from '../../src/api/http'
import { ConnectionError, ProtocolError } from '../../src/utils/errors'

interface Server {
  url: (path?: string) => string
  close: () => Promise<void>
  /** Sockets the server accepted, to prove connections are not reused. */
  connections: number
  release: () => void
}

/** Start a loopback server. `handler` may hold a response open. */
async function start(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<Server> {
  const state = { connections: 0 }
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  const server = http.createServer((request, response) => {
    void held.then(() => undefined)
    handler(request, response)
  })
  server.on('connection', () => {
    state.connections += 1
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  return {
    url: (path = '/SyncStatus') => `http://127.0.0.1:${port}${path}`,
    close: async () => {
      release()
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
    get connections() {
      return state.connections
    },
    release: () => release(),
  }
}

const limits = { connectTimeoutMs: 1_000, totalTimeoutMs: 2_000, maxBytes: 4_096 }

describe('httpGet', () => {
  let server: Server | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('returns the status and body', async () => {
    server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/xml' })
      response.end('<volume mute="0">41</volume>')
    })

    await expect(httpGet(server.url(), limits)).resolves.toEqual({
      status: 200,
      body: '<volume mute="0">41</volume>',
    })
  })

  it('reports a non-200 status rather than throwing, leaving the decision to the caller', async () => {
    server = await start((_request, response) => {
      response.writeHead(404)
      response.end('nope')
    })

    await expect(httpGet(server.url(), limits)).resolves.toMatchObject({ status: 404 })
  })

  it('reassembles a chunked body', async () => {
    server = await start((_request, response) => {
      response.writeHead(200)
      response.write('<volume')
      response.write(' mute="0">41</volume>')
      response.end()
    })

    await expect(httpGet(server.url(), limits)).resolves.toMatchObject({
      body: '<volume mute="0">41</volume>',
    })
  })

  it('rejects a body over the size cap', async () => {
    server = await start((_request, response) => {
      response.writeHead(200)
      response.end('x'.repeat(200))
    })

    await expect(httpGet(server.url(), { ...limits, maxBytes: 64 }))
      .rejects.toThrow(ProtocolError)
  })

  it('bounds a request that connects but never answers', async () => {
    // The long-poll case: idle is expected, so only the total deadline applies.
    server = await start(() => undefined)

    await expect(httpGet(server.url(), { ...limits, totalTimeoutMs: 250 }))
      .rejects.toThrow(/timed out after 250ms/)
  })

  it('does not apply the connect deadline to an idle held response', async () => {
    server = await start((_request, response) => {
      // Answers after longer than the connect deadline allows.
      setTimeout(() => {
        response.writeHead(200)
        response.end('<volume mute="0">7</volume>')
      }, 250)
    })

    await expect(httpGet(server.url(), { ...limits, connectTimeoutMs: 60 }))
      .resolves.toMatchObject({ body: '<volume mute="0">7</volume>' })
  })

  it('fails a connection that is refused', async () => {
    // Port 1 on loopback with nothing listening.
    await expect(httpGet('http://127.0.0.1:1/SyncStatus', limits))
      .rejects.toThrow(ConnectionError)
  })

  it('uses a separate connection per request, so a write cannot queue behind a poll', async () => {
    server = await start((_request, response) => {
      response.writeHead(200)
      response.end('<volume mute="0">1</volume>')
    })

    await httpGet(server.url(), limits)
    await httpGet(server.url('/Volume'), limits)

    expect(server.connections).toBe(2)
  })

  it('honours an abort signal', async () => {
    server = await start(() => undefined)
    const controller = new AbortController()
    // Left running to show that one abort does not disturb the other request;
    // its rejection at teardown is expected and swallowed.
    const untouched = httpGet(server.url(), limits).catch(() => 'torn down at teardown')
    const aborted = httpGet(server.url(), { ...limits, signal: controller.signal })

    controller.abort()

    await expect(aborted).rejects.toThrow(/aborted/)
    await expect(Promise.race([untouched, Promise.resolve('still running')]))
      .resolves.toBe('still running')
  })

  it('refuses immediately when the signal is already aborted', async () => {
    server = await start((_request, response) => {
      response.end('unused')
    })
    const signal = AbortSignal.abort()

    await expect(httpGet(server.url(), { ...limits, signal }))
      .rejects.toThrow(/aborted before it started/)
    expect(server.connections).toBe(0)
  })
})

describe('httpPost', () => {
  let server: Server | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** Start a server that echoes back what it was sent. */
  async function echo(): Promise<Server> {
    return start((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(JSON.stringify({
          method: request.method,
          contentType: request.headers['content-type'],
          contentLength: request.headers['content-length'],
          body,
        }))
      })
    })
  }

  it('sends a form-encoded body with an explicit length', async () => {
    // Explicit rather than chunked: a player's minimal HTTP server is likelier
    // to handle a plain body than a chunked one.
    server = await echo()

    const response = await httpPost(server.url('/reboot'), { yes: '1' }, limits)

    expect(JSON.parse(response.body)).toEqual({
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      contentLength: '5',
      body: 'yes=1',
    })
  })

  it('encodes values so one cannot break out of its field', async () => {
    server = await echo()

    const response = await httpPost(server.url('/reboot'), { yes: '1&admin=1' }, limits)

    expect(JSON.parse(response.body).body).toBe('yes=1%26admin%3D1')
  })

  it('reports a non-200 status rather than throwing', async () => {
    server = await start((_request, response) => {
      response.writeHead(404)
      response.end('nope')
    })

    await expect(httpPost(server.url('/reboot'), { yes: '1' }, limits))
      .resolves.toMatchObject({ status: 404 })
  })

  it('does not claim delivery when it never connected', async () => {
    // The distinction reboot depends on: nothing was sent, so nothing rebooted.
    const failure = await httpPost('http://127.0.0.1:1/reboot', { yes: '1' }, limits)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionError)
    expect((failure as ConnectionError).delivered).toBe(false)
  })

  it('reports delivery when the player took the request and then dropped the socket', async () => {
    // What a rebooting player does: accepts the request, then dies before it can
    // answer. The plugin reads that as success.
    server = await start((request) => {
      request.on('end', () => {
        request.socket.destroy()
      })
      request.resume()
    })

    const failure = await httpPost(server.url('/reboot'), { yes: '1' }, limits)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionError)
    expect((failure as ConnectionError).delivered).toBe(true)
  })
})
