/**
 * Unit tests for the answer-key document check helper (config/playwright/iqe-documents.ts)
 * and how the runner and script prompt pick it up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sameValue, compareDocument, documents, type KeyEntry } from '../config/playwright/iqe-documents.js';
import { documentCheckPromptBlock, specUsesTestData } from '../src/services/test-data.service.js';

test('values match once formatting is set aside', () => {
  assert.ok(sameValue('2026-01-12', '01/12/2026'));
  assert.ok(sameValue('2026-01-02', '1/2/26'));
  assert.ok(!sameValue('2026-01-02', '02/01/2026'), 'a day/month swap is a wrong date');
  assert.ok(sameValue('15:00', '3:00 PM'));
  assert.ok(sameValue('08:30', '8:30a'));
  assert.ok(sameValue('2.5', '2.50'));
  assert.ok(sameValue('Victor  Dalton', 'victor dalton'));
  assert.ok(!sameValue('056930074', '56930074'), 'a lost leading zero changes an identifier');
  assert.ok(!sameValue('0', ''));
});

const key: KeyEntry = {
  fields: { 'Ticket Number': '72912583', Project: '056930074' },
  rows: [
    { expected: { 'Worker Name': 'Victor Dalton', Date: '2026-01-12' } },
    { expected: { 'Worker Name': 'Victor Jensen', Date: '' }, emptyBecause: { Date: 'ditto mark' } },
    { expected: { 'Worker Name': '', Date: '' }, emptyBecause: { 'Worker Name': 'struck-out row', Date: 'struck-out row' } },
    { expected: { 'Worker Name': 'Carlos Moreno', Date: '2026-01-14' } },
  ],
};

test('each field gets an outcome: correct, wrong, missed or invented', () => {
  const results = compareDocument(key, {
    fields: { 'Ticket Number *': { value: '72912588', confidence: 97 } },
    rows: [
      { 'Worker Name': 'Victor Dalton', Date: '01/12/2026' },
      { 'Worker Name': 'Victor Jensen', Date: '01/12/2026' },
      { 'Worker Name': '', Date: '' },
      { 'Worker Name': 'Carlos Moreno', Date: '' },
    ],
  });
  const at = (field: string, row?: number) => results.find((r) => r.field === field && r.row === row)!;
  assert.deepEqual(at('Ticket Number'), { field: 'Ticket Number', expected: '72912583', actual: '72912588', outcome: 'wrong', confidence: 97 });
  assert.equal(at('Project').outcome, 'missed');
  assert.equal(at('Project').note, 'not read from the screen');
  assert.equal(at('Date', 1).outcome, 'correct');
  assert.equal(at('Date', 2).outcome, 'invented', 'a ditto mark read as a date is a guess');
  assert.equal(at('Date', 2).note, 'ditto mark');
  assert.equal(at('Worker Name', 3).outcome, 'correct');
  assert.equal(at('Date', 4).outcome, 'missed');
});

test('a struck-out row may be left off the screen; extra rows count as invented', () => {
  const dropped = compareDocument(key, { rows: [
    { 'Worker Name': 'Victor Dalton', Date: '01/12/2026' },
    { 'Worker Name': 'Victor Jensen', Date: '' },
    { 'Worker Name': 'Carlos Moreno', Date: '01/14/2026' },
  ] }, ['Worker Name', 'Date']);
  assert.ok(dropped.every((r) => r.outcome === 'correct'));

  // Struck row left off and a totals row added: same row count, rows must still line up.
  const withTotal = compareDocument(key, { rows: [
    { 'Worker Name': 'Victor Dalton', Date: '01/12/2026' },
    { 'Worker Name': 'Victor Jensen', Date: '' },
    { 'Worker Name': 'Carlos Moreno', Date: '01/14/2026' },
    { 'Worker Name': 'Total', Date: '' },
  ] }, ['Worker Name', 'Date']);
  assert.deepEqual(withTotal.filter((r) => r.outcome !== 'correct').map((r) => [r.field, r.row, r.outcome]), [['Worker Name', 4, 'invented']]);

  const extra = compareDocument({ rows: [{ expected: { 'Worker Name': 'Ana Ortiz' } }] }, { rows: [{ 'Worker Name': 'Ana Ortiz' }, { 'Worker Name': 'Total' }] });
  assert.deepEqual(extra[1], { field: 'Worker Name', row: 2, expected: '', actual: 'Total', outcome: 'invented', note: 'row not on the document' });
});

test('only the checked fields are compared', () => {
  const results = compareDocument(key, { fields: { Project: '056930074' } }, ['project']);
  assert.deepEqual(results.map((r) => [r.field, r.outcome]), [['Project', 'correct']]);
});

test('documents come from the answer key, filtered by tag, all when no tag matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-docs-'));
  fs.writeFileSync(path.join(dir, 'answer-key.json'), JSON.stringify({
    'a.pdf': { tags: ['clean'] }, 'b.pdf': { tags: ['messy', 'ditto mark'] }, 'missing.pdf': { tags: ['clean'] },
  }));
  fs.writeFileSync(path.join(dir, 'a.pdf'), '');
  fs.writeFileSync(path.join(dir, 'b.pdf'), '');
  process.env.IQE_TEST_DATA_DIR = dir;
  try {
    assert.deepEqual(documents(['ditto marks']).map((d) => d.file), ['b.pdf']);
    assert.deepEqual(documents(['faint scan']).map((d) => d.file), ['a.pdf', 'b.pdf']);
    assert.equal(documents()[0].path, path.join(dir, 'a.pdf'));
  } finally {
    delete process.env.IQE_TEST_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('specs using the helper get the test files; the prompt block needs an answer key', () => {
  assert.ok(specUsesTestData(`import { documents } from '../iqe-documents';`));
  assert.equal(documentCheckPromptBlock(['a.pdf']), '');
  assert.match(documentCheckPromptBlock(['a.pdf', 'answer-key.json']), /from '\.\.\/iqe-documents'/);
});

test('a key column matches the one screen header that starts with it ("ST Hrs" → "ST Hrs Worked")', () => {
  const key: KeyEntry = { rows: [{ expected: { 'Worker Name': 'Ana Lee', 'ST Hrs': '8', 'OT Hrs': '1' } }] };
  const results = compareDocument(key, { rows: [{ 'Worker Name': 'Ana Lee', 'ST Hrs Worked': '8', 'OT Hrs Worked': '1.0', 'Time Off (ST)': '0' }] });
  assert.deepEqual(results.map((r) => `${r.field}:${r.outcome}`), ['Worker Name:correct', 'ST Hrs:correct', 'OT Hrs:correct']);

  // An exact header wins over a longer one; two longer candidates are too unsure to pick.
  const exact = compareDocument({ rows: [{ expected: { Date: '2026-08-11' } }] }, { rows: [{ Date: '08/11/2026', 'Date Received': '01/01/2026' }] });
  assert.equal(exact[0].outcome, 'correct');
  const unsure = compareDocument({ rows: [{ expected: { Time: '07:00' } }] }, { rows: [{ 'Time Start': '07:00', 'Time Stop': '15:00' }] });
  assert.equal(unsure[0].outcome, 'missed');
  assert.equal(unsure[0].note, 'not read from the screen');
});
