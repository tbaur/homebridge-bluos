/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The Homebridge verification checker (`homebridge/plugins` `/check`) installs
 * the published package and fails the run if `config.schema.json` is not valid
 * draft-07, or if package.json is missing the fields that page lists. These
 * tests are that contract, so a local `npm test` catches the same mistakes.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface SchemaNode {
  required?: unknown
  properties?: Record<string, SchemaNode>
  items?: SchemaNode | SchemaNode[]
  oneOf?: SchemaNode[]
  anyOf?: SchemaNode[]
  allOf?: SchemaNode[]
}

interface ConfigSchema {
  pluginAlias: string
  pluginType: string
  schema: SchemaNode & { properties: Record<string, SchemaNode> }
}

interface PackageManifest {
  homepage?: string
  bugs?: { url?: string }
  keywords?: string[]
  scripts?: Record<string, string>
  engines?: { node?: string; homebridge?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, unknown>
  bundledDependencies?: string[]
  bundleDependencies?: string[]
}

function collectRequiredValues(node: SchemaNode | undefined, found: unknown[]): void {
  if (!node || typeof node !== 'object') {
    return
  }
  if ('required' in node) {
    found.push(node.required)
  }
  if (node.properties) {
    for (const child of Object.values(node.properties)) {
      collectRequiredValues(child, found)
    }
  }
  if (Array.isArray(node.items)) {
    for (const item of node.items) {
      collectRequiredValues(item, found)
    }
  } else {
    collectRequiredValues(node.items, found)
  }
  for (const branch of [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])]) {
    collectRequiredValues(branch, found)
  }
}

function loadSchema(): ConfigSchema {
  const raw = readFileSync(resolve(__dirname, '../../config.schema.json'), 'utf8')
  return JSON.parse(raw) as ConfigSchema
}

function loadPackage(): PackageManifest {
  const raw = readFileSync(resolve(__dirname, '../../package.json'), 'utf8')
  return JSON.parse(raw) as PackageManifest
}

describe('config.schema.json (Homebridge verification CI)', () => {
  const schema = loadSchema()

  it('declares the platform alias the plugin registers under', () => {
    expect(schema.pluginAlias).toBe('BluOS')
    expect(schema.pluginType).toBe('platform')
  })

  it('declares a name property so the settings UI and Homebridge 2.x have one', () => {
    expect(schema.schema.properties.name).toEqual(expect.any(Object))
  })

  it('never declares `required` as a boolean (invalid draft-07; AJV will not compile)', () => {
    const requiredValues: unknown[] = []
    collectRequiredValues(schema.schema, requiredValues)
    expect(requiredValues.length).toBeGreaterThan(0)
    for (const value of requiredValues) {
      expect(Array.isArray(value)).toBe(true)
    }
  })

  it('requires the platform name at the object level', () => {
    expect(schema.schema.required).toEqual(['name'])
  })

  it('does not require devices at the platform level (platform-only config must still start)', () => {
    expect(schema.schema.required).not.toEqual(expect.arrayContaining(['devices']))
  })

  it('requires the fields a saved player cannot be missing', () => {
    expect(schema.schema.properties.devices?.items).toEqual(
      expect.objectContaining({ required: ['id', 'name', 'host'] }),
    )
  })

  it('requires the fields a saved volume preset cannot be missing', () => {
    const deviceItems = schema.schema.properties.devices?.items
    const items = Array.isArray(deviceItems) ? deviceItems[0] : deviceItems
    expect(items?.properties?.volumePresets?.items).toEqual(
      expect.objectContaining({ required: ['name', 'volume'] }),
    )
  })
})

describe('package.json (Homebridge verification CI)', () => {
  const manifest = loadPackage()

  it('has an https homepage', () => {
    expect(manifest.homepage).toEqual(expect.stringMatching(/^https:\/\//))
  })

  it('has an https bugs.url the checker can read a GitHub repo from', () => {
    expect(manifest.bugs?.url).toEqual(
      expect.stringMatching(/^https:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/),
    )
  })

  it('declares homebridge-plugin, a transport keyword, and at least one more keyword', () => {
    const keywords = manifest.keywords ?? []
    expect(keywords).toContain('homebridge-plugin')
    expect(keywords.some((keyword) => ['supports-hap', 'supports-matter'].includes(keyword))).toBe(true)
    expect(keywords.length).toBeGreaterThan(1)
  })

  it('has no install-time scripts that mutate the host', () => {
    for (const script of ['preinstall', 'install', 'postinstall']) {
      expect(manifest.scripts?.[script]).toBeUndefined()
    }
  })

  it('declares engines for Node and Homebridge', () => {
    expect(manifest.engines?.node).toEqual(expect.any(String))
    expect(manifest.engines?.homebridge).toEqual(expect.any(String))
  })

  it('does not declare homebridge or hap-nodejs as a runtime, peer, or bundled dependency', () => {
    const declared = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
      ...manifest.peerDependenciesMeta,
    }
    const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies ?? []
    for (const dep of ['homebridge', 'hap-nodejs']) {
      expect(dep in declared).toBe(false)
      expect(bundled).not.toContain(dep)
    }
  })
})
