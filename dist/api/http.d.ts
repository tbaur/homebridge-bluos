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
/** A completed HTTP response. */
export interface HttpResponse {
    status: number;
    body: string;
}
/** Per-request timing and size limits. */
export interface HttpGetOptions {
    /** Deadline for establishing the TCP connection. */
    connectTimeoutMs: number;
    /** Deadline for the whole exchange, including a long-poll hold. */
    totalTimeoutMs: number;
    /** Largest response body accepted, in bytes. */
    maxBytes: number;
    /** Cancels the request; used to drop long-polls at shutdown. */
    signal?: AbortSignal;
}
/** Performs one GET. Injectable so tests never touch a socket. */
export type HttpGet = (url: string, options: HttpGetOptions) => Promise<HttpResponse>;
/**
 * Performs one form-encoded POST. Injectable for the same reason as
 * {@link HttpGet}.
 */
export type HttpPost = (url: string, form: Record<string, string>, options: HttpGetOptions) => Promise<HttpResponse>;
/** GET a URL with independent connect and total deadlines. */
export declare const httpGet: HttpGet;
/**
 * POST a form-encoded body.
 *
 * Only reboot needs this: it is the one BluOS command that is not a GET. The
 * body is built with `URLSearchParams` rather than by hand so a value can never
 * break out of its field.
 */
export declare const httpPost: HttpPost;
