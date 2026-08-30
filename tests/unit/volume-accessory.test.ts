/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The behaviours worth protecting here are the ones a user would report as
 * "the volume jumps" or "the slider lies": coalescing the pair of writes HomeKit
 * sends when a slider leaves zero, unmuting before setting a level, adopting the
 * player's clamped answer instead of the requested value, and refusing to invent
 * a position before the player has been read.
 */

import { VolumeAccessory } from '../../src/devices/volume-accessory'
import { SLIDER_COALESCE_MS } from '../../src/settings'
import { harness, observation, SERVICE_COMMUNICATION_FAILURE } from '../helpers/hap'

/** Long enough for the coalescing window to close. */
const afterCoalescing = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, SLIDER_COALESCE_MS + 40))
}

describe('VolumeAccessory', () => {
  it('exposes a Fanv2 by default, which Siri light commands do not sweep up', () => {
    const test = harness()

    new VolumeAccessory(test)

    expect(test.service('Fanv2')).toBeDefined()
    expect(test.accessory.services.some((service) => service.UUID === 'Lightbulb')).toBe(false)
  })

  it('exposes a Lightbulb when configured to', () => {
    const test = harness({ context: { sliderService: 'lightbulb' } })

    new VolumeAccessory(test)

    expect(test.service('Lightbulb')).toBeDefined()
  })

  it('constrains the slider to whole BluOS levels', () => {
    const test = harness()

    new VolumeAccessory(test)

    expect(test.service('Fanv2').getCharacteristic('RotationSpeed').props)
      .toMatchObject({ minValue: 0, maxValue: 100, minStep: 1 })
  })

  it('reuses a restored service, so the room and automations survive a restart', () => {
    const test = harness()

    new VolumeAccessory(test)
    const first = test.service('Fanv2')
    new VolumeAccessory(test)

    expect(test.accessory.services.filter((service) => service.UUID === 'Fanv2'))
      .toHaveLength(1)
    expect(test.service('Fanv2')).toBe(first)
  })

  it('removes the previous control when the slider style changes', () => {
    const test = harness({ context: { sliderService: 'lightbulb' } })
    new VolumeAccessory(test)
    expect(test.accessory.services.some((service) => service.UUID === 'Lightbulb')).toBe(true)

    // The style is deliberately not part of accessory identity, so the same
    // accessory is adopted. Leaving the old service attached would show the user
    // two controls, one of them bound to nothing — and a stray Lightbulb is
    // exactly what the fan default exists to avoid.
    test.context.sliderService = 'fan'
    new VolumeAccessory(test)

    expect(test.accessory.services.filter((service) => service.UUID === 'Lightbulb')).toHaveLength(0)
    expect(test.accessory.services.filter((service) => service.UUID === 'Fanv2')).toHaveLength(1)
    expect(test.log.calls.some((line) => line.includes('changed control style'))).toBe(true)
  })

  describe('reads', () => {
    it('refuses to answer before the player has been read', () => {
      const test = harness()
      new VolumeAccessory(test)

      // No Response is the honest answer; a plausible default would make
      // automations fire against fiction.
      expect(() => test.service('Fanv2').getCharacteristic('RotationSpeed').read())
        .toThrow(/HapStatusError:-70402/)
    })

    it('answers once an observation has arrived', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ volume: 60 }), 'startup')

      expect(test.service('Fanv2').getCharacteristic('RotationSpeed').read()).toBe(60)
      expect(test.service('Fanv2').getCharacteristic('Active').read()).toBe(1)
    })

    it('reads level zero as inactive', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ volume: 0 }), 'poll')

      expect(test.service('Fanv2').getCharacteristic('Active').read()).toBe(0)
    })

    it('refuses again after the player stops answering', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)
      accessory.applyObservation(observation(), 'startup')

      accessory.noteUnreachable(new Error('ETIMEDOUT'))

      expect(() => test.service('Fanv2').getCharacteristic('RotationSpeed').read())
        .toThrow(/HapStatusError/)
      expect(test.service('Fanv2').lastValue('RotationSpeed')).toBeInstanceOf(Error)
    })
  })

  describe('writes', () => {
    it('sends one level when HomeKit turns the slider on and moves it at once', async () => {
      // Dragging a Fanv2 up from zero produces Active then RotationSpeed. Acting
      // on both would set the restore level and then the requested one, which
      // the user hears as a jump.
      const test = harness({ context: { lastNonZeroVolume: 20 } })
      new VolumeAccessory(test)
      const service = test.service('Fanv2')

      await Promise.all([
        service.getCharacteristic('Active').write(1),
        service.getCharacteristic('RotationSpeed').write(75),
      ])
      await afterCoalescing()

      expect(test.client.setVolume).toHaveBeenCalledTimes(1)
      expect(test.client.setVolume).toHaveBeenCalledWith({ host: '192.168.4.11', port: 11_000 }, 75, { tellSlaves: false })
      expect(test.log.calls.some((line) => line === 'info Zone One: SET 75')).toBe(true)
    })

    it('writes level zero when switched off, rather than muting', async () => {
      // Level and mute stay separate so the two controls never fight.
      const test = harness()
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('Active').write(0)
      await afterCoalescing()

      expect(test.client.setVolume).toHaveBeenCalledWith(expect.anything(), 0, { tellSlaves: false })
      expect(test.client.setMute).not.toHaveBeenCalled()
    })

    it('restores the player\'s own remembered level when switched on while muted', async () => {
      const test = harness({
        observation: observation({ muted: true, volume: 0, muteVolume: 55 }),
        context: { lastNonZeroVolume: 20 },
      })
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('Active').write(1)
      await afterCoalescing()

      // muteVolume beats the persisted fallback: the player is authoritative.
      expect(test.client.setVolume).toHaveBeenCalledWith(expect.anything(), 55, { tellSlaves: false })
    })

    it('falls back to the persisted level when the player remembers nothing', async () => {
      const test = harness({
        observation: observation({ volume: 0 }),
        context: { lastNonZeroVolume: 20 },
      })
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('Active').write(1)
      await afterCoalescing()

      expect(test.client.setVolume).toHaveBeenCalledWith(expect.anything(), 20, { tellSlaves: false })
    })

    it('unmutes before setting a level, so the slider cannot lie about silence', async () => {
      const test = harness({ observation: observation({ muted: true, volume: 0 }) })
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('RotationSpeed').write(40)
      await afterCoalescing()

      expect(test.client.setMute).toHaveBeenCalledWith(expect.anything(), false, { tellSlaves: false })
      expect(test.client.setVolume).toHaveBeenCalledWith(expect.anything(), 40, { tellSlaves: false })
    })

    it('moves the whole group when the zone leads one', async () => {
      // While a group exists, the leader's tile is the group's control, which is
      // what the BluOS app does with the same slider.
      const test = harness({ observation: observation({ syncRole: 'primary' }) })
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('RotationSpeed').write(40)
      await afterCoalescing()

      expect(test.client.setVolume)
        .toHaveBeenCalledWith(expect.anything(), 40, { tellSlaves: true })
    })

    it('moves only itself when the zone follows a group', async () => {
      // A tile labelled one room must not quietly change the room leading it.
      const test = harness({ observation: observation({ syncRole: 'secondary' }) })
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('RotationSpeed').write(40)
      await afterCoalescing()

      expect(test.client.setVolume)
        .toHaveBeenCalledWith(expect.anything(), 40, { tellSlaves: false })
    })

    it('stops moving the group as soon as the player reports it has ungrouped', async () => {
      const test = harness({ observation: observation({ syncRole: 'primary' }) })
      new VolumeAccessory(test)

      test.setObservation(observation({ syncRole: 'standalone' }))
      await test.service('Fanv2').getCharacteristic('RotationSpeed').write(40)
      await afterCoalescing()

      expect(test.client.setVolume)
        .toHaveBeenCalledWith(expect.anything(), 40, { tellSlaves: false })
    })

    it('unmutes the group too, so a leader\'s slider is not half-applied', async () => {
      const test = harness({
        observation: observation({ syncRole: 'primary', muted: true, volume: 0 }),
      })
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('RotationSpeed').write(40)
      await afterCoalescing()

      expect(test.client.setMute)
        .toHaveBeenCalledWith(expect.anything(), false, { tellSlaves: true })
    })

    it('does not unmute when the requested level is zero', async () => {
      const test = harness({ observation: observation({ muted: true, volume: 0 }) })
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('RotationSpeed').write(0)
      await afterCoalescing()

      expect(test.client.setMute).not.toHaveBeenCalled()
    })

    it('adopts the level the player settled on, and explains a clamp once', async () => {
      const test = harness({ volumeResult: { level: 65, fixedVolume: false, muted: false } })
      new VolumeAccessory(test)
      const speed = test.service('Fanv2').getCharacteristic('RotationSpeed')

      await speed.write(90)
      await afterCoalescing()
      await speed.write(95)
      await afterCoalescing()

      expect(test.adopted.map((result) => result.level)).toEqual([65, 65])
      const clampWarnings = test.log.calls.filter((line) => line.startsWith('warn')
        && line.includes('clamped'))
      expect(clampWarnings).toHaveLength(1)
    })

    it('clamps an out-of-range request from HomeKit', async () => {
      const test = harness()
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('RotationSpeed').write(140)
      await afterCoalescing()

      expect(test.client.setVolume).toHaveBeenCalledWith(expect.anything(), 100, { tellSlaves: false })
    })

    it('rounds a fractional request, since BluOS levels are integers', async () => {
      const test = harness()
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('RotationSpeed').write(42.6)
      await afterCoalescing()

      expect(test.client.setVolume).toHaveBeenCalledWith(expect.anything(), 43, { tellSlaves: false })
    })

    it('ignores a non-numeric value instead of writing something invented', async () => {
      const test = harness()
      new VolumeAccessory(test)

      await test.service('Fanv2').getCharacteristic('RotationSpeed').write('loud')
      await afterCoalescing()

      expect(test.client.setVolume).not.toHaveBeenCalled()
    })

    it('reports a failed write to HomeKit and logs it', async () => {
      const test = harness()
      test.client.setVolume.mockRejectedValue(new Error('ECONNRESET'))
      new VolumeAccessory(test)

      await expect(test.service('Fanv2').getCharacteristic('RotationSpeed').write(30))
        .rejects.toThrow('ECONNRESET')
      expect(test.log.calls.some((line) => line.startsWith('warn') && line.includes('failed')))
        .toBe(true)
    })

    it('fails the write when the player is no longer configured', async () => {
      const test = harness({ endpoint: undefined })
      new VolumeAccessory(test)

      await expect(test.service('Fanv2').getCharacteristic('RotationSpeed').write(30))
        .rejects.toThrow(/no longer configured/)
    })

    it('drives the Lightbulb variant with booleans', async () => {
      const test = harness({ context: { sliderService: 'lightbulb', lastNonZeroVolume: 33 } })
      new VolumeAccessory(test)

      await test.service('Lightbulb').getCharacteristic('On').write(true)
      await afterCoalescing()

      expect(test.client.setVolume).toHaveBeenCalledWith(expect.anything(), 33, { tellSlaves: false })
    })
  })

  describe('observations', () => {
    it('pushes level and activity to HomeKit', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ volume: 45 }), 'poll')

      expect(test.service('Fanv2').lastValue('RotationSpeed')).toBe(45)
      expect(test.service('Fanv2').lastValue('Active')).toBe(1)
    })

    it('shows a muted player as off, because it reports level zero', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ muted: true, volume: 0, muteVolume: 60 }), 'poll')

      expect(test.service('Fanv2').lastValue('RotationSpeed')).toBe(0)
      expect(test.service('Fanv2').lastValue('Active')).toBe(0)
    })

    it('remembers the last non-zero level for the next switch-on', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ volume: 47 }), 'poll')

      expect(test.context.lastNonZeroVolume).toBe(47)
      expect(test.persisted).toBe(1)
    })

    it('persists the remembered level only when it changes', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ volume: 47 }), 'poll')
      accessory.applyObservation(observation({ volume: 47 }), 'poll')

      expect(test.persisted).toBe(1)
    })

    it('updates identity from the player when it knows better', () => {
      const test = harness({ context: { brand: 'BluOS', model: 'BluOS Player' } })
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation(), 'startup')

      expect(test.service('AccessoryInformation').lastValue('Manufacturer')).toBe('NAD')
      expect(test.service('AccessoryInformation').lastValue('Model')).toBe('CI S2')
    })

    it('reports the plugin version, not the player firmware, as FirmwareRevision', () => {
      const test = harness()

      new VolumeAccessory(test)

      expect(test.service('AccessoryInformation').lastValue('FirmwareRevision')).toBe('1.2.3')
    })

    it('publishes the opaque serial number rather than the MAC', () => {
      const test = harness()

      new VolumeAccessory(test)

      expect(test.service('AccessoryInformation').lastValue('SerialNumber')).toBe('serial-1')
    })
  })

  describe('fixed volume', () => {
    it('goes unavailable and explains itself once', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ fixedVolume: true, volume: undefined }), 'startup')
      accessory.applyObservation(observation({ fixedVolume: true, volume: undefined }), 'poll')

      const warnings = test.log.calls.filter((line) => line.startsWith('warn')
        && line.includes('fixed output level'))
      expect(warnings).toHaveLength(1)
      expect(test.service('Fanv2').lastValue('RotationSpeed')).toBeInstanceOf(Error)
    })

    it('refuses reads while output is fixed', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ fixedVolume: true, volume: undefined }), 'startup')

      expect(() => test.service('Fanv2').getCharacteristic('RotationSpeed').read())
        .toThrow(new RegExp(String(SERVICE_COMMUNICATION_FAILURE)))
    })

    it('does not write to a fixed-output player', async () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)
      accessory.applyObservation(observation({ fixedVolume: true, volume: undefined }), 'startup')

      await test.service('Fanv2').getCharacteristic('RotationSpeed').write(50)
      await afterCoalescing()

      expect(test.client.setVolume).not.toHaveBeenCalled()
    })

    it('recovers if the player stops reporting fixed output', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ fixedVolume: true, volume: undefined }), 'startup')
      accessory.applyObservation(observation({ volume: 30 }), 'poll')

      expect(test.service('Fanv2').getCharacteristic('RotationSpeed').read()).toBe(30)
    })
  })

  it('carries the battery service when it is the host tile', () => {
    const test = harness({ context: { kind: 'volume', hostsBattery: true } })
    const accessory = new VolumeAccessory(test)

    accessory.applyObservation(observation({ volume: 22, battery: { level: 40, charging: false } }), 'poll')

    expect(test.service('Fanv2').lastValue('RotationSpeed')).toBe(22)
    expect(test.service('Battery').lastValue('BatteryLevel')).toBe(40)
    expect(test.service('Battery').lastValue('StatusLowBattery')).toBe(0)
  })
})
