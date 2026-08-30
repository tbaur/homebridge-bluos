/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A momentary switch that restarts one player.
 *
 * Two departures from how every other accessory here behaves, both deliberate.
 *
 * It is momentary, never stateful. `On` always reads false, turning it on fires
 * the reboot and the tile springs back, and turning it off does nothing. There is
 * no such thing as an un-reboot, so an off has nothing to mean. This is also what
 * makes the switch safe to leave in a house full of scenes: "turn everything off"
 * and a scene that sets switches off both write false, and false does nothing
 * here. A stateful reboot switch would restart the stereo every time someone said
 * goodnight.
 *
 * It stays pressable when the player is unreachable, which breaks the plugin's
 * "unknown is No Response" rule. That rule exists so automations cannot fire
 * against invented *readings*, and this switch reports no reading: false is the
 * state of a button, and a button that has not been pressed is honestly not
 * pressed whether or not the player is answering. Enforcing the rule here would
 * grey out the tile in exactly the situation it is for — a player wedged badly
 * enough to have stopped answering is a player you want to restart.
 *
 * One thing this switch cannot do, which its name implies it can: restart a
 * single zone of a multi-zone chassis. Reboot is served on port 80, and port 80
 * is one server per box, so "Zone One Reboot" on a CI S2 also takes down
 * the other zone. The constructor says so once at startup, naming the rooms,
 * because the alternative is finding out by silencing one.
 */

import type { CharacteristicValue, Service } from 'homebridge'

import { MOMENTARY_RESET_MS } from '../settings'
import type { PlayerObservation, RefreshReason } from '../types'
import { forLog } from '../utils'
import { BaseAccessory, type AccessoryInit } from './base-accessory'

/** A restart button for one player. */
export class RebootAccessory extends BaseAccessory {
  private readonly service: Service

  private resetTimer: ReturnType<typeof setTimeout> | undefined

  constructor(init: AccessoryInit) {
    super(init)
    const { Characteristic: Char, Service: HapService } = this.host.hap
    this.service = this.requireService(HapService.Switch)
    this.service.setCharacteristic(Char.Name, this.displayName)
    this.service
      .getCharacteristic(Char.On)
      .onGet(() => false)
      .onSet(async (value) => this.writeOn(value))

    const shared = this.host.playersSharingAddress(this.deviceId)
    if (shared.length > 0) {
      this.host.log.warn(
        `${forLog(this.displayName)} will also restart ${shared.map(forLog).join(', ')}: `
        + 'they are zones of one chassis, and BluOS reboots the whole box',
      )
    }
  }

  private async writeOn(value: CharacteristicValue): Promise<void> {
    if (value !== true) {
      return
    }
    try {
      await this.completeWithinBudget('reboot', async () => {
        const endpoint = this.host.endpointFor(this.deviceId)
        if (endpoint === undefined) {
          throw new Error('player is no longer configured')
        }
        // The host only: reboot lives on port 80, not on the zone's control port.
        const result = await this.host.client.reboot(endpoint.host)
        // Never a group operation. Grouping decides where a *volume* change
        // reaches; a reboot restarts a box and has no notion of followers.
        this.logAction(
          result.acknowledged ? 'REBOOT' : 'REBOOT (sent; the player stopped answering, as expected)',
          { tellSlaves: false },
        )
      })
    } finally {
      // In `finally` because a failed reboot must not leave the tile stuck on.
      // The write already surfaced its own error to HomeKit and to the log.
      this.scheduleReset()
    }
  }

  /** Spring the tile back to off, the way a real button returns. */
  private scheduleReset(): void {
    if (this.resetTimer !== undefined) {
      clearTimeout(this.resetTimer)
    }
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined
      this.service.updateCharacteristic(this.host.hap.Characteristic.On, false)
    }, MOMENTARY_RESET_MS)
    // Nothing is waiting on this, so it must not hold Homebridge open at shutdown.
    this.resetTimer.unref?.()
  }

  /**
   * Nothing to apply.
   *
   * A button has no reading to refresh. Declared rather than inherited because
   * the base class requires it, and an empty body with a reason is clearer than
   * a subclass that quietly does nothing.
   */
  protected override updateFromObservation(
    _observation: PlayerObservation,
    _reason: RefreshReason,
  ): void {
    // Intentionally empty. See the note above.
  }

  /**
   * Stay available even when the player is not answering.
   *
   * See the file header: this is the one accessory that must remain pressable
   * while its player is unreachable, because that is when it is needed.
   */
  protected override markUnavailable(): void {
    // Intentionally empty. See the note above.
  }
}
