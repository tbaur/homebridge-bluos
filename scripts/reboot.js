/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Establish how BluOS reboot is actually addressed, by rebooting one player.
 *
 * This is the only script here that writes to a player, and the only one that is
 * destructive: it restarts hardware and interrupts whatever is playing. Every
 * other script in this directory is read-only by design.
 *
 * It sends one candidate request per run, so nothing is ambiguous about which
 * request caused what, and it confirms three things the plugin depends on:
 *
 * 1. **Which URL reaches the box.** `--variant hard-noport` is the one that
 *    works: `POST http://host/reboot`, no BluOS port, as spec v1.7 and the
 *    sibling `bluos-controller` project both address it. The other variants
 *    document the paths that answer 404, so a dead end stays a recorded fact
 *    rather than something to rediscover.
 * 2. **That the request restarts the hardware.** Uptime is the arbiter, not the
 *    HTTP status: a request that answers 200 while uptime keeps climbing has
 *    done nothing. This is also what separates a full reboot from a zone process
 *    merely restarting.
 * 3. **What a rebooting player does to the connection.** Whether it answers
 *    before going down, or drops the socket mid-response, decides whether the
 *    plugin's client may treat a lost connection as success.
 *
 * Uptime comes from `/diagnostics`, which is HTML on port 80 rather than the XML
 * API. It is the only reading that distinguishes "restarted" from "briefly
 * stopped answering", which matters because a player that merely dropped its
 * network for a moment looks identical on `/SyncStatus`.
 *
 *   node scripts/reboot.js --host 192.168.4.14:11010 --variant hard-port --confirm
 *   node scripts/reboot.js --host 192.168.4.14:11010 --variant hard-port \
 *     --watch 11000,11010 --confirm
 *
 * Output describes your network: player names, addresses and MAC addresses.
 * Redact it before attaching it to a public issue.
 */
const {
  fail,
  intFlag,
  parseEndpoint,
  parseFlags,
  postForm,
  run,
  sleep,
  tryGet,
} = require('./lib/common')

const OPTIONS = {
  host: 'string',
  variant: 'string',
  watch: 'string',
  wait: 'string',
  confirm: 'boolean',
}

/**
 * The candidate request forms.
 *
 * `hard` is the documented one (API v1.7, and `bluos-controller`'s `reboot`
 * command). `soft` is the undocumented one `bluos-controller` also sends; note
 * the capitalised path, which is its own variable worth testing since BluOS
 * resources are otherwise capitalised and this one is documented lower case.
 */
const VARIANTS = {
  // The hard variants send what pressing "Yes" on the confirmation page sends,
  // which is also what the plugin sends: matching it exactly is the point, since
  // a probe that validates a different request validates nothing.
  'hard-port': { path: '/reboot', form: { noheader: '0', yes: '1' }, usePort: true },
  'hard-noport': { path: '/reboot', form: { noheader: '0', yes: '1' }, usePort: false },
  'soft-port': { path: '/Reboot', form: { soft: '1' }, usePort: true },
  'soft-noport': { path: '/Reboot', form: { soft: '1' }, usePort: false },
}

/** How often a watched zone is asked whether it is back. */
const RECOVERY_POLL_MS = 500

/** How long to keep asking port 80 for uptime once the zones are back. */
const UPTIME_RECHECK_MS = 60_000

/** @see UPTIME_RECHECK_MS */
const UPTIME_RETRY_GAP_MS = 2_000

/** Per-request timeout while watching, short so the poll stays responsive. */
const LIVENESS_TIMEOUT_MS = 1_500

/** Longest a zone may take to come back before it is reported as still down. */
const DEFAULT_WAIT_SEC = 120

/**
 * Read uptime as a number of seconds.
 *
 * Observed format is `70h38m18s`, with days appearing on a player that has been
 * up longer. Parsed rather than compared as text because uptime *grows* while a
 * probe runs: only a decrease means the player restarted, and comparing the raw
 * strings would call every run a reset.
 */
