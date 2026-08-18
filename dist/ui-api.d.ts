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
export { BluOSClient } from './api/client';
export { BluOSDiscovery } from './api/discovery';
export { makeGeneratedPlayerId } from './api/identity';
export { DEFAULT_DISCOVERY_TIMEOUT_SEC, DOCUMENTED_BLUOS_PORTS, MAX_DISCOVERY_TIMEOUT_SEC, MIN_DISCOVERY_TIMEOUT_SEC, } from './settings';
export { isProbeableHost, isValidHost } from './utils/validators';
