/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Backend for the plugin's custom configuration UI.
 *
 * Runs in its own short-lived process, separate from Homebridge, and exists only
 * while a user has the settings page open. It reuses the compiled discovery and
 * client code from `dist/` rather than reimplementing either: a second
 * implementation of identity derivation would be a second thing to get wrong, and
 * the ids written here have to match exactly what the platform expects.
 */

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils')

class BluOSUiServer extends HomebridgePluginUiServer {
  constructor() {
    super()

    this.onRequest('/discover', (payload) => this.handleDiscover(payload))
    this.onRequest('/probe', (payload) => this.handleProbe(payload))

    // Must be last: the page is not told the server is up until this fires.
    this.ready()
  }

  /**
   * Load the compiled plugin API.
   *
   * Deferred rather than required at module scope so that a missing build
   * produces an actionable message in the UI instead of the settings page
   * failing to open at all.
   */
  loadApi() {
    if (this.api === undefined) {
      try {
        // `ui-api` is the explicit contract for this process, not the whole plugin.
        this.api = require('../dist/ui-api')
      } catch (error) {
        throw new RequestError(
          'The plugin is not built. Run "npm run build" in the plugin directory.',
          { message: String(error && error.message ? error.message : error) },
        )
      }
    }
    return this.api
  }

  /** A logger that keeps UI-process output out of the Homebridge log. */
  makeLogger() {
    const messages = []
    return {
      logger: {
        info: (message) => messages.push(`info ${message}`),
        warn: (message) => messages.push(`warn ${message}`),
        error: (message) => messages.push(`error ${message}`),
        debug: (message) => messages.push(`debug ${message}`),
      },
      messages,
    }
  }

  buildDiscovery() {
    const api = this.loadApi()
    const { logger, messages } = this.makeLogger()
    const client = new api.BluOSClient({ log: logger })
    const discovery = new api.BluOSDiscovery({ log: logger, client })
    return { api, discovery, messages }
  }

  /** Browse the network and return every zone that answered. */
  async handleDiscover(payload) {
    // Bounds come from the compiled settings rather than being restated here, so
    // raising the ceiling in one place raises it everywhere.
    const api = this.loadApi()
    const requested = Number(payload && payload.timeoutSec)
    const timeoutSec = Number.isFinite(requested)
      ? Math.min(
        api.MAX_DISCOVERY_TIMEOUT_SEC,
        Math.max(api.MIN_DISCOVERY_TIMEOUT_SEC, Math.round(requested)),
      )
      : api.DEFAULT_DISCOVERY_TIMEOUT_SEC

    const { discovery, messages } = this.buildDiscovery()
    try {
      const players = await discovery.discover(timeoutSec)
      return { players: players.map((player) => this.describe(player)), log: messages }
    } catch (error) {
      throw new RequestError('Discovery failed.', {
        message: String(error && error.message ? error.message : error),
        log: messages,
      })
    }
  }

  /**
   * Probe an address the user typed in, for networks where multicast is filtered.
   *
   * Every documented port is tried, because a multi-zone chassis answers on
   * several and the user cannot be expected to know which.
   *
   * Deliberately narrow: this endpoint makes the Homebridge host open a connection
   * to an address a caller chose, so it is only useful as a network probe to the
   * extent it is allowed to be one. The host must be a private IPv4 address
   * (including CGNAT / Tailscale) or a local hostname, and the port must be one
   * BluOS actually uses — which is what stops it being a general port scanner
   * run from the Homebridge host's network position.
   */
  async handleProbe(payload) {
    const host = payload && typeof payload.host === 'string' ? payload.host.trim() : ''
    const api = this.loadApi()
    if (!api.isValidHost(host)) {
      throw new RequestError('Enter a valid IP address or hostname.', { host })
    }
    if (!api.isProbeableHost(host)) {
      throw new RequestError(
        'That address is outside your local network. The BluOS API is unauthenticated, '
        + 'so only private addresses and local names can be probed from here.',
        { host },
      )
    }

    const requestedPort = Number(payload && payload.port)
    let ports = api.DOCUMENTED_BLUOS_PORTS
    if (Number.isInteger(requestedPort)) {
      if (!api.DOCUMENTED_BLUOS_PORTS.includes(requestedPort)) {
        throw new RequestError(
          `Port ${requestedPort} is not a BluOS control port. `
          + `Use one of ${api.DOCUMENTED_BLUOS_PORTS.join(', ')}, or leave it blank to try each.`,
          { host, port: requestedPort },
        )
      }
      ports = [requestedPort]
    }

    const { discovery, messages } = this.buildDiscovery()
    const found = []
    for (const port of ports) {
      // Sequential on purpose: these are all the same chassis, and hitting one
      // box with parallel requests is exactly what the client's rate limits are
      // there to prevent.
      const player = await discovery.probe({ host, port })
      if (player !== undefined) {
        found.push(this.describe(player))
      }
    }
    if (found.length === 0) {
      throw new RequestError(`Nothing answered at ${host} on port ${ports.join(', ')}.`, {
        log: messages,
      })
    }
    return { players: found, log: messages }
  }

  /**
   * Shape a discovered player for the page, including sensible defaults.
   *
   * A player that reports a fixed output level gets no slider suggested, because
   * writing a level to it does nothing. A player with no usable MAC is given a
   * generated identity here, once, so that it stays stable from then on.
   */
  describe(player) {
    const api = this.loadApi()
    const id = player.id && player.id.length > 0 ? player.id : api.makeGeneratedPlayerId()
    return {
      id,
      name: player.name,
      host: player.host,
      port: player.port,
      brand: player.brand || 'BluOS',
      model: player.modelName || player.model || 'BluOS Player',
      firmware: player.firmware || '',
      fixedVolume: player.fixedVolume === true,
      hasBattery: player.hasBattery === true,
      derivedIdentity: !(player.mac && player.mac.length > 0),
      suggested: {
        volumeSlider: player.fixedVolume !== true,
        mute: false,
        battery: player.hasBattery === true,
        // Never suggested. Restarting a player interrupts whatever it is doing,
        // so it should be a thing the user asked for rather than a default they
        // inherited from pressing Discover.
        reboot: false,
      },
    }
  }
}

// Homebridge starts this file as a child process and expects the instance to be
// constructed immediately.
;(() => new BluOSUiServer())()
