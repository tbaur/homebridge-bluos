/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview BluOS Custom Integration API client.
 *
 * Three scheduling rules are enforced here rather than at the call sites, so no
 * caller can accidentally violate them:
 *
 * 1. At least one second between consecutive requests for the same resource on
 *    the same endpoint. API v1.7 section 2 requires this of long-polling
 *    clients, and phrases it as a requirement rather than advice.
 * 2. At least 100 ms between control calls to one endpoint, so a HomeKit scene
 *    that touches several tiles at once cannot burst a player.
 * 3. Writes to one chassis are serialised. A NAD CI S2 or CI 580 exposes several
 *    zones on one IP; concurrent writes to `:11000` and `:11010` are writes to
 *    the same box. Different chassis still run in parallel.
 *
 * Note that a chassis and a group are different things. Serialisation above is
 * per chassis, because that is one piece of hardware; grouping is a logical
 * relationship between zones that may live on different chassis entirely, and it
 * is expressed per write through {@link WriteScope}.
 */

import {
  CONNECT_TIMEOUT_MS,
  CONTROL_RATE_LIMIT_MS,
  CONTROL_TIMEOUT_MS,
  LONG_POLL_READ_SLACK_MS,
  LONG_POLL_SEC,
  MAX_XML_BYTES,
  REBOOT_FORM,
  REBOOT_RESOURCE,
  REBOOT_TIMEOUT_MS,
  SAME_RESOURCE_MIN_GAP_MS,
  STATUS_TIMEOUT_MS,
  VOLUME_MAX,
  VOLUME_MIN,
} from '../settings'
import type { PlayerObservation, PluginLogger } from '../types'
import { ConnectionError, ProtocolError } from '../utils/errors'
import { sleep as realSleep } from '../utils/timing'
import { isValidHost } from '../utils/validators'
import {
  httpGet as defaultHttpGet,
  httpPost as defaultHttpPost,
  type HttpGet,
  type HttpPost,
} from './http'
import { formatEndpoint } from './identity'
import { parseSyncStatus, parseVolume, type VolumeResult } from './sync-status'

/** Where to reach one player zone. */
export interface Endpoint {
  host: string
  port: number
}

/**
 * How far a volume write should reach.
 *
 * `tellSlaves` maps to the API's `tell_slaves` parameter. False confines the
 * write to the addressed zone; true lets a group leader carry its followers with
 * it, which is what the BluOS app does when you move a leader's slider.
 *
 * Defaults to false everywhere, so a caller that has not thought about grouping
 * gets the conservative answer.
 */
export interface WriteScope {
  tellSlaves: boolean
}

/**
 * What a reboot request produced.
 *
 * `acknowledged` is false when the player took the request and then stopped
 * answering, which is a success rather than a failure — see
 * {@link BluOSClient.reboot}. It is carried so the log can say which happened,
 * because "sent, no answer" and "sent, answered" look identical to the user and
 * only one of them is worth investigating if the player never comes back.
 */
export interface RebootResult {
  acknowledged: boolean
}

/** Injectable collaborators, so tests need neither sockets nor real clocks. */
export interface BluOSClientOptions {
  log: PluginLogger
  httpGet?: HttpGet
  httpPost?: HttpPost
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Talks to BluOS players over the LAN.
 *
 * One instance serves the whole fleet: the rate limits and the per-chassis write
 * lock are only meaningful if every request goes through the same bookkeeping.
 */
export class BluOSClient {
  private readonly log: PluginLogger

  private readonly httpGet: HttpGet

  private readonly httpPost: HttpPost

  private readonly now: () => number

  private readonly sleep: (ms: number) => Promise<void>

  /** Last request time, keyed by `endpoint|resource`, for the one-second rule. */
  private readonly lastResourceRequest = new Map<string, number>()

  /** Last control call time, keyed by endpoint. */
  private readonly lastControlRequest = new Map<string, number>()

  /** Tail of the write queue for each chassis host. */
  private readonly chassisWriteQueue = new Map<string, Promise<unknown>>()

  constructor(options: BluOSClientOptions) {
    this.log = options.log
    this.httpGet = options.httpGet ?? defaultHttpGet
    this.httpPost = options.httpPost ?? defaultHttpPost
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? realSleep
  }

  /** Read `/SyncStatus` once, without long-polling. */
  async readSyncStatus(endpoint: Endpoint): Promise<PlayerObservation> {
    const body = await this.get({
      endpoint,
      resource: 'SyncStatus',
      query: {},
      totalTimeoutMs: STATUS_TIMEOUT_MS,
    })
    return parseSyncStatus(body, formatEndpoint(endpoint.host, endpoint.port))
  }

