/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * These helpers exist because of a real bug: rate-limit waits built on
 * `unref()`ed timers let Node exit while an awaited operation was still pending,
 * so a request that was supposed to hold for a hundred seconds returned nothing
 * and the process ended. The reference semantics are the behaviour under test.
 */

import { interruptibleSleep, raceTimeout, sleep, TIMED_OUT } from '../../src/utils/timing'

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const started = Date.now()

    await sleep(30)

    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })

  it('treats a negative delay as immediate', async () => {
    await expect(sleep(-100)).resolves.toBeUndefined()
  })

  it('keeps a reference on the event loop while it waits', () => {
    // The bug this module was written for: an unreferenced timer lets the
    // process exit under an awaited operation.
    const before = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length
    const pending = sleep(50)
    const during = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length

    expect(during).toBeGreaterThan(before)
    return pending
  })
})

describe('interruptibleSleep', () => {
  it('resolves on its own when not interrupted', async () => {
    await expect(interruptibleSleep(10).promise).resolves.toBeUndefined()
  })

  it('resolves early when interrupted', async () => {
    const started = Date.now()
    const pending = interruptibleSleep(5_000)

    pending.interrupt()
    await pending.promise

    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('clears the timer, so an interrupted wait does not hold the loop open', async () => {
    const pending = interruptibleSleep(60_000)
    const during = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length

    pending.interrupt()
    await pending.promise
    const after = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length

    expect(after).toBeLessThan(during)
  })

  it('tolerates being interrupted twice', async () => {
    const pending = interruptibleSleep(1_000)

    pending.interrupt()
    pending.interrupt()

    await expect(pending.promise).resolves.toBeUndefined()
  })
})

describe('raceTimeout', () => {
  it('returns the work when it finishes first', async () => {
    await expect(raceTimeout(Promise.resolve('done'), 1_000)).resolves.toBe('done')
  })

  it('reports the timeout when the deadline comes first', async () => {
    const slow = sleep(200).then(() => 'late')

    await expect(raceTimeout(slow, 20)).resolves.toBe(TIMED_OUT)

    // Awaited so the abandoned work does not outlive the test worker.
    await expect(slow).resolves.toBe('late')
  })

  it('propagates a rejection from the work', async () => {
    await expect(raceTimeout(Promise.reject(new Error('nope')), 1_000)).rejects.toThrow('nope')
  })

  it('does not leave its deadline timer behind after the work wins', async () => {
    const before = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length

    await raceTimeout(Promise.resolve('done'), 60_000)
    const after = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length

    expect(after).toBeLessThanOrEqual(before)
  })
})
