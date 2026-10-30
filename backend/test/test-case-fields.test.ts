/**
 * Unit tests for test case value normalising (utils/test-case-fields.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fit, normaliseTags, normaliseCategory, TEST_CASE_LIMITS } from '../src/utils/test-case-fields.js';

test('fit keeps short values and cuts long ones to the column size with an ellipsis', () => {
  assert.equal(fit('Verify login', 20), 'Verify login');
  const cut = fit('x'.repeat(1200), TEST_CASE_LIMITS.title)!;
  assert.equal(cut.length, TEST_CASE_LIMITS.title);
  assert.ok(cut.endsWith('…'));
  assert.equal(fit(null, 10), null);
  assert.equal(fit(undefined, 10), null);
  assert.equal(fit(42, 10), '42');
});

test('normaliseTags keeps known tags (including auth, security, data-validation), upper-cased, once', () => {
  assert.deepEqual(normaliseTags(['smoke', 'auth', 'Data-Validation', 'security', 'made-up', 'SMOKE']), ['SMOKE', 'AUTH', 'DATA-VALIDATION', 'SECURITY']);
  assert.deepEqual(normaliseTags('regression, sanity; accessibility'), ['REGRESSION', 'SANITY', 'ACCESSIBILITY']);
  assert.deepEqual(normaliseTags(undefined), []);
});

test('normaliseCategory accepts known categories only', () => {
  assert.equal(normaliseCategory('Boundary'), 'boundary');
  assert.equal(normaliseCategory('business-rule'), 'business-rule');
  assert.equal(normaliseCategory('performance'), null);
  assert.equal(normaliseCategory(undefined), null);
});
