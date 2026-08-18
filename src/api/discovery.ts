/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview mDNS discovery of BluOS zones.
 *
 * Two service types are browsed, because a multi-zone chassis advertises each
 * zone separately: `_musc._tcp` for primary zones and `_musp._tcp` for the
 * secondaries of a CI-S2 or CI 580. API v1.7 section 1 is explicit that the port
 * "should be discovered by use of the MDNS protocol using the services musc.tcp
 * and musp.tcp", and only the SRV record knows whether a zone is on 11000,
 * 11010, 11020 or 11030.
 *
 * The appendix also describes LSDP, a UDP-broadcast alternative that Lenbrook
 * says is more reliable than multicast on consumer networks. It is not
 * implemented: on the network this plugin was developed against, mDNS returned
 * every zone with full metadata while LSDP returned nothing at all, twice —
 * first with a global broadcast and then with per-interface subnet broadcasts
 * and an all-classes query. LSDP also never carries a zone's port, so it could
 * not replace this path even where it does answer. Manual entry by address
 * covers networks where multicast is filtered.
 *
 * Nothing here is trusted: an endpoint only counts as a player once it has
 * answered `/SyncStatus`, which is also where authoritative identity comes from.
 */

import os from 'node:os'

import type { Answer, Question, StringAnswer, SrvAnswer, TxtAnswer } from 'dns-packet'

import {
  DEFAULT_BLUOS_PORT,
  DISCOVERY_VERIFY_CONCURRENCY,
  MAX_DISCOVERY_CANDIDATES,
  MAX_DISCOVERY_RECORDS,
  MDNS_SERVICE_PRIMARY,
  MDNS_SERVICE_SECONDARY,
} from '../settings'
import type { DiscoveredPlayer, PluginLogger } from '../types'
import { describeError } from '../utils/errors'
import { interruptibleSleep } from '../utils/timing'
import type { BluOSClient, Endpoint } from './client'
import { formatEndpoint, makePlayerId, parseMac } from './identity'

/** An mDNS response packet, narrowed to the parts used here. */
export interface MdnsPacket {
  answers?: Answer[]
  additionals?: Answer[]
}

/** Where a packet came from. Used as a fallback when no A record is offered. */
export interface MdnsRemote {
  address: string
}

/**
 * The slice of `multicast-dns` this module needs.
 *
 * Declared structurally so a test can supply a fake without a socket, and so a
 * future move to a different mDNS implementation does not ripple outwards.
 */
export interface MdnsSession {
  on(event: 'response', listener: (packet: MdnsPacket, remote: MdnsRemote) => void): void
  /**
   * `error` is fatal for the session (the socket could not be bound); `warning`
   * covers recoverable trouble such as an undecodable packet. Both must be
   * subscribed, because an unheard `error` on an EventEmitter is thrown, and a
   * throw here would take Homebridge down with it.
   */
  on(event: 'error' | 'warning', listener: (error: Error) => void): void
  query(request: { questions: Question[] }): void
  destroy(callback?: () => void): void
}

/** Creates an mDNS session. */
export type MdnsFactory = () => MdnsSession

/** A service instance seen on the network, before verification. */
interface Candidate {
  instance: string
  service: string
  port: number
  target: string
  txt: Record<string, string>
  responder?: string
}

/** Injectable collaborators for {@link BluOSDiscovery}. */
export interface DiscoveryOptions {
  log: PluginLogger
  client: BluOSClient
  createMdns?: MdnsFactory
}

/** Re-query schedule, in milliseconds, to survive dropped multicast packets. */
const QUERY_SCHEDULE_MS = [0, 400, 1_200] as const

/** When to chase missing SRV, TXT and A records for known instances. */
const FOLLOW_UP_SCHEDULE_MS = [700, 1_600] as const

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

function isSrv(record: Answer): record is SrvAnswer {
  return record.type === 'SRV'
}

function isTxt(record: Answer): record is TxtAnswer {
  return record.type === 'TXT'
}

function isPtr(record: Answer): record is StringAnswer {
  return record.type === 'PTR'
}

function isA(record: Answer): record is StringAnswer {
  return record.type === 'A'
}

/**
 * Decode TXT record data into key/value pairs.
 *
 * BluOS primaries advertise `model`, `version`, `mac` and `zs`; secondary zones
 * omit `mac`, which is why identity is confirmed from `/SyncStatus` instead.
 */
