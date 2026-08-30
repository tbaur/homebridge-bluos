/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The global reboot switch.
 *
 * This is the accessory with the widest blast radius in the plugin, so the tests
 * concentrate on reach and on partial failure: which players it touches, that it
 * names them first, and that one dead address cannot stop it reaching the rest.
 */

import { RebootAllAccessory } from '../../src/devices/reboot-all-accessory'
import { PLATFORM_DEVICE_ID } from '../../src/settings'
import { harness } from '../helpers/hap'

/**
 * Two boxes, one of them carrying two zones.
 *
 * The CI S2 is one target rather than two: reboot is served on port 80, which is
 * one server per chassis, so both its zones go down together.
 */
const targets = [
  { host: '192.168.4.11', names: ['Zone One', 'Zone Two'] },
  { host: '192.168.4.12', names: ['Kitchen'] },
]

function globalHarness(overrides: Parameters<typeof harness>[0] = {}) {
  return harness({
    displayName: 'BluOS Reboot All',
    ...overrides,
    context: { kind: 'rebootAll', deviceId: PLATFORM_DEVICE_ID, ...overrides.context },
  })
}

describe('RebootAllAccessory', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('sends one reboot per address, not one per player', async () => {
    // A second request would only land on a box already on its way down.
    const test = globalHarness({ rebootTargets: targets })
    new RebootAllAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.reboot).toHaveBeenCalledTimes(2)
    expect(test.client.reboot.mock.calls.map(([host]) => host))
      .toEqual(['192.168.4.11', '192.168.4.12'])
    expect(test.expectedReboots).toEqual(['192.168.4.11', '192.168.4.12'])
  })

  it('counts devices at info and names every box at debug, before any of it does', async () => {
    // Naming only the address would understate the reach on a multi-zone box.
    const test = globalHarness({ rebootTargets: targets })
    new RebootAllAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.log.calls.some((line) => line === 'info BluOS Reboot All: found 2 device(s), 3 player(s)'))
      .toBe(true)
    const listed = test.log.calls
      .find((line) => line.includes('rebooting 2 box(es) carrying 3 player(s)'))
    expect(listed).toMatch(/^debug /)
    expect(listed).toContain('192.168.4.11 (Zone One, Zone Two)')
    expect(listed).toContain('192.168.4.12 (Kitchen)')
    expect(test.log.calls.some((line) => line === 'info BluOS Reboot All: 2 of 2 device(s) rebooted'))
      .toBe(true)
  })

  it('does nothing when switched off', async () => {
    const test = globalHarness({ rebootTargets: targets })
    new RebootAllAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(false)

    expect(test.rebootTargets).not.toHaveBeenCalled()
    expect(test.client.reboot).not.toHaveBeenCalled()
  })

  it('warns rather than failing silently when it finds nothing', async () => {
    const test = globalHarness({ rebootTargets: [] })
    new RebootAllAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.log.calls.some((line) => line.startsWith('warn')
      && line.includes('nothing to reboot'))).toBe(true)
    expect(test.client.reboot).not.toHaveBeenCalled()
  })

  it('keeps going when one box cannot be reached', async () => {
    const test = globalHarness({ rebootTargets: targets })
    test.client.reboot.mockImplementation(async (host) => {
      if (host === '192.168.4.11') {
        throw new Error('EHOSTUNREACH')
      }
      return { acknowledged: true }
    })
    new RebootAllAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.reboot).toHaveBeenCalledTimes(2)
    expect(test.log.calls.some((line) => line.startsWith('warn')
      && line.includes('Zone One, Zone Two'))).toBe(true)
    expect(test.log.calls.some((line) => line === 'info BluOS Reboot All: 1 of 2 device(s) rebooted'))
      .toBe(true)
    expect(test.expectedReboots).toEqual(['192.168.4.12'])
  })

  it('always reads off, and springs back after a press', async () => {
    const test = globalHarness({ rebootTargets: targets })
    new RebootAllAccessory(test)
    const on = test.service('Switch').getCharacteristic('On')

    expect(on.read()).toBe(false)

    await on.write(true)
    jest.runOnlyPendingTimers()

    expect(test.service('Switch').lastValue('On')).toBe(false)
  })

  it('is never marked unavailable, having no player of its own', () => {
    const test = globalHarness({ rebootTargets: targets })
    const accessory = new RebootAllAccessory(test)

    accessory.noteUnreachable(new Error('EHOSTUNREACH'))

    expect(test.log.calls.some((line) => line.startsWith('warn'))).toBe(false)
    expect(test.service('Switch').lastValue('On')).not.toBeInstanceOf(Error)
    expect(test.service('Switch').getCharacteristic('On').read()).toBe(false)
  })
})
