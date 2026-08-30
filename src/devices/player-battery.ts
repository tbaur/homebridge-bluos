/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The HAP Battery service for one player.
 *
 * HomeKit will not render a Battery accessory on its own: the Home app parks
 * that tile under Other and says Not Supported. The service has to sit on a
 * tile Home already understands, which for this plugin is the volume slider or
 * the mute switch. A player that exposes neither still gets a standalone
 * Battery accessory, and Home will keep saying Not Supported for that one.
 *
 * `/SyncStatus` already carries `<battery level charging/>` when a pack is
 * fitted, so this costs no extra traffic. A player without a pack never reports
 * the element, and the service then reports No Response rather than inventing
 * a charge level.
 */

import type { API, CharacteristicValue, PlatformAccessory, Service } from 'homebridge'

import type { PlayerObservation } from '../types'
import { forLog } from '../utils'

/** Below this percentage HomeKit is told the battery is low. */
const LOW_BATTERY_THRESHOLD = 20

/** Collaborators for one Battery service. */
export interface PlayerBatteryInit {
  hap: API['hap']
  accessory: PlatformAccessory
  displayName: string
  warnOnce: (key: string, message: string) => void
  communicationFailure: () => Error
  hasObservedState: () => boolean
}

/** Charge level, charging state and low-battery on one HAP Battery service. */
export class PlayerBattery {
  private readonly service: Service

  private level: number | undefined

  private charging = false

  constructor(private readonly init: PlayerBatteryInit) {
    const { Characteristic: Char, Service: HapService } = init.hap
    this.service = requireService(init.accessory, HapService.Battery, init.displayName)
    this.service.setCharacteristic(Char.Name, init.displayName)
    this.service.getCharacteristic(Char.BatteryLevel).onGet(() => this.readLevel())
    this.service.getCharacteristic(Char.StatusLowBattery).onGet(() => this.readLowBattery())
    this.service.getCharacteristic(Char.ChargingState).onGet(() => this.readChargingState())
  }

  apply(observation: PlayerObservation): void {
    const battery = observation.battery
    if (battery === undefined) {
      this.level = undefined
      this.init.warnOnce(
        'no-battery',
        `${forLog(this.init.displayName)} reports no battery pack; disable the battery sensor `
        + 'for this player in the plugin settings',
      )
      this.markUnavailable()
      return
    }
    this.level = battery.level
    this.charging = battery.charging
    const { Characteristic: Char } = this.init.hap
    this.service.updateCharacteristic(Char.BatteryLevel, battery.level)
    this.service.updateCharacteristic(
      Char.StatusLowBattery,
      battery.level <= LOW_BATTERY_THRESHOLD
        ? Char.StatusLowBattery.BATTERY_LEVEL_LOW
        : Char.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    )
    this.service.updateCharacteristic(
      Char.ChargingState,
      battery.charging ? Char.ChargingState.CHARGING : Char.ChargingState.NOT_CHARGING,
    )
  }

  markUnavailable(): void {
    const { Characteristic: Char } = this.init.hap
    const error = this.init.communicationFailure()
    this.service.updateCharacteristic(Char.BatteryLevel, error)
    this.service.updateCharacteristic(Char.StatusLowBattery, error)
    this.service.updateCharacteristic(Char.ChargingState, error)
  }

  private readLevel(): CharacteristicValue {
    this.requireBattery()
    return this.level ?? 0
  }

  private readLowBattery(): CharacteristicValue {
    this.requireBattery()
    const { Characteristic: Char } = this.init.hap
    return (this.level ?? 100) <= LOW_BATTERY_THRESHOLD
      ? Char.StatusLowBattery.BATTERY_LEVEL_LOW
      : Char.StatusLowBattery.BATTERY_LEVEL_NORMAL
  }

  private readChargingState(): CharacteristicValue {
    this.requireBattery()
    const { Characteristic: Char } = this.init.hap
    return this.charging ? Char.ChargingState.CHARGING : Char.ChargingState.NOT_CHARGING
  }

  private requireBattery(): void {
    if (!this.init.hasObservedState() || this.level === undefined) {
      throw this.init.communicationFailure()
    }
  }
}

/** Bind a Battery service, or drop a leftover one when this tile no longer hosts it. */
export function attachHostedBattery(
  init: PlayerBatteryInit,
  hosts: boolean,
): PlayerBattery | undefined {
  if (!hosts) {
    dropPlayerBattery(init.accessory, init.hap)
    return undefined
  }
  return new PlayerBattery(init)
}

/** Drop a leftover Battery service when this accessory no longer hosts one. */
export function dropPlayerBattery(accessory: PlatformAccessory, hap: API['hap']): void {
  const stale = accessory.services.find((service) => service.UUID === hap.Service.Battery.UUID)
  if (stale !== undefined) {
    accessory.removeService(stale)
  }
}

type BatteryServiceCtor = {
  UUID: string
  new (displayName?: string, subtype?: string): Service
}

function requireService(
  accessory: PlatformAccessory,
  ServiceType: BatteryServiceCtor,
  displayName: string,
): Service {
  const existing = accessory.services.find((service) => service.UUID === ServiceType.UUID)
  return existing ?? accessory.addService(new ServiceType(displayName))
}
