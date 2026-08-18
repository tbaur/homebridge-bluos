"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Readers for `/SyncStatus` and `/Volume` responses.
 *
 * `/Status` is intentionally never requested. API v1.7 section 2 says
 * "/SyncStatus should be polled if only the name, volume and grouping status of
 * a player is of interest", which is precisely this plugin's scope, and for a
 * group secondary `/Status` reports the *group's* volume while `/SyncStatus`
 * reports that player's own. Polling only `/SyncStatus` is therefore both
 * cheaper and more correct here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSyncStatus = parseSyncStatus;
exports.parseVolume = parseVolume;
exports.restoreLevelFrom = restoreLevelFrom;
const settings_1 = require("../settings");
const errors_1 = require("../utils/errors");
const identity_1 = require("./identity");
const xml_1 = require("./xml");
/** Clamp a reported level into the documented 0..100 range. */
function clampVolume(value) {
    return Math.min(settings_1.VOLUME_MAX, Math.max(settings_1.VOLUME_MIN, Math.round(value)));
}
/**
 * Work out whether this player leads a group, follows one, or is standalone.
 *
 * `<slave>` children mean it is the primary; a `<master>` pointing anywhere
 * other than itself means it is a secondary. A player can briefly report a
 * `<master>` equal to its own endpoint while regrouping, which is not a
 * following state.
 *
 * "Itself" is the `id` the player reports, falling back to the address we
 * dialled. The distinction matters when a player is configured by hostname: its
 * own `<master>` would then never match the endpoint, and a regrouping player
 * would look like a follower.
 */
function readSyncRole(root, endpoint) {
    if ((0, xml_1.children)(root, 'slave').length > 0) {
        return 'primary';
    }
    const self = (0, xml_1.attr)(root, 'id') ?? endpoint;
    const isSelf = (value) => value === self || value === endpoint;
    const masterElement = (0, xml_1.child)(root, 'master');
    if (masterElement !== undefined) {
        const host = masterElement.text.trim();
        const port = (0, xml_1.attr)(masterElement, 'port');
        const master = host.includes(':') || port === undefined ? host : `${host}:${port}`;
        if (master.length > 0 && !isSelf(master)) {
            return 'secondary';
        }
    }
    const legacyMaster = (0, xml_1.attr)(root, 'master');
    if (legacyMaster !== undefined && !isSelf(legacyMaster)) {
        return 'secondary';
    }
    return 'standalone';
}
/**
 * Decide whether a player is muted.
 *
 * `/Volume` says so outright with `mute="1"`, but `/SyncStatus` carries no mute
 * attribute at all. Verified against BluOS 4.16.6, where the same zone reports:
 *
 * - playing:  `volume="60" db="-32.1"`
 * - muted:    `volume="0" db="-100" muteVolume="60" muteDb="-32.1"`
 * - level 0:  `volume="0" db="-100"`
 *
 * So `db="-100"` is silence, not mute, and the two ways of reaching silence are
 * told apart only by the remembered pre-mute level, which the firmware publishes
 * exclusively while muted. Inferring mute from `db` instead would turn the mute
 * switch on whenever a user dragged the slider to zero.
 */
function readMuted(root) {
    if ((0, xml_1.attr)(root, 'mute') !== undefined) {
        return (0, xml_1.boolAttr)(root, 'mute');
    }
    return (0, xml_1.attr)(root, 'muteVolume') !== undefined || (0, xml_1.attr)(root, 'muteDb') !== undefined;
}
function readBattery(root) {
    const element = (0, xml_1.child)(root, 'battery');
    if (element === undefined) {
        return undefined;
    }
    const level = (0, xml_1.intAttr)(element, 'level');
    if (level === undefined) {
        return undefined;
    }
    return {
        level: Math.min(100, Math.max(0, level)),
        charging: (0, xml_1.boolAttr)(element, 'charging'),
    };
}
/**
 * Parse a `/SyncStatus` response.
 *
 * @param endpoint canonical `host:port` this response came from. Used, alongside
 * the response's own `id`, to tell a self-referential `<master>` apart from a
 * real group leader.
 */
