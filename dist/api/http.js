"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Minimal HTTP GET against a BluOS player.
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
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpGet = void 0;
const node_http_1 = __importDefault(require("node:http"));
const errors_1 = require("../utils/errors");
/**
 * GET a URL with independent connect and total deadlines.
 *
 * Rejects with {@link ConnectionError} for anything that prevented an answer,
 * and {@link ProtocolError} when the answer arrived but was unusable (over the
 * size cap). Redirects are not followed: BluOS control endpoints do not issue
 * them, and blindly following one would let a compromised player redirect us
 * at an arbitrary host.
 */
const httpGet = (url, options) => {
    const { connectTimeoutMs, totalTimeoutMs, maxBytes, signal } = options;
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new errors_1.ConnectionError('request aborted before it started'));
            return;
        }
        let settled = false;
        let onAbort;
        // Held in a container because `cleanup` closes over it before the timer that
        // fills it in can be created: the timer's callback needs `fail`, and `fail`
        // needs `cleanup`.
        const timers = {};
        // `agent: false` gives this request its own connection and closes it after.
        const request = node_http_1.default.get(url, { agent: false }, (response) => {
            const chunks = [];
            let received = 0;
            response.on('data', (chunk) => {
                received += chunk.length;
                if (received > maxBytes) {
                    fail(new errors_1.ProtocolError(`response exceeds ${maxBytes} bytes`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                finish({
                    status: response.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            });
            response.on('error', (error) => {
                fail(new errors_1.ConnectionError('response stream failed', { cause: error }));
            });
        });
        const cleanup = () => {
            if (timers.total !== undefined) {
                clearTimeout(timers.total);
            }
            if (onAbort !== undefined) {
                signal?.removeEventListener('abort', onAbort);
            }
        };
        const finish = (response) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(response);
        };
        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            request.destroy();
            reject(error);
        };
        // Applies until the socket connects, then swapped for the total deadline.
        request.setTimeout(connectTimeoutMs, () => {
            fail(new errors_1.ConnectionError(`connect timed out after ${connectTimeoutMs}ms`));
        });
        request.on('socket', (socket) => {
            const onConnect = () => {
                // Connected: inactivity is now expected, because a long-poll is idle by
                // design. The total deadline below is what bounds the request from here.
                request.setTimeout(0);
                socket.setNoDelay(true);
            };
            if (socket.connecting) {
                socket.once('connect', onConnect);
            }
            else {
                onConnect();
            }
        });
        request.on('error', (error) => {
            fail(new errors_1.ConnectionError('request failed', { cause: error }));
        });
        // Referenced on purpose, and always cleared in `cleanup`: a caller is
        // awaiting this request, so the process must not be free to exit under it.
        timers.total = setTimeout(() => {
            fail(new errors_1.ConnectionError(`request timed out after ${totalTimeoutMs}ms`));
        }, totalTimeoutMs);
        if (signal !== undefined) {
            onAbort = () => {
                fail(new errors_1.ConnectionError('request aborted'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
};
exports.httpGet = httpGet;
