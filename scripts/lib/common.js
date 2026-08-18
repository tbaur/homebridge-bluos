/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Shared plumbing for the maintenance scripts in this directory.
 *
 * These run against real players on a real network, so nothing here has a
 * built-in address, name or MAC: every target comes from the command line or
 * from discovery. Anything captured is written where the caller asks for it, and
 * `pseudonymise.js` is the step that makes such a capture publishable.
 */
const http = require('node:http')
const path = require('node:path')

const DEFAULT_PORT = 11000

/** Print a message and exit non-zero. Scripts are tools, not libraries. */
function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

/**
 * Parse `--key value` and `--flag` arguments into an object.
 *
 * Deliberately minimal, and unknown keys are rejected rather than ignored, so a
 * typo in `--seconds` cannot silently leave the default in place.
 */
function parseFlags(argv, known) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      fail(`unexpected argument "${token}"`)
    }
    const key = token.slice(2)
    if (!Object.prototype.hasOwnProperty.call(known, key)) {
      fail(`unknown option "--${key}". Known options: ${Object.keys(known).map((name) => `--${name}`).join(', ')}`)
    }
    if (known[key] === 'boolean') {
      flags[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      fail(`--${key} needs a value`)
    }
    flags[key] = value
    index += 1
  }
  return flags
}

/** Read a flag as a positive integer, or return the default. */
function intFlag(flags, key, fallback) {
  if (flags[key] === undefined) {
    return fallback
  }
  const value = Number(flags[key])
  if (!Number.isInteger(value) || value <= 0) {
    fail(`--${key} must be a positive integer, got "${flags[key]}"`)
  }
  return value
}

/**
 * Load the compiled plugin.
 *
 * The scripts use the same code the plugin runs rather than reimplementing the
 * protocol, which is the only way a script's result says anything about the
 * plugin. That means the build has to be current.
 */
function requireBuild() {
  const target = path.join(__dirname, '..', '..', 'dist', 'ui-api.js')
  try {
    return require(target)
  } catch (error) {
    fail(`could not load ${target}: ${error.message}\nRun "npm run build" first.`)
  }
}

/** A PluginLogger the plugin's own classes accept, printing to the terminal. */
function consoleLogger({ verbose = false } = {}) {
  return {
    info: (message) => console.log(`  [info]  ${message}`),
    warn: (message) => console.log(`  [warn]  ${message}`),
    error: (message) => console.log(`  [error] ${message}`),
    debug: (message) => {
      if (verbose) {
        console.log(`  [debug] ${message}`)
      }
    },
  }
}

/** Split `host` or `host:port` into an endpoint, defaulting to port 11000. */
function parseEndpoint(text) {
  const trimmed = text.trim()
  // Rejected here rather than several layers down, where the plugin's own host
  // check would refuse it with a message about an invalid host.
  if (trimmed.includes('[') || trimmed.includes(']')) {
    fail(`IPv6 is not supported; the BluOS API is reached over IPv4 ("${text}")`)
  }
  const match = /^([^:]+)(?::(\d+))?$/.exec(trimmed)
  if (match === null) {
    fail(`could not read "${text}" as host or host:port`)
  }
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`port in "${text}" is not a valid port`)
  }
  return { host: match[1], port }
}

/**
 * Fetch a URL path and return the raw body.
 *
 * Used where a script needs the bytes the player actually sent — capturing a
 * fixture, or inspecting a shape the parser does not model yet — rather than the
 * plugin's interpretation of them.
 */
function getRaw(endpoint, pathname, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: endpoint.host, port: endpoint.port, path: pathname, timeout: timeoutMs },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`${pathname} answered HTTP ${response.statusCode}`))
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => resolve(body))
      },
    )
    request.on('timeout', () => request.destroy(new Error(`${pathname} timed out after ${timeoutMs}ms`)))
    request.on('error', reject)
  })
}

/** Discover zones, or resolve the single endpoint the caller named. */
async function targetsFrom(flags, api, log) {
  const client = new api.BluOSClient({ log })
  const discovery = new api.BluOSDiscovery({ log, client })
  if (flags.host !== undefined) {
    const endpoint = parseEndpoint(flags.host)
    const player = await discovery.probe(endpoint)
    if (player === undefined) {
      fail(`no BluOS player answered at ${endpoint.host}:${endpoint.port}`)
    }
    return { client, players: [player] }
  }
  const seconds = intFlag(flags, 'seconds', 6)
  console.log(`=== mDNS discovery (${seconds}s) ===`)
  const started = Date.now()
  const players = await discovery.discover(seconds)
  console.log(`found ${players.length} zone(s) in ${Date.now() - started}ms\n`)
  if (players.length === 0) {
    fail('no zones found. Multicast may be filtered on this network; pass --host <address> instead.')
  }
  return { client, players }
}

/**
 * Wait, in milliseconds.
 *
 * Needed where a script issues a raw request alongside one the client made: the
 * API asks for a second between two requests for the same resource, and a raw
 * fetch is outside the client's limiter and so outside its bookkeeping.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Turn a name into a filename-safe slug. */
function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Run a script's main function, reporting a failure without a stack wall. */
function run(main) {
  main().catch((error) => {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

module.exports = {
  consoleLogger,
  fail,
  getRaw,
  intFlag,
  parseEndpoint,
  parseFlags,
  requireBuild,
  run,
  sleep,
  slug,
  targetsFrom,
}
