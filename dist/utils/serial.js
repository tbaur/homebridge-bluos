"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opaque HomeKit serial numbers.
 *
 * The player's MAC address is the obvious candidate and the wrong one. HomeKit
 * shows SerialNumber in the Home app and it ends up in screenshots and bug
 * reports, and a MAC is both identifying and, on a multi-zone chassis, shared
 * between zones. A random value generated once and persisted in accessory
 * context is stable across restarts without disclosing anything.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.newAccessorySerialNumber = newAccessorySerialNumber;
exports.ensureAccessorySerialNumber = ensureAccessorySerialNumber;
const node_crypto_1 = require("node:crypto");
/** Generate a fresh opaque serial number. */
function newAccessorySerialNumber() {
    return (0, node_crypto_1.randomUUID)();
}
/**
 * Return this accessory's serial number, generating and persisting one if the
 * cached accessory predates the field.
 */
function ensureAccessorySerialNumber(accessory) {
    const context = accessory.context;
    const existing = context.serialNumber;
    if (typeof existing === 'string' && existing.length > 0) {
        return existing;
    }
    const generated = newAccessorySerialNumber();
    context.serialNumber = generated;
    return generated;
}
