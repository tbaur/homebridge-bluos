/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import {
  attr,
  attrOrChildText,
  boolAttr,
  child,
  childText,
  children,
  floatAttr,
  intAttr,
  parseXml,
} from '../../src/api/xml'
import { ProtocolError } from '../../src/utils/errors'
import { SYNC_STATUS_BATTERY, SYNC_STATUS_C658 } from '../fixtures/responses'

describe('parseXml', () => {
  it('reads root attributes and nested children from a real response', () => {
    const root = parseXml(SYNC_STATUS_BATTERY)

    expect(root.name).toBe('SyncStatus')
    expect(attr(root, 'name')).toBe('Portable Speaker')
    expect(attr(root, 'modelName')).toBe('PULSE FLEX 2i')
    expect(intAttr(root, 'volume')).toBe(26)
    expect(floatAttr(root, 'db')).toBe(-40.5)

    const battery = child(root, 'battery')
    expect(intAttr(battery, 'level')).toBe(91)
    expect(boolAttr(battery, 'charging')).toBe(false)

    const options = children(child(root, 'zoneOptions'), 'option')
    expect(options.map((option) => option.text)).toEqual([
      'left',
      'right',
      'side_left',
      'side_right',
    ])
  })

  it('handles empty paired elements without treating them as text', () => {
    const root = parseXml(SYNC_STATUS_C658)

    expect(child(root, 'bluetoothOutput')?.text).toBe('')
    expect(children(root, 'slave')).toHaveLength(0)
  })

  it('handles self-closing elements and attribute values containing angle brackets', () => {
    const root = parseXml('<r a="1&gt;2"><c b=\'x\'/><c b="y"/></r>')

    expect(attr(root, 'a')).toBe('1>2')
    expect(children(root, 'c').map((node) => attr(node, 'b'))).toEqual(['x', 'y'])
  })

  it('decodes the predefined entities and numeric references', () => {
    const root = parseXml('<r><t>Rock &amp; Roll &lt;3 &#65;&#x42;</t></r>')

    expect(childText(root, 't')).toBe('Rock & Roll <3 AB')
  })

  it('leaves unknown entities verbatim rather than resolving them', () => {
    // A bare ampersand in a track title is far likelier than a real entity.
    const root = parseXml('<r><t>Simon &weird; Garfunkel</t></r>')

    expect(childText(root, 't')).toBe('Simon &weird; Garfunkel')
  })

  it('does not decode entities inside CDATA', () => {
    const root = parseXml('<r><t><![CDATA[a &amp; b]]></t></r>')

    expect(childText(root, 't')).toBe('a &amp; b')
  })

  it('skips comments and processing instructions', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><r a="1"/>')

    expect(attr(root, 'a')).toBe('1')
  })

  it('prefers an attribute over a like-named child element', () => {
    const withAttribute = parseXml('<r syncStat="7"><syncStat>9</syncStat></r>')
    const withChildOnly = parseXml('<r><syncStat>9</syncStat></r>')

    expect(attrOrChildText(withAttribute, 'syncStat')).toBe('7')
    expect(attrOrChildText(withChildOnly, 'syncStat')).toBe('9')
  })

  it('treats an absent boolean as false', () => {
    const root = parseXml('<r/>')

    // `/SyncStatus` never sends `mute`, so absence has to mean false here;
    // telling mute apart from silence is `readMuted`'s job, not this helper's.
    expect(boolAttr(root, 'mute')).toBe(false)
  })

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['0', false],
    ['false', false],
    ['', false],
  ])('reads boolean %s as %s', (value, expected) => {
    expect(boolAttr(parseXml(`<r m="${value}"/>`), 'm')).toBe(expected)
  })

  describe('hardening', () => {
    it('rejects a document type declaration', () => {
      // The XXE and entity-expansion defence: refused before any parsing.
      expect(() => parseXml('<!DOCTYPE r [<!ENTITY x "y">]><r/>')).toThrow(ProtocolError)
    })

    it('rejects an entity declaration even without a DOCTYPE', () => {
      expect(() => parseXml('<!ENTITY x "y"><r/>')).toThrow(/entity declarations/)
    })

    it('rejects a body over the byte cap', () => {
      expect(() => parseXml('<r/>', { maxBytes: 3 })).toThrow(/exceeds 3/)
    })

    it('rejects nesting past the depth cap', () => {
      expect(() => parseXml('<a><b><c><d/></c></b></a>', { maxDepth: 2 })).toThrow(/deeper than 2/)
    })

    it('rejects a document past the element cap', () => {
      expect(() => parseXml('<a><b/><c/><d/></a>', { maxElements: 3 })).toThrow(/more than 3/)
    })

    it('rejects an element past the attribute cap', () => {
      expect(() => parseXml('<a x="1" y="2" z="3"/>', { maxAttributes: 2 })).toThrow(/attributes/)
    })

    it('counts valueless attributes towards the cap', () => {
      // These are tolerated as empty rather than rejected, so they used to reach
      // the "treat it as empty" branch before the limit was consulted: a body of
      // bare names could then build an object of any size, once per poll, forever.
      const bare = Array.from({ length: 500 }, (_unused, index) => `a${index}`).join(' ')

      expect(() => parseXml(`<a ${bare}/>`, { maxAttributes: 64 })).toThrow(/exceeds 64/)
      expect(() => parseXml('<a x y z/>', { maxAttributes: 2 })).toThrow(/attributes/)
      expect(attr(parseXml('<a x y="1"/>'), 'x')).toBeUndefined()
    })

    it('does not resolve inherited object properties as entities', () => {
      // A plain object literal would make `&constructor;` resolve through
      // Object.prototype, substituting engine internals into a value that reaches
      // HomeKit and the accessory cache.
      for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
        expect(childText(parseXml(`<r><t>&${name};</t></r>`), 't')).toBe(`&${name};`)
      }
    })

    it('keeps a __proto__ attribute as an ordinary key', () => {
      const root = parseXml('<r __proto__="polluted" a="1"/>')

      expect(attr(root, '__proto__')).toBe('polluted')
      expect(attr(root, 'a')).toBe('1')
      expect(({} as Record<string, unknown>).a).toBeUndefined()
    })

    it('caps a numeric reference to a valid Unicode scalar', () => {
      // Out of range and lone surrogates stay literal instead of corrupting output.
      expect(childText(parseXml('<r><t>&#1114112;</t></r>'), 't')).toBe('&#1114112;')
      expect(childText(parseXml('<r><t>&#xD800;</t></r>'), 't')).toBe('&#xD800;')
    })
  })

  describe('malformed input', () => {
    it.each([
      ['empty', '   '],
      ['no root', '<!-- only a comment -->'],
      ['unclosed element', '<a><b></a>'],
      ['stray close', '<a/></b>'],
      ['two roots', '<a/><b/>'],
      ['unterminated tag', '<a'],
      ['unterminated comment', '<a><!-- x</a>'],
      ['unquoted attribute', '<a b=1/>'],
      ['unterminated attribute', '<a b="1/>'],
    ])('rejects %s', (_label, input) => {
      expect(() => parseXml(input)).toThrow(ProtocolError)
    })
  })

  it('accepts a Buffer as well as a string', () => {
    expect(attr(parseXml(Buffer.from('<r a="1"/>', 'utf8')), 'a')).toBe('1')
  })

  it('returns undefined for absent or blank attributes', () => {
    const root = parseXml('<r a="  "/>')

    expect(attr(root, 'a')).toBeUndefined()
    expect(attr(root, 'missing')).toBeUndefined()
    expect(intAttr(root, 'missing')).toBeUndefined()
    expect(floatAttr(root, 'missing')).toBeUndefined()
    expect(intAttr(parseXml('<r a="abc"/>'), 'a')).toBeUndefined()
    expect(childText(root, 'missing')).toBeUndefined()
    expect(attr(undefined, 'a')).toBeUndefined()
    expect(child(undefined, 'a')).toBeUndefined()
    expect(children(undefined, 'a')).toEqual([])
  })
})
