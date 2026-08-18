"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A deliberately small XML reader for BluOS responses.
 *
 * BluOS answers with flat documents: attributes on the root element plus a
 * handful of shallow children. A general-purpose parser would be a new
 * dependency and a much larger attack surface for input that arrives unattested
 * over the LAN, so this reads exactly the subset the API uses and refuses
 * everything else.
 *
 * Hardening, in order of importance:
 *
 * - Document type declarations and entity declarations are rejected outright.
 *   No `DOCTYPE` means no external entities (XXE) and no recursive entity
 *   expansion (the "billion laughs" denial of service).
 * - Only the five predefined entities and numeric character references are
 *   decoded, and numeric references are bounded to valid Unicode scalars.
 * - Byte length, nesting depth, element count and per-element attribute count
 *   are all capped, so a malfunctioning or hostile endpoint cannot exhaust
 *   memory.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseXml = parseXml;
exports.attr = attr;
exports.child = child;
exports.children = children;
exports.childText = childText;
exports.attrOrChildText = attrOrChildText;
exports.intAttr = intAttr;
exports.floatAttr = floatAttr;
exports.boolAttr = boolAttr;
const settings_1 = require("../settings");
const errors_1 = require("../utils/errors");
const DEFAULT_LIMITS = {
    maxBytes: settings_1.MAX_XML_BYTES,
    maxDepth: settings_1.MAX_XML_DEPTH,
    maxElements: settings_1.MAX_XML_ELEMENTS,
    maxAttributes: settings_1.MAX_XML_ATTRIBUTES,
};
const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.-]/;
const WHITESPACE = /\s/;
/**
 * Null-prototyped on purpose. A plain object literal inherits from
 * `Object.prototype`, so `&constructor;` and `&toString;` would resolve to
 * engine internals and be substituted into attribute values — which reach
 * HomeKit's Manufacturer and Model characteristics and the accessory cache.
 */
const NAMED_ENTITIES = Object.assign(Object.create(null), {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: '\'',
});
/**
 * Decode the entity subset XML predefines, plus numeric character references.
 *
 * Anything else is left verbatim rather than resolved: an unrecognised entity
 * in a BluOS response is far more likely to be a literal ampersand in a track
 * title than a reference we are supposed to expand.
 */
