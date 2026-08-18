/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Test setup file - runs before all tests.
 *
 * Fails fast if the suite is run without NODE_ENV=test, which the UI-server load
 * path and several fixtures rely on. Note that sockets are not blocked: the HTTP
 * tests deliberately bind a loopback server, because the behaviour worth testing
 * there is what happens to a real connection.
 */

if (process.env.NODE_ENV !== 'test') {
  throw new Error('Tests must run with NODE_ENV=test. Use: NODE_ENV=test npm test')
}

// Mock lifecycle and the per-test timeout are both configured once in
// jest.config.js; repeating either here only obscures where it happens.