function uptimeSeconds(text) {
  const units = { d: 86_400, h: 3_600, m: 60, s: 1 }
  let total
  for (const [, amount, unit] of text.matchAll(/(\d+)\s*([dhms])/gi)) {
    total = (total ?? 0) + Number(amount) * units[unit.toLowerCase()]
  }
  return total
}

/**
 * Read uptime from the player's diagnostics page.
 *
 * HTML scraping, because BluOS exposes uptime nowhere else. Returns the raw
 * string the page shows as well as its value in seconds, since the format is
 * part of what we are here to learn.
 */
async function readUptime(host) {
  const result = await tryGet(`http://${host}/diagnostics`, 4000)
  if (!result.ok) {
    return { value: undefined, note: result.error || `HTTP ${result.status}` }
  }
  const match = /Uptime:<\/div>\s*<div[^>]*>(.*?)<\/div>/i.exec(result.body)
  if (match) {
    const value = match[1].trim()
    return { value, seconds: uptimeSeconds(value) }
  }
  // Not a failure worth stopping for, but worth showing: if the page shape
  // changed, the snippet is what tells us the new one.
  const fallback = /uptime[^<]*<[^>]*>([^<]{1,60})/i.exec(result.body)
  const value = fallback ? fallback[1].trim() : undefined
  return {
    value,
    seconds: value === undefined ? undefined : uptimeSeconds(value),
    note: fallback ? 'matched a looser pattern; the page shape may have changed' : 'no uptime field found',
  }
}

/**
 * Read uptime once the box's web server is answering again.
 *
 * Port 80 comes back later than the control ports do: a zone can be serving
 * `/SyncStatus` while the web server carrying `/diagnostics` is still starting.
 * Reading once at that moment yields "unknown", and unknown is the one answer
 * that makes a whole run inconclusive, because uptime is the arbiter of whether
 * anything actually restarted. So it retries rather than reporting a gap in the
 * measurement as a finding about the hardware.
 */
async function readUptimeWhenReady(host) {
  const deadline = Date.now() + UPTIME_RECHECK_MS
  let reading = await readUptime(host)
  while (reading.value === undefined && Date.now() < deadline) {
    await sleep(UPTIME_RETRY_GAP_MS)
    reading = await readUptime(host)
  }
  return reading
}

/** True when this zone answers `/SyncStatus`. */
async function isAlive(host, port) {
  const result = await tryGet(`http://${host}:${port}/SyncStatus`, LIVENESS_TIMEOUT_MS)
  return result.ok
}

/**
 * Watch one zone through an outage.
 *
 * Reports the two facts that matter separately, because they mean different
 * things: a zone that never stopped answering did not reboot, and a zone that
 * stopped but never came back needs a human rather than a longer timeout.
 */
async function watchZone(host, port, waitSec) {
  const startedAt = Date.now()
  const deadline = startedAt + waitSec * 1_000
  let downAt
  let upAt

  while (Date.now() < deadline) {
    const alive = await isAlive(host, port)
    const now = Date.now()
    if (!alive && downAt === undefined) {
      downAt = now
    }
    if (alive && downAt !== undefined) {
      upAt = now
      break
    }
    await sleep(RECOVERY_POLL_MS)
  }

  return {
    port,
    wentDown: downAt !== undefined,
    recovered: upAt !== undefined,
    noticedDownAfterMs: downAt === undefined ? undefined : downAt - startedAt,
    downtimeMs: downAt !== undefined && upAt !== undefined ? upAt - downAt : undefined,
  }
}

