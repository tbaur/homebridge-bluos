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
 */

/** Hosts we have just asked to reboot, and when that expectation expires. */
export class RebootGrace {
  private readonly expiresAt = new Map<string, number>()

  constructor(
    private readonly graceMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start (or refresh) the quiet window for this address. */
  expect(host: string): void {
    this.expiresAt.set(host, this.now() + this.graceMs)
  }

  /**
   * End the window early, because the address answered.
   *
   * A box is usually back well inside the window. Without this, a genuine
   * failure in the time that remains would be swallowed as part of the reboot.
   */
  clear(host: string | undefined): void {
    if (host !== undefined) {
      this.expiresAt.delete(host)
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
      this.expiresAt.delete(host)
      return false
    }
    return true
  }
}
