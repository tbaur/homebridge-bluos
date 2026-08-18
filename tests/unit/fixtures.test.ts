/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Guards the repository against publishing a real network.
 *
 * Every `.xml` file in `tests/fixtures/` was recorded from physical hardware and
 * then pseudonymised, so each one arrives carrying real addresses, real MAC
 * addresses and the names of real rooms. A capture committed before that step
 * would publish all three, and a reviewer cannot tell the difference by eye —
 * `192.168.4.11` and someone's actual address look identical. The same is true
 * of a doc comment or a log example written while looking at a live player, so
 * the scan covers the whole tree — sources, the committed build output, docs,
 * scripts and tests — not just the corpus.
 *
 * This is deliberately an allowlist. A list of the values that must not appear
 * would have to contain them, which is the leak it is trying to prevent.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..')
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures')

/** The documentation addresses the tree is pseudonymised onto. */
const ALLOWED_IPV4 = /^192\.168\.4\.\d{1,3}$/

/**
 * Addresses that have to be literal because they are the thing under test, or
 * because they are not addresses of anything: the loopback and wildcard hosts,
 * the mDNS group, the documentation ranges reserved by RFC 5737, and the
 * boundary values `isNonPrivateIpv4` is checked against.
 */
const ALLOWED_LITERALS = new Set([
  '0.0.0.0',
  '8.8.8.8',
  '10.0.0.5',
  '127.0.0.1',
  '169.254.1.1',
  '172.16.0.1',
  '172.31.255.5',
  '172.32.0.1',
  '100.63.255.255',
  '100.64.0.0',
  '100.64.1.10',
  '100.127.255.255',
  '100.128.0.1',
  '192.0.2.1',
  '203.0.113.7',
  '010.0.0.1',
  '999.999.999.999',
  '224.0.0.251',
  '255.255.255.255',
  // Rejected shapes: an octet out of range, and a zero-padded octet that some
  // resolvers would read as octal.
  '192.168.4.256',
  '192.168.04.11',
])

/**
 * The documentation MACs: the real Bluesound OUI, which is public vendor
 * information and is load-bearing for the parser, plus a fictional device part.
 * A zone port may follow as a seventh field, which is how a multi-zone secondary
 * reports itself.
 */
const ALLOWED_MAC = /^90:56:82:0A:00:0[0-9A-F](?::\d{4,5})?$/

const IPV4_IN_TEXT = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
/** Colon and hyphen notation, with an optional zone-port suffix. */
const MAC_IN_TEXT = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?::\d{4,5})?\b/g
/**
 * The bare twelve-digit form mDNS TXT records use. Bounded by a non-hex, non-`-`
 * character on both sides so a UUID's own digit groups are not read as MACs.
 */
const BARE_MAC_IN_TEXT = /(?<![0-9A-Fa-f-])[0-9A-Fa-f]{12}(?![0-9A-Fa-f-])/g

/** Directories that are generated, vendored, or not ours. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'coverage', '.vscode', 'raw'])
/** Generated files whose contents are decided by a registry, not by us. */
const SKIPPED_FILES = new Set(['package-lock.json'])
const SCANNED_EXTENSIONS = [
  '.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.xml', '.html', '.yml', '.yaml',
]

function isScannable(name: string): boolean {
  return !SKIPPED_FILES.has(name)
    && SCANNED_EXTENSIONS.some((extension) => name.endsWith(extension))
}

/** Every scannable file in the repository, as paths relative to its root. */
function repositoryFiles(directory = REPO_ROOT): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        found.push(...repositoryFiles(join(directory, entry.name)))
      }
      continue
    }
    if (isScannable(entry.name)) {
      found.push(relative(REPO_ROOT, join(directory, entry.name)))
    }
  }
  return found.sort()
}

/** Colon-separated upper case, so one allowlist covers every notation. */
function normaliseMac(value: string): string {
  return value.toUpperCase().replace(/-/g, ':')
}

function bareToColons(value: string): string {
  return (value.toUpperCase().match(/.{2}/g) ?? []).join(':')
}

function fixtureFiles(): string[] {
  return readdirSync(FIXTURE_DIR).filter((entry) => entry.endsWith('.xml')).sort()
}

