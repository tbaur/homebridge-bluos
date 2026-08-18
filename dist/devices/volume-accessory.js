"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The volume slider.
 *
 * HomeKit has no speaker volume control that the Home app renders, so the slider
 * borrows one. Fanv2 `RotationSpeed` is the default and a Lightbulb's
 * `Brightness` is offered as an alternative; they look identical in the Home app.
 * The default is the fan because "turn off all the lights" and "set the lights to
 * 100%" both sweep up a Lightbulb, and a speaker jumping to full volume because
 * someone addressed the lights is a genuinely bad outcome. Every mature plugin in
 * this space carries the same warning.
 *
 * Mapping to BluOS:
 *
 * - The slider position is the player's 0..100 level. The player converts that to
 *   its own configured dB range, which differs per player and per configuration —
 *   two identical PULSE FLEX 2i units measured 0.7 dB apart at levels 26 and 35 —
 *   so the level is deliberately passed through rather than scaled here.
 * - Off means level zero. A muted player reports `volume="0"`, so an external mute
 *   shows up as Off without this accessory having to know about mute at all.
 * - Any explicit level write unmutes first, because a slider that appears to move
 *   while the player stays silent is indistinguishable from a broken plugin.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VolumeAccessory = void 0;
const sync_status_1 = require("../api/sync-status");
const settings_1 = require("../settings");
const utils_1 = require("../utils");
const base_accessory_1 = require("./base-accessory");
/** A volume slider for one player. */
class VolumeAccessory extends base_accessory_1.BaseAccessory {
    surface;
    /** Last level read from the player. Undefined until the first observation. */
    level;
    /** True when the player reports a fixed output level. */
    fixedVolume = false;
    /** Level awaiting a coalesced write. */
    pendingLevel;
    /** In-flight coalesced write, shared by every handler that queued into it. */
    flush;
    constructor(init) {
        super(init);
        this.surface = this.buildSurface();
        this.bindHandlers();
    }
    buildSurface() {
        const { Characteristic: Char, Service: HapService } = this.host.hap;
        const wantsLightbulb = this.context.sliderService === 'lightbulb';
        // The slider style is deliberately not part of accessory identity, so
        // switching it adopts the same accessory rather than replacing it. Without
        // removing the old service the accessory would carry both, and the Home app
        // would show two controls of which only one is bound to any handler.
        this.dropService(wantsLightbulb ? HapService.Fanv2 : HapService.Lightbulb);
        if (wantsLightbulb) {
            const service = this.requireService(HapService.Lightbulb);
            return {
                service,
                active: service.getCharacteristic(Char.On),
                level: service.getCharacteristic(Char.Brightness),
                toActiveValue: (on) => on,
            };
        }
        const service = this.requireService(HapService.Fanv2);
        return {
            service,
            active: service.getCharacteristic(Char.Active),
            level: service.getCharacteristic(Char.RotationSpeed),
            toActiveValue: (on) => (on ? Char.Active.ACTIVE : Char.Active.INACTIVE),
        };
    }
    bindHandlers() {
        const { Characteristic: Char } = this.host.hap;
        this.surface.service.setCharacteristic(Char.Name, this.displayName);
        // A whole-number step: BluOS levels are integers, and offering finer
        // granularity would only invite rounding surprises.
        this.surface.level.setProps({
            minValue: settings_1.VOLUME_MIN,
            maxValue: settings_1.VOLUME_MAX,
            minStep: 1,
        });
        this.surface.active
            .onGet(() => this.readActive())
            .onSet(async (value) => this.writeActive(value));
        this.surface.level
            .onGet(() => this.readLevel())
            .onSet(async (value) => this.writeLevel(value));
    }
    readActive() {
        this.requireSlider();
        return this.surface.toActiveValue((this.level ?? 0) > settings_1.VOLUME_MIN);
    }
    readLevel() {
        this.requireSlider();
        return this.level ?? settings_1.VOLUME_MIN;
    }
    /**
     * Refuse a read when the value would be a guess.
     *
     * A fixed-output player is treated the same as an unreachable one: there is no
     * level to report and writing one would do nothing, so No Response is the
     * truthful answer rather than a slider that silently ignores input.
     */
    requireSlider() {
        if (this.fixedVolume) {
            throw this.communicationFailure();
        }
        this.requireObservedState();
    }
    async writeActive(value) {
        const { Characteristic: Char } = this.host.hap;
        const on = this.context.sliderService === 'lightbulb'
            ? value === true
            : value === Char.Active.ACTIVE;
        if (!on) {
            await this.queueLevel(settings_1.VOLUME_MIN);
            return;
        }
        const observation = this.host.observationFor(this.deviceId);
        const restore = (0, sync_status_1.restoreLevelFrom)(observation ?? {}, this.context.lastNonZeroVolume, settings_1.DEFAULT_RESTORE_VOLUME);
        await this.queueLevel(restore);
    }
    async writeLevel(value) {
        const requested = typeof value === 'number' ? Math.round(value) : Number.NaN;
        if (!Number.isInteger(requested)) {
            this.host.log.debug(`${(0, utils_1.forLog)(this.displayName)} ignoring non-numeric level ${String(value)}`);
            return;
        }
        await this.queueLevel(Math.min(settings_1.VOLUME_MAX, Math.max(settings_1.VOLUME_MIN, requested)));
    }
    /**
     * Record the intended level and write it once the coalescing window closes.
     *
     * The most recent request wins, which is what makes the `Active` + level pair
     * that HomeKit sends when a slider leaves zero result in a single write.
     */
    async queueLevel(level) {
        this.pendingLevel = level;
        if (this.flush === undefined) {
            this.flush = (0, utils_1.sleep)(settings_1.SLIDER_COALESCE_MS).then(async () => this.applyPendingLevel());
        }
        const flush = this.flush;
        await this.completeWithinBudget('volume write', async () => flush);
    }
    async applyPendingLevel() {
        const level = this.pendingLevel;
        this.pendingLevel = undefined;
        this.flush = undefined;
        if (level === undefined) {
            return;
        }
        if (this.fixedVolume) {
            this.warnOnce('fixed-volume-write', `${(0, utils_1.forLog)(this.displayName)} reports a fixed output level; ignoring the volume write`);
            return;
        }
        const endpoint = this.host.endpointFor(this.deviceId);
        if (endpoint === undefined) {
            throw new Error('player is no longer configured');
        }
        // An explicit level is meaningless while muted, so unmute first. Writing the
        // level alone would leave the slider showing a value the room cannot hear.
        const observation = this.host.observationFor(this.deviceId);
        const scope = this.writeScope();
        if (level > settings_1.VOLUME_MIN && observation?.muted === true) {
            const unmuted = await this.host.client.setMute(endpoint, false, scope);
            this.host.adoptWriteResult(this.deviceId, unmuted);
        }
        // A group write changes the followers too. They are not touched here: each
        // zone runs its own long-poll, so their own etags move and they update within
        // a poll round trip, without this accessory having to know who they are.
        const result = await this.host.client.setVolume(endpoint, level, scope);
        // The player clamps into its own configured range, so its answer is the
        // truth and the requested value is only a request.
        this.host.adoptWriteResult(this.deviceId, result);
        this.logAction(`SET ${result.level ?? level}`, scope);
        if (result.level !== undefined && result.level !== level) {
            this.warnOnce('clamped', `${(0, utils_1.forLog)(this.displayName)} clamped volume ${level} to ${result.level}; `
                + 'the player has a configured volume range');
        }
    }
    updateFromObservation(observation, _reason) {
        if (observation.fixedVolume) {
            if (!this.fixedVolume) {
                this.fixedVolume = true;
                this.warnOnce('fixed-volume', `${(0, utils_1.forLog)(this.displayName)} reports a fixed output level, so its volume slider `
                    + 'cannot do anything; disable the slider for this player in the plugin settings');
                this.markUnavailable();
            }
            return;
        }
        this.fixedVolume = false;
        // A muted player already reports level 0, so this needs no mute handling of
        // its own; the guard is only for firmware that reports otherwise.
        const level = observation.muted ? settings_1.VOLUME_MIN : observation.volume ?? settings_1.VOLUME_MIN;
        this.level = level;
        if (level > settings_1.VOLUME_MIN && this.context.lastNonZeroVolume !== level) {
            this.context.lastNonZeroVolume = level;
            // This accessory only: a front-panel knob produces a level change per step,
            // and each one would otherwise rewrite the context of every accessory in the
            // fleet to the cache file on disk.
            this.host.persistContext(this.accessory);
        }
        const { Characteristic: Char } = this.host.hap;
        this.surface.service.updateCharacteristic(this.context.sliderService === 'lightbulb' ? Char.On : Char.Active, this.surface.toActiveValue(level > settings_1.VOLUME_MIN));
        this.surface.service.updateCharacteristic(this.context.sliderService === 'lightbulb' ? Char.Brightness : Char.RotationSpeed, level);
    }
    markUnavailable() {
        const { Characteristic: Char } = this.host.hap;
        const error = this.communicationFailure();
        this.surface.service.updateCharacteristic(this.context.sliderService === 'lightbulb' ? Char.On : Char.Active, error);
        this.surface.service.updateCharacteristic(this.context.sliderService === 'lightbulb' ? Char.Brightness : Char.RotationSpeed, error);
    }
}
exports.VolumeAccessory = VolumeAccessory;
