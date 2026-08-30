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
import type { PluginLogger } from './types';
/** npm package name. Must match `package.json` `name` for Homebridge to load us. */
export declare const PLUGIN_NAME = "homebridge-bluos";
/** Platform alias used in `config.json` and `config.schema.json`. */
export declare const PLATFORM_NAME = "BluOS";
/**
 * Namespace for generated accessory UUIDs.
 *
 * Deliberately does not include a host or port: seeding accessory identity with
 * an address means a DHCP lease change re-creates every accessory and destroys
 * the rooms, scenes and automations the user built on top of them.
 */
export declare const UUID_PREFIX = "homebridge-bluos:";
/**
 * Stands in for a player id on the accessories that belong to the platform.
 *
 * Only the "reboot everything" switch uses it. Accessory identity is built from
 * a device id, and that switch has no device, so it needs a value that is stable
 * for the life of the install and can never collide with a real player. A real
 * id is a MAC and port or a `gen-` UUID; neither can look like this.
 */
export declare const PLATFORM_DEVICE_ID = "platform:all";
/** Reported when `package.json` cannot be read. */
export declare const UNKNOWN_PLUGIN_VERSION = "0.0.0";
/** Manufacturer shown when `/SyncStatus` does not report a brand. */
export declare const DEFAULT_BRAND = "BluOS";
/** Model shown when `/SyncStatus` does not report one. */
export declare const DEFAULT_MODEL = "BluOS Player";
/** Control port for a primary player (API v1.7 section 1). */
export declare const DEFAULT_BLUOS_PORT = 11000;
/**
 * Ports the specification documents for multi-zone chassis.
 *
 * API v1.7 section 1: the CI 580 exposes four streamer nodes on one IP, using
 * 11000, 11010, 11020 and 11030. The CI S2 uses 11000 and 11010. Ports outside
 * this set are accepted but warned about, because mDNS SRV records are the
 * authority on which port a zone actually listens to.
 */
export declare const DOCUMENTED_BLUOS_PORTS: readonly number[];
/** Lowest port number accepted anywhere in configuration. */
export declare const MIN_PORT = 1;
/** Highest port number accepted anywhere in configuration. */
export declare const MAX_PORT = 65535;
/**
 * Duration passed as `/SyncStatus?timeout=`.
 *
 * The specification recommends 180 s for `/SyncStatus`, and forbids anything
 * faster than 10 s. 100 s is inside that envelope and halves the worst-case
 * delay before an unplugged player's socket read times out, which is how a
 * silent disappearance (as opposed to a connection reset) gets noticed.
 */
export declare const LONG_POLL_SEC = 100;
/** Read headroom beyond the player's own long-poll timeout. */
export declare const LONG_POLL_READ_SLACK_MS = 5000;
/**
 * Minimum gap between two consecutive requests for the same resource.
 *
 * API v1.7 section 2 makes this a requirement, not a suggestion: "a client must
 * not make two consecutive requests for the same resource less than one second
 * apart, even if the first request returns in less than one second".
 */
export declare const SAME_RESOURCE_MIN_GAP_MS = 1000;
/** Connect timeout. Short so a powered-off player cannot stall startup. */
export declare const CONNECT_TIMEOUT_MS = 2500;
/** Total timeout for a control call (`/Volume?level=`, `/Volume?mute=`). */
export declare const CONTROL_TIMEOUT_MS = 5000;
/** Total timeout for a plain, non-long-poll status read. */
export declare const STATUS_TIMEOUT_MS = 6000;
/**
 * Total timeout for a reboot request.
 *
 * Short on purpose. A player that is restarting cannot finish answering, so
 * waiting longer only delays the point at which we accept a half-finished
 * exchange as success. The sibling `bluos-controller` project uses 2 s against
 * the same fleet; this leaves a little more room for a busy player.
 */
export declare const REBOOT_TIMEOUT_MS = 3000;
/**
 * The reboot resource, and the parameters that arm it.
 *
 * The one command in the API that is POST rather than GET, and the only one
 * addressed without a BluOS port: `/reboot` is served on port 80 and answers 404
 * on the control ports. The body mirrors the confirmation form that page serves,
 * whose submit button is named `yes`. See the reboot section of
 * docs/PROTOCOL.md.
 */
export declare const REBOOT_RESOURCE = "reboot";
/** @see REBOOT_RESOURCE */
export declare const REBOOT_FORM: Readonly<Record<string, string>>;
/** Minimum spacing between control calls to one endpoint. */
export declare const CONTROL_RATE_LIMIT_MS = 100;
/** First reconnect delay after a failed poll. Doubles up to the ceiling. */
export declare const POLL_BACKOFF_BASE_MS = 2000;
/** Ceiling for poll backoff. */
export declare const POLL_BACKOFF_MAX_MS = 60000;
/** Consecutive poll failures before an accessory reports No Response. */
export declare const POLL_FAILURES_BEFORE_UNKNOWN = 3;
/** How long before a still-failing player is warned about again. */
export declare const POLL_FAILURE_REWARN_MS = 3600000;
/**
 * How long a HomeKit write may block before HAP gives up on it.
 *
 * HAP-NodeJS warns at `Accessory.TIMEOUT_WARNING` (3 s) and abandons the write
 * at 9 s total, returning `OPERATION_TIMED_OUT` and discarding whatever the
 * handler eventually returns. A set therefore has to answer well inside that
 * window and finish any slower work in the background.
 */
