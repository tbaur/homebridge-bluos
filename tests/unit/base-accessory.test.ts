/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Behaviour shared by every accessory, exercised through the volume slider
 * because the base class is abstract. The write budget is the part that matters
 * most: HAP-NodeJS abandons a write that takes too long and discards its result,
 * so a slow player must not be allowed to hold the handler open.
 */

import { VolumeAccessory } from '../../src/devices/volume-accessory'
import {
  HOMEKIT_WRITE_BUDGET_MS,
  POLL_FAILURE_REWARN_MS,
  SLIDER_COALESCE_MS,
} from '../../src/settings'
import { harness, observation } from '../helpers/hap'

describe('shared accessory behaviour', () => {
  describe('the HomeKit write budget', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    /** Start a slider write whose underlying call is still in flight. */
    async function slowWrite(holdMs: number, outcome: 'resolve' | 'reject' = 'resolve') {
      const test = harness()
      const accessory = new VolumeAccessory(test)
      accessory.applyObservation(observation({ volume: 10 }), 'startup')
      test.client.setVolume.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, holdMs))
        if (outcome === 'reject') {
          throw new Error('the player took too long and then failed')
        }
        return { level: 30, fixedVolume: false, muted: false }
      })

      const pending = test.service('Fanv2').getCharacteristic('RotationSpeed').write(30)
      await jest.advanceTimersByTimeAsync(SLIDER_COALESCE_MS + 20)
      return { test, pending }
    }

    it('returns to HomeKit rather than waiting out a slow player', async () => {
      const { test, pending } = await slowWrite(HOMEKIT_WRITE_BUDGET_MS * 4)

      await jest.advanceTimersByTimeAsync(HOMEKIT_WRITE_BUDGET_MS + 50)

      await expect(pending).resolves.toBeUndefined()
      expect(test.log.calls.some((line) => line.includes('completing in the background'))).toBe(true)
    })

    it('lets the abandoned write finish, so its result still reaches HomeKit', async () => {
      const { test, pending } = await slowWrite(HOMEKIT_WRITE_BUDGET_MS * 2)

      await jest.advanceTimersByTimeAsync(HOMEKIT_WRITE_BUDGET_MS + 50)
      await pending
      expect(test.adopted).toEqual([])

      await jest.advanceTimersByTimeAsync(HOMEKIT_WRITE_BUDGET_MS * 2)

      expect(test.adopted).toEqual([{ level: 30, fixedVolume: false, muted: false }])
    })

    it('logs a failure that arrives after the budget instead of losing it', async () => {
      const { test, pending } = await slowWrite(HOMEKIT_WRITE_BUDGET_MS * 2, 'reject')

      await jest.advanceTimersByTimeAsync(HOMEKIT_WRITE_BUDGET_MS + 50)
      // Resolved, because HomeKit is no longer listening by now.
      await expect(pending).resolves.toBeUndefined()
      await jest.advanceTimersByTimeAsync(HOMEKIT_WRITE_BUDGET_MS * 2)

      expect(test.log.calls.some((line) => line.startsWith('warn')
        && line.includes('took too long and then failed'))).toBe(true)
    })

    it('fails the write when the failure arrives inside the budget', async () => {
      const { pending } = await slowWrite(HOMEKIT_WRITE_BUDGET_MS / 5, 'reject')
      // Asserted before the clock moves, so the rejection is never momentarily
      // unhandled, which Jest reports as a failure in its own right.
      const settled = expect(pending).rejects.toThrow(/took too long and then failed/)

      await jest.advanceTimersByTimeAsync(HOMEKIT_WRITE_BUDGET_MS / 2)

      await settled
    })
  })

  describe('identity published to HomeKit', () => {
    it('publishes the configured identity, with the plugin version as firmware', () => {
      const test = harness()

      new VolumeAccessory(test)

      const information = test.service('AccessoryInformation')
      expect(information.lastValue('Manufacturer')).toBe('NAD')
      expect(information.lastValue('Model')).toBe('CI S2')
      expect(information.lastValue('SerialNumber')).toBe('serial-1')
      expect(information.lastValue('FirmwareRevision')).toBe('1.2.3')
    })

    it('corrects the brand and model from what the player reports', () => {
      const test = harness({ context: { brand: 'BluOS', model: 'BluOS Player' } })
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ brand: 'Bluesound', modelName: 'PULSE M' }), 'startup')

      const information = test.service('AccessoryInformation')
      expect(information.lastValue('Manufacturer')).toBe('Bluesound')
      expect(information.lastValue('Model')).toBe('PULSE M')
    })

    it('falls back to the model code when the player gives no friendly name', () => {
      const test = harness({ context: { model: 'BluOS Player' } })
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(
        observation({ model: 'N125', modelName: undefined }),
        'startup',
      )

      expect(test.service('AccessoryInformation').lastValue('Model')).toBe('N125')
    })

    it('caps and cleans a brand and model taken off the wire', () => {
      const test = harness({ context: { brand: 'BluOS', model: 'BluOS Player' } })
      const accessory = new VolumeAccessory(test)

      // These come from an unauthenticated endpoint, can be as long as the whole
      // response body, and land in a HomeKit characteristic and the accessory
      // cache on disk. Configuration values are sanitised the same way.
      accessory.applyObservation(
        observation({ brand: 'X'.repeat(200), modelName: 'PULSE\u0000 M\n' }),
        'startup',
      )

      const information = test.service('AccessoryInformation')
      expect(String(information.lastValue('Manufacturer')).length).toBeLessThanOrEqual(64)
      expect(information.lastValue('Model')).toBe('PULSE M')
    })

    it('keeps the known identity when the player reports a blank one', () => {
      const test = harness({ context: { brand: 'NAD', model: 'CI S2' } })
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation({ brand: '  ', modelName: '\u0001' }), 'startup')

      const information = test.service('AccessoryInformation')
      expect(information.lastValue('Manufacturer')).toBe('NAD')
      expect(information.lastValue('Model')).toBe('CI S2')
    })

    it('leaves identity alone when the player repeats what is already known', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)
      const information = test.service('AccessoryInformation')
      const before = information.getCharacteristic('Model').updates.length

      accessory.applyObservation(observation({ brand: 'NAD', modelName: 'CI S2' }), 'poll')

      expect(information.getCharacteristic('Model').updates.length).toBe(before)
    })

    it('applies an observation even with no information service to update', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)
      const services = (test.accessory as unknown as { services: { UUID: string }[] }).services
      services.splice(services.findIndex((service) => service.UUID === 'AccessoryInformation'), 1)

      expect(() => accessory.applyObservation(observation({ volume: 42 }), 'poll')).not.toThrow()
      expect(test.service('Fanv2').lastValue('RotationSpeed')).toBe(42)
    })
  })

  describe('reporting a player that stopped answering', () => {
    it('warns the first time and stays quiet afterwards', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)
      accessory.applyObservation(observation(), 'startup')

      accessory.noteUnreachable(new Error('host is down'))
      accessory.noteUnreachable(new Error('host is down'))

      expect(test.log.calls.filter((line) => line.startsWith('warn'))).toHaveLength(1)
      expect(test.log.calls.filter((line) => line.includes('still not responding'))).toHaveLength(1)
    })

    it('warns again once the silence has gone on long enough', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)
      const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000)
      accessory.noteUnreachable(new Error('host is down'))

      clock.mockReturnValue(1_000 + POLL_FAILURE_REWARN_MS + 1)
      accessory.noteUnreachable(new Error('host is down'))

      expect(test.log.calls.filter((line) => line.startsWith('warn'))).toHaveLength(2)
      clock.mockRestore()
    })

    it('warns again after the player has come back and gone away once more', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.noteUnreachable(new Error('host is down'))
      accessory.applyObservation(observation(), 'poll')
      accessory.noteUnreachable(new Error('host is down again'))

      expect(test.log.calls.filter((line) => line.startsWith('warn'))).toHaveLength(2)
    })

    it('says so when the player answers again, so an outage can be seen to have ended', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)
      accessory.noteUnreachable(new Error('host is down'))

      accessory.applyObservation(observation(), 'poll')

      const recovered = test.log.calls.filter((line) => line.includes('is responding again'))
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toContain('info')
    })

    it('says nothing about recovery while the player keeps answering', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)

      accessory.applyObservation(observation(), 'startup')
      accessory.applyObservation(observation({ volume: 20 }), 'poll')

      expect(test.log.calls.filter((line) => line.includes('is responding again'))).toHaveLength(0)
    })

    it('refuses reads again after going unreachable, rather than reporting stale state', () => {
      const test = harness()
      const accessory = new VolumeAccessory(test)
      accessory.applyObservation(observation({ volume: 60 }), 'startup')

      accessory.noteUnreachable(new Error('host is down'))

      expect(() => test.service('Fanv2').getCharacteristic('RotationSpeed').read())
        .toThrow(/HapStatusError:-70402/)
    })
  })
})
