/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Stable player identity.
 *
 * Accessory identity must survive a DHCP lease change, so it is built from the
 * chassis MAC and the zone's control port, never from an address. Verified on
 * firmware 4.16.6 against a NAD CI S2, where the primary zone reports
 * `mac="90:56:82:0A:00:01"` and its secondary zone reports the same NIC with a
 * port suffix, `mac="90:56:82:0A:00:01:11010"`.
 */
import type { AccessoryKind, ResolvedAccessory } from '../types';
/** A MAC split into its chassis part and, when present, a zone-port suffix. */
export interface ParsedMac {
    /** Six upper-case octets joined by colons. */
    mac: string;
    /** Zone control port carried in the MAC suffix, when the player reported one. */
    suffixPort?: number;
}
/**
 * Parse a MAC as reported by `/SyncStatus` or an mDNS TXT record.
 *
 * Accepts three shapes seen in the field: six colon-separated octets, six
 * octets plus a numeric zone-port suffix (multi-zone secondaries), and twelve
 * bare hex digits (mDNS TXT records report `mac=9056820A0002`).
 *
 * Returns undefined rather than guessing, so a caller can fall back to a
 * persisted identity instead of inventing an unstable one.
 */
export declare function parseMac(value: unknown): ParsedMac | undefined;
/** Normalise a MAC to six upper-case colon-separated octets, dropping any suffix. */
export declare function normalizeMac(value: unknown): string | undefined;
/**
 * Build a player id from a chassis MAC and the zone's control port.
 *
 * The result deliberately matches the shape a multi-zone secondary already
 * reports for itself (`90:56:82:0A:00:01:11010`), so ids read the same whether
 * they were derived here or observed on the wire.
 */
export declare function makePlayerId(mac: string, port: number): string;
/**
 * Generate a persisted identity for a player that reports no usable MAC.
 *
 * Deliberately random rather than derived from name or address: both change,
 * and a changing id silently orphans the accessory. The discovery UI writes
 * this into configuration once and it is stable from then on.
 */
export declare function makeGeneratedPlayerId(): string;
/** True when a value is safe to use as a player id and accessory UUID seed. */
export declare function isValidPlayerId(value: unknown): value is string;
/** Canonical `host:port` string for an endpoint. */
export declare function formatEndpoint(host: string, port?: number): string;
/**
 * The identity of an accessory: what it does, for which player.
 *
 * Two accessories with the same key are the same accessory, and one whose key
 * changes is a different accessory. Contains no address, so re-addressing a
 * player leaves every UUID untouched.
 */
export declare function accessoryIdentityKey(accessory: {
    kind: AccessoryKind;
    deviceId: string;
    volume?: number;
}): string;
/** True when a cached context describes the same accessory as a resolved one. */
export declare function hasAccessoryIdentity(context: {
    kind?: unknown;
    deviceId?: unknown;
    volume?: unknown;
}, accessory: ResolvedAccessory): boolean;