function decodeEntities(raw) {
    if (!raw.includes('&')) {
        return raw;
    }
    return raw.replace(/&(#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body) => {
        if (body.startsWith('#')) {
            const isHex = body[1] === 'x' || body[1] === 'X';
            const digits = isHex ? body.slice(2) : body.slice(1);
            const code = Number.parseInt(digits, isHex ? 16 : 10);
            if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
                return match;
            }
            // Lone surrogates are not valid scalar values and would corrupt the string.
            if (code >= 0xd800 && code <= 0xdfff) {
                return match;
            }
            try {
                return String.fromCodePoint(code);
            }
            catch {
                return match;
            }
        }
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
            ? NAMED_ENTITIES[body] ?? match
            : match;
    });
}
/** Find the end of a tag, ignoring `>` inside quoted attribute values. */
function findTagEnd(input, from) {
    let quote;
    for (let i = from; i < input.length; i += 1) {
        const char = input[i];
        if (quote !== undefined) {
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === '\'') {
            quote = char;
            continue;
        }
        if (char === '>') {
            return i;
        }
    }
    return -1;
}
function readName(input, from) {
    const first = input[from];
    if (first === undefined || !NAME_START.test(first)) {
        throw new errors_1.ProtocolError('malformed XML: expected an element name');
    }
    let i = from + 1;
    while (i < input.length) {
        const char = input[i];
        if (char === undefined || !NAME_CHAR.test(char)) {
            break;
        }
        i += 1;
    }
    return { name: input.slice(from, i), next: i };
}
function parseAttributes(source, elementName, limits) {
    // Null-prototyped for the same reason as NAMED_ENTITIES: an attribute named
    // `__proto__` or `constructor` must be a plain key, not a write or a read
    // through the prototype chain.
    const attributes = Object.create(null);
    let count = 0;
    let i = 0;
    while (i < source.length) {
        const char = source[i];
        if (char === undefined || WHITESPACE.test(char)) {
            i += 1;
            continue;
        }
        if (!NAME_START.test(char)) {
            throw new errors_1.ProtocolError(`malformed XML: bad attribute on <${elementName}>`);
        }
        const { name, next } = readName(source, i);
        i = next;
        // Counted here rather than per branch below: a valueless attribute used to
        // skip the limit check, so a body of thousands of bare names could build an
        // object far larger than maxAttributes allows.
        count += 1;
        if (count > limits.maxAttributes) {
            throw new errors_1.ProtocolError(`XML rejected: <${elementName}> exceeds ${limits.maxAttributes} attributes`);
        }
        while (i < source.length && WHITESPACE.test(source[i] ?? '')) {
            i += 1;
        }
        if (source[i] !== '=') {
            // A valueless attribute is not well-formed XML; treat it as empty rather
            // than failing the whole response over a cosmetic defect.
            attributes[name] = '';
            continue;
        }
        i += 1;
        while (i < source.length && WHITESPACE.test(source[i] ?? '')) {
            i += 1;
        }
        const quote = source[i];
        if (quote !== '"' && quote !== '\'') {
            throw new errors_1.ProtocolError(`malformed XML: unquoted attribute "${name}" on <${elementName}>`);
        }
        const close = source.indexOf(quote, i + 1);
        if (close === -1) {
            throw new errors_1.ProtocolError(`malformed XML: unterminated attribute "${name}" on <${elementName}>`);
        }
        attributes[name] = decodeEntities(source.slice(i + 1, close));
        i = close + 1;
    }
    return attributes;
}
/**
 * Parse a BluOS XML response.
 *
 * @throws ProtocolError when the input breaks a limit, declares a document type
 * or entity, or is not well-formed enough to read.
 */
