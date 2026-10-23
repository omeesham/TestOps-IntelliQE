/**
 * Unit tests for the production start-up check (utils/startup-check.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingProductionSettings } from '../src/utils/startup-check.js';

const good = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  WORKER_SECRET: 'a-long-random-worker-secret',
  AZURE_SQL_PASSWORD: 'sql-password',
};

test('development never blocks start-up', () => {
  assert.deepEqual(missingProductionSettings({ NODE_ENV: 'development' }), []);
});

test('complete production settings pass', () => {
  assert.deepEqual(missingProductionSettings(good), []);
});

test('missing or weak production settings are all listed', () => {
  const problems = missingProductionSettings({ NODE_ENV: 'production', JWT_SECRET: 'short', ENCRYPTION_KEY: 'abc', WORKER_SECRET: 'dev-secret' });
  assert.equal(problems.length, 4);
  assert.match(problems.join(' | '), /JWT_SECRET.*ENCRYPTION_KEY.*WORKER_SECRET.*SQL/);
});

test('DB_PASSWORD is accepted instead of AZURE_SQL_PASSWORD', () => {
  const { AZURE_SQL_PASSWORD, ...rest } = good;
  assert.deepEqual(missingProductionSettings({ ...rest, DB_PASSWORD: 'p' }), []);
});
