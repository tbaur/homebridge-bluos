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
/** A parsed element. Immutable by contract; callers only read. */
export interface XmlElement {
    name: string;
    attributes: Readonly<Record<string, string>>;
    children: readonly XmlElement[];
    /** Concatenated direct text content, trimmed. */
    text: string;
}
/** Overridable limits, so tests can exercise the guards cheaply. */
export interface XmlLimits {
    maxBytes: number;
    maxDepth: number;
    maxElements: number;
    maxAttributes: number;
}
/**
 * Parse a BluOS XML response.
 *
 * @throws ProtocolError when the input breaks a limit, declares a document type
 * or entity, or is not well-formed enough to read.
 */
export declare function parseXml(input: string | Buffer, overrides?: Partial<XmlLimits>): XmlElement;
/** Read an attribute, or undefined when absent or empty after trimming. */
export declare function attr(element: XmlElement | undefined, name: string): string | undefined;
/** First direct child with the given name. */
export declare function child(element: XmlElement | undefined, name: string): XmlElement | undefined;
/** All direct children with the given name. */
export declare function children(element: XmlElement | undefined, name: string): readonly XmlElement[];
/** Text of the first direct child with the given name, when non-empty. */
export declare function childText(element: XmlElement | undefined, name: string): string | undefined;
/**
 * Read a value that BluOS may report either as a root attribute or as a child
 * element, preferring the attribute.
 *
 * `/SyncStatus` puts `syncStat` on the root while `/Status` makes it a child,
 * and firmware versions differ on others, so callers should not have to care.
 */
export declare function attrOrChildText(element: XmlElement | undefined, name: string): string | undefined;
/** Parse an integer attribute, returning undefined when absent or unparseable. */
export declare function intAttr(element: XmlElement | undefined, name: string): number | undefined;
/** Parse a decimal attribute, returning undefined when absent or unparseable. */
export declare function floatAttr(element: XmlElement | undefined, name: string): number | undefined;
/**
 * Interpret a BluOS boolean.
 *
 * The API is inconsistent: `mute` is `0`/`1`, `initialized` and `charging` are
 * `true`/`false`. Absent means false throughout, so callers that need to tell
 * "absent" apart from "false" must check the attribute themselves — mute in
 * `/SyncStatus` being the case that matters, since it is never present there.
 */
export declare function boolAttr(element: XmlElement | undefined, name: string): boolean;
