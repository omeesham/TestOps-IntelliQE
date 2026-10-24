/**
 * Unit tests for the coverage engine helpers: rule ids, coverage tracking,
 * categories and skill selection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withIds } from '../src/agents/requirementAgent.js';
import { coveredIds, categoryFor } from '../src/agents/generatorAgent.js';
import { selectSkills, loadSkill } from '../src/agents/skills.js';
import type { ExploredApp } from '../src/agents/state.js';

test('withIds keeps valid ids, fills missing ones and removes duplicates', () => {
  const rules = withIds<{ id?: string; field?: string }>(
    [{ id: 'FLD-01', field: 'Email' }, { field: 'Age' }, { id: 'FLD-01', field: 'Phone' }, { id: 'x', field: 'Name' }, null, { id: 'FLD-09' }],
    'FLD',
    (r) => !!r.field,
  );
  assert.deepEqual(rules.map((r) => r.id), ['FLD-01', 'FLD-02', 'FLD-03', 'FLD-04']);
  assert.deepEqual(rules.map((r) => r.field), ['Email', 'Age', 'Phone', 'Name']);
});

test('withIds returns an empty list for missing or non-array input', () => {
  assert.deepEqual(withIds(undefined, 'BR', () => true), []);
  assert.deepEqual(withIds({ id: 'BR-01' }, 'BR', () => true), []);
});

test('coveredIds reads FLD and BR ids from traceability, case-insensitively', () => {
  const ids = coveredIds([
    { traceabilityId: 'FLD-01, br-02' },
    { traceabilityId: 'REQ-LOGIN-01' },
    { traceabilityId: 'BR-10; FLD-3' },
    {},
  ]);
  assert.deepEqual([...ids].sort(), ['BR-02', 'BR-10', 'FLD-01', 'FLD-3']);
});

test('categoryFor accepts valid categories and aliases, else derives from type', () => {
  assert.equal(categoryFor('boundary', 'negative'), 'boundary');
  assert.equal(categoryFor('Business Rules', 'positive'), 'business-rule');
  assert.equal(categoryFor('boundary-value', 'positive'), 'boundary');
  assert.equal(categoryFor(undefined, 'negative'), 'negative');
  assert.equal(categoryFor('nonsense', 'e2e'), 'positive');
});

const page = (fields: { name: string; type: string }[], title = 'Page') => ({
  url: 'http://app.test/', title, headings: [], buttons: [], links: [], navItems: [],
  forms: [{ fields: fields.map((f) => ({ ...f, required: false })) }],
});
const app = (pages: ExploredApp['pages'], authDetected = false): ExploredApp =>
  ({ baseUrl: 'http://app.test', pages, detectedFeatures: [], authDetected, notes: [] });

test('selectSkills always includes test-design and adds skills for what the app has', () => {
  assert.deepEqual(selectSkills({ requirements: 'A page that shows a welcome message.', exploredApp: null }), ['test-design']);
  assert.deepEqual(
    selectSkills({ requirements: '', exploredApp: app([page([{ name: 'name', type: 'text' }, { name: 'idDoc', type: 'file' }])]) }),
    ['test-design', 'forms-validation', 'file-upload'],
  );
  assert.deepEqual(
    selectSkills({ requirements: '', exploredApp: app([page([{ name: 'user', type: 'text' }, { name: 'pw', type: 'password' }])], true) }),
    ['test-design', 'forms-validation', 'login-auth'],
  );
});

test('a password field on a registration form does not pick the login skill', () => {
  const skills = selectSkills({ requirements: '', exploredApp: app([page([{ name: 'email', type: 'email' }, { name: 'password', type: 'password' }], 'Create account')]) });
  assert.ok(!skills.includes('login-auth'));
});

test('with an explored app, sign-in wording in requirement text alone does not pick the login skill', () => {
  const skills = selectSkills({ requirements: 'Visitors can book without signing in. No login is required.', exploredApp: app([page([{ name: 'name', type: 'text' }])]) });
  assert.ok(!skills.includes('login-auth'));
});

test('a sign-in page with a password field picks the login skill', () => {
  const skills = selectSkills({ requirements: '', exploredApp: app([page([{ name: 'user', type: 'text' }, { name: 'pw', type: 'password' }], 'Sign in - Portal')]) });
  assert.ok(skills.includes('login-auth'));
});

test('selectSkills reads stated rules from requirement text', () => {
  const skills = selectSkills({ requirements: 'Reason is required, max 200 characters. Users upload a PDF.', exploredApp: null });
  assert.ok(skills.includes('forms-validation'));
  assert.ok(skills.includes('file-upload'));
  assert.ok(!skills.includes('login-auth'));
});

test('every skill file exists and is not empty', () => {
  for (const name of ['test-design', 'forms-validation', 'file-upload', 'login-auth'] as const) {
    assert.ok(loadSkill(name).length > 200, `${name} skill missing or too short`);
  }
});
