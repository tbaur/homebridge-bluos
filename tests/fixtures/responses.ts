/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Access to the recorded BluOS responses.
 *
 * The `.xml` files beside this module were recorded from physical players on
 * firmware 4.16.6 and are read from disk rather than duplicated here, so there
 * is one copy of the evidence and no way for a constant to drift from it.
 * Addresses, MAC addresses and player names were substituted (see README.md);
 * nothing else was touched, including the quirks the parser exists to handle:
 *
 * - `/SyncStatus` never carries a `mute` attribute, in any state.
 * - A muted player reports `volume="0" db="-100"` plus `muteVolume`/`muteDb`.
 * - A player at `level=0` reports the same `volume="0" db="-100"` with no
 *   `muteVolume`, which is what makes `db` useless for detecting mute.
 * - A multi-zone secondary reports its chassis MAC with the zone's port appended
 *   as a seventh field.
 * - A group leader lists its followers as `<slave>` children; a follower names its
 *   leader in a `<master>` element.
 * - `zoneMaster="true"` inside `<zoneOptions>` is a stereo-pairing option and has
 *   nothing to do with grouping.
 *
 * The SYNTHESISED constants at the end cover states the development fleet was
 * never in, and follow the examples in API v1.7 sections 2.2 and 8. They are
 * separated from the recordings so no reader mistakes one for the other.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function load(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8').trim()
}

// --- RECORDED (firmware 4.16.6) --------------------------------------------

/** NAD C658 streamer, standalone, with a `<bluetoothOutput>` child. */
export const SYNC_STATUS_C658 = load('nad-c658.syncstatus.xml')

/** `/Volume` on the same C658. Note `source="Endpoint"`. */
export const VOLUME_C658 = load('nad-c658.volume.xml')

/**
 * NAD CI-S2, the zone on port 11000. Reports the chassis MAC with no suffix.
 *
 * Pairs with {@link SYNC_STATUS_CI_S2_ZONE_TWO}: the same physical box, the same
 * NIC, two independently controllable zones. This is why a MAC alone cannot key
 * an accessory.
 */
export const SYNC_STATUS_CI_S2_ZONE_ONE = load('nad-ci-s2-zone-one.syncstatus.xml')

/** `/Volume` for zone one. */
export const VOLUME_CI_S2_ZONE_ONE = load('nad-ci-s2-zone-one.volume.xml')

/** The same chassis on port 11010, reporting `mac="…:0A:00:02:11010"`. */
export const SYNC_STATUS_CI_S2_ZONE_TWO = load('nad-ci-s2-zone-two.syncstatus.xml')

/** `/Volume` for zone two, unmuted at level 60. */
export const VOLUME_CI_S2_ZONE_TWO = load('nad-ci-s2-zone-two.volume.xml')

/**
 * Zone two immediately after `GET /Volume?mute=1&tell_slaves=0`.
 *
 * No `mute` attribute: mute is visible only as `muteVolume`/`muteDb`.
 */
export const SYNC_STATUS_MUTED = load('nad-ci-s2-zone-two-muted.syncstatus.xml')

/** `/Volume` while muted, which does say `mute="1"` outright. */
export const VOLUME_MUTED = load('nad-ci-s2-zone-two-muted.volume.xml')

/**
 * Zone two after `GET /Volume?level=0&tell_slaves=0`.
 *
 * Silent but not muted, and indistinguishable from the muted case by `volume`
 * or `db` alone. The counter-example that keeps mute detection honest.
 */
export const SYNC_STATUS_LEVEL_ZERO = load('nad-ci-s2-zone-two-level-zero.syncstatus.xml')

/** `/Volume` at level zero: `db="-100"` with `mute="0"`. */
export const VOLUME_LEVEL_ZERO = load('nad-ci-s2-zone-two-level-zero.volume.xml')

/** Bluesound PULSE SOUNDBAR+, with nested `<zoneOptions>` and four children. */
export const SYNC_STATUS_SOUNDBAR = load('bluesound-p430-soundbar.syncstatus.xml')

/** Bluesound PULSE FLEX 2i with a battery pack fitted, at 91% and discharging. */
export const SYNC_STATUS_BATTERY = load('bluesound-p125-battery.syncstatus.xml')

/**
 * A live group leader, recorded while two zones of one CI-S2 were grouped.
 *
 * One `<slave>` child per follower, carrying the follower's address, port and
 * name, plus a `group` attribute naming the members for display. This is what
 * `tell_slaves=1` is decided from.
 */
export const SYNC_STATUS_GROUP_PRIMARY = load('nad-ci-s2-group-leader.syncstatus.xml')

/**
 * The follower from that same group, recorded at the same moment.
 *
 * `<master>` carries the leader's address with the port as an attribute. Note the
 * volume is this player's own, which is the whole reason the plugin polls
 * `/SyncStatus`: `/Status` on a follower reports the group's level instead.
 */
export const SYNC_STATUS_GROUP_SECONDARY = load('nad-ci-s2-group-follower.syncstatus.xml')

/**
 * A Bluesound player advertising stereo-pairing options.
 *
 * Recorded because `<zoneOptions>` contains `zoneMaster="true"`, which is a
 * pairing option and not a grouping signal. Any attribute lookup loose enough to
 * see it as `master` would report every paired speaker as a group follower.
 */
export const SYNC_STATUS_ZONE_OPTIONS = load('bluesound-p125-zone-options.syncstatus.xml')

// --- SYNTHESISED -----------------------------------------------------------

/** A player whose output level is fixed, per API v1.7 section 2.2. */
export const SYNC_STATUS_FIXED_VOLUME = `<?xml version="1.0" encoding="UTF-8"?>
<SyncStatus etag="3" syncStat="3" version="4.16.6" id="192.168.4.23:11000" volume="-1" name="Fixed Output" model="CI580" modelName="CI 580" brand="NAD" mac="90:56:82:0A:00:07"></SyncStatus>`

/** A player that reports no MAC, so identity has to be persisted instead. */
export const SYNC_STATUS_NO_MAC = `<?xml version="1.0" encoding="UTF-8"?>
<SyncStatus etag="1" syncStat="1" volume="10" name="Anonymous Player"></SyncStatus>`

/** `/Volume` after a set that the player clamped to its configured range. */
export const VOLUME_CLAMPED = `<?xml version="1.0" encoding="UTF-8"?>
<volume db="-22.5" offsetDb="0" mute="0" etag="f07f7e0512d97893547d97a7106e31ff" source="">72</volume>`
