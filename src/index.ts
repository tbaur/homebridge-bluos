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

import type { API } from 'homebridge'

import { BluOSPlatform } from './platform'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings'

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, BluOSPlatform)
}