export declare const HOMEKIT_WRITE_BUDGET_MS = 2500;
/** Level restored when the slider is switched on and no previous level is known. */
export declare const DEFAULT_RESTORE_VOLUME = 20;
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
export declare const SLIDER_COALESCE_MS = 150;
/**
 * How long a momentary switch stays on before it springs back.
 *
 * A reboot switch has no state to report: the player is either restarting or it
 * is not, and neither is "on". Long enough that the Home app renders the press
 * so the user sees the tap registered, short enough that the tile is not left
 * looking like a thing that is still happening.
 */
export declare const MOMENTARY_RESET_MS = 1000;
/** Lowest BluOS volume level. */
export declare const VOLUME_MIN = 0;
/** Highest BluOS volume level. */
export declare const VOLUME_MAX = 100;
/**
 * `volume="-1"` means the player's output level is fixed.
 *
 * API v1.7 section 2.2: "-1 means fixed volume". Such a player must not be
 * given a volume slider; writing a level to it is meaningless.
 */
export declare const FIXED_VOLUME_SENTINEL = -1;
/**
 * `db="-100"` means silence, and is not a real output level.
 *
 * Measured on firmware 4.16.6: muting reports `volume="0" db="-100"` alongside
 * `muteVolume` and `muteDb` carrying the pre-mute values. Note that writing
 * `level=0` reports the same `db="-100"` with no `muteVolume`, so this value
 * cannot be used to detect mute — see `readMuted` in `api/sync-status.ts`.
 */
export declare const MUTED_DB_SENTINEL = -100;
/**
 * Largest `/SyncStatus` body accepted.
 *
 * Real responses measure a few hundred bytes; a fully grouped CI 580 is still
 * far under a kilobyte. 128 KiB is generous while keeping a hostile or
 * malfunctioning endpoint from growing the heap.
 */
export declare const MAX_XML_BYTES = 131072;
/** Deepest element nesting accepted. */
export declare const MAX_XML_DEPTH = 16;
/** Most elements accepted in one document. */
export declare const MAX_XML_ELEMENTS = 2000;
/** Most attributes accepted on one element. */
export declare const MAX_XML_ATTRIBUTES = 64;
/** mDNS service type advertised by primary players. */
export declare const MDNS_SERVICE_PRIMARY = "_musc._tcp.local";
/**
 * mDNS service type advertised by secondary zones of a multi-zone chassis.
 *
 * API v1.7 appendix 13.1 maps this to LSDP class 0x0003, "BluOS Player
 * (secondary in multi-zone players such as the CI580)".
 */
export declare const MDNS_SERVICE_SECONDARY = "_musp._tcp.local";
/** Default discovery window, in seconds. */
export declare const DEFAULT_DISCOVERY_TIMEOUT_SEC = 5;
/** Shortest configurable discovery window. */
export declare const MIN_DISCOVERY_TIMEOUT_SEC = 1;
/** Longest configurable discovery window. */
export declare const MAX_DISCOVERY_TIMEOUT_SEC = 30;
/** Consecutive poll failures before the platform tries to re-resolve an address. */
export declare const FAILURES_BEFORE_REDISCOVERY = 3;
/** Minimum gap between address re-resolution attempts. */
export declare const REDISCOVERY_MIN_INTERVAL_MS = 60000;
/**
 * Most records of one kind kept from a browse window.
 *
 * Anything on the segment can answer a multicast query, and a browse window can
 * be as long as 30 s, so the maps that accumulate advertisements need a ceiling
 * they cannot be talked past. A household fleet uses a handful of entries.
 */
export declare const MAX_DISCOVERY_RECORDS = 256;
/**
 * Most candidate endpoints verified from one browse.
 *
 * Verification opens a real connection per candidate, so the count of
 * advertisements must not decide how many sockets this plugin opens.
 */
export declare const MAX_DISCOVERY_CANDIDATES = 64;
/** Candidate endpoints verified at once. Bounds concurrent sockets during a sweep. */
export declare const DISCOVERY_VERIFY_CONCURRENCY = 6;
/** Longest untrusted string interpolated into a log line. */
export declare const MAX_LOG_FIELD_LENGTH = 100;
/** Longest accepted HomeKit display name. */
export declare const MAX_NAME_LENGTH = 64;
/**
 * Read this plugin's version from `package.json`.
 *
 * Reported to HomeKit as FirmwareRevision, which makes the version visible in
 * the Home app and therefore in bug reports.
 */
export declare function readPluginVersion(log?: PluginLogger): string;
