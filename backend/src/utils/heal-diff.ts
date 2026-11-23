/**
 * heal-diff.ts
 * ────────────
 * Pure before→after diff for a self-heal proposal. A team only trusts auto-heal
 * when it can SEE exactly what a heal would change and explicitly approve it, so
 * this turns a proposal's "before" expectation and "after" patch into a readable
 * status + response-body diff. No DB, no network — directly unit-testable.
 */

export interface HealSide { status?: number; response?: string }

export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

export interface HealDiff {
  statusChanged: boolean;
  status?: { before?: number; after?: number };
  responseChanged: boolean;
  responseDiff: DiffLine[];
  /** Counts for an at-a-glance summary. */
  added: number;
  removed: number;
  summary: string;
}

const MAX_LINES = 400;

/** Standard LCS-based line diff (deterministic). Bounded to MAX_LINES per side. */
function lineDiff(beforeText: string, afterText: string): DiffLine[] {
  const a = beforeText.split('\n').slice(0, MAX_LINES);
  const b = afterText.split('\n').slice(0, MAX_LINES);
  const n = a.length, m = b.length;
  // LCS table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { out.push({ kind: 'del', text: a[i]! }); i++; }
    else { out.push({ kind: 'add', text: b[j]! }); j++; }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! });
  while (j < m) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

function normalize(s: string | undefined): string {
  if (!s) return '';
  // Pretty-print JSON so the diff is line-oriented and meaningful; fall back to raw.
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

export function buildHealDiff(before: HealSide, after: HealSide): HealDiff {
  const statusChanged = after.status !== undefined && after.status !== before.status;
  const beforeBody = normalize(before.response);
  const afterBody = normalize(after.response);
  const hasResponsePatch = after.response !== undefined;
  const responseDiff = hasResponsePatch ? lineDiff(beforeBody, afterBody) : [];
  const added = responseDiff.filter((l) => l.kind === 'add').length;
  const removed = responseDiff.filter((l) => l.kind === 'del').length;
  const responseChanged = added > 0 || removed > 0;

  const parts: string[] = [];
  if (statusChanged) parts.push(`status ${before.status ?? '—'} → ${after.status}`);
  if (responseChanged) parts.push(`response ${removed} removed / ${added} added`);
  const summary = parts.length ? parts.join(', ') : 'no change';

  return {
    statusChanged,
    status: statusChanged ? { before: before.status, after: after.status } : undefined,
    responseChanged,
    responseDiff,
    added,
    removed,
    summary,
  };
}
