/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import { BatteryAccessory } from '../../src/devices/battery-accessory'
import { harness, observation } from '../helpers/hap'

const batteryContext = { kind: 'battery' as const }

describe('BatteryAccessory', () => {
  it('reports level and charging state', () => {
    const test = harness({ context: batteryContext })
    const accessory = new BatteryAccessory(test)

    accessory.applyObservation(observation({ battery: { level: 91, charging: false } }), 'poll')
    const service = test.service('Battery')

    expect(service.getCharacteristic('BatteryLevel').read()).toBe(91)
    expect(service.getCharacteristic('ChargingState').read()).toBe(0)
    expect(service.getCharacteristic('StatusLowBattery').read()).toBe(0)
  })

  it('reports charging', () => {
    const test = harness({ context: batteryContext })
    const accessory = new BatteryAccessory(test)

    accessory.applyObservation(observation({ battery: { level: 40, charging: true } }), 'poll')

    expect(test.service('Battery').getCharacteristic('ChargingState').read()).toBe(1)
  })

  it.each([
    [21, 0],
    [20, 1],
    [5, 1],
  ])('flags level %s as low=%s', (level, expected) => {
    const test = harness({ context: batteryContext })
    const accessory = new BatteryAccessory(test)

    accessory.applyObservation(observation({ battery: { level, charging: false } }), 'poll')

    expect(test.service('Battery').getCharacteristic('StatusLowBattery').read()).toBe(expected)
  })

  it('pushes every characteristic to HomeKit on an observation', () => {
    const test = harness({ context: batteryContext })
    const accessory = new BatteryAccessory(test)

    accessory.applyObservation(observation({ battery: { level: 15, charging: true } }), 'poll')
    const service = test.service('Battery')

    expect(service.lastValue('BatteryLevel')).toBe(15)
    expect(service.lastValue('StatusLowBattery')).toBe(1)
    expect(service.lastValue('ChargingState')).toBe(1)
  })

  it('refuses to answer before the player has been read', () => {
    const test = harness({ context: batteryContext })
    new BatteryAccessory(test)

    expect(() => test.service('Battery').getCharacteristic('BatteryLevel').read())
      .toThrow(/HapStatusError:-70402/)
  })

  it('reports no response, and explains once, for a player with no pack fitted', () => {
    const test = harness({ context: batteryContext })
    const accessory = new BatteryAccessory(test)

    accessory.applyObservation(observation(), 'startup')
    accessory.applyObservation(observation(), 'poll')

    // Inventing a charge level would be worse than admitting there is none.
    expect(() => test.service('Battery').getCharacteristic('BatteryLevel').read())
      .toThrow(/HapStatusError/)
    const warnings = test.log.calls.filter((line) => line.startsWith('warn')
      && line.includes('no battery pack'))
    expect(warnings).toHaveLength(1)
  })

  it('recovers when a pack is fitted later', () => {
    const test = harness({ context: batteryContext })
    const accessory = new BatteryAccessory(test)

    accessory.applyObservation(observation(), 'startup')
    accessory.applyObservation(observation({ battery: { level: 80, charging: false } }), 'poll')

    expect(test.service('Battery').getCharacteristic('BatteryLevel').read()).toBe(80)
  })

  it('goes unavailable when the player stops answering', () => {
    const test = harness({ context: batteryContext })
    const accessory = new BatteryAccessory(test)
    accessory.applyObservation(observation({ battery: { level: 80, charging: false } }), 'poll')

    accessory.noteUnreachable(new Error('ETIMEDOUT'))
    const service = test.service('Battery')

    expect(service.lastValue('BatteryLevel')).toBeInstanceOf(Error)
    expect(service.lastValue('StatusLowBattery')).toBeInstanceOf(Error)
    expect(service.lastValue('ChargingState')).toBeInstanceOf(Error)
  })

  it('has no write handlers, being a sensor', () => {
    const test = harness({ context: batteryContext })
    new BatteryAccessory(test)

    expect(test.service('Battery').getCharacteristic('BatteryLevel').setHandler)
      .toBeUndefined()
  })
})
