/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The distinction under test is between a configuration that cannot be acted on
 * at all, which must stop the platform, and one bad entry, which must not cost
 * the user the rest of the fleet.
 */

import {
  forLog,
  isIpv4,
  isNonPrivateIpv4,
  isProbeableHost,
  isValidHost,
  resolveAccessories,
  resolveDiscoveryTimeoutSec,
  resolveSliderService,
  validateConfig,
} from '../../src/utils/validators'
import { DEFAULT_BLUOS_PORT, MAX_NAME_LENGTH, PLATFORM_DEVICE_ID } from '../../src/settings'
import type { ResolvedDevice } from '../../src/types'

const validDevice = {
  id: '90:56:82:0A:00:02:11000',
  name: 'Zone One',
  host: '192.168.4.11',
  port: 11_000,
  volumeSlider: true,
}

function device(overrides: Partial<ResolvedDevice> = {}): ResolvedDevice {
  return {
    id: '90:56:82:0A:00:02:11000',
    name: 'Zone One',
    host: '192.168.4.11',
    port: 11_000,
    volumeSlider: false,
    sliderService: 'fan',
    mute: false,
    battery: false,
    reboot: false,
    volumePresets: [],
    ...overrides,
  }
}

describe('forLog', () => {
  it('replaces every control character, not just the first', () => {
    // One escaped newline is enough to forge a log entry, so a single
    // replacement would leave the hole open.
    expect(forLog('a\nb\nc')).toBe('a\uFFFDb\uFFFDc')
    expect(forLog('a\r\n\tb')).toBe('a\uFFFD\uFFFD\uFFFDb')
  })

  it('truncates an over-long value', () => {
    const sanitized = forLog('x'.repeat(500))

    expect(sanitized).toHaveLength(101)
    expect(sanitized.endsWith('\u2026')).toBe(true)
  })

  it('stringifies a non-string', () => {
    expect(forLog(undefined)).toBe('undefined')
    expect(forLog(11_000)).toBe('11000')
  })
})

describe('isIpv4', () => {
  it.each([
    ['192.168.4.11', true],
    ['0.0.0.0', true],
    ['255.255.255.255', true],
    ['192.168.4.256', false],
    ['192.168.04.11', false],
    ['192.168.4', false],
    ['192.168.4.11.1', false],
    ['not-an-ip', false],
  ])('%s -> %s', (value, expected) => {
    expect(isIpv4(value)).toBe(expected)
  })
})

describe('isValidHost', () => {
  it.each([
    ['an address', '192.168.4.11', true],
    ['a hostname', 'player.local', true],
    ['a trimmed hostname', '  player.local  ', true],
    ['empty', '', false],
    ['a URL', 'http://192.168.4.11', false],
    ['a host with a port', '192.168.4.11:11000', false],
    ['a path traversal attempt', '../etc', false],
    ['a space', 'my player', false],
    ['not a string', 42, false],
    // Dotted quads that fail isIpv4 must not fall through as hostnames.
    ['a zero-padded octet', '192.168.04.11', false],
    ['a leading-zero first octet', '010.0.0.1', false],
    ['octets out of range', '999.999.999.999', false],
  ])('%s', (_label, value, expected) => {
    expect(isValidHost(value)).toBe(expected)
  })

  it('rejects an over-long name', () => {
    expect(isValidHost(`${'a'.repeat(254)}`)).toBe(false)
  })
})

describe('isNonPrivateIpv4', () => {
  it.each([
    ['10.0.0.5', false],
    ['172.16.0.1', false],
    ['172.31.255.5', false],
    ['192.168.4.11', false],
    ['127.0.0.1', false],
    ['169.254.1.1', false],
    ['100.64.0.0', false],
    ['100.64.1.10', false],
    ['100.127.255.255', false],
    ['8.8.8.8', true],
    ['172.32.0.1', true],
    ['100.63.255.255', true],
    ['100.128.0.1', true],
    ['player.local', false],
  ])('%s -> %s', (value, expected) => {
    expect(isNonPrivateIpv4(value)).toBe(expected)
  })
})

