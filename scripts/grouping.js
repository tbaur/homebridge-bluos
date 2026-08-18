/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Inspect how real firmware reports grouping, and what the plugin makes of it.
 * Read-only: it neither forms, breaks, nor writes to a group.
 *
 * The plugin sends `tell_slaves=1` only for a zone it believes leads a group, and
 * it decides that from `<slave>` children in `/SyncStatus`. Group two zones in the
 * BluOS app, run this, and compare the raw grouping elements against the role the
 * plugin derived:
 *
 *   node scripts/grouping.js
 *   node scripts/grouping.js --host 192.168.4.10
 *
 * A disagreement between the two lines per zone is a bug worth a fixture. So is a
 * zone that is not in a group reporting one: that is how `zoneMaster="true"` was
 * found.
 *
 * Output includes player names and addresses. Redact before sharing.
 */
const {
  consoleLogger,
  getRaw,
  parseFlags,
  requireBuild,
  run,
  sleep,
  targetsFrom,
} = require('./lib/common')

const OPTIONS = {
  host: 'string',
  seconds: 'string',
  verbose: 'boolean',
}

/** The API's minimum gap between two requests for one resource. */
const SAME_RESOURCE_GAP_MS = 1100

/**
 * Elements and attributes that carry grouping state, in any firmware wording.
 *
 * The leading `\b` matters: `<zoneOptions>` on a Bluesound player contains
 * `zoneMaster="true"`, which is a stereo-pairing option and nothing to do with
 * grouping. Without the boundary its tail reads as `master="true"` and every
 * paired speaker looks like it is in a group.
 */
const GROUPING_PATTERN = /<\s*(?:master|slave|group)\b[^>]*>|\b(?:master|group|syncStat)\s*=\s*"[^"]*"/gi

/** Pull the grouping-related fragments out of a raw `/SyncStatus` body. */
function groupingFragments(xml) {
  const found = xml.match(GROUPING_PATTERN)
  if (found === null) {
    return []
  }
  // A leader lists every follower, so identical fragments add nothing.
  return [...new Set(found.map((fragment) => fragment.replace(/\s+/g, ' ').trim()))]
}

/** What the plugin would put on the wire for a write to this zone. */
function scopeFor(role) {
  return role === 'primary' ? 'tell_slaves=1 (moves the group)' : 'tell_slaves=0 (moves this zone only)'
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), OPTIONS)
  const api = requireBuild()
  const log = consoleLogger({ verbose: flags.verbose === true })

  const { client, players } = await targetsFrom(flags, api, log)

  let anyGrouping = false
  for (const player of players) {
    const endpoint = { host: player.host, port: player.port }
    // Spaced by hand: the raw fetch is outside the client's rate limiter, and the
    // API asks for a second between two requests for the same resource. Two
    // requests are needed because one answers what the plugin concluded and the
    // other what the firmware actually said.
    const observation = await client.readSyncStatus(endpoint)
    await sleep(SAME_RESOURCE_GAP_MS)
    const xml = await getRaw(endpoint, '/SyncStatus')
    const fragments = groupingFragments(xml)
    anyGrouping = anyGrouping || fragments.length > 0

    console.log(`  ${player.name}  (${player.host}:${player.port})`)
    console.log(`    plugin sees  role=${observation.syncRole}  ->  ${scopeFor(observation.syncRole)}`)
    console.log(fragments.length === 0
      ? '    firmware says  no grouping elements present'
      : `    firmware says  ${fragments.join('  ')}`)
  }

  console.log('')
  if (!anyGrouping) {
    console.log('No zone reported any grouping. To verify the leader path, group two zones')
    console.log('in the BluOS app and run this again: the leader should report slave')
    console.log('elements and role=primary, and each follower a master and role=secondary.')
    return
  }
  console.log('Compare the two lines per zone. A leader reporting slave elements must show')
  console.log('role=primary, and a follower reporting a master must show role=secondary.')
  console.log('If they disagree, record the raw body as a fixture (scripts/capture-fixture.js)')
  console.log('and fix readSyncRole in src/api/sync-status.ts.')
}

run(main)
