/**
 * Unit tests for test files per application (services/test-data.service.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  sanitizeTestDataName, appTestDataDir, testDataPromptBlock, specUsesTestData, materializeTestData, NEGATIVE_FILES,
} from '../src/services/test-data.service.js';

test('file names are kept readable but safe; reserved and hidden names are refused', () => {
  assert.equal(sanitizeTestDataName('ID card (front).pdf'), 'ID_card_front.pdf');
  assert.equal(sanitizeTestDataName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeTestDataName('.env'), null);
  assert.equal(sanitizeTestDataName('negative-empty.pdf'), null);
  assert.equal(sanitizeTestDataName(''), null);
});

test('storage folder is per tenant and app, and rejects path tricks', () => {
  assert.match(appTestDataDir('tenant-1', 'app-shop'), /tenant-1[\\/]app-shop$/);
  assert.throws(() => appTestDataDir('..', 'app-shop'));
  assert.throws(() => appTestDataDir('tenant-1', 'app/../x'));
});

test('prompt blocks list the real and the generated files, and stay empty without files', () => {
  assert.equal(testDataPromptBlock(undefined, 'cases'), '');
  assert.equal(testDataPromptBlock([], 'script'), '');
  const cases = testDataPromptBlock(['id-card.pdf'], 'cases');
  assert.match(cases, /id-card\.pdf/);
  assert.match(cases, /never invent file names/);
  const script = testDataPromptBlock(['id-card.pdf'], 'script');
  assert.match(script, /setInputFiles\(path\.join\(TEST_DATA_DIR/);
  assert.match(script, /IQE_TEST_DATA_DIR/);
});

test('specs that read the test-data folder are detected', () => {
  assert.ok(specUsesTestData("const TEST_DATA_DIR = process.env.IQE_TEST_DATA_DIR || 'x';"));
  assert.ok(!specUsesTestData("await page.goto('/');"));
});

test('materializeTestData copies the app files and writes the invalid files', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'td-src-'));
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'td-dest-'));
  try {
    await fs.writeFile(path.join(src, 'id-card.pdf'), '%PDF-1.4 test');
    const names = await materializeTestData(src, dest);
    assert.ok(names.includes('id-card.pdf'));
    for (const n of NEGATIVE_FILES) assert.ok(names.includes(n.name));
    assert.equal((await fs.stat(path.join(dest, 'negative-empty.pdf'))).size, 0);
    assert.ok((await fs.stat(path.join(dest, 'negative-oversized.pdf'))).size > 10 * 1024 * 1024);
  } finally {
    await fs.rm(src, { recursive: true, force: true });
    await fs.rm(dest, { recursive: true, force: true });
  }
});