describe('isProbeableHost', () => {
  it.each([
    ['RFC 1918', '192.168.4.11', true],
    ['CGNAT / Tailscale', '100.64.1.10', true],
    ['loopback', '127.0.0.1', true],
    ['link-local', '169.254.1.1', true],
    ['single-label', 'nad-c658', true],
    ['.local', 'bluesound.local', true],
    ['.localhost', 'player.localhost', true],
    ['.internal', 'study.internal', true],
    ['.home.arpa', 'player.home.arpa', true],
    ['trimmed .local', '  pulse.local  ', true],
    ['public IPv4', '8.8.8.8', false],
    ['documentation IPv4', '203.0.113.7', false],
    ['just outside CGNAT', '100.63.255.255', false],
    ['public hostname', 'example.com', false],
    ['multi-label public', 'player.example.org', false],
    ['zero-padded octet', '192.168.04.11', false],
    ['empty', '', false],
    ['not a string', 42, false],
  ])('%s', (_label, value, expected) => {
    expect(isProbeableHost(value)).toBe(expected)
  })
})

describe('resolveDiscoveryTimeoutSec', () => {
  it('defaults when unset', () => {
    expect(resolveDiscoveryTimeoutSec(undefined)).toBe(5)
  })

  it('clamps and warns', () => {
    const warnings: string[] = []

    expect(resolveDiscoveryTimeoutSec(900, warnings)).toBe(30)
    expect(resolveDiscoveryTimeoutSec(0, warnings)).toBe(1)
    expect(warnings).toHaveLength(2)
  })

  it('warns and defaults on a non-number', () => {
    const warnings: string[] = []

    expect(resolveDiscoveryTimeoutSec('soon', warnings)).toBe(5)
    expect(warnings[0]).toMatch(/not a number/)
  })

  it('accepts a numeric string', () => {
    expect(resolveDiscoveryTimeoutSec('8')).toBe(8)
  })
})

describe('resolveSliderService', () => {
  it('prefers the device setting over the platform default', () => {
    expect(resolveSliderService('lightbulb', 'fan')).toBe('lightbulb')
  })

  it('falls back to the platform setting', () => {
    expect(resolveSliderService(undefined, 'lightbulb')).toBe('lightbulb')
  })

  it('defaults to the fan, which Siri light commands do not sweep up', () => {
    expect(resolveSliderService(undefined, undefined)).toBe('fan')
  })

  it('warns and uses the fan for an unknown value', () => {
    const warnings: string[] = []

    expect(resolveSliderService('speaker', undefined, warnings)).toBe('fan')
    expect(warnings[0]).toMatch(/is not "fan" or "lightbulb"/)
  })
})

