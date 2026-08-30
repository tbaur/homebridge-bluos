/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A momentary switch that restarts one player.
 *
 * Two departures from how every other accessory here behaves, both deliberate.
 *
 * It is momentary, never stateful. `On` always reads false, turning it on fires
 * the reboot and the tile springs back, and turning it off does nothing. There is
 * no such thing as an un-reboot, so an off has nothing to mean. This is also what
 * makes the switch safe to leave in a house full of scenes: "turn everything off"
 * and a scene that sets switches off both write false, and false does nothing
 * here. A stateful reboot switch would restart the stereo every time someone said
 * goodnight.
 *
 * It stays pressable when the player is unreachable, which breaks the plugin's
 * "unknown is No Response" rule. That rule exists so automations cannot fire
 * against invented *readings*, and this switch reports no reading: false is the
 * state of a button, and a button that has not been pressed is honestly not
 * pressed whether or not the player is answering. Enforcing the rule here would
 * grey out the tile in exactly the situation it is for — a player wedged badly
 * enough to have stopped answering is a player you want to restart.
 *
 * One thing this switch cannot do, which its name implies it can: restart a
 * single zone of a multi-zone chassis. Reboot is served on port 80, and port 80
 * is one server per box, so "Zone One Reboot" on a CI S2 also takes down
 * the other zone. The constructor says so once at startup, naming the rooms,
 * because the alternative is finding out by silencing one.
 */
import type { PlayerObservation, RefreshReason } from '../types';
import { BaseAccessory, type AccessoryInit } from './base-accessory';
/** A restart button for one player. */
export declare class RebootAccessory extends BaseAccessory {
    private readonly service;
    private resetTimer;
    constructor(init: AccessoryInit);
    private writeOn;
    /** Spring the tile back to off, the way a real button returns. */
    private scheduleReset;
    /**
     * Nothing to apply.
     *
     * A button has no reading to refresh. Declared rather than inherited because
     * the base class requires it, and an empty body with a reason is clearer than
     * a subclass that quietly does nothing.
     */
    protected updateFromObservation(_observation: PlayerObservation, _reason: RefreshReason): void;
    /**
     * Stay available even when the player is not answering.
     *
     * See the file header: this is the one accessory that must remain pressable
     * while its player is unreachable, because that is when it is needed.
     */
    protected markUnavailable(): void;
}
