/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import { VolumePresetAccessory } from '../../src/devices/volume-preset-accessory'
import { harness, observation } from '../helpers/hap'

const presetContext = { kind: 'volumePreset' as const, volume: 30 }

describe('VolumePresetAccessory', () => {
  it('sets exactly its configured level, which is what makes it automation-safe', async () => {
    const test = harness({ context: presetContext, displayName: 'Bedtime Volume' })
    new VolumePresetAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.setVolume)
      .toHaveBeenCalledWith({ host: '192.168.4.11', port: 11_000 }, 30, { tellSlaves: false })
    expect(test.log.calls.some((line) => line === 'info Bedtime Volume: SET 30')).toBe(true)
  })

  it('sets the whole group when the zone leads one', async () => {
    // A preset has to agree with the slider beside it: both are "put this room at
    // this level", and one of them reaching the group while the other does not
    // would be indefensible.
    const test = harness({
      context: presetContext,
      observation: observation({ syncRole: 'primary' }),
    })
    new VolumePresetAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.setVolume)
      .toHaveBeenCalledWith(expect.anything(), 30, { tellSlaves: true })
    expect(test.log.calls.some((line) => line === 'info Zone One: SET 30 (group)')).toBe(true)
  })

  it('unmutes first, so the preset cannot leave the room silent', async () => {
    const test = harness({
      context: presetContext,
      observation: observation({ muted: true, volume: 0, muteVolume: 60 }),
    })
    new VolumePresetAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.setMute).toHaveBeenCalledWith(expect.anything(), false, { tellSlaves: false })
    expect(test.client.setVolume).toHaveBeenCalledWith(expect.anything(), 30, { tellSlaves: false })
  })

  it('does not unmute for a preset of zero', async () => {
    const test = harness({
      context: { kind: 'volumePreset', volume: 0 },
      observation: observation({ muted: true, volume: 0 }),
    })
    new VolumePresetAccessory(test)

    await test.service('Switch').getCharacteristic('On').write(true)

    expect(test.client.setMute).not.toHaveBeenCalled()
  })

  it('treats switching off as nothing to undo, and re-asserts reality', async () => {
    const test = harness({ context: presetContext, observation: observation({ volume: 30 }) })
    new VolumePresetAccessory(test)
    const on = test.service('Switch').getCharacteristic('On')

    await on.write(false)

    expect(test.client.setVolume).not.toHaveBeenCalled()
    // The tile snaps back to the player's state rather than showing the tap.
    expect(test.service('Switch').lastValue('On')).toBe(true)
  })

  it('tolerates switching off before any observation exists', async () => {
    const test = harness({ context: presetContext })
    new VolumePresetAccessory(test)

    await expect(test.service('Switch').getCharacteristic('On').write(false))
      .resolves.toBeUndefined()
  })

  it('is on only while the player sits at its level', () => {
    const test = harness({ context: presetContext })
    const accessory = new VolumePresetAccessory(test)

    accessory.applyObservation(observation({ volume: 30 }), 'poll')
    expect(test.service('Switch').getCharacteristic('On').read()).toBe(true)

    accessory.applyObservation(observation({ volume: 31 }), 'poll')
    expect(test.service('Switch').getCharacteristic('On').read()).toBe(false)
  })

  it('is off while muted, even at the right level', () => {
    const test = harness({ context: presetContext })
    const accessory = new VolumePresetAccessory(test)

    accessory.applyObservation(observation({ muted: true, volume: 30 }), 'poll')

    expect(test.service('Switch').getCharacteristic('On').read()).toBe(false)
  })

  it('is off for a fixed-output player', () => {
    const test = harness({ context: presetContext })
    const accessory = new VolumePresetAccessory(test)

    accessory.applyObservation(observation({ fixedVolume: true, volume: undefined }), 'poll')

    expect(test.service('Switch').getCharacteristic('On').read()).toBe(false)
  })

  it('explains once when the player\'s range cannot reach the preset', async () => {
    const test = harness({
      context: presetContext,
      volumeResult: { level: 42, fixedVolume: false, muted: false },
    })
    new VolumePresetAccessory(test)
    const on = test.service('Switch').getCharacteristic('On')

    await on.write(true)
    await on.write(true)

    const warnings = test.log.calls.filter((line) => line.startsWith('warn')
      && line.includes('cannot reach 30'))
    expect(warnings).toHaveLength(1)
  })

  it('refuses to answer before the player has been read', () => {
    const test = harness({ context: presetContext })
    new VolumePresetAccessory(test)

    expect(() => test.service('Switch').getCharacteristic('On').read())
      .toThrow(/HapStatusError:-70402/)
  })

  it('goes unavailable when the player stops answering', () => {
    const test = harness({ context: presetContext })
    const accessory = new VolumePresetAccessory(test)
    accessory.applyObservation(observation({ volume: 30 }), 'startup')

    accessory.noteUnreachable(new Error('ETIMEDOUT'))

    expect(test.service('Switch').lastValue('On')).toBeInstanceOf(Error)
  })

  it('fails the write when the player is no longer configured', async () => {
    const test = harness({ context: presetContext, endpoint: undefined })
    new VolumePresetAccessory(test)

    await expect(test.service('Switch').getCharacteristic('On').write(true))
      .rejects.toThrow(/no longer configured/)
  })
})
