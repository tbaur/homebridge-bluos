/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared accessory behaviour: honesty about unknown state, and
 * writes that answer HomeKit inside its patience.
 *
 * Two rules are implemented once, here, because getting either wrong produces
 * bugs that are very hard to diagnose from a user's description.
 *
 * Never guess a characteristic value. Until a player has actually been read, and
 * whenever it has stopped answering, reads fail with
 * `SERVICE_COMMUNICATION_FAILURE` so the Home app shows No Response. A plausible
 * default is worse than no answer: it makes automations fire against fiction.
 *
 * Never let a write outlive HomeKit's patience. HAP-NodeJS warns at three
 * seconds and abandons a write at nine, discarding the eventual result. A set
 * handler therefore returns within {@link HOMEKIT_WRITE_BUDGET_MS} and finishes
 * anything slower in the background, where its outcome still reaches HomeKit
 * through the normal update path.
 */
import type { PlatformAccessory, Service } from 'homebridge';
import type { WriteScope } from '../api/client';
import type { AccessoryContext, PlayerObservation, RefreshReason, RefreshableAccessory } from '../types';
import type { AccessoryHost } from './host';
/** A concrete HAP service class, such as `Service.Fanv2`. */
export type ServiceConstructor = {
    UUID: string;
    new (displayName?: string, subtype?: string): Service;
};
/** Everything an accessory needs to attach itself to a restored accessory. */
export interface AccessoryInit {
    host: AccessoryHost;
    accessory: PlatformAccessory;
    context: AccessoryContext;
}
/** Base class for every accessory this plugin exposes. */
export declare abstract class BaseAccessory implements RefreshableAccessory {
    protected readonly host: AccessoryHost;
    protected readonly accessory: PlatformAccessory;
    protected readonly context: AccessoryContext;
    /** True once a real observation has been applied. */
    private observed;
    /** True while the player is not answering. */
    private offline;
    /** Throttles repeated warnings about the same persistent failure. */
    private lastWarningAt;
    /** Ensures a one-time explanation is logged only once. */
    private readonly warnedOnce;
    constructor(init: AccessoryInit);
    get deviceId(): string;
    get displayName(): string;
    /** Apply a fresh observation, and remember that state is now known. */
    applyObservation(observation: PlayerObservation, reason: RefreshReason): void;
    /**
     * Report that the player could not be reached.
     *
     * Characteristic values are left untouched rather than zeroed: HomeKit is told
     * the accessory is unreachable, and inventing a value on the way out would
     * defeat that.
     */
    noteUnreachable(error: unknown): void;
    /** Apply an observation to this accessory's characteristics. */
    protected abstract updateFromObservation(observation: PlayerObservation, reason: RefreshReason): void;
    /** Push an unreachable state to HomeKit. */
    protected abstract markUnavailable(): void;
    /** True once this accessory has seen a real reading. */
    protected hasObservedState(): boolean;
    /**
     * The error to return from a read when the true value is unknown.
     *
     * `SERVICE_COMMUNICATION_FAILURE` is what makes the Home app render No
     * Response, which is the honest answer before the first successful poll.
     */
    protected communicationFailure(): Error;
    /** Throw if this accessory has no observed state to report. */
    protected requireObservedState(): void;
    /**
     * How far this accessory's volume writes should reach.
     *
     * A zone that leads a group carries its followers with it, matching what the
     * BluOS app does when you move a leader's slider: the tile is the group's
     * control while the group exists. Every other zone — standalone, or a follower
     * addressed directly — moves alone, because a tile labelled one room must not
     * quietly change another.
     *
     * Derived from the last observation rather than remembered, so ungrouping takes
     * effect on the next poll without any bookkeeping here. When a player reports
     * no grouping at all the answer is false, which is the pre-grouping behaviour.
     */
    protected writeScope(): WriteScope;
    /** One info line after a HomeKit write reached the player. */
    protected logAction(action: string, scope: WriteScope): void;
    /** Log an explanation the first time a condition is met, then stay quiet. */
    protected warnOnce(key: string, message: string): void;
    /**
     * Run a HomeKit write, returning once it finishes or the budget expires.
     *
     * Slow work is not cancelled when the budget runs out, only stopped being
     * waited on: the player will still apply the change, and the resulting state
     * reaches HomeKit through the poll that our own write triggers.
     */
    protected completeWithinBudget(label: string, work: () => Promise<void>): Promise<void>;
    /**
     * The service this accessory's state lives on, created if necessary.
     *
     * Reusing a restored service rather than replacing it is what preserves the
     * user's HomeKit room assignment, name and automations across a restart.
     */
    protected requireService(type: ServiceConstructor): Service;
    /**
     * Remove a service this accessory no longer represents.
     *
     * Needed when a setting changes which service carries the state, since the
     * accessory itself is adopted rather than recreated and would otherwise keep
     * both — one of them unbound to any handler.
     */
    protected dropService(type: ServiceConstructor): void;
    /**
     * Publish identity to HomeKit.
     *
     * SerialNumber is the opaque generated value rather than the player's MAC: the
     * Home app displays it, so it ends up in screenshots and bug reports, and on a
     * multi-zone chassis a MAC is shared between zones anyway.
     */
    private configureAccessoryInformation;
    /** Update identity from a live reading, when the player knows better. */
    private refreshAccessoryInformation;
}
