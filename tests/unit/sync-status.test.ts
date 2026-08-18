/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The mute cases are the reason this file exists. Firmware 4.16.6 reports a
 * muted zone and a zone turned down to zero with identical `volume` and `db`,
 * and never sends a `mute` attribute in `/SyncStatus` at all, so a parser that
 * trusts either field is wrong in a way no specification reading would reveal.
 */

import { parseSyncStatus, parseVolume, restoreLevelFrom } from '../../src/api/sync-status'
import { ProtocolError } from '../../src/utils/errors'
import {
  SYNC_STATUS_BATTERY,
  SYNC_STATUS_C658,
  SYNC_STATUS_CI_S2_ZONE_ONE,
  SYNC_STATUS_CI_S2_ZONE_TWO,
  SYNC_STATUS_FIXED_VOLUME,
  SYNC_STATUS_GROUP_PRIMARY,
  SYNC_STATUS_GROUP_SECONDARY,
  SYNC_STATUS_LEVEL_ZERO,
  SYNC_STATUS_MUTED,
  SYNC_STATUS_NO_MAC,
  SYNC_STATUS_SOUNDBAR,
  SYNC_STATUS_ZONE_OPTIONS,
  VOLUME_C658,
  VOLUME_LEVEL_ZERO,
  VOLUME_MUTED,
} from '../fixtures/responses'

