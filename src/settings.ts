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

import type { PluginLogger } from './types'

/** npm package name. Must match `package.json` `name` for Homebridge to load us. */
export const PLUGIN_NAME = 'homebridge-bluos'

/** Platform alias used in `config.json` and `config.schema.json`. */
export const PLATFORM_NAME = 'BluOS'

/**
 * Namespace for generated accessory UUIDs.
 *
 * Deliberately does not include a host or port: seeding accessory identity with
 * an address means a DHCP lease change re-creates every accessory and destroys
 * the rooms, scenes and automations the user built on top of them.
 */
export const UUID_PREFIX = 'homebridge-bluos:'

/**
 * Stands in for a player id on the accessories that belong to the platform.
 *
 * Only the "reboot everything" switch uses it. Accessory identity is built from
 * a device id, and that switch has no device, so it needs a value that is stable
 * for the life of the install and can never collide with a real player. A real
 * id is a MAC and port or a `gen-` UUID; neither can look like this.
 */
export const PLATFORM_DEVICE_ID = 'platform:all'

/** Reported when `package.json` cannot be read. */
export const UNKNOWN_PLUGIN_VERSION = '0.0.0'

/** Manufacturer shown when `/SyncStatus` does not report a brand. */
export const DEFAULT_BRAND = 'BluOS'

/** Model shown when `/SyncStatus` does not report one. */
export const DEFAULT_MODEL = 'BluOS Player'

// --- Endpoints -------------------------------------------------------------

/** Control port for a primary player (API v1.7 section 1). */
export const DEFAULT_BLUOS_PORT = 11_000

/**
 * Ports the specification documents for multi-zone chassis.
 *
 * API v1.7 section 1: the CI 580 exposes four streamer nodes on one IP, using
 * 11000, 11010, 11020 and 11030. The CI S2 uses 11000 and 11010. Ports outside
 * this set are accepted but warned about, because mDNS SRV records are the
 * authority on which port a zone actually listens to.
 */
export const DOCUMENTED_BLUOS_PORTS: readonly number[] = [11_000, 11_010, 11_020, 11_030]

/** Lowest port number accepted anywhere in configuration. */
export const MIN_PORT = 1

/** Highest port number accepted anywhere in configuration. */
export const MAX_PORT = 65_535

// --- Polling ---------------------------------------------------------------

/**
 * Duration passed as `/SyncStatus?timeout=`.
 *
 * The specification recommends 180 s for `/SyncStatus`, and forbids anything
 * faster than 10 s. 100 s is inside that envelope and halves the worst-case
 * delay before an unplugged player's socket read times out, which is how a
 * silent disappearance (as opposed to a connection reset) gets noticed.
 */
export const LONG_POLL_SEC = 100

/** Read headroom beyond the player's own long-poll timeout. */
export const LONG_POLL_READ_SLACK_MS = 5_000

/**
 * Minimum gap between two consecutive requests for the same resource.
 *
 * API v1.7 section 2 makes this a requirement, not a suggestion: "a client must
 * not make two consecutive requests for the same resource less than one second
 * apart, even if the first request returns in less than one second".
 */
export const SAME_RESOURCE_MIN_GAP_MS = 1_000

/** Connect timeout. Short so a powered-off player cannot stall startup. */
export const CONNECT_TIMEOUT_MS = 2_500

/** Total timeout for a control call (`/Volume?level=`, `/Volume?mute=`). */
export const CONTROL_TIMEOUT_MS = 5_000

/** Total timeout for a plain, non-long-poll status read. */
export const STATUS_TIMEOUT_MS = 6_000

/**
 * Total timeout for a reboot request.
 *
 * Short on purpose. A player that is restarting cannot finish answering, so
 * waiting longer only delays the point at which we accept a half-finished
 * exchange as success. The sibling `bluos-controller` project uses 2 s against
 * the same fleet; this leaves a little more room for a busy player.
 */
export const REBOOT_TIMEOUT_MS = 3_000

/**
 * The reboot resource, and the parameters that arm it.
 *
 * The one command in the API that is POST rather than GET, and the only one
 * addressed without a BluOS port: `/reboot` is served on port 80 and answers 404
 * on the control ports. The body mirrors the confirmation form that page serves,
 * whose submit button is named `yes`. See the reboot section of
 * docs/PROTOCOL.md.
 */
export const REBOOT_RESOURCE = 'reboot'

/** @see REBOOT_RESOURCE */
export const REBOOT_FORM: Readonly<Record<string, string>> = { noheader: '0', yes: '1' }

/**
 * How long after a reboot request we treat silence as the player coming back.
 *
 * A reboot takes the control ports down with the box. Polls fail, and without
 * this window every accessory on that box would warn "is not responding" and
 * then info "is responding again" — which is exactly what a reboot looks like.
 * After this window a still-silent player is logged the usual way.
 */
export const REBOOT_GRACE_MS = 90_000

/** Minimum spacing between control calls to one endpoint. */
export const CONTROL_RATE_LIMIT_MS = 100

/** First reconnect delay after a failed poll. Doubles up to the ceiling. */
export const POLL_BACKOFF_BASE_MS = 2_000

/** Ceiling for poll backoff. */
export const POLL_BACKOFF_MAX_MS = 60_000

/** Consecutive poll failures before an accessory reports No Response. */
export const POLL_FAILURES_BEFORE_UNKNOWN = 3

/** How long before a still-failing player is warned about again. */
export const POLL_FAILURE_REWARN_MS = 3_600_000