function decodeTxt(data: TxtAnswer['data']): Record<string, string> {
  // Null-prototyped: the keys come from an unauthenticated multicast packet, so
  // a record of `__proto__=x` must land as an ordinary key rather than reaching
  // the prototype chain.
  const entries: Record<string, string> = Object.create(null) as Record<string, string>
  const items = Array.isArray(data) ? data : [data]
  for (const item of items) {
    const text = typeof item === 'string' ? item : Buffer.from(item).toString('utf8')
    const separator = text.indexOf('=')
    if (separator <= 0) {
      continue
    }
    entries[text.slice(0, separator).toLowerCase()] = text.slice(separator + 1)
  }
  return entries
}

/** Discovers BluOS zones and confirms them against the API. */
export class BluOSDiscovery {
  private readonly log: PluginLogger

  private readonly client: BluOSClient

  private readonly createMdns: MdnsFactory

  /** Live browse windows, so a shutdown does not have to wait one out. */
  private readonly openWindows = new Set<{ interrupt: () => void }>()

  private cancelled = false

  constructor(options: DiscoveryOptions) {
    this.log = options.log
    this.client = options.client
    this.createMdns = options.createMdns ?? defaultMdnsFactory
  }

  /**
   * Abandon every browse in flight and refuse any that start afterwards.
   *
   * A browse window is a referenced timer holding a bound multicast socket, so
   * without this a shutdown during an address re-resolution keeps the Homebridge
   * process alive for the rest of the window — up to 30 s per unreachable
   * player. One-way by design: it is only called when the platform is stopping.
   */
  cancelAll(): void {
    this.cancelled = true
    for (const window of this.openWindows) {
      window.interrupt()
    }
    this.openWindows.clear()
  }

