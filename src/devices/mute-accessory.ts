/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The mute switch.
 *
 * On means muted, which reads correctly in an automation: "turn on Study Mute"
 * silences the study.
 *
 * Mute is deliberately kept independent of the volume slider. Switching the
 * slider off writes level zero instead of muting, so the two controls never fight
 * over one piece of state, and a scene can mute a room without disturbing the
 * level it will return to. That works because the player remembers the pre-mute
 * level itself: measured on firmware 4.16.6, `mute=1` reports
 * `volume="0" muteVolume="72"` and unmuting restores 72 unaided.
 *
 * Muting a zone that leads a group mutes the group, for the same reason its
 * slider moves the group: while the group exists, the leader's tile is the
 * group's control. Muting a follower directly silences only that follower.
 */

import type { CharacteristicValue, Service } from 'homebridge'

import type { PlayerObservation, RefreshReason } from '../types'
import { forLog } from '../utils'
import { BaseAccessory, type AccessoryInit } from './base-accessory'
import { attachHostedBattery, PlayerBattery } from './player-battery'

/** A mute switch for one player. */
export class MuteAccessory extends BaseAccessory {
  private readonly service: Service

  /** Last mute state read from the player. */
  private muted: boolean | undefined

  /** Present when this switch also carries the player's battery. */
  private readonly battery: PlayerBattery | undefined

  constructor(init: AccessoryInit) {
    super(init)
    const { Characteristic: Char, Service: HapService } = this.host.hap
    this.service = this.requireService(HapService.Switch)
    this.service.setCharacteristic(Char.Name, this.displayName)
    this.service
      .getCharacteristic(Char.On)
      .onGet(() => this.readOn())
      .onSet(async (value) => this.writeOn(value))
    this.battery = attachHostedBattery({
      hap: this.host.hap,
      accessory: this.accessory,
      displayName: this.displayName,
      warnOnce: (key, message) => this.warnOnce(key, message),
      communicationFailure: () => this.communicationFailure(),
      hasObservedState: () => this.hasObservedState(),
    }, this.context.hostsBattery === true)
  }

  private readOn(): CharacteristicValue {
    this.requireObservedState()
    return this.muted === true
  }

  private async writeOn(value: CharacteristicValue): Promise<void> {
    const shouldMute = value === true
    await this.completeWithinBudget('mute write', async () => {
      const endpoint = this.host.endpointFor(this.deviceId)
      if (endpoint === undefined) {
        throw new Error('player is no longer configured')
      }
      const scope = this.writeScope()
      const result = await this.host.client.setMute(endpoint, shouldMute, scope)
      this.host.adoptWriteResult(this.deviceId, result)
      this.logAction(shouldMute ? 'ON' : 'OFF', scope)
      if (result.muted !== shouldMute) {
        this.warnOnce(
          'mute-refused',
          `${forLog(this.displayName)} did not accept mute=${shouldMute ? 1 : 0}`,
        )
      }
    })
  }

  protected override updateFromObservation(
    observation: PlayerObservation,
    _reason: RefreshReason,
  ): void {
    this.muted = observation.muted
    this.service.updateCharacteristic(this.host.hap.Characteristic.On, observation.muted)
    this.battery?.apply(observation)
  }

  protected override markUnavailable(): void {
    this.service.updateCharacteristic(
      this.host.hap.Characteristic.On,
      this.communicationFailure(),
    )
    this.battery?.markUnavailable()
  }
}
