/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The two module boundaries a user never sees but every install depends on: the
 * name the platform is registered under, and the surface the configuration UI is
 * allowed to reach. A mistake in the first makes Homebridge load nothing at all,
 * with no error to explain it; a gap in the second breaks the settings page,
 * which runs in another process and is not typechecked against this code.
 */

import type { API } from 'homebridge'

import { isValidPlayerId, makeGeneratedPlayerId } from '../../src/api/identity'
import register from '../../src/index'
import { BluOSPlatform } from '../../src/platform'
import { DEFAULT_BLUOS_PORT, PLATFORM_NAME, PLUGIN_NAME } from '../../src/settings'
import { isValidHost } from '../../src/utils/validators'
import * as uiApi from '../../src/ui-api'

describe('the plugin entry point', () => {
  it('registers the platform under the name the config schema uses', () => {
    const registerPlatform = jest.fn()

    register({ registerPlatform } as unknown as API)

    expect(registerPlatform).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, BluOSPlatform)
  })

  it('matches the name in the config schema', () => {
    const schema = require('../../config.schema.json') as {
      pluginAlias: string
      pluginType: string
    }

    expect(schema.pluginAlias).toBe(PLATFORM_NAME)
    expect(schema.pluginType).toBe('platform')
  })

  it('constrains a player id and host in the form exactly as the code does', () => {
    // The form is the only thing standing between a typo and a device the plugin
    // silently skips, so its patterns have to be the code's patterns.
    const schema = require('../../config.schema.json') as {
      schema: {
        properties: {
          devices: {
            items: { properties: Record<string, { pattern?: string }> }
          }
        }
      }
    }
    const device = schema.schema.properties.devices.items.properties

    for (const [field, accept, reject] of [
      ['id', '90:56:82:0A:00:02:11010', '../../etc/passwd'],
      ['host', '192.168.4.11', 'not a host'],
    ] as const) {
      const pattern = device[field]?.pattern
      expect(pattern).toEqual(expect.any(String))
      const form = new RegExp(pattern as string)
      expect(form.test(accept)).toBe(true)
      expect(form.test(reject)).toBe(false)
      const code = field === 'id' ? isValidPlayerId : isValidHost
      expect(code(accept)).toBe(true)
      expect(code(reject)).toBe(false)
    }
  })
})

describe('the surface offered to the configuration UI', () => {
  it('exports everything the UI server reaches for', () => {
    // Kept in step with `homebridge-ui/server.js`, which resolves these names at
    // runtime from `dist/` and would fail in the browser, not in CI.
    expect(Object.keys(uiApi).sort()).toEqual([
      'BluOSClient',
      'BluOSDiscovery',
      'DEFAULT_DISCOVERY_TIMEOUT_SEC',
      'DOCUMENTED_BLUOS_PORTS',
      'MAX_DISCOVERY_TIMEOUT_SEC',
      'MIN_DISCOVERY_TIMEOUT_SEC',
      'isProbeableHost',
      'isValidHost',
      'makeGeneratedPlayerId',
    ])
  })

  it('offers ports the UI can probe, in the documented order', () => {
    expect(uiApi.DOCUMENTED_BLUOS_PORTS[0]).toBe(DEFAULT_BLUOS_PORT)
    expect(uiApi.DOCUMENTED_BLUOS_PORTS.length).toBeGreaterThan(1)
  })

  it('offers the discovery bounds the UI clamps a request to', () => {
    expect(uiApi.MIN_DISCOVERY_TIMEOUT_SEC).toBeLessThanOrEqual(uiApi.DEFAULT_DISCOVERY_TIMEOUT_SEC)
    expect(uiApi.DEFAULT_DISCOVERY_TIMEOUT_SEC).toBeLessThanOrEqual(uiApi.MAX_DISCOVERY_TIMEOUT_SEC)
  })

  it('generates an identity the platform will accept', () => {
    expect(isValidPlayerId(makeGeneratedPlayerId())).toBe(true)
  })
})
