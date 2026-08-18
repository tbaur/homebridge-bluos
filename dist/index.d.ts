/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Plugin entry point.
 *
 * The registered platform name must match `config.schema.json` and the
 * `platform` value in the user's `config.json`, or Homebridge silently loads
 * nothing at all.
 */
import type { API } from 'homebridge';
declare const _default: (api: API) => void;
export default _default;
