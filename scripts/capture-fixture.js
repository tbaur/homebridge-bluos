/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Capture raw `/SyncStatus` and `/Volume` XML from real players, so the parser is
 * tested against bytes a firmware actually sent rather than bytes someone assumed
 * it would. Read-only: no control endpoint is called.
 *
 *   node scripts/capture-fixture.js
 *   node scripts/capture-fixture.js --host 192.168.4.10:11010 --label muted
 *
 * Captures land in `tests/fixtures/raw/`, which is git-ignored, because a raw body
 * carries your MAC addresses, IP addresses and room names. Run
 * `scripts/pseudonymise.js` before moving anything into `tests/fixtures/`.
 *
 * To capture a state you cannot reach passively — muted, level zero, grouped —
 * put the player in that state from the BluOS app first, then capture with a
 * --label saying which state it was in.
 */
const fs = require('node:fs')
const path = require('node:path')

const {
  consoleLogger,
  getRaw,
  parseFlags,
  requireBuild,
  run,
  slug,
  targetsFrom,
} = require('./lib/common')

const OPTIONS = {
  host: 'string',
  seconds: 'string',
  out: 'string',
  label: 'string',
  verbose: 'boolean',
}

const ENDPOINTS = [
  ['/SyncStatus', 'syncstatus'],
  ['/Volume', 'volume'],
]

const DEFAULT_OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'raw')

async function main() {
  const flags = parseFlags(process.argv.slice(2), OPTIONS)
  const api = requireBuild()
  const log = consoleLogger({ verbose: flags.verbose === true })

  const outDir = flags.out === undefined ? DEFAULT_OUT : path.resolve(flags.out)
  const { players } = await targetsFrom(flags, api, log)
  fs.mkdirSync(outDir, { recursive: true })

  const manifest = []
  for (const player of players) {
    const parts = [player.model || 'player', player.name, flags.label].filter(Boolean)
    const base = slug(parts.join('-'))
    const endpoint = { host: player.host, port: player.port }
    for (const [pathname, suffix] of ENDPOINTS) {
      const xml = await getRaw(endpoint, pathname)
      const file = `${base}.${suffix}.xml`
      fs.writeFileSync(path.join(outDir, file), `${xml.trim()}\n`)
      manifest.push({
        file,
        endpoint: pathname,
        model: player.model,
        firmware: player.firmware,
        port: player.port,
        label: flags.label,
        bytes: xml.length,
      })
      console.log(`  ${file} (${xml.length} bytes)`)
    }
  }

  const manifestPath = path.join(outDir, 'MANIFEST.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`\n${manifest.length} file(s) in ${outDir}`)
  console.log('These are unredacted. Run scripts/pseudonymise.js before committing any of them.')
}

run(main)
