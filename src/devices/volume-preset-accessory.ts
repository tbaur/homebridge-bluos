/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A switch that sets one specific volume level.
 *
 * This is the automation-safe counterpart to the slider. A scene or a Siri phrase
 * can only ever put the player at the configured level, so there is no way for a
 * misfiring automation or a misheard command to land on full volume at three in
 * the morning. It is also the only control here that is meaningfully addressable
 * by voice without a number: "turn on Bedtime Volume".
 *
 * On means the player is currently at this level and not muted. Turning the switch
 * off has no meaning — there is no opposite of "be at 30" — so it is a no-op that
 * re-asserts the real state.
 */

import type { CharacteristicValue, Service } from 'homebridge'

import { VOLUME_MIN } from '../settings'
import type { PlayerObservation, RefreshReason } from '../types'
import { forLog } from '../utils'
import { BaseAccessory, type AccessoryInit } from './base-accessory'

/** A one-level volume switch for one player. */
export class VolumePresetAccessory extends BaseAccessory {
  private readonly service: Service

  private readonly target: number

  /** Whether the player is currently sitting at this preset's level. */
  private applied: boolean | undefined

  constructor(init: AccessoryInit) {
    super(init)
    this.target = init.context.volume ?? VOLUME_MIN
    const { Characteristic: Char, Service: HapService } = this.host.hap
    this.service = this.requireService(HapService.Switch)
    this.service.setCharacteristic(Char.Name, this.displayName)
    this.service
      .getCharacteristic(Char.On)
      .onGet(() => this.readOn())
      .onSet(async (value) => this.writeOn(value))
  }

  private readOn(): CharacteristicValue {
    this.requireObservedState()
    return this.applied === true
  }

  private async writeOn(value: CharacteristicValue): Promise<void> {
    if (value !== true) {
      // Nothing to undo. Re-assert observed state so the tile stops showing the
      // user's tap rather than the player's reality.
      const observation = this.host.observationFor(this.deviceId)
      if (observation !== undefined) {
        this.updateFromObservation(observation, 'post-set')
      }
      return
    }
    await this.completeWithinBudget('preset write', async () => {
      const endpoint = this.host.endpointFor(this.deviceId)
      if (endpoint === undefined) {
        throw new Error('player is no longer configured')
      }
      const observation = this.host.observationFor(this.deviceId)
      const scope = this.writeScope()
      // A preset that leaves the room silent would look like it had failed.
      if (this.target > VOLUME_MIN && observation?.muted === true) {
        this.host.adoptWriteResult(
          this.deviceId,
          await this.host.client.setMute(endpoint, false, scope),
        )
      }
      const result = await this.host.client.setVolume(endpoint, this.target, scope)
      this.host.adoptWriteResult(this.deviceId, result)
      this.logAction(`SET ${result.level ?? this.target}`, scope)
      if (result.level !== undefined && result.level !== this.target) {
        // The player's configured range can make a preset unreachable, in which
        // case the switch would otherwise sit off forever with no explanation.
        this.warnOnce(
          'unreachable-preset',
          `${forLog(this.displayName)} asked for volume ${this.target} but the player `
          + `settled at ${result.level}; its configured volume range cannot reach ${this.target}`,
        )
      }
    })
  }

  protected override updateFromObservation(
    observation: PlayerObservation,
    _reason: RefreshReason,
  ): void {
    const applied = !observation.muted
      && !observation.fixedVolume
      && observation.volume === this.target
    this.applied = applied
    this.service.updateCharacteristic(this.host.hap.Characteristic.On, applied)
  }

  protected override markUnavailable(): void {
    this.service.updateCharacteristic(
      this.host.hap.Characteristic.On,
      this.communicationFailure(),
    )
  }
}
