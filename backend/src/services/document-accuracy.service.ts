/**
 * document-accuracy.service
 * ─────────────────────────
 * Scorecard for answer-key document checks. Each generated document test
 * attaches its per-field results ("document-check", see config/playwright/
 * iqe-documents.ts); after a run they are combined into per-field accuracy
 * against the agreed threshold, plus every read that needs a person's eye,
 * most severe first: wrong values shown with high confidence, other wrong or
 * invented values, missed values, then correct values shown with low confidence.
 *
 * The scorecard is added to the run's Allure results as its own entry
 * ("Document accuracy"), failed when any field is below the threshold.
 *
 * Settings (percentages): DOCUMENT_ACCURACY_THRESHOLD (95),
 * DOCUMENT_HIGH_CONFIDENCE (90), DOCUMENT_LOW_CONFIDENCE (60).
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export type Outcome = 'correct' | 'wrong' | 'missed' | 'invented';

export interface FieldResult {
  field: string;
  row?: number;
  expected: string;
  actual: string;
  outcome: Outcome;
  confidence?: number;
  note?: string;
}

export interface DocumentCheck { document: string; tags?: string[]; results: FieldResult[] }

export interface AccuracySettings { threshold: number; highConfidence: number; lowConfidence: number }

export interface FieldAccuracy {
  field: string;
  checked: number;
  correct: number;
  wrong: number;
  missed: number;
  invented: number;
  /** Percentage of checked values that were correct, one decimal. */
  accuracy: number;
  meetsThreshold: boolean;
}

export type FlagKind = 'high-confidence wrong' | 'wrong' | 'invented' | 'missed' | 'low confidence';
export interface Flag extends FieldResult { document: string; kind: FlagKind }

export interface AccuracyScorecard {
  settings: AccuracySettings;
  documents: number;
  checked: number;
  correct: number;
  accuracy: number;
  meetsThreshold: boolean;
  fields: FieldAccuracy[];
  flags: Flag[];
}

function percentSetting(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

export function accuracySettings(): AccuracySettings {
  return {
    threshold: percentSetting('DOCUMENT_ACCURACY_THRESHOLD', 95),
    highConfidence: percentSetting('DOCUMENT_HIGH_CONFIDENCE', 90),
    lowConfidence: percentSetting('DOCUMENT_LOW_CONFIDENCE', 60),
  };
}

/** True when a test failed because screen values differ from the answer key (checkDocument's message). */
export function isDocumentFinding(error: string | undefined): boolean {
  return /: expected "[^"]*", screen shows "/.test(error || '');
}

/** The document-check attachments of a Playwright JSON report. */
export function collectDocumentChecks(summary: any): DocumentCheck[] {
  const checks: DocumentCheck[] = [];
  const walk = (suite: any) => {
    for (const spec of suite?.specs || []) {
      for (const t of spec.tests || []) {
        for (const r of t.results || []) {
          for (const a of r.attachments || []) {
            if (a?.name !== 'document-check' || !a.body) continue;
            try {
              const check = JSON.parse(Buffer.from(a.body, 'base64').toString('utf-8'));
              if (check?.document && Array.isArray(check.results)) checks.push(check);
            } catch { /* not a check we wrote */ }
          }
        }
      }
    }
    (suite?.suites || []).forEach(walk);
  };
  (summary?.suites || []).forEach(walk);
  return checks;
}

const pct = (part: number, whole: number): number => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

const FLAG_ORDER: FlagKind[] = ['high-confidence wrong', 'wrong', 'invented', 'missed', 'low confidence'];

function flagKind(r: FieldResult, s: AccuracySettings): FlagKind | null {
  const sure = r.confidence !== undefined && r.confidence >= s.highConfidence;
  if (r.outcome === 'wrong' || r.outcome === 'invented') return sure ? 'high-confidence wrong' : r.outcome;
  if (r.outcome === 'missed') return 'missed';
  return r.confidence !== undefined && r.confidence < s.lowConfidence ? 'low confidence' : null;
}

/**
 * Combine document checks into a scorecard (null when there are none). A value
 * checked by several tests (same document, field and row) counts once.
 */
