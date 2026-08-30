"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.forLog = forLog;
exports.forDisplay = forDisplay;
exports.isIpv4 = isIpv4;
exports.isValidHost = isValidHost;
exports.isNonPrivateIpv4 = isNonPrivateIpv4;
exports.isProbeableHost = isProbeableHost;
exports.resolveDiscoveryTimeoutSec = resolveDiscoveryTimeoutSec;
exports.resolveSliderService = resolveSliderService;
exports.validateConfig = validateConfig;
exports.resolveAccessories = resolveAccessories;
const identity_1 = require("../api/identity");
const settings_1 = require("../settings");
const types_1 = require("../types");
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
/**
 * The same class, global, for replacement.
 * Kept separate because a global regex carries `lastIndex` state, which would
 * make the `test` calls above return alternating answers for one input.
 */
const ALL_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,252}[A-Za-z0-9])?$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/**
 * Make an untrusted string safe to interpolate into a log line.
 *
 * Device names come from configuration and from the players themselves, so they
 * are attacker-influenced in the threat model where someone can write to either.
 * A newline in a log line lets them forge entries; truncation stops one long
 * name from burying everything else.
 */
function forLog(value) {
    const text = typeof value === 'string' ? value : String(value);
    const sanitized = text.replace(ALL_CONTROL_CHARACTERS, '\uFFFD');
    return sanitized.length > settings_1.MAX_LOG_FIELD_LENGTH
        ? `${sanitized.slice(0, settings_1.MAX_LOG_FIELD_LENGTH)}\u2026`
        : sanitized;
}
/**
 * Make an untrusted string safe to publish to HomeKit.
 *
 * Same sanitising as {@link forLog} but capped at HomeKit's name budget rather
 * than the log field budget, for values that become characteristic values and
 * are written into the accessory cache. An empty result becomes undefined, so a
 * caller keeps the value it already had instead of publishing a blank.
 */
function forDisplay(value) {
    const cleaned = value.replace(ALL_CONTROL_CHARACTERS, '').trim();
    if (cleaned.length === 0) {
        return undefined;
    }
    return cleaned.length > settings_1.MAX_NAME_LENGTH
        ? `${cleaned.slice(0, settings_1.MAX_NAME_LENGTH - 1)}\u2026`
        : cleaned;
}
/** True for an IPv4 literal whose octets are all in range. */
function isIpv4(value) {
    const match = IPV4.exec(value);
    if (match === null) {
        return false;
    }
    // Canonical form only. A leading zero is rejected rather than normalised
    // because `010` is decimal ten to this check and octal eight to some
    // resolvers, and the address we validate must be the address that gets dialled.
    return match.slice(1).every((octet) => {
        const number = Number(octet);
        return number >= 0 && number <= 255 && String(number) === octet;
    });
}
/** True for something usable as an HTTP host: an IPv4 literal or a hostname. */
function isValidHost(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 253) {
        return false;
    }
    // A four-octet dotted quad is an address, never a hostname. Falling through
    // to HOSTNAME would accept `192.168.04.11` and `999.999.999.999`, undoing
    // isIpv4's canonical-form check — the exact octal-ambiguity case that check
    // exists to reject.
    if (IPV4.test(trimmed)) {
        return isIpv4(trimmed);
    }
    return HOSTNAME.test(trimmed);
}
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
function isNonPrivateIpv4(value) {
    if (!isIpv4(value)) {
        return false;
    }
    const [a = 0, b = 0] = value.split('.').map(Number);
    if (a === 10 || a === 127) {
        return false;
    }
    if (a === 192 && b === 168) {
        return false;
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return false;
    }
    if (a === 169 && b === 254) {
        return false;
    }
    // RFC 6598: 100.64.0.0/10. Tailscale and carrier-grade NAT live here.
    if (a === 100 && b >= 64 && b <= 127) {
        return false;
    }
    return true;
}
/**
 * Suffixes that name a host on this network rather than on the public internet.
 *
 * `.local` is mDNS. `.localhost`, `.internal` and `.home.arpa` are IANA
 * special-use. A single-label name (no dots) is a DHCP / local-resolver name.
 */
