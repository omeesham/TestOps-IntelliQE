/**
 * Unit tests for the document accuracy scorecard (services/document-accuracy.service.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectDocumentChecks, summariseDocumentChecks, writeAllureScorecard, isDocumentFinding,
  type DocumentCheck, type AccuracySettings,
} from '../src/services/document-accuracy.service.js';

const settings: AccuracySettings = { threshold: 90, highConfidence: 90, lowConfidence: 60 };

const checks: DocumentCheck[] = [
  { document: 'a.pdf', results: [
    { field: 'Ticket Number', expected: '1', actual: '1', outcome: 'correct', confidence: 99 },
    { field: 'Project', expected: '7', actual: '7', outcome: 'correct', confidence: 40 },
    { field: 'Date', row: 2, expected: '', actual: '01/12/2026', outcome: 'invented', note: 'ditto mark' },
  ] },
  // The same document checked by a second test: its values count once.
  { document: 'a.pdf', results: [{ field: 'Date', row: 2, expected: '', actual: '01/12/2026', outcome: 'invented', note: 'ditto mark' }] },
  { document: 'b.pdf', results: [
    { field: 'Ticket Number', expected: '2', actual: '3', outcome: 'wrong', confidence: 98 },
    { field: 'Project', expected: '8', actual: '', outcome: 'missed', confidence: 35 },
  ] },
];

test('accuracy per field, against the threshold, with each value counted once', () => {
  const card = summariseDocumentChecks(checks, settings)!;
  assert.equal(card.documents, 2);
  assert.equal(card.checked, 5);
  assert.equal(card.correct, 2);
  assert.equal(card.accuracy, 40);
  assert.equal(card.meetsThreshold, false);
  assert.deepEqual(card.fields.map((f) => [f.field, f.checked, f.accuracy, f.meetsThreshold]), [
    ['Date', 1, 0, false], ['Project', 2, 50, false], ['Ticket Number', 2, 50, false],
  ]);
});

test('flags put high-confidence wrong values first and include correct but low-confidence reads', () => {
  const card = summariseDocumentChecks(checks, settings)!;
  assert.deepEqual(card.flags.map((f) => [f.kind, f.document, f.field]), [
    ['high-confidence wrong', 'b.pdf', 'Ticket Number'],
    ['invented', 'a.pdf', 'Date'],
    ['missed', 'b.pdf', 'Project'],
    ['low confidence', 'a.pdf', 'Project'],
  ]);
});

test('no checks, no scorecard', () => {
  assert.equal(summariseDocumentChecks([], settings), null);
});

test('checks are read from the Playwright JSON report attachments', () => {
  const body = (c: DocumentCheck) => Buffer.from(JSON.stringify(c)).toString('base64');
  const summary = { suites: [{ suites: [{ specs: [{ tests: [{ results: [{ attachments: [
    { name: 'document-check', body: body(checks[0]) },
    { name: 'screenshot', body: 'x' },
    { name: 'document-check', body: Buffer.from('not json').toString('base64') },
  ] }] }] }] }] }] };
  assert.deepEqual(collectDocumentChecks(summary), [checks[0]]);
});

test('the scorecard becomes an Allure entry, failed below the threshold', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-acc-'));
  try {
    await writeAllureScorecard(dir, summariseDocumentChecks(checks, settings)!);
    const files = fs.readdirSync(dir);
    const result = JSON.parse(fs.readFileSync(path.join(dir, files.find((f) => f.endsWith('-result.json'))!), 'utf-8'));
    assert.equal(result.status, 'failed');
    assert.match(result.name, /^Document accuracy: 40%/);
    const html = fs.readFileSync(path.join(dir, result.attachments[0].source), 'utf-8');
    assert.match(html, /high-confidence wrong/);
    assert.match(html, /98%/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a value mismatch is a finding; other failures are not', () => {
  assert.ok(isDocumentFinding('Error: b.pdf – Ticket Number: expected "2", screen shows "3"'));
  assert.ok(!isDocumentFinding('locator.click: Timeout 15000ms exceeded'));
  assert.ok(!isDocumentFinding(undefined));
});
