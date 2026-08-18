/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import { MuteAccessory } from '../../src/devices/mute-accessory'
import { harness, observation } from '../helpers/hap'

describe('MuteAccessory', () => {
  it('exposes a switch where on means muted', async () => {
    const test = harness({ context: { kind: 'mute' }, displayName: 'Zone One Mute' })
    new MuteAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.setMute)
      .toHaveBeenCalledWith({ host: '192.168.4.11', port: 11_000 }, true, { tellSlaves: false })
    expect(test.log.calls.some((line) => line === 'info Zone One Mute: ON')).toBe(true)
  })

  it('mutes the whole group when the zone leads one', async () => {
    // Matches the slider on the same player: while the group exists, the
    // leader's tiles are the group's controls.
    const test = harness({
      context: { kind: 'mute' },
      observation: observation({ syncRole: 'primary' }),
    })
    new MuteAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.setMute)
      .toHaveBeenCalledWith(expect.anything(), true, { tellSlaves: true })
  })

  it('mutes only itself when the zone follows a group', async () => {
    const test = harness({
      context: { kind: 'mute' },
      observation: observation({ syncRole: 'secondary' }),
    })
    new MuteAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.setMute)
      .toHaveBeenCalledWith(expect.anything(), true, { tellSlaves: false })
  })

  it('unmutes when switched off', async () => {
    const test = harness({ context: { kind: 'mute' } })
    new MuteAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(false)

    expect(test.client.setMute).toHaveBeenCalledWith(expect.anything(), false, { tellSlaves: false })
    expect(test.log.calls.some((line) => line === 'info Zone One: OFF')).toBe(true)
  })

  it('never touches the level, so mute and the slider cannot fight', async () => {
    const test = harness({ context: { kind: 'mute' } })
    new MuteAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.setVolume).not.toHaveBeenCalled()
  })

  it('adopts the state the write returned', async () => {
    const test = harness({
      context: { kind: 'mute' },
      muteResult: { level: 0, fixedVolume: false, muted: true, muteVolume: 60 },
    })
    new MuteAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.adopted).toEqual([{
      level: 0,
      fixedVolume: false,
      muted: true,
      muteVolume: 60,
    }])
  })

  it('warns once when the player refuses the change', async () => {
    const test = harness({
      context: { kind: 'mute' },
      muteResult: { level: 60, fixedVolume: false, muted: false },
    })
    new MuteAccessory(test)
    const on = test.service('Switch').getCharacteristic('On')

    await on.write(true)
    await on.write(true)

    const warnings = test.log.calls.filter((line) => line.startsWith('warn')
      && line.includes('did not accept'))
    expect(warnings).toHaveLength(1)
  })

  it('refuses to answer before the player has been read', () => {
    const test = harness({ context: { kind: 'mute' } })
    new MuteAccessory(test)

    expect(() => test.service('Switch').getCharacteristic('On').read())
      .toThrow(/HapStatusError:-70402/)
  })

  it('reports the observed mute state', () => {
    const test = harness({ context: { kind: 'mute' } })
    const accessory = new MuteAccessory(test)

    accessory.applyObservation(observation({ muted: true, volume: 0, muteVolume: 60 }), 'poll')

    expect(test.service('Switch').getCharacteristic('On').read()).toBe(true)
    expect(test.service('Switch').lastValue('On')).toBe(true)
  })

  it('does not report mute for a player merely turned down to zero', () => {
    // Firmware reports the same volume and dB for both; only muteVolume differs.
    const test = harness({ context: { kind: 'mute' } })
    const accessory = new MuteAccessory(test)

    accessory.applyObservation(observation({ muted: false, volume: 0, db: -100 }), 'poll')

    expect(test.service('Switch').getCharacteristic('On').read()).toBe(false)
  })

  it('goes unavailable when the player stops answering', () => {
    const test = harness({ context: { kind: 'mute' } })
    const accessory = new MuteAccessory(test)
    accessory.applyObservation(observation(), 'startup')

    accessory.noteUnreachable(new Error('EHOSTUNREACH'))

    expect(test.service('Switch').lastValue('On')).toBeInstanceOf(Error)
    expect(() => test.service('Switch').getCharacteristic('On').read()).toThrow(/HapStatusError/)
  })

  it('warns once while a player stays unreachable', () => {
    const test = harness({ context: { kind: 'mute' } })
    const accessory = new MuteAccessory(test)
    accessory.applyObservation(observation(), 'startup')

    accessory.noteUnreachable(new Error('EHOSTUNREACH'))
    accessory.noteUnreachable(new Error('EHOSTUNREACH'))

    const warnings = test.log.calls.filter((line) => line.startsWith('warn'))
    expect(warnings).toHaveLength(1)
    expect(test.log.calls.some((line) => line.startsWith('debug')
      && line.includes('still not responding'))).toBe(true)
  })

  it('warns again after the player recovers and fails once more', () => {
    const test = harness({ context: { kind: 'mute' } })
    const accessory = new MuteAccessory(test)

    accessory.noteUnreachable(new Error('first'))
    accessory.applyObservation(observation(), 'poll')
    accessory.noteUnreachable(new Error('second'))

    expect(test.log.calls.filter((line) => line.startsWith('warn'))).toHaveLength(2)
  })

  it('fails the write when the player is no longer configured', async () => {
    const test = harness({ context: { kind: 'mute' }, endpoint: undefined })
    new MuteAccessory(test)

    await expect(test.service('Switch').getCharacteristic('On').write(true))
      .rejects.toThrow(/no longer configured/)
  })
})