  /**
   * Long-poll `/SyncStatus`, returning when the player's state changes or the
   * poll window elapses.
   *
   * Measured on firmware 4.16.6: with a current etag the request holds for the
   * full requested window (15.03 s for `timeout=15`), and with a stale etag it
   * answers in 44 ms. Verified per-zone rather than per-chassis, so a sibling
   * zone changing volume does not wake this poll.
   */
  async pollSyncStatus(
    endpoint: Endpoint,
    etag: string,
    signal?: AbortSignal,
  ): Promise<PlayerObservation> {
    const body = await this.get({
      endpoint,
      resource: 'SyncStatus',
      query: { timeout: String(LONG_POLL_SEC), etag },
      totalTimeoutMs: LONG_POLL_SEC * 1_000 + LONG_POLL_READ_SLACK_MS,
      signal,
    })
    return parseSyncStatus(body, formatEndpoint(endpoint.host, endpoint.port))
  }

  /**
   * Read `/Volume` without changing anything.
   *
   * Not on the polling path: `/SyncStatus` is the source of truth for level and
   * mute, and it long-polls. This exists for the diagnostic scripts and for
   * confirming what a player reports when a write result looks wrong.
   */
  async readVolume(endpoint: Endpoint): Promise<VolumeResult> {
    const body = await this.get({
      endpoint,
      resource: 'Volume',
      query: {},
      totalTimeoutMs: STATUS_TIMEOUT_MS,
    })
    return parseVolume(body)
  }

  /**
   * Set this zone's absolute level.
   *
   * `tell_slaves` is always sent explicitly rather than left to the firmware's
   * default, because the two answers are both defensible and the caller is the
   * only one that knows which applies: a tile addressing a zone that leads a
   * group should move the group, and a tile addressing any other zone must move
   * nothing else. See {@link WriteScope}.
   *
   * The player clamps the level into its own configured dB range, so the result
   * is authoritative and the caller should adopt it rather than assume the
   * requested value took effect.
   */
  async setVolume(
    endpoint: Endpoint,
    level: number,
    scope: WriteScope = { tellSlaves: false },
  ): Promise<VolumeResult> {
    if (!Number.isInteger(level) || level < VOLUME_MIN || level > VOLUME_MAX) {
      throw new RangeError(`volume must be an integer ${VOLUME_MIN}-${VOLUME_MAX}, got ${level}`)
    }
    return this.control(endpoint, {
      level: String(level),
      tell_slaves: scope.tellSlaves ? '1' : '0',
    })
  }

  /**
   * Mute or unmute this zone.
   *
   * `mute=1` mutes and `mute=0` unmutes. API v1.7's parameter table in section
   * 3.1 states the opposite, but sections 3.4 and 3.5, the response attribute
   * tables, and firmware 4.16.6 all agree with the mapping used here: writing
   * `mute=1` produced `mute="1" muteVolume="72"` on a real player.
   */
  async setMute(
    endpoint: Endpoint,
    muted: boolean,
    scope: WriteScope = { tellSlaves: false },
  ): Promise<VolumeResult> {
    return this.control(endpoint, {
      mute: muted ? '1' : '0',
      tell_slaves: scope.tellSlaves ? '1' : '0',
    })
  }

  /**
   * Restart the box at an address.
   *
   * Takes a host and no port, which is the whole story about this call. `/reboot`
   * is served on port 80 alongside `/diagnostics`, and the control ports answer
   * 404 for it. Port 80 is one server per chassis, so this restarts every zone
   * behind the address and cannot be aimed at one zone of a CI S2, however much
   * the rest of the API is per zone. See docs/PROTOCOL.md.
   *
   * Deliberately outside {@link withChassisLock}, unlike every other write. That
   * lock protects one address from concurrent volume and mute traffic, which is
   * rapid and repeated; a reboot is one request per address per press. Holding
   * the lock would only mean that a box which dies mid-response makes anything
   * queued behind it wait out the whole timeout. `respectResourceGap` still
   * paces repeat presses, keyed on the same address.
   *
   * A lost connection counts as success once the request reached the player.
   * This is the one call where that is right rather than reckless: a player that
   * is restarting cannot finish answering, so insisting on a clean response would
   * report failure precisely when the command worked. A failure to connect at all
   * is still a failure, which is the distinction {@link ConnectionError.delivered}
   * exists to draw.
   */
  async reboot(host: string): Promise<RebootResult> {
    if (!isValidHost(host)) {
      throw new ConnectionError(`refusing to contact an invalid host: ${JSON.stringify(host)}`)
    }
    await this.respectResourceGap(`${host}|${REBOOT_RESOURCE}`)
    const url = `http://${host}/${REBOOT_RESOURCE}`
    this.log.debug(`POST ${url}`)

    try {
      const response = await this.httpPost(url, { ...REBOOT_FORM }, {
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        totalTimeoutMs: REBOOT_TIMEOUT_MS,
        maxBytes: MAX_XML_BYTES,
      })
      if (response.status !== 200) {
        throw new ProtocolError(`reboot on ${host} answered HTTP ${response.status}`)
      }
      return { acknowledged: true }
    } catch (error) {
      if (error instanceof ConnectionError && error.delivered) {
        this.log.debug(`${host} stopped answering after the reboot request, which is expected`)
        return { acknowledged: false }
      }
      throw error
    }
  }

