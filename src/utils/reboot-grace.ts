/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A short window after a reboot request in which silence is expected.
 *
 * Reboot takes the box down. The poller then fails, and every accessory on that
 * address would otherwise warn and later claim to have recovered. That is noise:
 * we asked it to go down. This clock is what lets the platform stay quiet until
 * the player answers again, or until the window ends and a real outage remains.
 *
 * A reading that arrives before the box actually drops is not recovery. The
 * control ports often answer one more time after POST /reboot. That last gasp
 * must not end the window, or the real outage that follows is logged as usual.
 * Recovery is a successful poll after we have already seen the expected silence.
 */

/** Hosts we have just asked to reboot, and when that expectation expires. */
export class RebootGrace {
  private readonly expiresAt = new Map<string, number>()
  /** Addresses that have gone quiet at least once inside their window. */
  private readonly sawSilence = new Set<string>()

  constructor(
    private readonly graceMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start (or refresh) the quiet window for this address. */
  expect(host: string): void {
    this.expiresAt.set(host, this.now() + this.graceMs)
    this.sawSilence.delete(host)
  }

  /**
   * Record that this address failed while a reboot was still expected.
   *
   * The next successful poll is then treated as the player coming back, not as
   * a last gasp from a box that has not gone down yet.
   */
  noteSilence(host: string | undefined): void {
    if (host !== undefined && this.isExpected(host)) {
      this.sawSilence.add(host)
    }
  }

  /**
   * End the window if this address already went quiet and has now answered.
   *
   * A success with no prior silence is ignored: the box has not dropped yet.
   */
  clearIfRecovered(host: string | undefined): void {
    if (host !== undefined && this.sawSilence.has(host)) {
      this.clear(host)
    }
  }

  /**
   * End the window now.
   *
   * Used when the clock runs out, and by tests. Recovery goes through
   * {@link clearIfRecovered} so a last-gasp reading cannot cancel the window.
   */
  clear(host: string | undefined): void {
    if (host !== undefined) {
      this.expiresAt.delete(host)
      this.sawSilence.delete(host)
    }
  }

  /** True while a reboot of this address is still expected to look like an outage. */
  isExpected(host: string | undefined): boolean {
    if (host === undefined) {
      return false
    }
    const expires = this.expiresAt.get(host)
    if (expires === undefined) {
      return false
    }
    if (this.now() >= expires) {
      this.clear(host)
      return false
    }
    return true
  }
}
