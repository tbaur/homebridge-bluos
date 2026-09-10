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
 *
 * One press is one wave, and a wave outlasts the HomeKit write budget by a good
 * margin: the sweep alone runs for the discovery window before a single request
 * goes out. So the tile is held on for as long as the wave runs, and a press that
 * arrives while one is running is ignored rather than queued. Without both, a
 * press looks like it did nothing, gets repeated, and each repeat sweeps a fleet
 * that is now half way through restarting — which finds fewer boxes every time
 * and reports the ones it does find as failures.
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

  /** True from a press until the tile springs back. @see writeOn */
  private rebooting = false

  constructor(init: AccessoryInit) {
    super(init)
    const { Characteristic: Char, Service: HapService } = this.host.hap
    this.service = this.requireService(HapService.Switch)
    this.service.setCharacteristic(Char.Name, this.displayName)
    this.service
      .getCharacteristic(Char.On)
      .onGet(() => this.rebooting)
      .onSet(async (value) => this.writeOn(value))
  }

  private async writeOn(value: CharacteristicValue): Promise<void> {
    if (value !== true) {
      return
    }
    if (this.rebooting) {
      this.host.log.info(
        `${forLog(this.displayName)}: a restart is already under way; ignoring this press`,
      )
      return
    }
    this.rebooting = true
    await this.completeWithinBudget('reboot all', async () => {
      try {
        await this.runWave()
      } finally {
        // Inside the work rather than around the budget. The budget expires long
        // before the sweep finishes, so resetting there springs the tile back
        // before the first line of the log is written.
        this.scheduleReset()
      }
    })
  }

  /** Sweep for targets, then restart every one that is not already going down. */
  private async runWave(): Promise<void> {
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
   *
   * Addresses already inside their reboot grace window are left alone. Nothing
   * serves port 80 while a box boots, so a request there could only fail, and
   * reporting that as `could not reboot` states the opposite of what is true.
   */
  private async rebootAll(targets: readonly RebootTarget[]): Promise<void> {
    const { pending, restarting } = this.partition(targets)
    if (restarting.length > 0) {
      this.host.log.info(
        `${forLog(this.displayName)}: skipping ${restarting.length} device(s) already `
        + `restarting: ${restarting.map((target) => target.host).join(', ')}`,
      )
    }
    if (pending.length === 0) {
      this.host.log.info(
        `${forLog(this.displayName)}: every device found is already restarting; nothing sent`,
      )
      return
    }

    const outcomes = await Promise.allSettled(
      pending.map(async (target) => this.host.client.reboot(target.host)),
    )

    let failed = 0
    outcomes.forEach((outcome, index) => {
      const target = pending[index]
      if (target === undefined) {
        return
      }
      if (outcome.status === 'fulfilled') {
        this.host.expectReboot(target.host)
        return
      }
      if (!this.isExcusedFailure(target, outcome.reason)) {
        failed += 1
      }
    })

    const rebooted = pending.length - failed
    this.host.log.info(
      `${forLog(this.displayName)}: ${rebooted} of ${pending.length} device(s) rebooted`,
    )
  }

  /** Split targets into those still to restart and those already restarting. */
  private partition(targets: readonly RebootTarget[]): {
    pending: RebootTarget[]
    restarting: RebootTarget[]
  } {
    const pending: RebootTarget[] = []
    const restarting: RebootTarget[] = []
    for (const target of targets) {
      if (this.host.isRebooting(target.host)) {
        restarting.push(target)
      } else {
        pending.push(target)
      }
    }
    return { pending, restarting }
  }

  /**
   * Log one failed reboot, and say whether it counts against the total.
   *
   * A box that entered its grace window after the check above — because the
   * per-player switch was pressed, or an earlier wave reached it — is going down
   * already. A refused or unanswered port 80 is what that looks like, so it is a
   * debug line rather than a warning about a reboot that did not work.
   */
  private isExcusedFailure(target: RebootTarget, reason: unknown): boolean {
    const named = `${target.host} (${target.names.map(forLog).join(', ')})`
    const detail = describeError(reason)
    if (this.host.isRebooting(target.host)) {
      this.host.log.debug(
        `${forLog(this.displayName)}: ${named} is already restarting, so it did not `
        + `answer: ${detail}`,
      )
      return true
    }
    this.host.log.warn(`${forLog(this.displayName)}: could not reboot ${named}: ${detail}`)
    return false
  }

  /**
   * Spring the tile back to off, the way a real button returns.
   *
   * Clearing {@link rebooting} here rather than when the wave finishes keeps the
   * reported value and the pushed value in step: HomeKit is told off at the same
   * moment a read would start answering off.
   */
  private scheduleReset(): void {
    if (this.resetTimer !== undefined) {
      clearTimeout(this.resetTimer)
    }
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined
      this.rebooting = false
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
