/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Readers for `/SyncStatus` and `/Volume` responses.
 *
 * `/Status` is intentionally never requested. API v1.7 section 2 says
 * "/SyncStatus should be polled if only the name, volume and grouping status of
 * a player is of interest", which is precisely this plugin's scope, and for a
 * group secondary `/Status` reports the *group's* volume while `/SyncStatus`
 * reports that player's own. Polling only `/SyncStatus` is therefore both
 * cheaper and more correct here.
 */
import type { PlayerObservation } from '../types';
/**
 * Parse a `/SyncStatus` response.
 *
 * @param endpoint canonical `host:port` this response came from. Used, alongside
 * the response's own `id`, to tell a self-referential `<master>` apart from a
 * real group leader.
 */
export declare function parseSyncStatus(body: string, endpoint: string): PlayerObservation;
/** A parsed `/Volume` response. */
export interface VolumeResult {
    /** Level 0..100, or undefined when the player reports fixed volume. */
    level?: number;
    fixedVolume: boolean;
    muted: boolean;
    /** Pre-mute level, present only while muted. */
    muteVolume?: number;
    db?: number;
}
/**
 * Parse a `/Volume` response.
 *
 * The level is the element's text content rather than an attribute:
 * `<volume db="-39.8" mute="0" ...>35</volume>`.
 */
export declare function parseVolume(body: string): VolumeResult;
/**
 * The level to restore when a muted or zeroed player is switched back on.
 *
 * `muteVolume` is preferred because the player itself remembers the pre-mute
 * level, which makes an unmute lossless without any state of our own. The
 * remembered level is only a fallback for the other way of reaching silence,
 * writing `level=0`, which the player cannot undo for us.
 */
export declare function restoreLevelFrom(observation: Pick<PlayerObservation, 'muteVolume'>, remembered: number | undefined, fallback: number): number;
