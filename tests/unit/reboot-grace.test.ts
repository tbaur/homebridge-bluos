/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The quiet window after a reboot request.
 */

import { RebootGrace } from '../../src/utils/reboot-grace'

describe('RebootGrace', () => {
  it('is expected from the moment of the request until the window ends', () => {
    let now = 1_000
    const grace = new RebootGrace(90_000, () => now)

    expect(grace.isExpected('192.168.4.11')).toBe(false)

    grace.expect('192.168.4.11')

    expect(grace.isExpected('192.168.4.11')).toBe(true)
    now = 90_999
    expect(grace.isExpected('192.168.4.11')).toBe(true)
    now = 91_000
    expect(grace.isExpected('192.168.4.11')).toBe(false)
  })

  it('does not treat a different address as expected', () => {
    const grace = new RebootGrace(90_000, () => 1_000)
    grace.expect('192.168.4.11')

    expect(grace.isExpected('192.168.4.12')).toBe(false)
    expect(grace.isExpected(undefined)).toBe(false)
  })

  it('ends the window early when the address is cleared', () => {
    const grace = new RebootGrace(90_000, () => 1_000)
    grace.expect('192.168.4.11')
    grace.expect('192.168.4.12')

    grace.clear('192.168.4.11')

    expect(grace.isExpected('192.168.4.11')).toBe(false)
    expect(grace.isExpected('192.168.4.12')).toBe(true)
  })

  it('shrugs off a clear for an address it never expected', () => {
    const grace = new RebootGrace(90_000, () => 1_000)

    expect(() => {
      grace.clear('192.168.4.99')
      grace.clear(undefined)
    }).not.toThrow()
  })

  it('refreshes the window when the same address is expected again', () => {
    let now = 1_000
    const grace = new RebootGrace(90_000, () => now)
    grace.expect('192.168.4.11')
    now = 80_000
    grace.expect('192.168.4.11')
    now = 160_000

    expect(grace.isExpected('192.168.4.11')).toBe(true)
    now = 170_000
    expect(grace.isExpected('192.168.4.11')).toBe(false)
  })
})
