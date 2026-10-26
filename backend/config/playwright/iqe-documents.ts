/**
 * Document check helpers for generated specs, copied into the Playwright
 * workspace as iqe-documents.ts when a spec imports it.
 *
 * answer-key.json sits beside the uploaded test documents and states what
 * each document must produce on screen:
 *   { "<file>": { "fields": { "<label>": "<value>" },
 *                 "rows": [{ "expected": { "<column>": "<value>" }, "emptyBecause": { "<column>": "<why>" } }],
 *                 "tags": ["clean", "ditto mark"] } }
 * An empty string means the field must stay empty (nothing readable to extract).
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

export interface KeyRow { expected: Record<string, string>; emptyBecause?: Record<string, string> }
export interface KeyEntry { fields?: Record<string, string>; rows?: KeyRow[]; tags?: string[] }
export interface TestDocument { file: string; path: string; key: KeyEntry }

/** A value read from the screen, with the confidence (0–100) the screen shows for it, if any. */
export type Reading = string | { value: string; confidence?: number };
export interface Readings { fields?: Record<string, Reading>; rows?: Record<string, Reading>[] }

export type Outcome = 'correct' | 'wrong' | 'missed' | 'invented';
export interface FieldResult {
  field: string;
  /** 1-based table row; absent for single fields. */
  row?: number;
  expected: string;
  actual: string;
  outcome: Outcome;
  confidence?: number;
  note?: string;
}

// Resolved on use: the workspace copy runs as CommonJS, unit tests as ESM with the env var set.
const dataDir = (): string => process.env.IQE_TEST_DATA_DIR || path.join(__dirname, 'test-data');
const KEY_FILE = 'answer-key.json';

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
const sameName = (a: string, b: string): boolean => norm(a.replace(/\*/g, '')) === norm(b.replace(/\*/g, ''));

/** Test documents listed in the answer key; with `tags`, only the matching ones (all when none match). */
export function documents(tags: string[] = []): TestDocument[] {
  const dir = dataDir();
  const keyPath = path.join(dir, KEY_FILE);
  if (!fs.existsSync(keyPath)) throw new Error(`${KEY_FILE} is not among the application's test files`);
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf-8')) as Record<string, KeyEntry>;
  const all = Object.entries(key)
    .filter(([file]) => fs.existsSync(path.join(dir, file)))
    .map(([file, entry]) => ({ file, path: path.join(dir, file), key: entry }));
  if (!all.length) throw new Error(`None of the documents in ${KEY_FILE} is among the application's test files`);
  const wanted = tags.map(norm).filter(Boolean);
  const tagged = all.filter((d) => (d.key.tags || []).map(norm).some((t) => wanted.some((w) => t.includes(w) || w.includes(t))));
  return tagged.length ? tagged : all;
}

