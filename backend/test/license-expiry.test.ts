/**
 * Unit tests for the trial/license expiry gate (middleware/license-expiry.middleware.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLicenseExpired } from '../src/middleware/license-expiry.middleware.js';

const before = Date.parse('2026-11-11T23:59:59Z');
const onDay = Date.parse('2026-11-12T00:00:00Z');

test('runs before the expiry date and stops from midnight UTC on it', () => {
  assert.equal(isLicenseExpired(before, '2026-11-12', true), false);
  assert.equal(isLicenseExpired(onDay, '2026-11-12', true), true);
});

test('no baked-in date: local dev runs, production fails closed', () => {
  assert.equal(isLicenseExpired(before, null, false), false);
  assert.equal(isLicenseExpired(before, null, true), true);
});

test('an unreadable date counts as expired', () => {
  assert.equal(isLicenseExpired(before, 'not-a-date', true), true);
});
