/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A momentary switch that restarts every BluOS player it can find.
 *
 * The only accessory here that belongs to the platform rather than to a player.
 * It has no endpoint, no observations and no poller; its device id is the
 * synthetic {@link PLATFORM_DEVICE_ID}, and the platform resolves its targets on
 * each press.
 *
 * Its reach is wider than the plugin's configuration: it restarts every player
 * mDNS answers for, including ones deliberately left out of `devices[]`. That is
 * what it is for, and it is why the option is off by default and why every target
 * is named in the log before a single request goes out. The BluOS API has no
 * authentication, so anything on the segment will comply.
 *
 * It works in addresses rather than players, because reboot is served on port 80
 * and port 80 is one server per chassis. A CI S2 carrying two zones is one
 * target, not two — de-duplicating matters here beyond tidiness, since a second
 * request would land on a box already on its way down.
 *
 * See RebootAccessory for why this is momentary and why it stays pressable when
 * players are unreachable; the same reasoning applies, more so here, since a
 * fleet-wide restart is most useful when several players have stopped answering.
 */
import type { PlayerObservation, RefreshReason } from '../types';
import { BaseAccessory, type AccessoryInit } from './base-accessory';
/** A restart button for the whole network. */
export declare class RebootAllAccessory extends BaseAccessory {
    private readonly service;
    private resetTimer;
    constructor(init: AccessoryInit);
    private writeOn;
    /** Name everything that is about to go down, before any of it does. */
    private announce;
    /**
     * Restart every target, letting each succeed or fail on its own.
     *
     * Concurrent rather than sequential: these are separate boxes, one being
     * unreachable says nothing about the next, and running in series would make a
     * single dead address delay every box behind it by a full timeout.
     * `allSettled` because one failure must not abandon the rest — a fleet-wide
     * restart that stopped at the first missing player would be worse than useless.
     */
    private rebootAll;
    /** Spring the tile back to off, the way a real button returns. */
    private scheduleReset;
    /**
     * Never marked unreachable.
     *
     * Overridden rather than left to the base class because this accessory has no
     * player: the base would log that a player stopped answering and name a device
     * id that is not one. The switch is always usable, since its targets are
     * resolved when it is pressed rather than held here.
     */
    noteUnreachable(error: unknown): void;
    /** Nothing to apply: this accessory is a button, not a reading. */
    protected updateFromObservation(_observation: PlayerObservation, _reason: RefreshReason): void;
    /** Never unavailable. @see noteUnreachable */
    protected markUnavailable(): void;
}