describe('validateConfig', () => {
  it('accepts a minimal device and defaults the rest', () => {
    const result = validateConfig({ platform: 'BluOS', devices: [validDevice] })

    expect(result.errors).toEqual([])
    expect(result.devices).toEqual([
      {
        id: validDevice.id,
        name: 'Zone One',
        host: '192.168.4.11',
        port: 11_000,
        volumeSlider: true,
        sliderService: 'fan',
        mute: false,
        battery: false,
        reboot: false,
        volumePresets: [],
      },
    ])
  })

  it('gives a hand-written entry a slider by default', () => {
    // config.schema.json defaults volumeSlider to true and the settings page
    // reads an absent value as on, so a hand-edited entry of id, name and host
    // must get a slider rather than silently exposing nothing.
    const { id, name, host } = validDevice
    const result = validateConfig({ platform: 'BluOS', devices: [{ id, name, host }] })

    expect(result.devices[0]?.volumeSlider).toBe(true)
    expect(result.warnings).not.toContainEqual(expect.stringMatching(/nothing will appear in HomeKit/))
  })

  it('honours an explicitly disabled slider', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, volumeSlider: false, mute: true }],
    })

    expect(result.devices[0]?.volumeSlider).toBe(false)
  })

  it('is fatal when the platform block is missing', () => {
    expect(validateConfig(undefined).errors).toEqual(['platform configuration is missing'])
  })

  it('is fatal when devices is absent or not a list', () => {
    expect(validateConfig({ platform: 'BluOS' }).errors[0]).toMatch(/no "devices" list/)
    expect(validateConfig({ platform: 'BluOS', devices: 'all' }).errors[0])
      .toMatch(/must be a list/)
  })

  it('warns rather than fails when no devices are configured', () => {
    const result = validateConfig({ platform: 'BluOS', devices: [] })

    expect(result.errors).toEqual([])
    expect(result.warnings[0]).toMatch(/no devices are configured/)
  })

  it('accepts the full configuration Homebridge verification CI generates from the schema', () => {
    // The checker fills every property: defaults where present, `test-value`
    // from the field name, the first `oneOf` (empty string = use the platform
    // slider), and one volume preset at the integer minimum.
    const result = validateConfig({
      platform: 'BluOS',
      name: 'BluOS',
      options: {
        sliderService: 'fan',
        discoveryTimeoutSec: 5,
      },
      devices: [{
        id: 'test-value',
        name: 'test-value',
        host: '192.168.4.11',
        port: 11_000,
        volumeSlider: true,
        sliderService: '',
        mute: false,
        battery: false,
        volumePresets: [{ name: 'test-value', volume: 0 }],
      }],
    })

    expect(result.errors).toEqual([])
    expect(result.devices).toHaveLength(1)
    expect(result.devices[0]).toEqual(expect.objectContaining({
      id: 'test-value',
      host: '192.168.4.11',
      sliderService: 'fan',
      volumePresets: [{ name: 'test-value', volume: 0 }],
    }))
  })

  it('keeps the good devices and skips the bad one', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [validDevice, { name: 'Broken', host: 'nope//', id: '' }],
    })

    expect(result.errors).toEqual([])
    expect(result.devices).toHaveLength(1)
    expect(result.warnings.join(' ')).toMatch(/skipping Broken/)
  })

  it('is fatal only when every device was rejected', () => {
    const result = validateConfig({ platform: 'BluOS', devices: [{ name: 'Broken' }] })

    expect(result.errors[0]).toMatch(/all 1 configured device\(s\) were rejected/)
  })

  it('skips a duplicate id, which would collide on UUID', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [validDevice, { ...validDevice, name: 'Copy' }],
    })

    expect(result.devices).toHaveLength(1)
    expect(result.warnings.join(' ')).toMatch(/repeats id/)
  })

  it.each([
    ['a missing name', { ...validDevice, name: undefined }, /missing a name/],
    ['a control character in the name', { ...validDevice, name: 'a\nb' }, /control characters/],
    ['an over-long name', { ...validDevice, name: 'x'.repeat(MAX_NAME_LENGTH + 1) }, /longer than/],
    ['an unusable id', { ...validDevice, id: 'a b' }, /no usable id/],
    ['an unusable host', { ...validDevice, host: 'http://x' }, /not a valid address/],
    ['a non-object entry', 'device', /is not an object/],
  ])('rejects %s', (_label, entry, expected) => {
    const result = validateConfig({ platform: 'BluOS', devices: [entry] })

    expect(result.devices).toEqual([])
    expect(result.warnings.join(' ')).toMatch(expected)
  })

  it('defaults an invalid port and warns', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, port: 70_000 }],
    })

    expect(result.devices[0]?.port).toBe(DEFAULT_BLUOS_PORT)
    expect(result.warnings.join(' ')).toMatch(/is invalid/)
  })

  it('accepts an undocumented port but says so, since the SRV record is the authority', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, port: 12_345 }],
    })

    expect(result.devices[0]?.port).toBe(12_345)
    expect(result.warnings.join(' ')).toMatch(/outside the documented BluOS ports/)
  })

  it('warns about a routable address, because the API is unauthenticated', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, host: '203.0.113.7' }],
    })

    expect(result.devices).toHaveLength(1)
    expect(result.warnings.join(' ')).toMatch(/not a private address/)
  })

  it('does not warn about a CGNAT / Tailscale address', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, host: '100.64.1.10' }],
    })

    expect(result.devices).toHaveLength(1)
    expect(result.warnings.join(' ')).not.toMatch(/not a private address/)
  })

  it('warns when a device exposes nothing at all', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, volumeSlider: false }],
    })

    expect(result.warnings.join(' ')).toMatch(/nothing will appear in HomeKit/)
  })

  it('counts a reboot switch as something being exposed', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, volumeSlider: false, reboot: true }],
    })

    expect(result.devices[0]?.reboot).toBe(true)
    expect(result.warnings.join(' ')).not.toMatch(/nothing will appear in HomeKit/)
  })

  it('counts the global reboot switch as something being exposed', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, volumeSlider: false }],
      options: { rebootAll: true },
    })

    expect(result.options.rebootAll).toBe(true)
    expect(result.warnings.join(' ')).not.toMatch(/nothing will appear in HomeKit/)
  })

  it('leaves both reboot switches off unless they are asked for', () => {
    const result = validateConfig({ platform: 'BluOS', devices: [validDevice] })

    expect(result.devices[0]?.reboot).toBe(false)
    expect(result.options.rebootAll).toBe(false)
    expect(result.options.rebootAllName).toBeUndefined()
  })

  it('carries the name given to the global reboot switch, trimmed', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [validDevice],
      options: { rebootAll: true, rebootAllName: '  Restart Everything  ' },
    })

    expect(result.options.rebootAllName).toBe('Restart Everything')
    expect(result.errors).toEqual([])
  })

  it('warns and falls back to the default when that name is unusable', () => {
    // A warning rather than an error: a rejected label should cost the user
    // their name, not their switch.
    const result = validateConfig({
      platform: 'BluOS',
      devices: [validDevice],
      options: { rebootAll: true, rebootAllName: 'x'.repeat(100) },
    })

    expect(result.options.rebootAll).toBe(true)
    expect(result.options.rebootAllName).toBeUndefined()
    expect(result.errors).toEqual([])
    expect(result.warnings.join(' ')).toMatch(/reboot all switch name is longer than/)
  })

  it('carries a model and brand through, sanitised', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, model: ' CI S2 ', brand: 'NAD\n' }],
    })

    expect(result.devices[0]).toMatchObject({ model: 'CI S2', brand: 'NAD' })
  })

  describe('volume presets', () => {
    it('accepts valid presets', () => {
      const result = validateConfig({
        platform: 'BluOS',
        devices: [{
          ...validDevice,
          volumePresets: [{ name: 'Quiet', volume: 15 }, { name: 'Party', volume: 70 }],
        }],
      })

      expect(result.devices[0]?.volumePresets).toEqual([
        { name: 'Quiet', volume: 15 },
        { name: 'Party', volume: 70 },
      ])
    })

    it('drops a duplicate level, which would collide on UUID', () => {
      const result = validateConfig({
        platform: 'BluOS',
        devices: [{
          ...validDevice,
          volumePresets: [{ name: 'A', volume: 15 }, { name: 'B', volume: 15 }],
        }],
      })

      expect(result.devices[0]?.volumePresets).toHaveLength(1)
      expect(result.warnings.join(' ')).toMatch(/repeats volume 15/)
    })

    it.each([
      ['a level out of range', { name: 'A', volume: 101 }],
      ['a fractional level', { name: 'A', volume: 12.5 }],
      ['a missing name', { volume: 10 }],
      ['a non-object', 'loud'],
    ])('drops %s', (_label, preset) => {
      const result = validateConfig({
        platform: 'BluOS',
        devices: [{ ...validDevice, volumePresets: [preset] }],
      })

      expect(result.devices[0]?.volumePresets).toEqual([])
      expect(result.warnings.length).toBeGreaterThan(0)
    })

    it('ignores a presets value that is not a list', () => {
      const result = validateConfig({
        platform: 'BluOS',
        devices: [{ ...validDevice, volumePresets: 'loud' }],
      })

      expect(result.devices[0]?.volumePresets).toEqual([])
      expect(result.warnings.join(' ')).toMatch(/is not a list/)
    })
  })

  it('applies the platform slider default to every device', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [validDevice],
      options: { sliderService: 'lightbulb' },
    })

    expect(result.devices[0]?.sliderService).toBe('lightbulb')
  })

  it('treats a blank device slider setting as "use the platform setting"', () => {
    // The Homebridge form writes an empty string for that option, so reading it as
    // a bad value would make choosing it override the platform setting instead.
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, sliderService: '' }],
      options: { sliderService: 'lightbulb' },
    })

    expect(result.devices[0]?.sliderService).toBe('lightbulb')
    expect(result.warnings.join(' ')).not.toMatch(/sliderService/)
  })

  it('names the device and the value when a slider setting is wrong', () => {
    const result = validateConfig({
      platform: 'BluOS',
      devices: [{ ...validDevice, sliderService: 'switch' }],
    })

    expect(result.devices[0]?.sliderService).toBe('fan')
    expect(result.warnings.join(' ')).toMatch(/devices\[0\] sliderService "switch"/)
  })
})