  /**
   * Browse for zones and return the ones that answer `/SyncStatus`.
   *
   * Failures are logged and skipped rather than thrown: a single unreachable
   * player must not deny the user the rest of the fleet.
   */
  async discover(timeoutSec: number): Promise<DiscoveredPlayer[]> {
    const candidates = await this.browse(timeoutSec)
    const endpoints = this.toEndpoints(candidates)
    this.log.debug(`discovery: ${endpoints.length} candidate endpoint(s) to verify`)

    const verified = await this.verifyAll(endpoints)
    return verified.sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Verify candidates a few at a time.
   *
   * Verification opens a connection and holds it for up to the status timeout,
   * and nothing throttles distinct endpoints against each other, so verifying
   * every advertisement at once would let whatever answered the browse decide how
   * many sockets this plugin opens at one moment.
   */
  private async verifyAll(
    entries: readonly { endpoint: Endpoint; txt: Record<string, string> }[],
  ): Promise<DiscoveredPlayer[]> {
    const found: DiscoveredPlayer[] = []
    let next = 0
    const take = (): { endpoint: Endpoint; txt: Record<string, string> } | undefined => {
      const entry = entries[next]
      next += 1
      return entry
    }
    const worker = async (): Promise<void> => {
      for (let entry = take(); entry !== undefined; entry = take()) {
        if (this.cancelled) {
          return
        }
        const player = await this.verify(entry)
        if (player !== undefined) {
          found.push(player)
        }
      }
    }
    const width = Math.min(DISCOVERY_VERIFY_CONCURRENCY, entries.length)
    await Promise.all(Array.from({ length: width }, async () => worker()))
    return found
  }

  /**
   * Find the current address of an already-known player.
   *
   * Called at launch and after a player goes silent, so a DHCP lease change does
   * not require the user to re-save configuration.
   */
  async resolveEndpoint(playerId: string, timeoutSec: number): Promise<Endpoint | undefined> {
    const players = await this.discover(timeoutSec)
    const match = players.find((player) => player.id === playerId)
    return match === undefined ? undefined : { host: match.host, port: match.port }
  }

  /** Probe one endpoint directly, for the UI's manual-entry path. */
  async probe(endpoint: Endpoint): Promise<DiscoveredPlayer | undefined> {
    return this.verify({ endpoint, txt: {} })
  }

  private async verify(entry: {
    endpoint: Endpoint
    txt: Record<string, string>
  }): Promise<DiscoveredPlayer | undefined> {
    const target = formatEndpoint(entry.endpoint.host, entry.endpoint.port)
    try {
      const observation = await this.client.readSyncStatus(entry.endpoint)
      // A multi-zone secondary reports its chassis NIC with a port suffix, so the
      // MAC alone is ambiguous; the zone's own port disambiguates it.
      const mac = parseMac(observation.mac)?.mac ?? parseMac(entry.txt.mac)?.mac
      const player: DiscoveredPlayer = {
        id: mac === undefined ? '' : makePlayerId(mac, entry.endpoint.port),
        name: observation.name.length > 0 ? observation.name : target,
        host: entry.endpoint.host,
        port: entry.endpoint.port,
        fixedVolume: observation.fixedVolume,
        hasBattery: observation.battery !== undefined,
      }
      if (observation.brand !== undefined) {
        player.brand = observation.brand
      }
      if (observation.model !== undefined) {
        player.model = observation.model
      }
      if (observation.modelName !== undefined) {
        player.modelName = observation.modelName
      }
      if (observation.firmware !== undefined) {
        player.firmware = observation.firmware
      }
      if (mac !== undefined) {
        player.mac = mac
      }
      return player
    } catch (error) {
      this.log.debug(`discovery: ${target} did not answer SyncStatus: ${describeError(error)}`)
      return undefined
    }
  }

  /**
   * Turn service instances into addressable endpoints.
   *
   * A zone is only usable once its SRV record (for the port) and an IPv4 address
   * are both known. The address comes from an A record when one was offered, and
   * otherwise from the responder's own source address, which for a player
   * advertising its own service is the same machine.
   */
  private toEndpoints(candidates: {
    instances: Candidate[]
    addresses: Map<string, string>
  }): { endpoint: Endpoint; txt: Record<string, string> }[] {
    const seen = new Set<string>()
    const results: { endpoint: Endpoint; txt: Record<string, string> }[] = []
    for (const candidate of candidates.instances) {
      const fromA = candidates.addresses.get(candidate.target.toLowerCase())
      const host = fromA ?? candidate.responder
      if (host === undefined || !IPV4.test(host)) {
        this.log.debug(
          `discovery: no IPv4 address for ${candidate.instance} (target ${candidate.target})`,
        )
        continue
      }
      const key = formatEndpoint(host, candidate.port)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      if (results.length >= MAX_DISCOVERY_CANDIDATES) {
        this.log.warn(
          `discovery found more than ${MAX_DISCOVERY_CANDIDATES} candidate endpoints; `
          + 'verifying the first ones only. Add the player by address in the plugin settings '
          + 'if it is missing',
        )
        break
      }
      results.push({ endpoint: { host, port: candidate.port }, txt: candidate.txt })
    }
    return results
  }

  /** Collect mDNS records for the configured window. */
  private async browse(timeoutSec: number): Promise<{
    instances: Candidate[]
    addresses: Map<string, string>
  }> {
    const services = [MDNS_SERVICE_PRIMARY, MDNS_SERVICE_SECONDARY]
    const instanceService = new Map<string, string>()
    const srv = new Map<string, { port: number; target: string }>()
    const txt = new Map<string, Record<string, string>>()
    const addresses = new Map<string, string>()
    const responders = new Map<string, string>()

    if (this.cancelled) {
      return { instances: [], addresses }
    }

    let session: MdnsSession
    try {
      session = this.createMdns()
    } catch (error) {
      this.log.warn(`discovery unavailable: ${describeError(error)}`)
      return { instances: [], addresses }
    }

    const windowMs = Math.max(1, timeoutSec) * 1_000
    const browseWindow = interruptibleSleep(windowMs)
    this.openWindows.add(browseWindow)

    /** Belongs to one of the browsed service types, so worth remembering. */
    const isBrowsedInstance = (name: string): boolean =>
      services.some((service) => name.endsWith(`.${service}`))

    let capacityWarned = false
    /** Record into a capped map, so a chatty or hostile segment cannot grow the heap. */
    const remember = <T>(map: Map<string, T>, key: string, value: T): void => {
      if (!map.has(key) && map.size >= MAX_DISCOVERY_RECORDS) {
        if (!capacityWarned) {
          capacityWarned = true
          this.log.debug(
            `discovery: ignoring mDNS records past ${MAX_DISCOVERY_RECORDS} of one kind`,
          )
        }
        return
      }
      map.set(key, value)
    }

    // A dead socket will never answer, so stop waiting on it. Discovery then
    // returns empty and the caller falls back to configured addresses.
    session.on('error', (error) => {
      this.log.warn(`mDNS unavailable, discovery cannot run: ${describeError(error)}`)
      browseWindow.interrupt()
    })
    session.on('warning', (error) => {
      this.log.debug(`mDNS warning: ${describeError(error)}`)
    })

    session.on('response', (packet, remote) => {
      const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])]
      for (const record of records) {
        // SRV and TXT are matched on the service suffix rather than against the
        // instances seen so far, because a single packet may carry the SRV ahead
        // of the PTR that introduces it. Records for unrelated services on the
        // segment are dropped rather than accumulated.
        if (isPtr(record) && services.includes(record.name)) {
          remember(instanceService, record.data, record.name)
          remember(responders, record.data, remote.address)
        } else if (isSrv(record) && isBrowsedInstance(record.name)) {
          remember(srv, record.name, { port: record.data.port, target: record.data.target })
          remember(responders, record.name, remote.address)
        } else if (isTxt(record) && isBrowsedInstance(record.name)) {
          remember(txt, record.name, decodeTxt(record.data))
        } else if (isA(record)) {
          remember(addresses, record.name.toLowerCase(), record.data)
        }
      }
    })

    const ask = (questions: Question[]): void => {
      if (questions.length === 0) {
        return
      }
      try {
        session.query({ questions })
      } catch (error) {
        this.log.debug(`mDNS query failed: ${describeError(error)}`)
      }
    }

    const timers: ReturnType<typeof setTimeout>[] = []
    const schedule = (delayMs: number, work: () => void): void => {
      if (delayMs >= windowMs) {
        return
      }
      timers.push(setTimeout(work, delayMs))
    }

    for (const delay of QUERY_SCHEDULE_MS) {
      schedule(delay, () => {
        ask(services.map((service) => ({ name: service, type: 'PTR' })))
      })
    }
    for (const delay of FOLLOW_UP_SCHEDULE_MS) {
      schedule(delay, () => {
        const questions: Question[] = []
        for (const instance of instanceService.keys()) {
          if (!srv.has(instance)) {
            questions.push({ name: instance, type: 'SRV' })
          }
          if (!txt.has(instance)) {
            questions.push({ name: instance, type: 'TXT' })
          }
        }
        for (const entry of srv.values()) {
          if (!addresses.has(entry.target.toLowerCase())) {
            questions.push({ name: entry.target, type: 'A' })
          }
        }
        ask(questions)
      })
    }

    try {
      await browseWindow.promise
    } finally {
      this.openWindows.delete(browseWindow)
      browseWindow.interrupt()
      for (const timer of timers) {
        clearTimeout(timer)
      }
      try {
        session.destroy()
      } catch (error) {
        this.log.debug(`mDNS teardown failed: ${describeError(error)}`)
      }
    }

    const instances: Candidate[] = []
    for (const [instance, service] of instanceService) {
      const record = srv.get(instance)
      if (record === undefined) {
        this.log.debug(`discovery: no SRV record for ${instance}`)
        continue
      }
      const candidate: Candidate = {
        instance,
        service,
        port: record.port > 0 ? record.port : DEFAULT_BLUOS_PORT,
        target: record.target,
        txt: txt.get(instance) ?? {},
      }
      const responder = responders.get(instance)
      if (responder !== undefined) {
        candidate.responder = responder
      }
      instances.push(candidate)
    }
    return { instances, addresses }
  }
}

/**
 * Default mDNS session.
 *
 * `loopback: false` stops us from answering our own queries, and the require is
 * deferred so that importing this module — which the config UI does — cannot
 * fail merely because a socket could not be bound.
 *
 * Interfaces are enumerated up front because `multicast-dns` does the same from
 * inside its `listening` handler, where a throw would surface as an uncaught
 * exception instead of a failed call. Doing it here keeps the failure catchable
 * by {@link BluOSDiscovery.browse}, which degrades to "discovery unavailable".
 */
export const defaultMdnsFactory: MdnsFactory = () => {
  os.networkInterfaces()

  const makeMdns = require('multicast-dns') as (options?: {
    loopback?: boolean
    reuseAddr?: boolean
  }) => MdnsSession
  return makeMdns({ loopback: false, reuseAddr: true })
}
