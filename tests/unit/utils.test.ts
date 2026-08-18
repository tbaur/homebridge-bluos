/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import type { PlatformAccessory } from 'homebridge'

import { parseAccessoryContext } from '../../src/utils/context'
import {
  ConfigValidationError,
  ConnectionError,
  describeError,
  describeErrorStack,
  ProtocolError,
} from '../../src/utils/errors'
import {
  ensureAccessorySerialNumber,
  newAccessorySerialNumber,
} from '../../src/utils/serial'
import { DEFAULT_BLUOS_PORT, DEFAULT_BRAND, DEFAULT_MODEL } from '../../src/settings'
import type { AccessoryContext } from '../../src/types'

describe('describeError', () => {
  it('includes the error code, which is usually the useful part', () => {
    const error = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })

    expect(describeError(error)).toBe('connect failed (ECONNREFUSED)')
  })

  it('unwraps a cause chain', () => {
    const inner = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const outer = new ConnectionError('request failed', { cause: inner })

    expect(describeError(outer)).toBe('request failed: socket hang up (ECONNRESET)')
  })

  it('does not repeat an identical message from the chain', () => {
    const inner = new Error('same')
    const outer = new Error('same', { cause: inner })

    expect(describeError(outer)).toBe('same')
  })

  it('survives a cyclic cause chain', () => {
    const first = new Error('first')
    const second = new Error('second', { cause: first })
    ;(first as { cause?: unknown }).cause = second

    expect(describeError(second)).toBe('second: first')
  })

  it('strips control characters so a remote message cannot forge log entries', () => {
    expect(describeError(new Error('a\nWARN forged\r\nb'))).toBe('a\uFFFDWARN forged\uFFFD\uFFFDb')
  })

  it('truncates a flood', () => {
    expect(describeError(new Error('x'.repeat(1_000)))).toHaveLength(301)
  })

  it.each([
    ['a string', 'plain failure', 'plain failure'],
    ['an object', { code: 7 }, '{"code":7}'],
    ['undefined', undefined, 'unknown error'],
    ['null', null, 'unknown error'],
    ['an empty message', new Error(''), 'unknown error'],
  ])('describes %s', (_label, value, expected) => {
    expect(describeError(value)).toBe(expected)
  })

  it('falls back to String() for something JSON cannot serialise', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(describeError(circular)).toBe('[object Object]')
  })
})

describe('describeErrorStack', () => {
  it('appends the stack for debug logging', () => {
    expect(describeErrorStack(new ProtocolError('bad xml'))).toMatch(/bad xml\n.*at /s)
  })

  it('returns just the description for a non-error', () => {
    expect(describeErrorStack('oops')).toBe('oops')
  })
})

describe('serial numbers', () => {
  it('generates unique values', () => {
    expect(newAccessorySerialNumber()).not.toBe(newAccessorySerialNumber())
  })

  it('does not derive from anything identifying', () => {
    // Must never be a MAC: the Home app displays it.
    expect(newAccessorySerialNumber()).not.toMatch(/([0-9A-F]{2}:){5}/i)
  })

  it('keeps an existing serial number', () => {
    const accessory = { context: { serialNumber: 'existing' } } as unknown as PlatformAccessory

    expect(ensureAccessorySerialNumber(accessory)).toBe('existing')
  })

  it('generates and persists one for an accessory that predates the field', () => {
    const accessory = { context: {} } as unknown as PlatformAccessory

    const generated = ensureAccessorySerialNumber(accessory)

    expect(generated).toHaveLength(36)
    expect((accessory.context as { serialNumber?: string }).serialNumber).toBe(generated)
  })
})

describe('parseAccessoryContext', () => {
  function accessoryWith(context: Partial<AccessoryContext>): PlatformAccessory {
    return { displayName: 'Zone One', context } as unknown as PlatformAccessory
  }

  const valid: Partial<AccessoryContext> = {
    kind: 'volume',
    deviceId: '90:56:82:0A:00:02:11000',
    serialNumber: 'abc',
  }

  it('reads a full context', () => {
    const context = parseAccessoryContext(accessoryWith({
      ...valid,
      host: '192.168.4.11',
      port: 11_010,
      brand: 'NAD',
      model: 'CI S2',
      adoptedLegacyUuid: true,
      sliderService: 'lightbulb',
      lastNonZeroVolume: 42,
    }))

    expect(context).toEqual({
      kind: 'volume',
      deviceId: '90:56:82:0A:00:02:11000',
      host: '192.168.4.11',
      port: 11_010,
      brand: 'NAD',
      model: 'CI S2',
      serialNumber: 'abc',
      adoptedLegacyUuid: true,
      sliderService: 'lightbulb',
      lastNonZeroVolume: 42,
    })
  })

  it('defaults the fields a restart can do without', () => {
    const context = parseAccessoryContext(accessoryWith(valid))

    expect(context).toMatchObject({
      host: '',
      port: DEFAULT_BLUOS_PORT,
      brand: DEFAULT_BRAND,
      model: DEFAULT_MODEL,
      adoptedLegacyUuid: false,
      sliderService: 'fan',
    })
    expect(context.lastNonZeroVolume).toBeUndefined()
  })

  it('keeps a preset\'s target level', () => {
    const context = parseAccessoryContext(accessoryWith({
      ...valid,
      kind: 'volumePreset',
      volume: 30,
    }))

    expect(context.volume).toBe(30)
  })

  it.each([
    ['an unknown kind', { ...valid, kind: 'party' as never }, /unknown kind/],
    ['no device id', { ...valid, deviceId: '' }, /no device id/],
    ['no serial number', { ...valid, serialNumber: undefined }, /no serial number/],
    ['a preset with no level', { ...valid, kind: 'volumePreset' as const }, /no target volume/],
  ])('rejects %s', (_label, context, expected) => {
    expect(() => parseAccessoryContext(accessoryWith(context)))
      .toThrow(ConfigValidationError)
    expect(() => parseAccessoryContext(accessoryWith(context))).toThrow(expected)
  })

  it('tolerates a missing context object entirely', () => {
    const accessory = { displayName: 'Zone One' } as unknown as PlatformAccessory

    expect(() => parseAccessoryContext(accessory)).toThrow(ConfigValidationError)
  })
})
