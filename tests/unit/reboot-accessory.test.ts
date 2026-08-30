/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The per-player reboot switch.
 *
 * Most of these assert on things the switch deliberately does *not* do, because
 * that is where its value is: an accidental reboot is not recoverable the way an
 * accidental mute is, so "cannot be triggered by an off-sweep" and "does not
 * grey out" are the behaviours worth pinning down.
 */

import { RebootAccessory } from '../../src/devices/reboot-accessory'
import { harness, observation } from '../helpers/hap'

describe('RebootAccessory', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('reboots the player by address, since reboot lives on port 80', async () => {
    // Not the zone's control port: that answers 404 for /reboot.
    const test = harness({ context: { kind: 'reboot' }, displayName: 'Zone One Reboot' })
    new RebootAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.reboot).toHaveBeenCalledWith('192.168.4.11')
    expect(test.log.calls.some((line) => line === 'info Zone One Reboot: REBOOT')).toBe(true)
  })

  it('says at startup which other rooms it will take down with it', async () => {
    // A switch named for one room that silences another is worth saying out
    // loud, rather than leaving to be discovered by pressing it.
    const test = harness({
      context: { kind: 'reboot' },
      displayName: 'Zone One Reboot',
      sharingAddress: ['Zone Two'],
    })

    new RebootAccessory(test)

    expect(test.log.calls.some((line) => line.startsWith('warn')
      && line.includes('Zone One Reboot: will also reboot Zone Two')))
      .toBe(true)
  })

  it('stays quiet for a player that has its chassis to itself', () => {
    const test = harness({ context: { kind: 'reboot' } })

    new RebootAccessory(test)

    expect(test.log.calls.some((line) => line.startsWith('warn'))).toBe(false)
  })

  it('does nothing when switched off', async () => {
    // The point of the whole design: a scene, or "turn everything off", writes
    // false to every switch in the house. If false did anything here, going to
    // bed would restart the stereo.
    const test = harness({ context: { kind: 'reboot' } })
    new RebootAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(false)

    expect(test.client.reboot).not.toHaveBeenCalled()
  })

  it('always reads off, so no automation can see it as a state', () => {
    const test = harness({ context: { kind: 'reboot' } })
    const accessory = new RebootAccessory(test)

    expect(test.service('Switch').getCharacteristic('On').read()).toBe(false)

    accessory.applyObservation(observation(), 'poll')

    expect(test.service('Switch').getCharacteristic('On').read()).toBe(false)
  })

  it('springs back to off after a press', async () => {
    const test = harness({ context: { kind: 'reboot' } })
    new RebootAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)
    jest.runOnlyPendingTimers()

    expect(test.service('Switch').lastValue('On')).toBe(false)
  })

  it('tells the host to expect silence from the box it just rebooted', async () => {
    const test = harness({ context: { kind: 'reboot' } })
    new RebootAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.expectedReboots).toEqual(['192.168.4.11'])
  })

  it('does not expect silence when the reboot never left', async () => {
    const test = harness({ context: { kind: 'reboot' }, endpoint: undefined })
    new RebootAccessory(test)

    await expect(test.service('Switch').getCharacteristic('On').write(true))
      .rejects.toThrow(/no longer configured/)

    expect(test.expectedReboots).toEqual([])
  })

  it('springs back even when the reboot failed', async () => {
    // A tile stuck on would suggest something is still happening. Nothing is.
    const test = harness({ context: { kind: 'reboot' }, endpoint: undefined })
    new RebootAccessory(test)

    await expect(test.service('Switch').getCharacteristic('On').write(true))
      .rejects.toThrow(/no longer configured/)
    jest.runOnlyPendingTimers()

    expect(test.service('Switch').lastValue('On')).toBe(false)
  })

  it('says so when the player took the request and then went quiet', async () => {
    const test = harness({
      context: { kind: 'reboot' },
      displayName: 'Zone One Reboot',
      rebootResult: { acknowledged: false },
    })
    new RebootAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.log.calls.some((line) => line.startsWith('info Zone One Reboot: REBOOT')
      && line.includes('stopped answering'))).toBe(true)
  })

  it('stays pressable while the player is unreachable', async () => {
    // The whole reason it exists. A No Response tile cannot be pressed in the
    // Home app, and a player wedged badly enough to stop answering is exactly
    // the one you want to restart.
    const test = harness({ context: { kind: 'reboot' } })
    const accessory = new RebootAccessory(test)
    accessory.applyObservation(observation(), 'startup')

    accessory.noteUnreachable(new Error('EHOSTUNREACH'))

    expect(test.service('Switch').lastValue('On')).not.toBeInstanceOf(Error)
    expect(test.service('Switch').getCharacteristic('On').read()).toBe(false)
    await expect(test.service('Switch').getCharacteristic('On').write(true)).resolves
      .toBeUndefined()
    expect(test.client.reboot).toHaveBeenCalled()
  })

  it('fails the write when the player is no longer configured', async () => {
    const test = harness({ context: { kind: 'reboot' }, endpoint: undefined })
    new RebootAccessory(test)

    await expect(test.service('Switch').getCharacteristic('On').write(true))
      .rejects.toThrow(/no longer configured/)
  })

  it('never touches volume or mute', async () => {
    const test = harness({ context: { kind: 'reboot' } })
    new RebootAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.setVolume).not.toHaveBeenCalled()
    expect(test.client.setMute).not.toHaveBeenCalled()
  })
})