describe('resolveAccessories', () => {
  it('expands each enabled feature into one accessory', () => {
    const accessories = resolveAccessories([device({
      volumeSlider: true,
      mute: true,
      battery: true,
      reboot: true,
      volumePresets: [{ name: 'Quiet', volume: 15 }],
    })])

    expect(accessories.map((entry) => [entry.kind, entry.name])).toEqual([
      ['volume', 'Zone One Volume'],
      ['mute', 'Zone One Mute'],
      ['reboot', 'Zone One Reboot'],
      ['volumePreset', 'Quiet'],
    ])
    expect(accessories.find((entry) => entry.kind === 'volume')?.hostsBattery).toBe(true)
    expect(accessories.find((entry) => entry.kind === 'mute')?.hostsBattery).toBeUndefined()
  })

  it('puts the battery on mute when there is no slider', () => {
    const accessories = resolveAccessories([device({ mute: true, battery: true })])

    expect(accessories.map((entry) => entry.kind)).toEqual(['mute'])
    expect(accessories[0]?.hostsBattery).toBe(true)
  })

  it('keeps a standalone battery accessory when nothing else is on', () => {
    const accessories = resolveAccessories([device({ battery: true })])

    expect(accessories.map((entry) => [entry.kind, entry.name])).toEqual([
      ['battery', 'Zone One Battery'],
    ])
  })

  it('exposes nothing for a device with no features enabled', () => {
    expect(resolveAccessories([device()])).toEqual([])
  })

  it('creates a slider even though fixed volume is not yet knowable', () => {
    // Whether output is fixed is only visible in a live /SyncStatus, so the
    // slider is created and disables itself on the first observation.
    expect(resolveAccessories([device({ volumeSlider: true })])).toHaveLength(1)
  })

  it('keeps a suffixed name inside HomeKit\'s budget', () => {
    const long = 'x'.repeat(MAX_NAME_LENGTH)
    const accessories = resolveAccessories([device({ name: long, mute: true })])

    expect(accessories[0]?.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH)
    expect(accessories[0]?.name.endsWith('Mute')).toBe(true)
  })

  it('warns when two accessories share a name, since Siri cannot disambiguate', () => {
    const warnings: string[] = []
    resolveAccessories(
      [
        device({ volumePresets: [{ name: 'Quiet', volume: 10 }] }),
        device({ id: 'other', volumePresets: [{ name: 'Quiet', volume: 20 }] }),
      ],
      warnings,
    )

    expect(warnings.join(' ')).toMatch(/2 accessories are named Quiet/)
  })

  it('carries the slider service onto every accessory of a device', () => {
    const accessories = resolveAccessories([device({
      sliderService: 'lightbulb',
      volumeSlider: true,
      mute: true,
    })])

    expect(accessories.every((entry) => entry.sliderService === 'lightbulb')).toBe(true)
  })

  it('adds the global reboot switch once, outside any device', () => {
    const accessories = resolveAccessories(
      [device({ reboot: true }), device({ id: 'other', reboot: true })],
      [],
      { rebootAll: true, name: 'BluOS' },
    )

    const global = accessories.filter((entry) => entry.kind === 'rebootAll')
    expect(global).toHaveLength(1)
    expect(global[0]?.name).toBe('BluOS Reboot All')
    expect(global[0]?.deviceId).toBe(PLATFORM_DEVICE_ID)
  })

  it('offers the global reboot switch even with no devices configured', () => {
    // A network that filters multicast leaves discovery empty, which is exactly
    // where a manual sweep is the only way to reach anything.
    const accessories = resolveAccessories([], [], { rebootAll: true, name: 'BluOS' })

    expect(accessories.map((entry) => entry.kind)).toEqual(['rebootAll'])
  })

  it('leaves the global reboot switch out unless it is asked for', () => {
    expect(resolveAccessories([device({ reboot: true })], [], { rebootAll: false, name: 'BluOS' }))
      .toHaveLength(1)
  })

  it('names the global reboot switch whatever the user called it', () => {
    // Taken bare rather than suffixed: it is the one accessory with no room of
    // its own, so the name is the only thing that can place it in one.
    const accessories = resolveAccessories([], [], {
      rebootAll: true,
      rebootAllName: 'Restart Everything',
      name: 'BluOS',
    })

    expect(accessories[0]?.name).toBe('Restart Everything')
  })
})
