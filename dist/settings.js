"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Plugin-wide constants and the plugin version reader.
 *
 * Numbers that came from the BluOS Custom Integration API v1.7 specification or
 * from measurements against real players cite their source, so a future reader
 * can tell a vendor requirement apart from a judgement call.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_NAME_LENGTH = exports.MAX_LOG_FIELD_LENGTH = exports.DISCOVERY_VERIFY_CONCURRENCY = exports.MAX_DISCOVERY_CANDIDATES = exports.MAX_DISCOVERY_RECORDS = exports.REDISCOVERY_MIN_INTERVAL_MS = exports.FAILURES_BEFORE_REDISCOVERY = exports.MAX_DISCOVERY_TIMEOUT_SEC = exports.MIN_DISCOVERY_TIMEOUT_SEC = exports.DEFAULT_DISCOVERY_TIMEOUT_SEC = exports.MDNS_SERVICE_SECONDARY = exports.MDNS_SERVICE_PRIMARY = exports.MAX_XML_ATTRIBUTES = exports.MAX_XML_ELEMENTS = exports.MAX_XML_DEPTH = exports.MAX_XML_BYTES = exports.MUTED_DB_SENTINEL = exports.FIXED_VOLUME_SENTINEL = exports.VOLUME_MAX = exports.VOLUME_MIN = exports.SLIDER_COALESCE_MS = exports.DEFAULT_RESTORE_VOLUME = exports.HOMEKIT_WRITE_BUDGET_MS = exports.POLL_FAILURE_REWARN_MS = exports.POLL_FAILURES_BEFORE_UNKNOWN = exports.POLL_BACKOFF_MAX_MS = exports.POLL_BACKOFF_BASE_MS = exports.CONTROL_RATE_LIMIT_MS = exports.STATUS_TIMEOUT_MS = exports.CONTROL_TIMEOUT_MS = exports.CONNECT_TIMEOUT_MS = exports.SAME_RESOURCE_MIN_GAP_MS = exports.LONG_POLL_READ_SLACK_MS = exports.LONG_POLL_SEC = exports.MAX_PORT = exports.MIN_PORT = exports.DOCUMENTED_BLUOS_PORTS = exports.DEFAULT_BLUOS_PORT = exports.DEFAULT_MODEL = exports.DEFAULT_BRAND = exports.UNKNOWN_PLUGIN_VERSION = exports.UUID_PREFIX = exports.PLATFORM_NAME = exports.PLUGIN_NAME = void 0;
exports.readPluginVersion = readPluginVersion;
/** npm package name. Must match `package.json` `name` for Homebridge to load us. */
exports.PLUGIN_NAME = 'homebridge-bluos';
/** Platform alias used in `config.json` and `config.schema.json`. */
exports.PLATFORM_NAME = 'BluOS';
/**
 * Namespace for generated accessory UUIDs.
 *
 * Deliberately does not include a host or port: seeding accessory identity with
 * an address means a DHCP lease change re-creates every accessory and destroys
 * the rooms, scenes and automations the user built on top of them.
 */
exports.UUID_PREFIX = 'homebridge-bluos:';
/** Reported when `package.json` cannot be read. */
exports.UNKNOWN_PLUGIN_VERSION = '0.0.0';
/** Manufacturer shown when `/SyncStatus` does not report a brand. */
exports.DEFAULT_BRAND = 'BluOS';
/** Model shown when `/SyncStatus` does not report one. */
exports.DEFAULT_MODEL = 'BluOS Player';
// --- Endpoints -------------------------------------------------------------
/** Control port for a primary player (API v1.7 section 1). */
exports.DEFAULT_BLUOS_PORT = 11_000;
/**
 * Ports the specification documents for multi-zone chassis.
 *
 * API v1.7 section 1: the CI 580 exposes four streamer nodes on one IP, using
 * 11000, 11010, 11020 and 11030. The CI-S2 uses 11000 and 11010. Ports outside
 * this set are accepted but warned about, because mDNS SRV records are the
 * authority on which port a zone actually listens to.
 */