function parseXml(input, overrides = {}) {
    const limits = { ...DEFAULT_LIMITS, ...overrides };
    const byteLength = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.length;
    if (byteLength > limits.maxBytes) {
        throw new errors_1.ProtocolError(`XML rejected: ${byteLength} bytes exceeds ${limits.maxBytes}`);
    }
    const text = typeof input === 'string' ? input : input.toString('utf8');
    if (text.trim().length === 0) {
        throw new errors_1.ProtocolError('XML rejected: empty response');
    }
    // Checked before any parsing: refusing the declaration outright is what makes
    // external-entity and entity-expansion attacks structurally impossible here.
    if (/<!\s*(DOCTYPE|ENTITY)/i.test(text)) {
        throw new errors_1.ProtocolError('XML rejected: document type and entity declarations are not accepted');
    }
    const stack = [];
    let root;
    let elementCount = 0;
    let i = 0;
    while (i < text.length) {
        const lt = text.indexOf('<', i);
        if (lt === -1) {
            break;
        }
        const parent = stack[stack.length - 1];
        if (parent !== undefined && lt > i) {
            parent.text += decodeEntities(text.slice(i, lt));
        }
        if (text.startsWith('<!--', lt)) {
            const end = text.indexOf('-->', lt + 4);
            if (end === -1) {
                throw new errors_1.ProtocolError('malformed XML: unterminated comment');
            }
            i = end + 3;
            continue;
        }
        if (text.startsWith('<![CDATA[', lt)) {
            const end = text.indexOf(']]>', lt + 9);
            if (end === -1) {
                throw new errors_1.ProtocolError('malformed XML: unterminated CDATA section');
            }
            if (parent !== undefined) {
                // CDATA content is literal by definition, so it is not entity-decoded.
                parent.text += text.slice(lt + 9, end);
            }
            i = end + 3;
            continue;
        }
        if (text.startsWith('<?', lt)) {
            const end = text.indexOf('?>', lt + 2);
            if (end === -1) {
                throw new errors_1.ProtocolError('malformed XML: unterminated processing instruction');
            }
            i = end + 2;
            continue;
        }
        const tagEnd = findTagEnd(text, lt + 1);
        if (tagEnd === -1) {
            throw new errors_1.ProtocolError('malformed XML: unterminated tag');
        }
        if (text[lt + 1] === '/') {
            const { name } = readName(text, lt + 2);
            const open = stack.pop();
            if (open === undefined) {
                throw new errors_1.ProtocolError(`malformed XML: unexpected </${name}>`);
            }
            if (open.name !== name) {
                throw new errors_1.ProtocolError(`malformed XML: </${name}> closes <${open.name}>`);
            }
            open.text = open.text.trim();
            i = tagEnd + 1;
            continue;
        }
        const { name, next } = readName(text, lt + 1);
        let inner = text.slice(next, tagEnd);
        let selfClosing = false;
        if (inner.endsWith('/')) {
            selfClosing = true;
            inner = inner.slice(0, -1);
        }
        elementCount += 1;
        if (elementCount > limits.maxElements) {
            throw new errors_1.ProtocolError(`XML rejected: more than ${limits.maxElements} elements`);
        }
        const element = {
            name,
            attributes: parseAttributes(inner, name, limits),
            children: [],
            text: '',
        };
        if (parent === undefined) {
            if (root !== undefined) {
                throw new errors_1.ProtocolError('malformed XML: more than one root element');
            }
            root = element;
        }
        else {
            parent.children.push(element);
        }
        if (!selfClosing) {
            stack.push(element);
            if (stack.length > limits.maxDepth) {
                throw new errors_1.ProtocolError(`XML rejected: nesting deeper than ${limits.maxDepth}`);
            }
        }
        i = tagEnd + 1;
    }
    if (stack.length > 0) {
        throw new errors_1.ProtocolError(`malformed XML: <${stack[stack.length - 1]?.name}> is never closed`);
    }
    if (root === undefined) {
        throw new errors_1.ProtocolError('malformed XML: no root element');
    }
    return root;
}
/** Read an attribute, or undefined when absent or empty after trimming. */
function attr(element, name) {
    const raw = element?.attributes[name];
    if (raw === undefined) {
        return undefined;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
/** First direct child with the given name. */
function child(element, name) {
    return element?.children.find((candidate) => candidate.name === name);
}
/** All direct children with the given name. */
function children(element, name) {
    return element?.children.filter((candidate) => candidate.name === name) ?? [];
}
/** Text of the first direct child with the given name, when non-empty. */
function childText(element, name) {
    const found = child(element, name)?.text.trim();
    return found !== undefined && found.length > 0 ? found : undefined;
}
/**
 * Read a value that BluOS may report either as a root attribute or as a child
 * element, preferring the attribute.
 *
 * `/SyncStatus` puts `syncStat` on the root while `/Status` makes it a child,
 * and firmware versions differ on others, so callers should not have to care.
 */
function attrOrChildText(element, name) {
    return attr(element, name) ?? childText(element, name);
}
/** Parse an integer attribute, returning undefined when absent or unparseable. */
function intAttr(element, name) {
    const raw = attr(element, name);
    if (raw === undefined) {
        return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) ? value : undefined;
}
/** Parse a decimal attribute, returning undefined when absent or unparseable. */
function floatAttr(element, name) {
    const raw = attr(element, name);
    if (raw === undefined) {
        return undefined;
    }
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : undefined;
}
/**
 * Interpret a BluOS boolean.
 *
 * The API is inconsistent: `mute` is `0`/`1`, `initialized` and `charging` are
 * `true`/`false`. Absent means false throughout, so callers that need to tell
 * "absent" apart from "false" must check the attribute themselves — mute in
 * `/SyncStatus` being the case that matters, since it is never present there.
 */
function boolAttr(element, name) {
    const raw = attr(element, name)?.toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}
