/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Make a captured fixture publishable: rewrite the addresses, MAC addresses and
 * room names it carries, then prove none of them survived.
 *
 *   node scripts/pseudonymise.js --map ~/bluos.map.json
 *   node scripts/pseudonymise.js --in tests/fixtures --check
 *
 * The substitution map lives outside this repository, or beside it as
 * `*.map.json`, which is git-ignored: it is a list of your real values and is the
 * one thing here that must never be committed. See `scripts/README.md` for its
 * shape.
 *
 * Substitutions are applied longest-first, so no replacement can be a prefix of
 * another, and they are structure-preserving by convention — an address for an
 * address, a MAC for a MAC — so every quirk the parser tests depend on survives
 * byte for byte.
 *
 * `--check` skips rewriting and only audits, which is worth running over
 * `tests/fixtures/` before a release.
 */
const fs = require('node:fs')
const path = require('node:path')

const { fail, parseFlags, run } = require('./lib/common')

const OPTIONS = {
  map: 'string',
  in: 'string',
  out: 'string',
  check: 'boolean',
}

const DEFAULT_IN = path.join(__dirname, '..', 'tests', 'fixtures', 'raw')

const MAC_PATTERN = /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

/** Read and validate the substitution map. */
function readMap(file) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`could not read the map at ${file}: ${error.message}`)
  }
  const substitutions = parsed.substitutions
  if (!Array.isArray(substitutions) || substitutions.length === 0) {
    fail(`${file} needs a non-empty "substitutions" array of [from, to] pairs`)
  }
  for (const pair of substitutions) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      fail(`${file}: every substitution must be a [from, to] pair of strings`)
    }
    if (pair[0].length === 0) {
      fail(`${file}: a substitution cannot rewrite an empty string`)
    }
  }
  const rename = Array.isArray(parsed.rename) ? parsed.rename : []
  // Longest first, so a shorter value cannot consume part of a longer one.
  return {
    substitutions: [...substitutions].sort((left, right) => right[0].length - left[0].length),
    rename: new Map(rename),
  }
}

function rewrite(text, substitutions) {
  let out = text
  for (const [from, to] of substitutions) {
    out = out.split(from).join(to)
  }
  return out
}

/**
 * Audit a rewritten file.
 *
 * Two questions: did any mapped value survive (a bug in the rewrite, and a leak),
 * and what identifiers remain at all (for the operator to eyeball, since only they
 * know which values are fictional).
 */
function audit(body, substitutions) {
  const survived = substitutions
    .filter(([from]) => body.includes(from))
    .map(([from]) => from)
  const remaining = new Set([
    ...(body.match(MAC_PATTERN) || []),
    ...(body.match(IPV4_PATTERN) || []),
  ])
  return { survived, remaining: [...remaining] }
}

function xmlFiles(dir) {
  if (!fs.existsSync(dir)) {
    fail(`${dir} does not exist. Capture something first with scripts/capture-fixture.js.`)
  }
  return fs.readdirSync(dir).filter((entry) => entry.endsWith('.xml')).sort()
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), OPTIONS)
  const checkOnly = flags.check === true
  if (!checkOnly && flags.map === undefined) {
    fail('--map is required unless you pass --check. See scripts/README.md.')
  }

  const inDir = flags.in === undefined ? DEFAULT_IN : path.resolve(flags.in)
  const outDir = flags.out === undefined ? inDir : path.resolve(flags.out)
  const { substitutions, rename } = flags.map === undefined
    ? { substitutions: [], rename: new Map() }
    : readMap(path.resolve(flags.map))

  fs.mkdirSync(outDir, { recursive: true })

  const leaks = []
  const identifiers = new Set()
  for (const entry of xmlFiles(inDir)) {
    const body = fs.readFileSync(path.join(inDir, entry), 'utf8')
    const rewritten = checkOnly ? body : rewrite(body, substitutions)
    const target = rename.get(entry) || entry
    // The map is the operator's own file, but a rename target is joined onto the
    // output directory, so it has to be a filename and not a path.
    if (target.includes('/') || target.includes('\\') || target.includes('..')) {
      fail(`rename target "${target}" must be a plain filename, not a path`)
    }

    if (!checkOnly) {
      fs.writeFileSync(path.join(outDir, target), rewritten)
      if (target !== entry && outDir === inDir) {
        fs.unlinkSync(path.join(inDir, entry))
      }
    }

    const result = audit(rewritten, substitutions)
    for (const value of result.survived) {
      leaks.push(`${target}: "${value}" survived the rewrite`)
    }
    for (const value of result.remaining) {
      identifiers.add(value)
    }
    console.log(checkOnly ? `  checked ${entry}` : `  ${entry} -> ${target}`)
  }

  console.log('\n=== identifiers present in the output ===')
  if (identifiers.size === 0) {
    console.log('  none')
  }
  for (const value of [...identifiers].sort()) {
    console.log(`  ${value}`)
  }
  console.log('\nEvery value above will be published. Confirm each one is fictional:')
  console.log('anything your network actually uses needs a substitution in the map.')

  if (leaks.length > 0) {
    for (const leak of leaks) {
      console.log(`  LEAK ${leak}`)
    }
    throw new Error(`${leaks.length} mapped value(s) survived the rewrite`)
  }
}

run(main)
