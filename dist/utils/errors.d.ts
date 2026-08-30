/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Error description helpers.
 *
 * Node wraps low-level network failures in `cause` chains, so a bare
 * `error.message` frequently reads "fetch failed" while the useful detail
 * (ECONNREFUSED, ETIMEDOUT) sits one level down.
 */
/**
 * Describe an error, including any `cause` chain, for a single log line.
 *
 * Control characters are stripped: an error message can contain remote input,
 * and a newline inside a log line lets an attacker forge log entries.
 */
export declare function describeError(error: unknown): string;
/** Describe an error and append its stack, for `log.debug` only. */
export declare function describeErrorStack(error: unknown): string;
/** Raised when configuration cannot produce a usable accessory set. */
export declare class ConfigValidationError extends Error {
    constructor(message: string);
}
/** Raised when a player answers, but not with something we can parse. */
export declare class ProtocolError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/**
 * Raised when a player cannot be reached at all.
 *
 * `delivered` records whether the request had already been written to the socket
 * when the failure happened, which separates "the player never heard us" from
 * "the player heard us and then stopped talking". It matters for exactly one
 * caller: a reboot request that went out and then lost its connection has almost
 * certainly succeeded, because a player that is restarting is a player that
 * cannot finish answering. Every other call treats both alike.
 */
export declare class ConnectionError extends Error {
    readonly delivered: boolean;
    constructor(message: string, options?: {
        cause?: unknown;
        delivered?: boolean;
    });
}