// --- HomeKit ---------------------------------------------------------------

/**
 * How long a HomeKit write may block before HAP gives up on it.
 *
 * HAP-NodeJS warns at `Accessory.TIMEOUT_WARNING` (3 s) and abandons the write
 * at 9 s total, returning `OPERATION_TIMED_OUT` and discarding whatever the
 * handler eventually returns. A set therefore has to answer well inside that
 * window and finish any slower work in the background.
 */
export const HOMEKIT_WRITE_BUDGET_MS = 2_500

/** Level restored when the slider is switched on and no previous level is known. */
export const DEFAULT_RESTORE_VOLUME = 20

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
export const SLIDER_COALESCE_MS = 150

/**
 * How long a momentary switch stays on before it springs back.
 *
 * A reboot switch has no state to report: the player is either restarting or it
 * is not, and neither is "on". Long enough that the Home app renders the press
 * so the user sees the tap registered, short enough that the tile is not left
 * looking like a thing that is still happening.
 */
export const MOMENTARY_RESET_MS = 1_000

// --- Volume ----------------------------------------------------------------

/** Lowest BluOS volume level. */
export const VOLUME_MIN = 0

/** Highest BluOS volume level. */
export const VOLUME_MAX = 100

/**
 * `volume="-1"` means the player's output level is fixed.
 *
 * API v1.7 section 2.2: "-1 means fixed volume". Such a player must not be
 * given a volume slider; writing a level to it is meaningless.
 */
export const FIXED_VOLUME_SENTINEL = -1

/**
 * `db="-100"` means silence, and is not a real output level.
 *
 * Measured on firmware 4.16.6: muting reports `volume="0" db="-100"` alongside
 * `muteVolume` and `muteDb` carrying the pre-mute values. Note that writing
 * `level=0` reports the same `db="-100"` with no `muteVolume`, so this value
 * cannot be used to detect mute — see `readMuted` in `api/sync-status.ts`.
 */
export const MUTED_DB_SENTINEL = -100

// --- XML parsing -----------------------------------------------------------

/**
 * Largest `/SyncStatus` body accepted.
 *
 * Real responses measure a few hundred bytes; a fully grouped CI 580 is still
 * far under a kilobyte. 128 KiB is generous while keeping a hostile or
 * malfunctioning endpoint from growing the heap.
 */
export const MAX_XML_BYTES = 131_072

/** Deepest element nesting accepted. */
export const MAX_XML_DEPTH = 16

/** Most elements accepted in one document. */
export const MAX_XML_ELEMENTS = 2_000

/** Most attributes accepted on one element. */
export const MAX_XML_ATTRIBUTES = 64

// --- Discovery -------------------------------------------------------------

/** mDNS service type advertised by primary players. */
export const MDNS_SERVICE_PRIMARY = '_musc._tcp.local'

/**
 * mDNS service type advertised by secondary zones of a multi-zone chassis.
 *
 * API v1.7 appendix 13.1 maps this to LSDP class 0x0003, "BluOS Player
 * (secondary in multi-zone players such as the CI580)".
 */
export const MDNS_SERVICE_SECONDARY = '_musp._tcp.local'

/** Default discovery window, in seconds. */
export const DEFAULT_DISCOVERY_TIMEOUT_SEC = 5

/** Shortest configurable discovery window. */
export const MIN_DISCOVERY_TIMEOUT_SEC = 1

/** Longest configurable discovery window. */
export const MAX_DISCOVERY_TIMEOUT_SEC = 30

/** Consecutive poll failures before the platform tries to re-resolve an address. */
export const FAILURES_BEFORE_REDISCOVERY = 3

/** Minimum gap between address re-resolution attempts. */
export const REDISCOVERY_MIN_INTERVAL_MS = 60_000

/**
 * Most records of one kind kept from a browse window.
 *
 * Anything on the segment can answer a multicast query, and a browse window can
 * be as long as 30 s, so the maps that accumulate advertisements need a ceiling
 * they cannot be talked past. A household fleet uses a handful of entries.
 */
export const MAX_DISCOVERY_RECORDS = 256

/**
 * Most candidate endpoints verified from one browse.
 *
 * Verification opens a real connection per candidate, so the count of
 * advertisements must not decide how many sockets this plugin opens.
 */
export const MAX_DISCOVERY_CANDIDATES = 64

/** Candidate endpoints verified at once. Bounds concurrent sockets during a sweep. */
export const DISCOVERY_VERIFY_CONCURRENCY = 6

// --- Logging ---------------------------------------------------------------

/** Longest untrusted string interpolated into a log line. */
export const MAX_LOG_FIELD_LENGTH = 100

/** Longest accepted HomeKit display name. */
export const MAX_NAME_LENGTH = 64

let cachedVersion: string | undefined

/**
 * Read this plugin's version from `package.json`.
 *
 * Reported to HomeKit as FirmwareRevision, which makes the version visible in
 * the Home app and therefore in bug reports.
 */
export function readPluginVersion(log?: PluginLogger): string {
  if (cachedVersion !== undefined) {
    return cachedVersion
  }
  try {

    const pkg = require('../package.json') as { version?: unknown }
    cachedVersion = typeof pkg.version === 'string' && pkg.version.length > 0
      ? pkg.version
      : UNKNOWN_PLUGIN_VERSION
  } catch (error) {
    log?.debug(`could not read plugin version: ${String(error)}`)
    cachedVersion = UNKNOWN_PLUGIN_VERSION
  }
  return cachedVersion
}