const PROBE_LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];
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
function isProbeableHost(value) {
    if (!isValidHost(value)) {
        return false;
    }
    const host = value.trim();
    if (isIpv4(host)) {
        return !isNonPrivateIpv4(host);
    }
    const lower = host.toLowerCase();
    if (!lower.includes('.')) {
        return true;
    }
    return PROBE_LOCAL_SUFFIXES.some((suffix) => lower.endsWith(suffix) && lower.length > suffix.length);
}
/** Clamp the discovery window into the supported range. */
function resolveDiscoveryTimeoutSec(value, warnings) {
    if (value === undefined) {
        return settings_1.DEFAULT_DISCOVERY_TIMEOUT_SEC;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        warnings?.push(`options.discoveryTimeoutSec is not a number; using ${settings_1.DEFAULT_DISCOVERY_TIMEOUT_SEC}s`);
        return settings_1.DEFAULT_DISCOVERY_TIMEOUT_SEC;
    }
    const clamped = Math.min(settings_1.MAX_DISCOVERY_TIMEOUT_SEC, Math.max(settings_1.MIN_DISCOVERY_TIMEOUT_SEC, Math.round(numeric)));
    if (clamped !== numeric) {
        warnings?.push(`options.discoveryTimeoutSec clamped to ${clamped}s`);
    }
    return clamped;
}
/**
 * Resolve a slider service, falling back to the platform default then `fan`.
 *
 * An empty string counts as absent, because that is what the Homebridge form
 * writes for the per-device "use the platform setting" option; treating it as a
 * bad value would make choosing that option override the platform setting.
 */
function resolveSliderService(deviceValue, platformValue, warnings, label) {
    const where = label === undefined ? '' : `${label} `;
    for (const candidate of [deviceValue, platformValue]) {
        if (candidate === undefined || candidate === '') {
            continue;
        }
        if ((0, types_1.isSliderService)(candidate)) {
            return candidate;
        }
        warnings?.push(`${where}sliderService ${JSON.stringify(forLog(candidate))} is not "fan" or "lightbulb"; `
            + 'using "fan"');
        return 'fan';
    }
    // Fanv2 by default: a Lightbulb renders the same slider but is swept up by
    // "turn off all the lights", which would silence the house.
    return 'fan';
}
function validateName(value, label, problems) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        problems.push(`${label} is missing a name`);
        return undefined;
    }
    const name = value.trim();
    if (CONTROL_CHARACTERS.test(name)) {
        problems.push(`${label} name contains control characters`);
        return undefined;
    }
    if (name.length > settings_1.MAX_NAME_LENGTH) {
        problems.push(`${label} name is longer than ${settings_1.MAX_NAME_LENGTH} characters`);
        return undefined;
    }
    return name;
}
function validatePort(value, label, warnings) {
    if (value === undefined) {
        return settings_1.DEFAULT_BLUOS_PORT;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(numeric) || numeric < settings_1.MIN_PORT || numeric > settings_1.MAX_PORT) {
        warnings.push(`${label} port ${forLog(value)} is invalid; using ${settings_1.DEFAULT_BLUOS_PORT}`);
        return settings_1.DEFAULT_BLUOS_PORT;
    }
    if (!settings_1.DOCUMENTED_BLUOS_PORTS.includes(numeric)) {
        // Accepted anyway: the SRV record, not this list, is the authority on which
        // port a zone listens to.
        warnings.push(`${label} uses port ${numeric}, which is outside the documented BluOS ports `
            + `(${settings_1.DOCUMENTED_BLUOS_PORTS.join(', ')})`);
    }
    return numeric;
}
/**
 * Validate volume presets, dropping any that cannot be exposed.
 *
 * Two presets on one device with the same level would generate the same
 * accessory UUID, so the duplicate is dropped rather than allowed to collide.
 */
