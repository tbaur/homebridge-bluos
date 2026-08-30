/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A momentary switch that restarts every BluOS player it can find.
 *
 * The only accessory here that belongs to the platform rather than to a player.
 * It has no endpoint, no observations and no poller; its device id is the
 * synthetic {@link PLATFORM_DEVICE_ID}, and the platform resolves its targets on
 * each press.
 *
 * Its reach is wider than the plugin's configuration: it restarts every player
 * mDNS answers for, including ones deliberately left out of `devices[]`. That is
 * what it is for, and it is why the option is off by default. The info log is a
 * count of devices and players; the debug log names every box before a single
 * request goes out. The BluOS API has no authentication, so anything on the
 * segment will comply.
 *
 * It works in addresses rather than players, because reboot is served on port 80
 * and port 80 is one server per chassis. A CI S2 carrying two zones is one
 * target, not two — de-duplicating matters here beyond tidiness, since a second
 * request would land on a box already on its way down.
 *
 * See RebootAccessory for why this is momentary and why it stays pressable when
 * players are unreachable; the same reasoning applies, more so here, since a
 * fleet-wide restart is most useful when several players have stopped answering.
 */

import type { CharacteristicValue, Service } from 'homebridge'

import { MOMENTARY_RESET_MS } from '../settings'
import type { PlayerObservation, RefreshReason } from '../types'
import { describeError, forLog } from '../utils'
import { BaseAccessory, type AccessoryInit } from './base-accessory'
import type { RebootTarget } from './host'

/** A restart button for the whole network. */
export class RebootAllAccessory extends BaseAccessory {
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
  }

  private async writeOn(value: CharacteristicValue): Promise<void> {
    if (value !== true) {
      return
    }
    try {
      await this.completeWithinBudget('reboot all', async () => {
        const targets = await this.host.rebootTargets()
        if (targets.length === 0) {
          this.host.log.warn(
            `${forLog(this.displayName)}: found nothing to reboot. `
            + 'Multicast may be filtered on this network and no players are configured',
          )
          return
        }
        this.announce(targets)
        await this.rebootAll(targets)
      })
    } finally {
      this.scheduleReset()
    }
  }

  /** Count at info, name every box at debug, before any request goes out. */
  private announce(targets: readonly RebootTarget[]): void {
    const players = playerCount(targets)
    this.host.log.info(
      `${forLog(this.displayName)}: found ${targets.length} device(s), ${players} player(s)`,
    )
    const listed = targets
      .map((target) => `${target.host} (${target.names.map(forLog).join(', ')})`)
      .join('; ')
    this.host.log.debug(
      `${forLog(this.displayName)}: rebooting ${targets.length} box(es) carrying `
      + `${players} player(s): ${listed}`,
    )
  }

  /**
   * Restart every target, letting each succeed or fail on its own.
   *
   * Concurrent rather than sequential: these are separate boxes, one being
   * unreachable says nothing about the next, and running in series would make a
   * single dead address delay every box behind it by a full timeout.
   * `allSettled` because one failure must not abandon the rest — a fleet-wide
   * restart that stopped at the first missing player would be worse than useless.
   */
  private async rebootAll(targets: readonly RebootTarget[]): Promise<void> {
    const outcomes = await Promise.allSettled(
      targets.map(async (target) => this.host.client.reboot(target.host)),
    )

    let failed = 0
    outcomes.forEach((outcome, index) => {
      const target = targets[index]
      if (target === undefined) {
        return
      }
      if (outcome.status === 'fulfilled') {
        this.host.expectReboot(target.host)
        return
      }
      failed += 1
      this.host.log.warn(
        `${forLog(this.displayName)}: could not reboot ${target.host} `
        + `(${target.names.map(forLog).join(', ')}): ${describeError(outcome.reason)}`,
      )
    })

    const rebooted = targets.length - failed
    this.host.log.info(
      `${forLog(this.displayName)}: ${rebooted} of ${targets.length} device(s) rebooted`,
    )
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
    this.resetTimer.unref?.()
  }

  /**
   * Never marked unreachable.
   *
   * Overridden rather than left to the base class because this accessory has no
   * player: the base would log that a player stopped answering and name a device
   * id that is not one. The switch is always usable, since its targets are
   * resolved when it is pressed rather than held here.
   */
  override noteUnreachable(error: unknown): void {
    this.host.log.debug(
      `${forLog(this.displayName)} has no player of its own to be unreachable: ${describeError(error)}`,
    )
  }

  /** Nothing to apply: this accessory is a button, not a reading. */
  protected override updateFromObservation(
    _observation: PlayerObservation,
    _reason: RefreshReason,
  ): void {
    // Intentionally empty. See the note above.
  }

  /** Never unavailable. @see noteUnreachable */
  protected override markUnavailable(): void {
    // Intentionally empty. See the note above.
  }
}

/** How many player names sit behind the given boxes. */
function playerCount(targets: readonly RebootTarget[]): number {
  return targets.reduce((total, target) => total + target.names.length, 0)
}