exports.DOCUMENTED_BLUOS_PORTS = [11_000, 11_010, 11_020, 11_030];
/** Lowest port number accepted anywhere in configuration. */
exports.MIN_PORT = 1;
/** Highest port number accepted anywhere in configuration. */
exports.MAX_PORT = 65_535;
// --- Polling ---------------------------------------------------------------
/**
 * Duration passed as `/SyncStatus?timeout=`.
 *
 * The specification recommends 180 s for `/SyncStatus`, and forbids anything
 * faster than 10 s. 100 s is inside that envelope and halves the worst-case
 * delay before an unplugged player's socket read times out, which is how a
 * silent disappearance (as opposed to a connection reset) gets noticed.
 */
exports.LONG_POLL_SEC = 100;
/** Read headroom beyond the player's own long-poll timeout. */
exports.LONG_POLL_READ_SLACK_MS = 5_000;
/**
 * Minimum gap between two consecutive requests for the same resource.
 *
 * API v1.7 section 2 makes this a requirement, not a suggestion: "a client must
 * not make two consecutive requests for the same resource less than one second
 * apart, even if the first request returns in less than one second".
 */
exports.SAME_RESOURCE_MIN_GAP_MS = 1_000;
/** Connect timeout. Short so a powered-off player cannot stall startup. */
exports.CONNECT_TIMEOUT_MS = 2_500;
/** Total timeout for a control call (`/Volume?level=`, `/Volume?mute=`). */
exports.CONTROL_TIMEOUT_MS = 5_000;
/** Total timeout for a plain, non-long-poll status read. */
exports.STATUS_TIMEOUT_MS = 6_000;
/** Minimum spacing between control calls to one endpoint. */
exports.CONTROL_RATE_LIMIT_MS = 100;
/** First reconnect delay after a failed poll. Doubles up to the ceiling. */
exports.POLL_BACKOFF_BASE_MS = 2_000;
/** Ceiling for poll backoff. */
exports.POLL_BACKOFF_MAX_MS = 60_000;
/** Consecutive poll failures before an accessory reports No Response. */
exports.POLL_FAILURES_BEFORE_UNKNOWN = 3;
/** How long before a still-failing player is warned about again. */
exports.POLL_FAILURE_REWARN_MS = 3_600_000;
// --- HomeKit ---------------------------------------------------------------
/**
 * How long a HomeKit write may block before HAP gives up on it.
 *
 * HAP-NodeJS warns at `Accessory.TIMEOUT_WARNING` (3 s) and abandons the write
 * at 9 s total, returning `OPERATION_TIMED_OUT` and discarding whatever the
 * handler eventually returns. A set therefore has to answer well inside that
 * window and finish any slower work in the background.
 */
exports.HOMEKIT_WRITE_BUDGET_MS = 2_500;
/** Level restored when the slider is switched on and no previous level is known. */
exports.DEFAULT_RESTORE_VOLUME = 20;
/**
 * Window for coalescing the pair of writes HomeKit sends when a slider moves
 * from off.
 *
 * Dragging a Fanv2 up from zero produces an `Active` write immediately followed
 * by a `RotationSpeed` write. Acting on both would set the restore level and then
 * the requested level, which the user hears as a jump. Waiting briefly lets the
 * second write supersede the first, so one value reaches the player. Short enough
 * to be imperceptible next to the LAN round trip.
 */
exports.SLIDER_COALESCE_MS = 150;
// --- Volume ----------------------------------------------------------------
/** Lowest BluOS volume level. */
exports.VOLUME_MIN = 0;
/** Highest BluOS volume level. */
exports.VOLUME_MAX = 100;
/**
 * `volume="-1"` means the player's output level is fixed.
 *
 * API v1.7 section 2.2: "-1 means fixed volume". Such a player must not be
 * given a volume slider; writing a level to it is meaningless.
 */
