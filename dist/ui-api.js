"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The surface the configuration UI server is allowed to use.
 *
 * An explicit contract rather than a barrel. The UI runs in a separate process
 * and is the one consumer outside the plugin itself, so pinning what it may
 * reach means its dependencies are visible here instead of being discovered by
 * breaking it. In particular the identity helpers are shared rather than
 * reimplemented: the ids the UI writes into configuration have to match what the
 * platform derives, and two implementations would eventually disagree.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidHost = exports.isProbeableHost = exports.MIN_DISCOVERY_TIMEOUT_SEC = exports.MAX_DISCOVERY_TIMEOUT_SEC = exports.DOCUMENTED_BLUOS_PORTS = exports.DEFAULT_DISCOVERY_TIMEOUT_SEC = exports.makeGeneratedPlayerId = exports.BluOSDiscovery = exports.BluOSClient = void 0;
var client_1 = require("./api/client");
Object.defineProperty(exports, "BluOSClient", { enumerable: true, get: function () { return client_1.BluOSClient; } });
var discovery_1 = require("./api/discovery");
Object.defineProperty(exports, "BluOSDiscovery", { enumerable: true, get: function () { return discovery_1.BluOSDiscovery; } });
var identity_1 = require("./api/identity");
Object.defineProperty(exports, "makeGeneratedPlayerId", { enumerable: true, get: function () { return identity_1.makeGeneratedPlayerId; } });
var settings_1 = require("./settings");
Object.defineProperty(exports, "DEFAULT_DISCOVERY_TIMEOUT_SEC", { enumerable: true, get: function () { return settings_1.DEFAULT_DISCOVERY_TIMEOUT_SEC; } });
Object.defineProperty(exports, "DOCUMENTED_BLUOS_PORTS", { enumerable: true, get: function () { return settings_1.DOCUMENTED_BLUOS_PORTS; } });
Object.defineProperty(exports, "MAX_DISCOVERY_TIMEOUT_SEC", { enumerable: true, get: function () { return settings_1.MAX_DISCOVERY_TIMEOUT_SEC; } });
Object.defineProperty(exports, "MIN_DISCOVERY_TIMEOUT_SEC", { enumerable: true, get: function () { return settings_1.MIN_DISCOVERY_TIMEOUT_SEC; } });
var validators_1 = require("./utils/validators");
Object.defineProperty(exports, "isProbeableHost", { enumerable: true, get: function () { return validators_1.isProbeableHost; } });
Object.defineProperty(exports, "isValidHost", { enumerable: true, get: function () { return validators_1.isValidHost; } });