/** Report what the POST itself did. */
function describeResponse(result) {
  console.log('\n=== response ===')
  console.log(`  outcome   ${result.outcome}`)
  console.log(`  elapsed   ${result.elapsedMs}ms`)
  if (result.status !== undefined) {
    console.log(`  status    HTTP ${result.status}`)
  }
  if (result.error !== undefined) {
    console.log(`  error     ${result.error}`)
  }
  if (result.body !== undefined && result.body.length > 0) {
    const shown = result.body.length > 400 ? `${result.body.slice(0, 400)}\u2026` : result.body
    console.log(`  body      ${JSON.stringify(shown)}`)
  } else if (result.outcome === 'answered') {
    console.log('  body      (empty)')
  }
}

/**
 * Turn the readings into the answer the plugin needs.
 *
 * Deliberately states what was observed before what it implies, so a surprising
 * conclusion can be checked against the evidence that produced it.
 */
function verdict(input) {
  const { target, watched, before, after, result } = input
  console.log('\n=== verdict ===')

  const restarted = watched.filter((zone) => zone.wentDown)
  const untouched = watched.filter((zone) => !zone.wentDown)
  const stranded = watched.filter((zone) => zone.wentDown && !zone.recovered)

  // Only a *decrease* is a restart. Uptime grows while the probe watches, so
  // any comparison that treats "changed" as "reset" calls every run a success.
  const uptimeReset = before.seconds !== undefined
    && after.seconds !== undefined
    && after.seconds < before.seconds

  const uptimeNote = uptimeReset
    ? '  (RESET)'
    : (before.seconds !== undefined && after.seconds !== undefined ? '  (still counting up)' : '')
  console.log(`  uptime        ${before.value ?? 'unknown'} -> ${after.value ?? 'unknown'}${uptimeNote}`)
  console.log(`  restarted     ${restarted.length > 0 ? restarted.map((zone) => zone.port).join(', ') : 'none'}`)
  console.log(`  stayed up     ${untouched.length > 0 ? untouched.map((zone) => zone.port).join(', ') : 'none'}`)
  for (const zone of watched) {
    if (zone.downtimeMs !== undefined) {
      console.log(`  :${zone.port} was down ${Math.round(zone.downtimeMs / 1000)}s`)
    }
  }

  const nothingHappened = restarted.length === 0 && !uptimeReset

  // A 404 is the clearest answer this probe can get, so it is said first and
  // plainly rather than left to be inferred from an absence of restarts.
  if (result.outcome === 'answered' && result.status === 404 && nothingHappened) {
    console.log(`\n  -> this endpoint DOES NOT EXIST. ${target} answered 404 and nothing restarted.`)
    return
  }
  if (result.outcome === 'failed' && nothingHappened) {
    console.log('\n  -> this variant did NOTHING. The request never went out.')
    return
  }
  if (nothingHappened) {
    console.log(`\n  -> this variant did NOTHING. It answered HTTP ${result.status ?? '?'} `
      + 'but nothing restarted and uptime kept counting up.')
    console.log('     For a soft reboot that is the answer: it should not ship.')
    return
  }
  if (untouched.length > 0 && restarted.length > 0) {
    console.log(`\n  -> reboot is PER ZONE. Only ${restarted.map((z) => `:${z.port}`).join(', ')} restarted `
      + `while ${untouched.map((z) => `:${z.port}`).join(', ')} kept answering.`)
    console.log('     This does not match how the plugin addresses reboot, which assumes one')
    console.log('     server per box on port 80. Re-check, then update docs/PROTOCOL.md and')
    console.log('     the de-duplication in platform.rebootTargets().')
  } else if (watched.length > 1) {
    console.log('\n  -> reboot took down EVERY watched zone on this address.')
    console.log('     One call per host covers the box, which is what the plugin sends.')
  } else {
    console.log(`\n  -> ${target} restarted. Watch a sibling zone with --watch to learn `
      + 'whether this is per zone or per address.')
  }

  if (restarted.length > 0 && after.seconds === undefined) {
    // "Unknown" is not "unchanged", and saying so would report a gap in the
    // measurement as a finding about the hardware.
    console.log('\n  NOTE: the zones restarted, but uptime could not be read afterwards, so this '
      + 'run cannot say whether the hardware rebooted or the zones merely restarted.')
  } else if (restarted.length > 0 && !uptimeReset) {
    // Worth flagging rather than hiding: on a multi-zone chassis a zone can
    // restart as a process while the box itself keeps running.
    console.log('\n  NOTE: zones restarted but the box\'s uptime did not reset, so what restarted '
      + 'was the zone rather than the hardware.')
  }
  if (stranded.length > 0) {
    console.log(`\n  WARNING: ${stranded.map((z) => `:${z.port}`).join(', ')} never came back within the wait. `
      + 'Check the player before drawing conclusions.')
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), OPTIONS)

  if (flags.host === undefined) {
    fail('--host is required. This script reboots a player, so it never discovers targets itself.')
  }
  const variantName = flags.variant
  if (variantName === undefined) {
    fail(`--variant is required. One of: ${Object.keys(VARIANTS).join(', ')}`)
  }
  const variant = VARIANTS[variantName]
  if (variant === undefined) {
    fail(`unknown --variant "${variantName}". One of: ${Object.keys(VARIANTS).join(', ')}`)
  }

  const endpoint = parseEndpoint(flags.host)
  const waitSec = intFlag(flags, 'wait', DEFAULT_WAIT_SEC)

  const watchPorts = flags.watch === undefined
    ? [endpoint.port]
    : flags.watch.split(',').map((text) => {
      const port = Number(text.trim())
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        fail(`--watch contains "${text.trim()}", which is not a port`)
      }
      return port
    })

  const authority = variant.usePort ? `${endpoint.host}:${endpoint.port}` : endpoint.host
  const url = `http://${authority}${variant.path}`
  const body = new URLSearchParams(variant.form).toString()

  console.log('\n=== target ===')
  console.log(`  variant   ${variantName}`)
  console.log(`  request   POST ${url}`)
  console.log(`  body      ${body}`)
  console.log(`  watching  ${watchPorts.map((port) => `${endpoint.host}:${port}`).join(', ')}`)

  if (flags.confirm !== true) {
    fail('this will REBOOT the player and interrupt playback. Re-run with --confirm to proceed.')
  }

  console.log('\n=== before ===')
  const before = await readUptime(endpoint.host)
  console.log(`  uptime    ${before.value ?? 'unknown'}${before.note ? `  (${before.note})` : ''}`)
  for (const port of watchPorts) {
    const alive = await isAlive(endpoint.host, port)
    console.log(`  :${port}     ${alive ? 'answering' : 'NOT ANSWERING'}`)
    if (!alive) {
      // Without a live baseline there is no outage to observe, and the run would
      // report "never went down" for a zone that was already down.
      fail(`${endpoint.host}:${port} is not answering before we start; nothing to measure`)
    }
  }

  const result = await postForm(url, variant.form, 5000)
  describeResponse(result)

  console.log(`\n=== watching for up to ${waitSec}s ===`)
  const watched = await Promise.all(
    watchPorts.map(async (port) => watchZone(endpoint.host, port, waitSec)),
  )
  for (const zone of watched) {
    const state = zone.wentDown
      ? (zone.recovered ? `down then back after ${Math.round((zone.downtimeMs ?? 0) / 1000)}s` : 'down, still down')
      : 'never stopped answering'
    console.log(`  :${zone.port}     ${state}`)
  }

  console.log('\n=== after ===')
  const after = await readUptimeWhenReady(endpoint.host)
  console.log(`  uptime    ${after.value ?? 'unknown'}${after.note ? `  (${after.note})` : ''}`)

  verdict({ target: `${endpoint.host}:${endpoint.port}`, watched, before, after, result })
  console.log()
}

// Guarded so the reading helpers can be exercised without a player, and without
// the import itself firing a reboot.
if (require.main === module) {
  run(main)
}

module.exports = { readUptime, readUptimeWhenReady, uptimeSeconds }