function isoDate(s: string): string | null {
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/); // month/day/year
  if (us) return `${us[3].length === 2 ? `20${us[3]}` : us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return null;
}

function minutes(s: string): number | null {
  const m = s.replace(/\s+/g, '').match(/^(\d{1,2}):(\d{2})(?::\d{2})?(a|am|p|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].startsWith('p') ? 12 : 0);
  }
  return h * 60 + min;
}

/** Plain numbers only: a leading zero (e.g. "056930074") makes it an identifier, compared as text. */
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Same value once formatting is set aside: case and spacing, date and time formats, "2.50" vs "2.5". */
export function sameValue(expected: string, actual: string): boolean {
  const e = norm(expected);
  const a = norm(actual);
  if (e === a) return true;
  if (!e || !a) return false;
  const de = isoDate(e);
  const da = isoDate(a);
  if (de && da) return de === da;
  const te = minutes(e);
  const ta = minutes(a);
  if (te !== null && ta !== null) return te === ta;
  if (NUMBER.test(e) && NUMBER.test(a)) return Number(e) === Number(a);
  return false;
}

const valueOf = (r: Reading | undefined): string => (typeof r === 'string' ? r : r?.value ?? '');
const confidenceOf = (r: Reading | undefined): number | undefined => (typeof r === 'object' ? r.confidence : undefined);
const find = (record: Record<string, Reading> | undefined, field: string): Reading | undefined =>
  Object.entries(record || {}).find(([k]) => sameName(k, field))?.[1];

function result(field: string, expected: string, reading: Reading | undefined, row?: number, note?: string): FieldResult {
  const actual = valueOf(reading);
  const outcome: Outcome = sameValue(expected, actual) ? 'correct' : !norm(actual) ? 'missed' : !norm(expected) ? 'invented' : 'wrong';
  const why = reading === undefined && norm(expected) ? 'not read from the screen' : note;
  return { field, ...(row ? { row } : {}), expected, actual, outcome, ...(confidenceOf(reading) !== undefined ? { confidence: confidenceOf(reading) } : {}), ...(why ? { note: why } : {}) };
}

/** Compare what the screen shows with the answer key; `only` limits the check to some fields. */
export function compareDocument(key: KeyEntry, readings: Readings, only: string[] = []): FieldResult[] {
  const wanted = (field: string): boolean => !only.length || only.some((o) => sameName(o, field));
  const out: FieldResult[] = [];
  for (const [field, expected] of Object.entries(key.fields || {})) {
    if (wanted(field)) out.push(result(field, expected, find(readings.fields, field)));
  }
  const keyRows = key.rows || [];
  const screen = readings.rows || [];
  // A row left empty on purpose (e.g. struck out) may be left off the screen rather than shown empty.
  const expectedRows = screen.length < keyRows.length
    ? keyRows.filter((r) => Object.values(r.expected).some((v) => norm(v)))
    : keyRows;
  expectedRows.forEach((r, i) => {
    for (const [field, expected] of Object.entries(r.expected)) {
      if (wanted(field)) out.push(result(field, expected, find(screen[i], field), i + 1, r.emptyBecause?.[field]));
    }
  });
  screen.slice(expectedRows.length).forEach((extra, j) => {
    for (const [field, reading] of Object.entries(extra)) {
      if (wanted(field) && norm(valueOf(reading))) out.push(result(field, '', reading, expectedRows.length + j + 1, 'row not on the document'));
    }
  });
  return out;
}

/**
 * Compare a document's screen values with its answer key, attach the per-field
 * results to the test ("document-check") and fail softly on every field that
 * does not match, so one run lists all differences.
 */
export async function checkDocument(doc: TestDocument, readings: Readings, only: string[] = []): Promise<FieldResult[]> {
  const results = compareDocument(doc.key, readings, only);
  await test.info().attach('document-check', {
    body: JSON.stringify({ document: doc.file, tags: doc.key.tags || [], results }, null, 2),
    contentType: 'application/json',
  });
  for (const r of results) {
    const where = r.row ? `${r.field} (row ${r.row})` : r.field;
    const message = `${doc.file} – ${where}: expected "${r.expected}", screen shows "${r.actual}"${r.note ? ` (${r.note})` : ''}`;
    expect.soft(r.outcome, message).toBe('correct');
  }
  return results;
}

const labelPattern = (label: string): RegExp =>
  new RegExp(`^\\s*${label.replace(/\*/g, '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?\\s*:?\\s*$`, 'i');

/**
 * The form control of a field by its visible label (a trailing "*" is ignored),
 * also when the label is not linked to its input: then the first control after the label text.
 */
export function fieldByLabel(page: Page, label: string): Locator {
  const pattern = labelPattern(label);
  return page.getByLabel(pattern)
    .or(page.getByText(pattern).locator('xpath=following::*[self::input or self::textarea or self::select][1]'))
    .first();
}

/**
 * Read single fields by their visible label, with the confidence shown beside
 * a field ("Confidence: 87%"). Fields not found are left out, so the check
 * reports them as not read rather than empty.
 */
export async function readFields(page: Page, labels: string[]): Promise<Record<string, Reading>> {
  const out: Record<string, Reading> = {};
  for (const label of labels) {
    const control = fieldByLabel(page, label);
    if (!(await control.count())) continue;
    const { value, context } = await control.evaluate((el) => {
      const v = el instanceof HTMLSelectElement ? el.selectedOptions[0]?.text ?? '' : (el as HTMLInputElement).value;
      return { value: v, context: el.parentElement?.textContent || '' };
    });
    const c = context.match(/confidence\s*:?\s*(\d+(?:\.\d+)?)\s*%?/i);
    out[label] = c ? { value, confidence: Number(c[1]) } : value;
  }
  return out;
}

/** Read a table's rows as { column header: value }, from inputs where cells hold them, else cell text. */
export async function readTable(page: Page, nth = 0): Promise<Record<string, string>[]> {
  return page.locator('table').nth(nth).evaluate((table) => {
    const clean = (s: string | null): string => (s || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(table.querySelectorAll('tr'));
    const head = rows.find((tr) => tr.querySelector('th'));
    const headers = Array.from(head?.querySelectorAll('th') || []).map((th) => clean(th.textContent));
    return rows.filter((tr) => tr !== head && tr.querySelector('td')).map((tr) => {
      const row: Record<string, string> = {};
      Array.from(tr.querySelectorAll('td')).forEach((td, i) => {
        if (!headers[i]) return;
        const control = td.querySelector('input, textarea, select');
        row[headers[i]] = control instanceof HTMLSelectElement
          ? control.selectedOptions[0]?.text ?? ''
          : control ? (control as HTMLInputElement).value : clean(td.textContent);
      });
      return row;
    });
  });
}