export function summariseDocumentChecks(checks: DocumentCheck[], settings: AccuracySettings): AccuracyScorecard | null {
  const seen = new Map<string, Flag>();
  for (const c of checks) {
    for (const r of c.results) {
      const key = `${c.document}|${r.field.toLowerCase()}|${r.row ?? ''}`;
      if (!seen.has(key)) seen.set(key, { ...r, document: c.document, kind: 'wrong' });
    }
  }
  if (!seen.size) return null;
  const values = [...seen.values()];

  const byField = new Map<string, FieldAccuracy>();
  for (const v of values) {
    const f = byField.get(v.field) || { field: v.field, checked: 0, correct: 0, wrong: 0, missed: 0, invented: 0, accuracy: 0, meetsThreshold: false };
    f.checked++;
    f[v.outcome]++;
    byField.set(v.field, f);
  }
  const fields = [...byField.values()].map((f) => {
    const accuracy = pct(f.correct, f.checked);
    return { ...f, accuracy, meetsThreshold: accuracy >= settings.threshold };
  }).sort((a, b) => a.accuracy - b.accuracy || a.field.localeCompare(b.field));

  const flags = values
    .map((v) => ({ ...v, kind: flagKind(v, settings) }))
    .filter((v): v is Flag => v.kind !== null)
    .sort((a, b) => FLAG_ORDER.indexOf(a.kind) - FLAG_ORDER.indexOf(b.kind) || a.document.localeCompare(b.document));

  const correct = values.filter((v) => v.outcome === 'correct').length;
  return {
    settings,
    documents: new Set(values.map((v) => v.document)).size,
    checked: values.length,
    correct,
    accuracy: pct(correct, values.length),
    meetsThreshold: fields.every((f) => f.meetsThreshold),
    fields,
    flags,
  };
}

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** The scorecard as a self-contained HTML page. */
export function scorecardHtml(card: AccuracyScorecard): string {
  const s = card.settings;
  const fieldRows = card.fields.map((f) => `<tr class="${f.meetsThreshold ? '' : 'below'}"><td>${esc(f.field)}</td><td>${f.checked}</td><td>${f.correct}</td><td>${f.wrong}</td><td>${f.missed}</td><td>${f.invented}</td><td><b>${f.accuracy}%</b></td><td>${f.meetsThreshold ? 'Meets' : 'Below'}</td></tr>`).join('');
  const flagRows = card.flags.map((f) => `<tr><td class="k">${esc(f.kind)}</td><td>${esc(f.document)}</td><td>${esc(f.field)}${f.row ? ` (row ${f.row})` : ''}</td><td>${esc(f.expected) || '<i>empty</i>'}</td><td>${esc(f.actual) || '<i>empty</i>'}</td><td>${f.confidence !== undefined ? `${f.confidence}%` : '–'}</td><td>${esc(f.note)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Document accuracy</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1d2433}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}
.v{font-size:15px;margin:8px 0}.ok{color:#17663a}.bad{color:#b3261e}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d6dae3;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f1f3f8}tr.below td{background:#fdecea}td.k{font-weight:600;white-space:nowrap}.n{color:#5b6475}
</style></head><body>
<h1>Document accuracy</h1>
<div class="v ${card.meetsThreshold ? 'ok' : 'bad'}"><b>${card.accuracy}%</b> of ${card.checked} values correct across ${card.documents} documents — ${card.meetsThreshold ? 'every field meets' : 'fields below'} the ${s.threshold}% threshold</div>
<div class="n">A value is correct when it matches the answer key after formatting is set aside (date, time and number notation). Empty expected values must stay empty.</div>
<h2>Accuracy per field</h2>
<table><tr><th>Field</th><th>Checked</th><th>Correct</th><th>Wrong</th><th>Missed</th><th>Invented</th><th>Accuracy</th><th>Threshold ${s.threshold}%</th></tr>${fieldRows}</table>
<h2>Reads to review (${card.flags.length})</h2>
<div class="n">Most severe first. High confidence: ${s.highConfidence}% or more. Low confidence: below ${s.lowConfidence}%. Wrong = a different value; missed = left empty; invented = a value where the document has none.</div>
${card.flags.length ? `<table><tr><th>Flag</th><th>Document</th><th>Field</th><th>Expected</th><th>Screen</th><th>Confidence</th><th>Note</th></tr>${flagRows}</table>` : '<p>None.</p>'}
</body></html>`;
}

/** Add the scorecard to a run's Allure results as its own entry, failed when below the threshold. */
export async function writeAllureScorecard(resultsDir: string, card: AccuracyScorecard): Promise<void> {
  const uuid = crypto.randomUUID();
  const attachment = `${uuid}-attachment.html`;
  const now = Date.now();
  const verdict = card.meetsThreshold ? 'all fields meet' : `${card.fields.filter((f) => !f.meetsThreshold).length} field(s) below`;
  await fs.writeFile(path.join(resultsDir, attachment), scorecardHtml(card), 'utf-8');
  await fs.writeFile(path.join(resultsDir, `${uuid}-result.json`), JSON.stringify({
    uuid,
    historyId: 'document-accuracy',
    name: `Document accuracy: ${card.accuracy}% (${verdict} the ${card.settings.threshold}% threshold)`,
    fullName: 'Document accuracy',
    status: card.meetsThreshold ? 'passed' : 'failed',
    ...(card.meetsThreshold ? {} : { statusDetails: { message: card.fields.filter((f) => !f.meetsThreshold).map((f) => `${f.field}: ${f.accuracy}%`).join('\n') } }),
    stage: 'finished',
    start: now,
    stop: now,
    labels: [{ name: 'suite', value: 'Document accuracy' }],
    attachments: [{ name: 'Document accuracy scorecard', source: attachment, type: 'text/html' }],
  }), 'utf-8');
}