exports.FIXED_VOLUME_SENTINEL = -1;
/**
 * `db="-100"` means silence, and is not a real output level.
 *
 * Measured on firmware 4.16.6: muting reports `volume="0" db="-100"` alongside
 * `muteVolume` and `muteDb` carrying the pre-mute values. Note that writing
 * `level=0` reports the same `db="-100"` with no `muteVolume`, so this value
 * cannot be used to detect mute — see `readMuted` in `api/sync-status.ts`.
 */
exports.MUTED_DB_SENTINEL = -100;
// --- XML parsing -----------------------------------------------------------
/**
 * Largest `/SyncStatus` body accepted.
 *
 * Real responses measure a few hundred bytes; a fully grouped CI 580 is still
 * far under a kilobyte. 128 KiB is generous while keeping a hostile or
 * malfunctioning endpoint from growing the heap.
 */
exports.MAX_XML_BYTES = 131_072;
/** Deepest element nesting accepted. */
exports.MAX_XML_DEPTH = 16;
/** Most elements accepted in one document. */
exports.MAX_XML_ELEMENTS = 2_000;
/** Most attributes accepted on one element. */
exports.MAX_XML_ATTRIBUTES = 64;
// --- Discovery -------------------------------------------------------------
/** mDNS service type advertised by primary players. */
exports.MDNS_SERVICE_PRIMARY = '_musc._tcp.local';
/**
 * mDNS service type advertised by secondary zones of a multi-zone chassis.
 *
 * API v1.7 appendix 13.1 maps this to LSDP class 0x0003, "BluOS Player
 * (secondary in multi-zone players such as the CI580)".
 */
exports.MDNS_SERVICE_SECONDARY = '_musp._tcp.local';
/** Default discovery window, in seconds. */
exports.DEFAULT_DISCOVERY_TIMEOUT_SEC = 5;
/** Shortest configurable discovery window. */
exports.MIN_DISCOVERY_TIMEOUT_SEC = 1;
/** Longest configurable discovery window. */
exports.MAX_DISCOVERY_TIMEOUT_SEC = 30;
/** Consecutive poll failures before the platform tries to re-resolve an address. */
exports.FAILURES_BEFORE_REDISCOVERY = 3;
/** Minimum gap between address re-resolution attempts. */
exports.REDISCOVERY_MIN_INTERVAL_MS = 60_000;
/**
 * Most records of one kind kept from a browse window.
 *
 * Anything on the segment can answer a multicast query, and a browse window can
 * be as long as 30 s, so the maps that accumulate advertisements need a ceiling
 * they cannot be talked past. A household fleet uses a handful of entries.
 */
exports.MAX_DISCOVERY_RECORDS = 256;
/**
 * Most candidate endpoints verified from one browse.
 *
 * Verification opens a real connection per candidate, so the count of
 * advertisements must not decide how many sockets this plugin opens.
 */
exports.MAX_DISCOVERY_CANDIDATES = 64;
/** Candidate endpoints verified at once. Bounds concurrent sockets during a sweep. */
exports.DISCOVERY_VERIFY_CONCURRENCY = 6;
// --- Logging ---------------------------------------------------------------
/** Longest untrusted string interpolated into a log line. */
exports.MAX_LOG_FIELD_LENGTH = 100;
/** Longest accepted HomeKit display name. */
exports.MAX_NAME_LENGTH = 64;
let cachedVersion;
/**
 * Read this plugin's version from `package.json`.
 *
 * Reported to HomeKit as FirmwareRevision, which makes the version visible in
 * the Home app and therefore in bug reports.
 */
function readPluginVersion(log) {
    if (cachedVersion !== undefined) {
        return cachedVersion;
    }
    try {
        const pkg = require('../package.json');
        cachedVersion = typeof pkg.version === 'string' && pkg.version.length > 0
            ? pkg.version
            : exports.UNKNOWN_PLUGIN_VERSION;
    }
    catch (error) {
        log?.debug(`could not read plugin version: ${String(error)}`);
        cachedVersion = exports.UNKNOWN_PLUGIN_VERSION;
    }
    return cachedVersion;
}
