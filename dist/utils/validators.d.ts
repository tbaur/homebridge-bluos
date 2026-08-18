/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * The split between fatal and non-fatal is deliberate. A structural problem —
 * `devices` present but not an array — means the file does not describe anything
 * we can act on, so the platform disables itself while leaving cached
 * accessories registered, and HomeKit shows them as No Response rather than
 * losing the rooms and automations built on them.
 *
 * A problem with one device is different: rejecting the whole fleet because one
 * entry is malformed would be a worse outcome than skipping that entry. Skipped
 * devices are warned about by name and reason, because a device that silently
 * fails to appear is the hardest kind of bug for a user to report.
 */
import { type ResolvedAccessory, type ResolvedDevice, type SliderService } from '../types';
/** Outcome of validating a platform configuration block. */
export interface ConfigValidationResult {
    /** Fatal problems. Any entry means the platform must not start polling. */
    errors: string[];
    /** Problems worth reporting that do not prevent operation. */
    warnings: string[];
    /** Devices that survived validation, in configuration order. */
    devices: ResolvedDevice[];
}
/**
 * Make an untrusted string safe to interpolate into a log line.
 *
 * Device names come from configuration and from the players themselves, so they
 * are attacker-influenced in the threat model where someone can write to either.
 * A newline in a log line lets them forge entries; truncation stops one long
 * name from burying everything else.
 */
export declare function forLog(value: unknown): string;
/**
 * Make an untrusted string safe to publish to HomeKit.
 *
 * Same sanitising as {@link forLog} but capped at HomeKit's name budget rather
 * than the log field budget, for values that become characteristic values and
 * are written into the accessory cache. An empty result becomes undefined, so a
 * caller keeps the value it already had instead of publishing a blank.
 */
export declare function forDisplay(value: string): string | undefined;
/** True for an IPv4 literal whose octets are all in range. */
export declare function isIpv4(value: string): boolean;
/** True for something usable as an HTTP host: an IPv4 literal or a hostname. */
export declare function isValidHost(value: unknown): value is string;
/**
 * True for an address outside the ranges treated as local.
 *
 * Local here is RFC 1918, RFC 6598 shared address space (CGNAT / Tailscale),
 * loopback, and link-local. Not blocked in configuration, only warned about:
 * the BluOS API is unauthenticated and intended for a local network, and a
 * routable address in the configuration is much more likely to be a typo than
 * an intention. Hostnames cannot be classified this way and are left alone
 * in configuration; the settings-page probe uses {@link isProbeableHost}.
 */
export declare function isNonPrivateIpv4(value: string): boolean;
/**
 * True for a host the settings-page probe is allowed to dial.
 *
 * Narrower than {@link isValidHost}: configuration may name a split-DNS
 * hostname that happens to look public, but the probe is an authenticated
 * Homebridge administrator asking this host to open a connection, so it must
 * not become a scanner. Public IPv4 literals and multi-label public names
 * (`example.com`) are refused. Private IPv4 (including CGNAT) and local
 * hostnames are accepted.
 */
export declare function isProbeableHost(value: unknown): value is string;
/** Clamp the discovery window into the supported range. */
export declare function resolveDiscoveryTimeoutSec(value: unknown, warnings?: string[]): number;
/**
 * Resolve a slider service, falling back to the platform default then `fan`.
 *
 * An empty string counts as absent, because that is what the Homebridge form
 * writes for the per-device "use the platform setting" option; treating it as a
 * bad value would make choosing that option override the platform setting.
 */
export declare function resolveSliderService(deviceValue: unknown, platformValue: unknown, warnings?: string[], label?: string): SliderService;
/**
 * Validate a platform configuration block.
 *
 * Never throws: the platform needs the errors and warnings in order to report
 * them, and a configuration problem should produce a diagnosable log rather than
 * an exception during Homebridge startup.
 */
export declare function validateConfig(config: unknown): ConfigValidationResult;
/**
 * Expand validated devices into the accessories to expose.
 *
 * Names are derived here rather than at use time so that duplicates can be
 * detected once: two accessories sharing a name still work, but they make Siri
 * ambiguous, which is worth a warning.
 */
export declare function resolveAccessories(devices: readonly ResolvedDevice[], warnings?: string[]): ResolvedAccessory[];
