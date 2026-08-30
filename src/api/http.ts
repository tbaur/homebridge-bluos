/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Minimal HTTP against a BluOS player.
 *
 * Built on `node:http` rather than `fetch` for two reasons.
 *
 * Separate connect and total timeouts. A long-poll legitimately takes 100
 * seconds, but a powered-off player must fail in a couple of seconds rather
 * than holding a slot for the full poll window. `AbortSignal.timeout` only
 * expresses one deadline, so `fetch` cannot say "connect fast, then wait".
 *
 * No connection reuse, deliberately. Measured on firmware 4.16.6, a control
 * call to a player completes in ~31 ms while that same endpoint has a
 * `/SyncStatus` long-poll held open — but only because the two used different
 * TCP connections. Sharing one keep-alive socket per endpoint would queue the
 * write behind the held poll, which is the problem other BluOS clients solve
 * with an explicit "drop the hold before writing" dance. Opening a fresh
 * connection each time removes the failure mode instead of managing it, and on
 * a LAN a handshake every hundred seconds costs nothing.
 *
 * GET covers the whole API bar one. Reboot is POST, so the machinery below is
 * shared rather than duplicated: the timeout handling is the subtle part, and
 * two copies of it would drift.
 */

import http from 'node:http'

import { ConnectionError, ProtocolError } from '../utils/errors'

/** A completed HTTP response. */
export interface HttpResponse {
  status: number
  body: string
}

/** Per-request timing and size limits. */
export interface HttpGetOptions {
  /** Deadline for establishing the TCP connection. */
  connectTimeoutMs: number
  /** Deadline for the whole exchange, including a long-poll hold. */
  totalTimeoutMs: number
  /** Largest response body accepted, in bytes. */
  maxBytes: number
  /** Cancels the request; used to drop long-polls at shutdown. */
  signal?: AbortSignal
}

/** Performs one GET. Injectable so tests never touch a socket. */
export type HttpGet = (url: string, options: HttpGetOptions) => Promise<HttpResponse>

/**
 * Performs one form-encoded POST. Injectable for the same reason as
 * {@link HttpGet}.
 */
export type HttpPost = (
  url: string,
  form: Record<string, string>,
  options: HttpGetOptions,
) => Promise<HttpResponse>

/**
 * Issue one request with independent connect and total deadlines.
 *
 * Rejects with {@link ConnectionError} for anything that prevented an answer,
 * and {@link ProtocolError} when the answer arrived but was unusable (over the
 * size cap). Redirects are not followed: BluOS control endpoints do not issue
 * them, and blindly following one would let a compromised player redirect us
 * at an arbitrary host.
 *
 * Every `ConnectionError` carries whether the request had already reached the
 * socket, so a caller that can treat a half-finished exchange as success — only
 * reboot — is able to tell the two apart. See {@link ConnectionError}.
 */
function perform(
  method: 'GET' | 'POST',
  url: string,
  options: HttpGetOptions,
  body?: string,
): Promise<HttpResponse> {
  const { connectTimeoutMs, totalTimeoutMs, maxBytes, signal } = options

  return new Promise<HttpResponse>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new ConnectionError('request aborted before it started'))
      return
    }

    let settled = false
    // Delivery needs both halves. `finish` alone is not enough: Node buffers a
    // request whose socket has not connected yet and emits `finish` regardless,
    // so a connection that never completed would otherwise claim the player had
    // heard us.
    let connected = false
    let written = false
    let onAbort: (() => void) | undefined
    // Held in a container because `cleanup` closes over it before the timer that
    // fills it in can be created: the timer's callback needs `fail`, and `fail`
    // needs `cleanup`.
    const timers: { total?: ReturnType<typeof setTimeout> } = {}

    const headers: Record<string, string> = body === undefined
      ? {}
      : {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Explicit, so the request never falls back to chunked encoding. A
        // player's minimal HTTP server is likelier to handle a plain body.
        'Content-Length': String(Buffer.byteLength(body)),
      }

    // `agent: false` gives this request its own connection and closes it after.
    const request = http.request(url, { method, agent: false, headers }, (response) => {
      const chunks: Buffer[] = []
      let received = 0

      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > maxBytes) {
          fail(new ProtocolError(`response exceeds ${maxBytes} bytes`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        finish({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.on('error', (error) => {
        fail(new ConnectionError('response stream failed', { cause: error }))
      })
    })

    const cleanup = (): void => {
      if (timers.total !== undefined) {
        clearTimeout(timers.total)
      }
      if (onAbort !== undefined) {
        signal?.removeEventListener('abort', onAbort)
      }
    }

    const finish = (response: HttpResponse): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(response)
    }

    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      request.destroy()
      reject(
        error instanceof ConnectionError && connected && written
          ? new ConnectionError(error.message, { cause: error.cause, delivered: true })
          : error,
      )
    }

    request.on('finish', () => {
      written = true
    })

    // Applies until the socket connects, then swapped for the total deadline.
    request.setTimeout(connectTimeoutMs, () => {
      fail(new ConnectionError(`connect timed out after ${connectTimeoutMs}ms`))
    })

    request.on('socket', (socket) => {
      const onConnect = (): void => {
        // Connected: inactivity is now expected, because a long-poll is idle by
        // design. The total deadline below is what bounds the request from here.
        connected = true
        request.setTimeout(0)
        socket.setNoDelay(true)
      }
      if (socket.connecting) {
        socket.once('connect', onConnect)
      } else {
        onConnect()
      }
    })

    request.on('error', (error) => {
      fail(new ConnectionError('request failed', { cause: error }))
    })

    // Referenced on purpose, and always cleared in `cleanup`: a caller is
    // awaiting this request, so the process must not be free to exit under it.
    timers.total = setTimeout(() => {
      fail(new ConnectionError(`request timed out after ${totalTimeoutMs}ms`))
    }, totalTimeoutMs)

    if (signal !== undefined) {
      onAbort = (): void => {
        fail(new ConnectionError('request aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    request.end(body)
  })
}

/** GET a URL with independent connect and total deadlines. */
export const httpGet: HttpGet = (url, options) => perform('GET', url, options)

/**
 * POST a form-encoded body.
 *
 * Only reboot needs this: it is the one BluOS command that is not a GET. The
 * body is built with `URLSearchParams` rather than by hand so a value can never
 * break out of its field.
 */
export const httpPost: HttpPost = (url, form, options) => (
  perform('POST', url, options, new URLSearchParams(form).toString())
)