function parseSyncStatus(body, endpoint) {
    const root = (0, xml_1.parseXml)(body);
    // Firmware has shipped both `SyncStatus` and lowercase variants; matching
    // case-insensitively costs nothing and avoids a needless incompatibility.
    if (root.name.toLowerCase() !== 'syncstatus') {
        throw new errors_1.ProtocolError(`expected a SyncStatus response, got <${root.name}>`);
    }
    const rawVolume = (0, xml_1.intAttr)(root, 'volume');
    const fixedVolume = rawVolume === settings_1.FIXED_VOLUME_SENTINEL;
    const muted = readMuted(root);
    const rawDb = (0, xml_1.floatAttr)(root, 'db');
    const observation = {
        name: (0, xml_1.attr)(root, 'name') ?? '',
        brand: (0, xml_1.attr)(root, 'brand'),
        model: (0, xml_1.attr)(root, 'model'),
        modelName: (0, xml_1.attr)(root, 'modelName'),
        firmware: (0, xml_1.attr)(root, 'version'),
        mac: (0, identity_1.normalizeMac)((0, xml_1.attr)(root, 'mac')),
        fixedVolume,
        muted,
        syncRole: readSyncRole(root, endpoint),
        etag: (0, xml_1.attr)(root, 'etag'),
        syncStat: (0, xml_1.attrOrChildText)(root, 'syncStat'),
    };
    if (rawVolume !== undefined && !fixedVolume) {
        observation.volume = clampVolume(rawVolume);
    }
    const muteVolume = (0, xml_1.intAttr)(root, 'muteVolume');
    if (muteVolume !== undefined) {
        observation.muteVolume = clampVolume(muteVolume);
    }
    // `db="-100"` is the mute sentinel rather than a real output level, so it is
    // dropped instead of being reported as if the amplifier were at -100 dB.
    if (rawDb !== undefined && !(muted && rawDb <= settings_1.MUTED_DB_SENTINEL)) {
        observation.db = rawDb;
    }
    const battery = readBattery(root);
    if (battery !== undefined) {
        observation.battery = battery;
    }
    return observation;
}
/**
 * Parse a `/Volume` response.
 *
 * The level is the element's text content rather than an attribute:
 * `<volume db="-39.8" mute="0" ...>35</volume>`.
 */
function parseVolume(body) {
    const root = (0, xml_1.parseXml)(body);
    if (root.name.toLowerCase() !== 'volume') {
        throw new errors_1.ProtocolError(`expected a Volume response, got <${root.name}>`);
    }
    const rawLevel = Number.parseInt(root.text, 10);
    const fixedVolume = rawLevel === settings_1.FIXED_VOLUME_SENTINEL;
    const muted = (0, xml_1.boolAttr)(root, 'mute');
    const rawDb = (0, xml_1.floatAttr)(root, 'db');
    const result = { fixedVolume, muted };
    if (Number.isInteger(rawLevel) && !fixedVolume) {
        result.level = clampVolume(rawLevel);
    }
    const muteVolume = (0, xml_1.intAttr)(root, 'muteVolume');
    if (muteVolume !== undefined) {
        result.muteVolume = clampVolume(muteVolume);
    }
    if (rawDb !== undefined && !(muted && rawDb <= settings_1.MUTED_DB_SENTINEL)) {
        result.db = rawDb;
    }
    return result;
}
/**
 * The level to restore when a muted or zeroed player is switched back on.
 *
 * `muteVolume` is preferred because the player itself remembers the pre-mute
 * level, which makes an unmute lossless without any state of our own. The
 * remembered level is only a fallback for the other way of reaching silence,
 * writing `level=0`, which the player cannot undo for us.
 */
function restoreLevelFrom(observation, remembered, fallback) {
    const candidates = [observation.muteVolume, remembered, fallback];
    for (const candidate of candidates) {
        if (candidate !== undefined && candidate > settings_1.VOLUME_MIN && candidate <= settings_1.VOLUME_MAX) {
            return candidate;
        }
    }
    return fallback;
}