describe('parseSyncStatus', () => {
  it('reads a standalone player', () => {
    const observation = parseSyncStatus(SYNC_STATUS_C658, '192.168.4.10:11000')

    expect(observation).toMatchObject({
      name: 'Amplifier',
      brand: 'NAD',
      model: 'C658',
      modelName: 'C658',
      firmware: '4.16.6',
      mac: '90:56:82:0A:00:01',
      volume: 41,
      db: -42,
      fixedVolume: false,
      muted: false,
      syncRole: 'standalone',
      etag: '9',
      syncStat: '9',
    })
    expect(observation.battery).toBeUndefined()
  })

  it('strips the zone-port suffix a multi-zone secondary reports in its MAC', () => {
    const zoneOne = parseSyncStatus(SYNC_STATUS_CI_S2_ZONE_ONE, '192.168.4.11:11000')
    const zoneTwo = parseSyncStatus(SYNC_STATUS_CI_S2_ZONE_TWO, '192.168.4.11:11010')

    // One chassis, one NIC, two independently named zones: the normalised MAC is
    // shared, so it cannot key an accessory on its own.
    expect(zoneOne.mac).toBe('90:56:82:0A:00:02')
    expect(zoneTwo.mac).toBe('90:56:82:0A:00:02')
    expect(zoneOne.name).not.toBe(zoneTwo.name)
    // Only the secondary carries the port suffix on the wire.
    expect(SYNC_STATUS_CI_S2_ZONE_TWO).toContain('mac="90:56:82:0A:00:02:11010"')
    expect(SYNC_STATUS_CI_S2_ZONE_ONE).toContain('mac="90:56:82:0A:00:02"')
  })

  it('detects mute from the remembered pre-mute level', () => {
    const observation = parseSyncStatus(SYNC_STATUS_MUTED, '192.168.4.11:11010')

    // No `mute` attribute is present in this response at all.
    expect(SYNC_STATUS_MUTED).not.toMatch(/\bmute="/)
    expect(observation.muted).toBe(true)
    expect(observation.muteVolume).toBe(60)
    expect(observation.volume).toBe(0)
    // -100 dB is the silence sentinel, not an output level worth reporting.
    expect(observation.db).toBeUndefined()
  })

  it('does not mistake a level of zero for mute', () => {
    const observation = parseSyncStatus(SYNC_STATUS_LEVEL_ZERO, '192.168.4.11:11010')

    // Same volume and dB as the muted response; only muteVolume separates them.
    expect(observation.volume).toBe(0)
    expect(observation.muted).toBe(false)
    expect(observation.muteVolume).toBeUndefined()
    expect(observation.db).toBe(-100)
  })

  it('trusts an explicit mute attribute when firmware sends one', () => {
    const muted = parseSyncStatus('<SyncStatus mute="1" volume="0"/>', 'h:1')
    const notMuted = parseSyncStatus('<SyncStatus mute="0" volume="0" muteVolume="9"/>', 'h:1')

    expect(muted.muted).toBe(true)
    expect(notMuted.muted).toBe(false)
  })

  it('reports fixed volume and withholds a level', () => {
    const observation = parseSyncStatus(SYNC_STATUS_FIXED_VOLUME, '192.168.4.23:11000')

    expect(observation.fixedVolume).toBe(true)
    expect(observation.volume).toBeUndefined()
  })

  it('reads battery state', () => {
    const observation = parseSyncStatus(SYNC_STATUS_BATTERY, '192.168.4.13:11000')

    expect(observation.battery).toEqual({ level: 91, charging: false })
  })

  it('ignores a battery element with no level', () => {
    const observation = parseSyncStatus('<SyncStatus><battery charging="true"/></SyncStatus>', 'h:1')

    expect(observation.battery).toBeUndefined()
  })

  it('clamps a battery level into 0..100', () => {
    const low = parseSyncStatus('<SyncStatus><battery level="-5"/></SyncStatus>', 'h:1')
    const high = parseSyncStatus('<SyncStatus><battery level="220"/></SyncStatus>', 'h:1')

    expect(low.battery?.level).toBe(0)
    expect(high.battery?.level).toBe(100)
  })

  it('reads nested children without confusing them for state', () => {
    const observation = parseSyncStatus(SYNC_STATUS_SOUNDBAR, '192.168.4.12:11000')

    expect(observation.modelName).toBe('PULSE SOUNDBAR+')
    expect(observation.syncRole).toBe('standalone')
    expect(observation.volume).toBe(26)
  })

  describe('group roles', () => {
    it('reads a leader from its slave children', () => {
      expect(parseSyncStatus(SYNC_STATUS_GROUP_PRIMARY, '192.168.4.14:11000').syncRole)
        .toBe('primary')
    })

    it('reads a follower from its master element, and keeps its own volume', () => {
      const observation = parseSyncStatus(SYNC_STATUS_GROUP_SECONDARY, '192.168.4.14:11010')

      expect(observation.syncRole).toBe('secondary')
      // The follower's own level, not the group's. This is why /Status is unused.
      expect(observation.volume).toBe(60)
    })

    it('reads a grouped zone of a multi-zone chassis without confusing it for its sibling', () => {
      // Both recorded from one CI-S2 while its two zones were grouped together:
      // one NIC, one MAC, and the port is the only thing telling them apart.
      const leader = parseSyncStatus(SYNC_STATUS_GROUP_PRIMARY, '192.168.4.14:11000')
      const follower = parseSyncStatus(SYNC_STATUS_GROUP_SECONDARY, '192.168.4.14:11010')

      expect(leader.syncRole).toBe('primary')
      expect(follower.syncRole).toBe('secondary')
      expect(leader.mac).toBe(follower.mac)
    })

    it('does not read a stereo-pairing option as grouping', () => {
      // <zoneOptions> carries zoneMaster="true" on a paired speaker. Reading that
      // as a master would put every such player in a group it is not in, and a
      // group leader's volume writes would then reach the wrong rooms.
      const observation = parseSyncStatus(SYNC_STATUS_ZONE_OPTIONS, '192.168.4.15:11000')

      expect(observation.syncRole).toBe('standalone')
      expect(observation.volume).toBe(35)
    })

    it('treats a self-referential master as standalone', () => {
      // Seen briefly while regrouping; it does not mean the player follows itself.
      const xml = '<SyncStatus volume="5"><master port="11000">192.168.4.21</master></SyncStatus>'

      expect(parseSyncStatus(xml, '192.168.4.21:11000').syncRole).toBe('standalone')
    })

    it('treats a self-referential master as standalone when dialled by hostname', () => {
      // A player may be configured by hostname, so comparing only against the
      // address we dialled would read its own master as somebody else's and put a
      // regrouping player in a group it does not belong to.
      const xml = '<SyncStatus id="192.168.4.21:11000" volume="5">'
        + '<master port="11000">192.168.4.21</master></SyncStatus>'

      expect(parseSyncStatus(xml, 'study-amp.local:11000').syncRole).toBe('standalone')
    })

    it('reads a master element that already carries a port', () => {
      const xml = '<SyncStatus volume="5"><master>192.168.4.20:11000</master></SyncStatus>'

      expect(parseSyncStatus(xml, '192.168.4.21:11000').syncRole).toBe('secondary')
    })

    it('reads a legacy master attribute', () => {
      const xml = '<SyncStatus volume="5" master="192.168.4.20:11000"/>'

      expect(parseSyncStatus(xml, '192.168.4.21:11000').syncRole).toBe('secondary')
    })
  })

  it('clamps an out-of-range level', () => {
    expect(parseSyncStatus('<SyncStatus volume="140"/>', 'h:1').volume).toBe(100)
    expect(parseSyncStatus('<SyncStatus volume="-8"/>', 'h:1').volume).toBe(0)
  })

  it('survives a player that reports no MAC', () => {
    const observation = parseSyncStatus(SYNC_STATUS_NO_MAC, '192.168.4.30:11000')

    expect(observation.mac).toBeUndefined()
    expect(observation.name).toBe('Anonymous Player')
  })

  it('rejects a response that is not a SyncStatus', () => {
    expect(() => parseSyncStatus(VOLUME_C658, 'h:1')).toThrow(ProtocolError)
  })

  it('accepts a lower-case root element', () => {
    expect(parseSyncStatus('<syncstatus volume="3"/>', 'h:1').volume).toBe(3)
  })
})

describe('parseVolume', () => {
  it('reads the level from the element text', () => {
    expect(parseVolume(VOLUME_C658)).toEqual({
      level: 41,
      fixedVolume: false,
      muted: false,
      db: -42,
    })
  })

  it('reads a muted response, including the pre-mute level', () => {
    expect(parseVolume(VOLUME_MUTED)).toEqual({
      level: 0,
      fixedVolume: false,
      muted: true,
      muteVolume: 60,
    })
  })

  it('reads level zero as unmuted, unlike the muted response', () => {
    const result = parseVolume(VOLUME_LEVEL_ZERO)

    expect(result.muted).toBe(false)
    expect(result.level).toBe(0)
    expect(result.db).toBe(-100)
  })

  it('reports fixed volume', () => {
    const result = parseVolume('<volume mute="0">-1</volume>')

    expect(result).toEqual({ fixedVolume: true, muted: false })
  })

  it('rejects a response that is not a Volume', () => {
    expect(() => parseVolume(SYNC_STATUS_C658)).toThrow(ProtocolError)
  })

  it('tolerates a missing level', () => {
    expect(parseVolume('<volume mute="0"></volume>').level).toBeUndefined()
  })
})

describe('restoreLevelFrom', () => {
  it('prefers the player\'s own remembered pre-mute level', () => {
    // Lossless unmute with no client-side state.
    expect(restoreLevelFrom({ muteVolume: 60 }, 30, 20)).toBe(60)
  })

  it('falls back to the persisted level when the player remembers nothing', () => {
    // The level=0 path: the player cannot undo it for us.
    expect(restoreLevelFrom({}, 30, 20)).toBe(30)
  })

  it('falls back to the default when nothing is known', () => {
    expect(restoreLevelFrom({}, undefined, 20)).toBe(20)
  })

  it('ignores zero and out-of-range candidates', () => {
    expect(restoreLevelFrom({ muteVolume: 0 }, 0, 20)).toBe(20)
    expect(restoreLevelFrom({ muteVolume: 900 }, undefined, 20)).toBe(20)
  })
})
