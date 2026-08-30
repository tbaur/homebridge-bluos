"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Validation of the data cached on a restored accessory.
 *
 * Homebridge hands back whatever was persisted when the plugin last ran, which
 * may have been written by an older version with a different shape. Reading it
 * through one checked path means a stale or hand-edited cache produces a clear
 * error for that one accessory instead of an undefined field surfacing much
 * later as a wrong characteristic value.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAccessoryContext = parseAccessoryContext;
const settings_1 = require("../settings");
const types_1 = require("../types");
const errors_1 = require("./errors");
const validators_1 = require("./validators");
/** Read and validate a restored accessory's context. */
function parseAccessoryContext(accessory) {
    const raw = (accessory.context ?? {});
    if (!(0, types_1.isAccessoryKind)(raw.kind)) {
        throw new errors_1.ConfigValidationError(`cached accessory ${(0, validators_1.forLog)(accessory.displayName)} has an unknown kind ${(0, validators_1.forLog)(raw.kind)}`);
    }
    if (typeof raw.deviceId !== 'string' || raw.deviceId.length === 0) {
        throw new errors_1.ConfigValidationError(`cached accessory ${(0, validators_1.forLog)(accessory.displayName)} has no device id`);
    }
    if (typeof raw.serialNumber !== 'string' || raw.serialNumber.length === 0) {
        throw new errors_1.ConfigValidationError(`cached accessory ${(0, validators_1.forLog)(accessory.displayName)} has no serial number`);
    }
    if (raw.kind === 'volumePreset' && !Number.isInteger(raw.volume)) {
        throw new errors_1.ConfigValidationError(`cached preset ${(0, validators_1.forLog)(accessory.displayName)} has no target volume`);
    }
    const sliderService = (0, types_1.isSliderService)(raw.sliderService) ? raw.sliderService : 'fan';
    const context = {
        kind: raw.kind,
        deviceId: raw.deviceId,
        host: typeof raw.host === 'string' ? raw.host : '',
        port: Number.isInteger(raw.port) ? raw.port : settings_1.DEFAULT_BLUOS_PORT,
        brand: typeof raw.brand === 'string' && raw.brand.length > 0 ? raw.brand : settings_1.DEFAULT_BRAND,
        model: typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : settings_1.DEFAULT_MODEL,
        serialNumber: raw.serialNumber,
        adoptedLegacyUuid: raw.adoptedLegacyUuid === true,
        sliderService,
    };
    if (Number.isInteger(raw.volume)) {
        context.volume = raw.volume;
    }
    if (Number.isInteger(raw.lastNonZeroVolume)) {
        context.lastNonZeroVolume = raw.lastNonZeroVolume;
    }
    if (raw.hostsBattery === true) {
        context.hostsBattery = true;
    }
    return context;
}
