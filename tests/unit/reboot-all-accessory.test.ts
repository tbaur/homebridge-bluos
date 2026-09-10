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
import {
  HOMEKIT_WRITE_BUDGET_MS,
  MOMENTARY_RESET_MS,
  PLATFORM_DEVICE_ID,
} from '../../src/settings'
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

  it('reads off when idle, and springs back after a press', async () => {
    const test = globalHarness({ rebootTargets: targets })
    new RebootAllAccessory(test)
    const on = test.service('Switch').getCharacteristic('On')

    expect(on.read()).toBe(false)

    await on.write(true)
    jest.runOnlyPendingTimers()

    expect(test.service('Switch').lastValue('On')).toBe(false)
  })

  describe('one wave at a time', () => {
    /** Hold the sweep open, so a second press can be tried while the first runs. */
    function heldSweep(test: ReturnType<typeof globalHarness>): () => void {
      let release = (): void => {}
      test.rebootTargets.mockImplementation(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return targets
      })
      return () => release()
    }

    it('stays on past the write budget, until the wave itself finishes', async () => {
      // The defect this pins down: the sweep runs for the whole discovery window,
      // several times the write budget, so a reset tied to the budget sprang the
      // tile back before the first line of the log was written. A press then
      // looked like it had done nothing at all.
      const test = globalHarness({ rebootTargets: targets })
      const release = heldSweep(test)
      new RebootAllAccessory(test)
      const on = test.service('Switch').getCharacteristic('On')

      const press = on.write(true)
      await jest.advanceTimersByTimeAsync(HOMEKIT_WRITE_BUDGET_MS + 1)
      await press

      // HomeKit has its answer, and the wave has not sent anything yet.
      expect(on.read()).toBe(true)
      expect(test.client.reboot).not.toHaveBeenCalled()

      release()
      await jest.advanceTimersByTimeAsync(MOMENTARY_RESET_MS + 1)

      expect(test.client.reboot).toHaveBeenCalledTimes(2)
      expect(on.read()).toBe(false)
      expect(test.service('Switch').lastValue('On')).toBe(false)
    })

    it('ignores a press that arrives while a wave is still running', async () => {
      // Each repeat press used to sweep a fleet that was already half way down,
      // find fewer boxes than the press before it, and report the ones it did
      // find as failures.
      const test = globalHarness({ rebootTargets: targets })
      const release = heldSweep(test)
      new RebootAllAccessory(test)
      const on = test.service('Switch').getCharacteristic('On')

      const press = on.write(true)
      await jest.advanceTimersByTimeAsync(HOMEKIT_WRITE_BUDGET_MS + 1)
      await press
      await on.write(true)

      expect(test.rebootTargets).toHaveBeenCalledTimes(1)
      expect(test.log.calls.some((line) => line.startsWith('info')
        && line.includes('already under way'))).toBe(true)

      release()
      await jest.advanceTimersByTimeAsync(MOMENTARY_RESET_MS + 1)
    })

    it('sweeps again once the tile has sprung back, and finds the fleet restarting', async () => {
      const test = globalHarness({ rebootTargets: targets })
      new RebootAllAccessory(test)
      const on = test.service('Switch').getCharacteristic('On')

      await on.write(true)
      await jest.advanceTimersByTimeAsync(MOMENTARY_RESET_MS + 1)
      test.client.reboot.mockClear()
      await on.write(true)

      expect(test.rebootTargets).toHaveBeenCalledTimes(2)
      expect(test.client.reboot).not.toHaveBeenCalled()
    })
  })

  describe('boxes that are already restarting', () => {
    it('leaves an address inside its grace window alone', async () => {
      // Nothing serves port 80 while a box boots, so a request there could only
      // fail — and reporting that as `could not reboot` states the opposite of
      // what is true, which is that an earlier press worked.
      const test = globalHarness({ rebootTargets: targets, rebooting: ['192.168.4.11'] })
      new RebootAllAccessory(test)

      await test.service('Switch').getCharacteristic('On').write(true)

      expect(test.client.reboot.mock.calls.map(([host]) => host)).toEqual(['192.168.4.12'])
      expect(test.log.calls).toContain(
        'info BluOS Reboot All: skipping 1 device(s) already restarting: 192.168.4.11',
      )
    })

    it('counts only the boxes it actually sent to', async () => {
      const test = globalHarness({ rebootTargets: targets, rebooting: ['192.168.4.11'] })
      new RebootAllAccessory(test)

      await test.service('Switch').getCharacteristic('On').write(true)

      // Still reports everything it found, so the skip is explained rather than
      // looking like a sweep that quietly missed a box.
      expect(test.log.calls).toContain('info BluOS Reboot All: found 2 device(s), 3 player(s)')
      expect(test.log.calls).toContain('info BluOS Reboot All: 1 of 1 device(s) rebooted')
    })

    it('sends nothing when every box found is already restarting', async () => {
      const test = globalHarness({
        rebootTargets: targets,
        rebooting: ['192.168.4.11', '192.168.4.12'],
      })
      new RebootAllAccessory(test)

      await test.service('Switch').getCharacteristic('On').write(true)

      expect(test.client.reboot).not.toHaveBeenCalled()
      expect(test.log.calls.some((line) => line.startsWith('info')
        && line.includes('every device found is already restarting'))).toBe(true)
      expect(test.log.calls.some((line) => line.includes('device(s) rebooted'))).toBe(false)
    })

    it('does not warn when a box starts restarting after the check', async () => {
      // The per-player switch, or a press on another controller, can open the
      // window between the check and the request. A refused port 80 then means
      // the box is going down, which is what this request wanted.
      const test = globalHarness({ rebootTargets: targets })
      test.client.reboot.mockImplementation(async (host) => {
        if (host === '192.168.4.11') {
          test.host.expectReboot('192.168.4.11')
          throw new Error('connect ECONNREFUSED 192.168.4.11:80')
        }
        return { acknowledged: true }
      })
      new RebootAllAccessory(test)

      await test.service('Switch').getCharacteristic('On').write(true)

      expect(test.log.calls.some((line) => line.startsWith('warn'))).toBe(false)
      expect(test.log.calls.some((line) => line.startsWith('debug')
        && line.includes('192.168.4.11 (Zone One, Zone Two) is already restarting'))).toBe(true)
      expect(test.log.calls).toContain('info BluOS Reboot All: 2 of 2 device(s) rebooted')
    })
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
