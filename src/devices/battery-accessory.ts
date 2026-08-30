/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Standalone battery accessory, used only when no other tile exists.
 *
 * HomeKit will not render this in the Home app. Prefer hosting the Battery
 * service on the volume or mute accessory, which resolveAccessories does
 * whenever one of those is enabled. This class remains for a player that
 * exposes battery and nothing else.
 */

import type { PlayerObservation, RefreshReason } from '../types'
import { BaseAccessory, type AccessoryInit } from './base-accessory'
import { PlayerBattery } from './player-battery'

/** A battery sensor for one player, with no other HomeKit service beside it. */
export class BatteryAccessory extends BaseAccessory {
  private readonly battery: PlayerBattery

  constructor(init: AccessoryInit) {
    super(init)
    this.battery = new PlayerBattery({
      hap: this.host.hap,
      accessory: this.accessory,
      displayName: this.displayName,
      warnOnce: (key, message) => this.warnOnce(key, message),
      communicationFailure: () => this.communicationFailure(),
      hasObservedState: () => this.hasObservedState(),
    })
  }

  protected override updateFromObservation(
    observation: PlayerObservation,
    _reason: RefreshReason,
  ): void {
    this.battery.apply(observation)
  }

  protected override markUnavailable(): void {
    this.battery.markUnavailable()
  }
}