describe('the recorded fixture corpus', () => {
  const files = fixtureFiles()

  it('is not empty, so a passing suite cannot mean an empty directory', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s contains only documentation addresses', (file) => {
    const body = readFileSync(join(FIXTURE_DIR, file), 'utf8')

    for (const address of body.match(IPV4_IN_TEXT) ?? []) {
      expect(address).toMatch(ALLOWED_IPV4)
    }
  })

  it.each(files)('%s contains only documentation MAC addresses', (file) => {
    const body = readFileSync(join(FIXTURE_DIR, file), 'utf8')

    for (const mac of body.match(MAC_IN_TEXT) ?? []) {
      expect(normaliseMac(mac)).toMatch(ALLOWED_MAC)
    }
  })

  it('keeps raw captures out of the corpus', () => {
    // scripts/capture-fixture.js writes here and the directory is git-ignored, so
    // a stray raw file means an unpseudonymised body is sitting in the tree.
    expect(readdirSync(FIXTURE_DIR)).not.toContain('raw')
  })
})

describe('the repository as a whole', () => {
  const files = repositoryFiles()

  it('scans the places a leak actually hides', () => {
    // A guard that quietly stopped finding files would pass forever, so assert it
    // reaches the source, the committed build output, the docs and the corpus.
    expect(files.length).toBeGreaterThan(50)
    for (const expected of [
      join('src', 'api', 'identity.ts'),
      join('dist', 'api', 'identity.js'),
      join('docs', 'PROTOCOL.md'),
      join('tests', 'fixtures', 'responses.ts'),
      join('homebridge-ui', 'public', 'index.js'),
      'README.md',
    ]) {
      expect(files).toContain(expected)
    }
  })

  it('recognises a leak in every notation it claims to cover', () => {
    // Assembled from parts rather than written out, because a guard whose own
    // fixtures were literal would have to exempt its own file and would then stop
    // being able to fail. Without this test, a regex that matched nothing would
    // pass the two scans above forever.
    const octets = ['01', '23', '45', '67', '89', 'AB']
    const address = ['10', '1', '2', '3'].join('.')

    expect(ALLOWED_LITERALS.has(address) || ALLOWED_IPV4.test(address)).toBe(false)
    expect(address).toMatch(IPV4_IN_TEXT)
    for (const notation of [octets.join(':'), octets.join('-')]) {
      expect(notation).toMatch(MAC_IN_TEXT)
      expect(ALLOWED_MAC.test(normaliseMac(notation))).toBe(false)
    }
    const bare = octets.join('')
    expect(bare).toMatch(BARE_MAC_IN_TEXT)
    expect(ALLOWED_MAC.test(bareToColons(bare))).toBe(false)
  })

  it('reads a UUID as a UUID rather than as a MAC address', () => {
    // A generated player id embeds one, and its last group is twelve hex digits.
    const id = 'gen-2f1c9b1e-0000-4000-8000-000000000000'

    expect(id.match(BARE_MAC_IN_TEXT)).toBeNull()
  })

  it('carries no address outside the documentation range', () => {
    const found: string[] = []
    for (const file of files) {
      const body = readFileSync(join(REPO_ROOT, file), 'utf8')
      for (const address of body.match(IPV4_IN_TEXT) ?? []) {
        if (!ALLOWED_LITERALS.has(address) && !ALLOWED_IPV4.test(address)) {
          found.push(`${file}: ${address}`)
        }
      }
    }

    expect(found).toEqual([])
  })

  it('carries no MAC address outside the documentation scheme, in any notation', () => {
    const found: string[] = []
    for (const file of files) {
      const body = readFileSync(join(REPO_ROOT, file), 'utf8')
      const candidates = [
        ...(body.match(MAC_IN_TEXT) ?? []).map(normaliseMac),
        ...(body.match(BARE_MAC_IN_TEXT) ?? []).map(bareToColons),
      ]
      for (const mac of candidates) {
        if (!ALLOWED_MAC.test(mac)) {
          found.push(`${file}: ${mac}`)
        }
      }
    }

    expect(found).toEqual([])
  })
})
