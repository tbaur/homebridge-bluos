/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * End-to-end check of the built plugin against real players. Read-only: it never
 * calls a control endpoint, so it cannot change a volume, a mute state or a group.
 *
 * It exercises the paths that unit tests can only fake — mDNS discovery and
 * SRV/TXT/A correlation, `/SyncStatus` verification, identity derivation across
 * the zones of one chassis, and the long-poll's etag behaviour — which is why it
 * is worth running before a release even though CI cannot.
 *
 *   node scripts/smoke.js
 *   node scripts/smoke.js --host 192.168.4.10:11010
 *   node scripts/smoke.js --seconds 10 --hold 20 --verbose
 *
 * Output describes your network: player names, addresses and MAC addresses.
 * Redact it before attaching it to a public issue.
 */
const { consoleLogger, intFlag, parseFlags, requireBuild, run, targetsFrom } = require('./lib/common')

const OPTIONS = {
  host: 'string',
  seconds: 'string',
  hold: 'string',
  verbose: 'boolean',
}

/** Report what discovery made of each zone. */
function describe(players) {
  for (const player of players) {
    const flags = [
      player.fixedVolume ? 'FIXED-VOLUME' : null,
      player.hasBattery ? 'BATTERY' : null,
    ].filter(Boolean).join(' ')
    console.log(`  ${player.name}`)
    console.log(`    id       ${player.id}`)
    console.log(`    endpoint ${player.host}:${player.port}`)
    console.log(`    hardware ${player.brand} ${player.modelName || player.model} fw ${player.firmware}`)
    console.log(`    mac      ${player.mac}${flags ? `  ${flags}` : ''}`)
  }
}

/**
 * Check that identity is unique per zone.
 *
 * The interesting case is a multi-zone chassis, where several zones share one MAC
 * and the port is the only thing separating them. A collision here would mean two
 * rooms sharing one HomeKit accessory.
 */
function checkIdentity(players) {
  const ids = players.map((player) => player.id)
  const unique = new Set(ids)
  console.log('\n=== identity ===')
  console.log(`  ${ids.length} zone(s), ${unique.size} unique id(s) -> ${unique.size === ids.length ? 'OK' : 'COLLISION'}`)

  const perMac = new Map()
  for (const player of players) {
    perMac.set(player.mac, (perMac.get(player.mac) || 0) + 1)
  }
  for (const [mac, count] of perMac) {
    if (count > 1) {
      console.log(`  ${mac} carries ${count} zones on one NIC (multi-zone chassis)`)
    }
  }
  return unique.size === ids.length
}

/**
 * Watch a long-poll for a while and report whether it stayed open.
 *
 * The poll is cancelled rather than waited out: the plugin's hold is 100 seconds,
 * and holding is precisely what this is checking for, so there is nothing to gain
 * by sitting through it. Cancelling also proves the abort path works, which is
 * what lets Homebridge shut down promptly.
 */
async function watchPoll(client, endpoint, etag, holdSeconds) {
  const controller = new AbortController()
  const started = Date.now()
  // The abort below is deliberate, so a rejection is an expected outcome here and
  // is folded into the result rather than thrown.
  const poll = client.pollSyncStatus(endpoint, etag, controller.signal).then(
    (observation) => ({ kind: 'returned', observation }),
    () => ({ kind: 'cancelled' }),
  )

  let timer
  const window = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'holding' }), holdSeconds * 1000)
  })
  const outcome = await Promise.race([poll, window])
  clearTimeout(timer)
  if (outcome.kind === 'holding') {
    controller.abort()
    await poll
  }
  return { ...outcome, elapsedMs: Date.now() - started }
}

/**
 * Prove the long-poll end to end.
 *
 * A matching etag should hold the connection open; a stale one should come back
 * at once. Those two together are what make a front-panel volume change show up
 * in HomeKit in about a second without polling the player to death.
 */
async function checkLongPoll(client, player, holdSeconds) {
  console.log(`\n=== long-poll ${player.name} ===`)
  const endpoint = { host: player.host, port: player.port }
  const first = await client.readSyncStatus(endpoint)
  console.log(`  read      volume=${first.volume} muted=${first.muted} db=${first.db} `
    + `etag=${first.etag} role=${first.syncRole}`)

  const held = await watchPoll(client, endpoint, first.etag, holdSeconds)
  console.log(held.kind === 'holding'
    ? `  current etag: still holding after ${held.elapsedMs}ms, then cancelled (correct: state unchanged)`
    : `  current etag: returned after ${held.elapsedMs}ms `
      + '(a change arrived, or this firmware does not hold)')

  const startedStale = Date.now()
  const stale = await client.pollSyncStatus(endpoint, 'definitely-not-the-etag')
  console.log(`  stale etag:   returned after ${Date.now() - startedStale}ms volume=${stale.volume} etag=${stale.etag}`)
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), OPTIONS)
  const api = requireBuild()
  const log = consoleLogger({ verbose: flags.verbose === true })

  const { client, players } = await targetsFrom(flags, api, log)
  describe(players)
  const identityOk = checkIdentity(players)

  const pollable = players.find((player) => !player.fixedVolume)
  if (pollable === undefined) {
    console.log('\nno zone with a controllable volume; skipping the long-poll check')
  } else {
    await checkLongPoll(client, pollable, intFlag(flags, 'hold', 12))
  }

  if (!identityOk) {
    throw new Error('two zones derived the same identity')
  }
  console.log('\nsmoke test complete')
}

run(main)