  private async control(
    endpoint: Endpoint,
    query: Record<string, string>,
  ): Promise<VolumeResult> {
    // Serialised per chassis: zones of a multi-zone player share one box.
    return this.withChassisLock(endpoint.host, async () => {
      await this.respectControlRate(endpoint)
      const body = await this.get({
        endpoint,
        resource: 'Volume',
        query,
        totalTimeoutMs: CONTROL_TIMEOUT_MS,
      })
      return parseVolume(body)
    })
  }

  /**
   * Queue work behind anything already writing to this chassis.
   *
   * The queue tail is stored per host; failures are swallowed for the purpose of
   * chaining so one rejected write does not poison later ones, while the
   * original promise still rejects for its own caller.
   */
  private async withChassisLock<T>(host: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chassisWriteQueue.get(host) ?? Promise.resolve()
    const run = previous.then(work, work)
    this.chassisWriteQueue.set(host, run.catch(() => undefined))
    try {
      return await run
    } finally {
      // Only clear if nothing else queued behind us in the meantime.
      if (this.chassisWriteQueue.get(host) === run) {
        this.chassisWriteQueue.delete(host)
      }
    }
  }

  private async respectControlRate(endpoint: Endpoint): Promise<void> {
    const key = formatEndpoint(endpoint.host, endpoint.port)
    const last = this.lastControlRequest.get(key)
    const elapsed = last === undefined ? Number.POSITIVE_INFINITY : this.now() - last
    if (elapsed < CONTROL_RATE_LIMIT_MS) {
      await this.sleep(CONTROL_RATE_LIMIT_MS - elapsed)
    }
    this.lastControlRequest.set(key, this.now())
  }

  /**
   * Wait out the API's one-second minimum gap between consecutive requests for
   * the same resource on the same endpoint.
   */
  private async respectResourceGap(key: string): Promise<void> {
    const last = this.lastResourceRequest.get(key)
    const elapsed = last === undefined ? Number.POSITIVE_INFINITY : this.now() - last
    if (elapsed < SAME_RESOURCE_MIN_GAP_MS) {
      await this.sleep(SAME_RESOURCE_MIN_GAP_MS - elapsed)
    }
    this.lastResourceRequest.set(key, this.now())
  }

  /**
   * Validate the host and wait out the same-resource gap, then name the target.
   *
   * Shared by every request whatever its method, so a new call path cannot
   * forget either. The host check especially: two copies of the one defence
   * against a configuration or cache value altering a request URL would
   * eventually disagree, and the disagreement would be the security regression.
   * It is the same check the settings page and the configuration validator apply.
   */
  private async prepare(endpoint: Endpoint, resource: string): Promise<string> {
    const target = formatEndpoint(endpoint.host, endpoint.port)
    if (!isValidHost(endpoint.host)) {
      throw new ConnectionError(`refusing to contact an invalid host: ${JSON.stringify(endpoint.host)}`)
    }
    await this.respectResourceGap(`${target}|${resource}`)
    return target
  }

  private async get(request: {
    endpoint: Endpoint
    resource: string
    query: Record<string, string>
    totalTimeoutMs: number
    signal?: AbortSignal
  }): Promise<string> {
    const { endpoint, resource, query, totalTimeoutMs, signal } = request
    const target = await this.prepare(endpoint, resource)

    const search = new URLSearchParams(query).toString()
    const url = `http://${target}/${resource}${search.length > 0 ? `?${search}` : ''}`
    // Safe to log unsanitised, and the only place in the plugin where wire data
    // reaches a log line without passing through forLog: the query carries a
    // player-supplied etag, which URLSearchParams percent-encodes, so no control
    // character can reach the log. Templating the query by hand would reintroduce
    // log injection.
    this.log.debug(`GET ${url}`)

    const response = await this.httpGet(url, {
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      totalTimeoutMs,
      maxBytes: MAX_XML_BYTES,
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.status !== 200) {
      throw new ProtocolError(`${resource} on ${target} answered HTTP ${response.status}`)
    }
    return response.body
  }
}
