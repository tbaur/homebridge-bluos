/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Identity is the one thing that must never churn: a changed key silently
 * orphans an accessory and takes the user's rooms, scenes and automations with
 * it. These tests pin the shape of every key the plugin generates.
 */

import {
  accessoryIdentityKey,
  formatEndpoint,
  hasAccessoryIdentity,
  isValidPlayerId,
  makeGeneratedPlayerId,
  makePlayerId,
  normalizeMac,
  parseMac,
} from '../../src/api/identity'
import type { ResolvedAccessory } from '../../src/types'

describe('parseMac', () => {
  it('reads six colon-separated octets', () => {
    expect(parseMac('90:56:82:0a:00:01')).toEqual({ mac: '90:56:82:0A:00:01' })
  })

  it('reads the zone-port suffix a multi-zone secondary appends', () => {
    expect(parseMac('90:56:82:0A:00:02:11010')).toEqual({
      mac: '90:56:82:0A:00:02',
      suffixPort: 11_010,
    })
  })

  it('reads the bare twelve-digit form used in mDNS TXT records', () => {
    expect(parseMac('9056820A0001')).toEqual({ mac: '90:56:82:0A:00:01' })
  })

  it('keeps the NIC and drops an unrecognised suffix', () => {
    expect(parseMac('90:56:82:0A:00:02:zone')).toEqual({ mac: '90:56:82:0A:00:02' })
    expect(parseMac('90:56:82:0A:00:02:11010:extra')).toEqual({ mac: '90:56:82:0A:00:02' })
  })

  it('rejects a suffix that is not a usable port', () => {
    expect(parseMac('90:56:82:0A:00:02:0')).toEqual({ mac: '90:56:82:0A:00:02' })
    expect(parseMac('90:56:82:0A:00:02:99999')).toEqual({ mac: '90:56:82:0A:00:02' })
  })

  it.each([
    ['not a string', 42],
    ['empty', '   '],
    ['too few octets', '90:56:82:0A:00'],
    ['non-hex octet', '90:56:82:0A:00:ZZ'],
    ['wrong bare length', '9056820000'],
  ])('returns undefined for %s', (_label, value) => {
    expect(parseMac(value)).toBeUndefined()
  })
})

describe('normalizeMac', () => {
  it('drops the suffix and upper-cases', () => {
    expect(normalizeMac('90:56:82:0a:00:02:11010')).toBe('90:56:82:0A:00:02')
  })

  it('returns undefined for anything unusable', () => {
    expect(normalizeMac(undefined)).toBeUndefined()
  })
})

describe('makePlayerId', () => {
  it('matches the shape a secondary zone reports for itself', () => {
    expect(makePlayerId('90:56:82:0a:00:02', 11_010)).toBe('90:56:82:0A:00:02:11010')
  })

  it('distinguishes two zones on one chassis', () => {
    const mac = '90:56:82:0A:00:02'

    expect(makePlayerId(mac, 11_000)).not.toBe(makePlayerId(mac, 11_010))
  })
})

describe('makeGeneratedPlayerId', () => {
  it('is unique and valid', () => {
    const first = makeGeneratedPlayerId()
    const second = makeGeneratedPlayerId()

    expect(first).not.toBe(second)
    expect(isValidPlayerId(first)).toBe(true)
  })
})

describe('isValidPlayerId', () => {
  it.each([
    ['a derived id', '90:56:82:0A:00:02:11010', true],
    ['a generated id', 'gen-2f1c9b1e-0000-4000-8000-000000000000', true],
    ['a hand-written label', 'study_player.1', true],
    ['empty', '', false],
    ['leading punctuation', ':90:56:82', false],
    ['a path traversal attempt', '../../etc/passwd', false],
    ['a query injection attempt', 'a&level=100', false],
    ['whitespace', 'a b', false],
    ['not a string', 7, false],
  ])('%s', (_label, value, expected) => {
    expect(isValidPlayerId(value)).toBe(expected)
  })

  it('rejects an id longer than the cap', () => {
    expect(isValidPlayerId(`a${'b'.repeat(200)}`)).toBe(false)
  })
})

describe('formatEndpoint', () => {
  it('defaults to the primary control port', () => {
    expect(formatEndpoint('192.168.4.10')).toBe('192.168.4.10:11000')
    expect(formatEndpoint('192.168.4.10', 11_010)).toBe('192.168.4.10:11010')
  })
})

describe('accessoryIdentityKey', () => {
  it('separates kinds for one player', () => {
    const deviceId = '90:56:82:0A:00:02:11000'

    expect(accessoryIdentityKey({ kind: 'volume', deviceId }))
      .not.toBe(accessoryIdentityKey({ kind: 'mute', deviceId }))
  })

  it('separates presets by level, since level is what makes them different', () => {
    const deviceId = '90:56:82:0A:00:02:11000'

    expect(accessoryIdentityKey({ kind: 'volumePreset', deviceId, volume: 20 }))
      .not.toBe(accessoryIdentityKey({ kind: 'volumePreset', deviceId, volume: 40 }))
  })

  it('contains no address, so re-addressing a player changes nothing', () => {
    const key = accessoryIdentityKey({ kind: 'volume', deviceId: '90:56:82:0A:00:02:11000' })

    expect(key).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
  })
})

describe('hasAccessoryIdentity', () => {
  const accessory: ResolvedAccessory = {
    kind: 'volumePreset',
    deviceId: '90:56:82:0A:00:02:11000',
    name: 'Evening',
    sliderService: 'fan',
    volume: 30,
  }

  it('matches on kind, device and level', () => {
    expect(hasAccessoryIdentity({ ...accessory }, accessory)).toBe(true)
  })

  it('rejects a different level', () => {
    expect(hasAccessoryIdentity({ ...accessory, volume: 31 }, accessory)).toBe(false)
  })

  it('rejects a different kind or device', () => {
    expect(hasAccessoryIdentity({ ...accessory, kind: 'volume' }, accessory)).toBe(false)
    expect(hasAccessoryIdentity({ ...accessory, deviceId: 'other' }, accessory)).toBe(false)
  })

  it('ignores level for kinds that do not have one', () => {
    const mute: ResolvedAccessory = { ...accessory, kind: 'mute', volume: undefined }

    expect(hasAccessoryIdentity({ kind: 'mute', deviceId: mute.deviceId, volume: 99 }, mute))
      .toBe(true)
  })
})