function validatePresets(value, label, warnings) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        warnings.push(`${label} volumePresets is not a list; ignoring it`);
        return [];
    }
    const presets = [];
    const levels = new Set();
    value.forEach((entry, index) => {
        const presetLabel = `${label} volumePresets[${index}]`;
        if (typeof entry !== 'object' || entry === null) {
            warnings.push(`${presetLabel} is not an object; skipping it`);
            return;
        }
        const candidate = entry;
        const problems = [];
        const name = validateName(candidate.name, presetLabel, problems);
        const volume = typeof candidate.volume === 'number' ? candidate.volume : Number(candidate.volume);
        if (!Number.isInteger(volume) || volume < settings_1.VOLUME_MIN || volume > settings_1.VOLUME_MAX) {
            problems.push(`${presetLabel} volume must be an integer ${settings_1.VOLUME_MIN}-${settings_1.VOLUME_MAX}`);
        }
        if (name === undefined || problems.length > 0) {
            warnings.push(`${problems.join('; ')}; skipping this preset`);
            return;
        }
        if (levels.has(volume)) {
            warnings.push(`${presetLabel} repeats volume ${volume}; skipping the duplicate`);
            return;
        }
        levels.add(volume);
        presets.push({ name, volume });
    });
    return presets;
}
function validateDevice(input) {
    const { entry, index, platformSlider, warnings } = input;
    const label = `devices[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
        warnings.push(`${label} is not an object; skipping it`);
        return undefined;
    }
    const device = entry;
    const problems = [];
    const name = validateName(device.name, label, problems);
    if (!(0, identity_1.isValidPlayerId)(device.id)) {
        problems.push(`${label} has no usable id (re-run discovery in the plugin settings)`);
    }
    if (!isValidHost(device.host)) {
        problems.push(`${label} host ${forLog(device.host)} is not a valid address or hostname`);
    }
    if (problems.length > 0) {
        warnings.push(`${problems.join('; ')}; skipping ${name === undefined ? label : forLog(name)}`);
        return undefined;
    }
    // Narrowed by the guards above; the early return covers every failing case.
    const id = device.id;
    const host = device.host.trim();
    const port = validatePort(device.port, label, warnings);
    if (isNonPrivateIpv4(host)) {
        warnings.push(`${label} host ${forLog(host)} is not a private address; the BluOS API is `
            + 'unauthenticated and meant for a local network');
    }
    const resolved = {
        id,
        name: name,
        host,
        port,
        // Absent means on, matching the schema default, the settings page and the
        // documented default. The other three accessories are opt-in, so they read
        // the reverse. A hand-written entry of just id, name and host is meant to
        // give you a working slider and nothing else.
        volumeSlider: device.volumeSlider !== false,
        sliderService: resolveSliderService(device.sliderService, platformSlider, warnings, label),
        mute: device.mute === true,
        battery: device.battery === true,
        reboot: device.reboot === true,
        volumePresets: validatePresets(device.volumePresets, label, warnings),
    };
    if (typeof device.model === 'string' && device.model.trim().length > 0) {
        resolved.model = forLog(device.model.trim());
    }
    if (typeof device.brand === 'string' && device.brand.trim().length > 0) {
        resolved.brand = forLog(device.brand.trim());
    }
    return resolved;
}
/**
 * Validate a platform configuration block.
 *
 * Never throws: the platform needs the errors and warnings in order to report
 * them, and a configuration problem should produce a diagnosable log rather than
 * an exception during Homebridge startup.
 */
function validateConfig(config) {
    const errors = [];
    const warnings = [];
    const noOptions = { rebootAll: false, rebootAllName: undefined };
    if (typeof config !== 'object' || config === null) {
        return {
            errors: ['platform configuration is missing'],
            warnings,
            devices: [],
            options: noOptions,
        };
    }
    const platform = config;
    const rawDevices = platform.devices;
    const options = {
        rebootAll: platform.options?.rebootAll === true,
        // A warning rather than an error, and the default rather than nothing: a
        // rejected name should cost the user their label, not their switch.
        rebootAllName: platform.options?.rebootAllName === undefined
            ? undefined
            : validateName(platform.options.rebootAllName, 'the reboot all switch', warnings),
    };
    if (rawDevices === undefined) {
        return {
            errors: ['configuration has no "devices" list; open the plugin settings and run discovery'],
            warnings,
            devices: [],
            options,
        };
    }
    if (!Array.isArray(rawDevices)) {
        return { errors: ['configuration "devices" must be a list'], warnings, devices: [], options };
    }
    const platformSlider = platform.options?.sliderService;
    const devices = [];
    const seenIds = new Set();
    rawDevices.forEach((entry, index) => {
        const device = validateDevice({ entry, index, platformSlider, warnings });
        if (device === undefined) {
            return;
        }
        if (seenIds.has(device.id)) {
            warnings.push(`devices[${index}] repeats id ${forLog(device.id)}; skipping the duplicate`);
            return;
        }
        seenIds.add(device.id);
        devices.push(device);
    });
    if (rawDevices.length > 0 && devices.length === 0) {
        // Every entry was rejected. The user plainly meant to configure something,
        // so this is fatal rather than an idle platform.
        errors.push(`all ${rawDevices.length} configured device(s) were rejected; see the warnings above`);
    }
    else if (rawDevices.length === 0) {
        warnings.push('no devices are configured; open the plugin settings and run discovery');
    }
    const exposed = devices.filter((device) => device.volumeSlider
        || device.mute
        || device.battery
        || device.reboot
        || device.volumePresets.length > 0);
    if (devices.length > 0 && exposed.length === 0 && !options.rebootAll) {
        warnings.push('no device has a volume slider, mute switch, battery sensor, reboot switch or volume '
            + 'preset enabled, so nothing will appear in HomeKit');
    }
    return { errors, warnings, devices, options };
}
/**
 * Expand validated devices into the accessories to expose.
 *
 * Names are derived here rather than at use time so that duplicates can be
 * detected once: two accessories sharing a name still work, but they make Siri
 * ambiguous, which is worth a warning.
 */
function resolveAccessories(devices, warnings, platform) {
    const accessories = [];
    for (const device of devices) {
        // Whether a player reports a fixed output level is only knowable from a live
        // `/SyncStatus`, so the slider is created here and disables itself on first
        // observation if the player turns out to have no adjustable volume.
        if (device.volumeSlider) {
            accessories.push({
                kind: 'volume',
                deviceId: device.id,
                // Suffixed like the others rather than taking the player's name bare: the
                // slider is a fan tile, and a bare room name sitting among real fans is
                // ambiguous both on screen and to Siri.
                name: suffixName(device.name, 'Volume'),
                sliderService: device.sliderService,
            });
        }
        if (device.mute) {
            accessories.push({
                kind: 'mute',
                deviceId: device.id,
                name: suffixName(device.name, 'Mute'),
                sliderService: device.sliderService,
            });
        }
        if (device.battery) {
            accessories.push({
                kind: 'battery',
                deviceId: device.id,
                name: suffixName(device.name, 'Battery'),
                sliderService: device.sliderService,
            });
        }
        if (device.reboot) {
            accessories.push({
                kind: 'reboot',
                deviceId: device.id,
                name: suffixName(device.name, 'Reboot'),
                sliderService: device.sliderService,
            });
        }
        for (const preset of device.volumePresets) {
            accessories.push({
                kind: 'volumePreset',
                deviceId: device.id,
                name: preset.name,
                sliderService: device.sliderService,
                volume: preset.volume,
            });
        }
    }
    // Last, and outside the loop: it belongs to the platform, not to any player,
    // and it exists even when no device is configured — which is exactly the case
    // where a network sweep is the only way to reach anything.
    if (platform?.rebootAll === true) {
        accessories.push({
            kind: 'rebootAll',
            deviceId: settings_1.PLATFORM_DEVICE_ID,
            // Taken bare when the user named it, unlike a player's accessories: they
            // are suffixed so several tiles for one room stay tellable apart, and this
            // is the one accessory with no room and no siblings.
            name: platform.rebootAllName ?? suffixName(platform.name, 'Reboot All'),
            sliderService: 'fan',
        });
    }
    const names = new Map();
    for (const accessory of accessories) {
        names.set(accessory.name, (names.get(accessory.name) ?? 0) + 1);
    }
    for (const [name, count] of names) {
        if (count > 1) {
            warnings?.push(`${count} accessories are named ${forLog(name)}; Siri cannot tell them apart`);
        }
    }
    return accessories;
}
/** Append a suffix to a device name without exceeding HomeKit's name budget. */
function suffixName(name, suffix) {
    const combined = `${name} ${suffix}`;
    if (combined.length <= settings_1.MAX_NAME_LENGTH) {
        return combined;
    }
    return `${name.slice(0, settings_1.MAX_NAME_LENGTH - suffix.length - 2)}\u2026 ${suffix}`;
}
