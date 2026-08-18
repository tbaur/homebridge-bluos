"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionError = exports.ProtocolError = exports.ConfigValidationError = void 0;
exports.describeError = describeError;
exports.describeErrorStack = describeErrorStack;
/** Longest description produced, so a hostile endpoint cannot flood the log. */
const MAX_DESCRIPTION_LENGTH = 300;
function messageOf(error) {
    if (error instanceof Error) {
        const code = error.code;
        return typeof code === 'string' && code.length > 0
            ? `${error.message} (${code})`
            : error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error) ?? String(error);
    }
    catch {
        return String(error);
    }
}
/**
 * Describe an error, including any `cause` chain, for a single log line.
 *
 * Control characters are stripped: an error message can contain remote input,
 * and a newline inside a log line lets an attacker forge log entries.
 */
function describeError(error) {
    const parts = [];
    let current = error;
    const seen = new Set();
    while (current !== undefined && current !== null && !seen.has(current)) {
        seen.add(current);
        const text = messageOf(current);
        if (text.length > 0 && !parts.includes(text)) {
            parts.push(text);
        }
        current = current instanceof Error ? current.cause : undefined;
    }
    const joined = parts.length > 0 ? parts.join(': ') : 'unknown error';
    const sanitized = joined.replace(/[\u0000-\u001F\u007F]/g, '\uFFFD');
    return sanitized.length > MAX_DESCRIPTION_LENGTH
        ? `${sanitized.slice(0, MAX_DESCRIPTION_LENGTH)}\u2026`
        : sanitized;
}
/** Describe an error and append its stack, for `log.debug` only. */
function describeErrorStack(error) {
    const description = describeError(error);
    if (error instanceof Error && typeof error.stack === 'string') {
        return `${description}\n${error.stack}`;
    }
    return description;
}
/** Raised when configuration cannot produce a usable accessory set. */
class ConfigValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigValidationError';
    }
}
exports.ConfigValidationError = ConfigValidationError;
/** Raised when a player answers, but not with something we can parse. */
class ProtocolError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'ProtocolError';
    }
}
exports.ProtocolError = ProtocolError;
/** Raised when a player cannot be reached at all. */
class ConnectionError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'ConnectionError';
    }
}
exports.ConnectionError = ConnectionError;
