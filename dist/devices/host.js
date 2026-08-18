"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The contract between an accessory and the platform.
 *
 * Accessories depend on this narrow interface rather than on the platform class,
 * which keeps the import graph acyclic and lets a test drive an accessory with a
 * handful of stubs instead of a whole platform.
 */
Object.defineProperty(exports, "__esModule", { value: true });
