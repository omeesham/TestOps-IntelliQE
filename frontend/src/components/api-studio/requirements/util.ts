/**
 * Requirements Management dashboard — pure helpers.
 *
 * Split out of the component files so those export only components (mixing the
 * two breaks fast refresh, the same rule format.ts follows). Nothing here holds
 * state or touches the network; every function is total and side-effect-free.
 */
import type { IntegrationDashboard, IntegratedMatrix, IntegratedRow, ReviewFlag } from '@/services/api';

/** The mockup shows a requirement's identity as the joined BRD + FRD keys
 *  ("BRD-001 / FRD-001"). Build that from whichever side the matrix row is. */
export function combinedReqId(row: IntegratedRow): string {
  if (row.source === 'brd') {
    const frds = (row.frdRefs || []).join(', ');
    return frds ? `${row.reqKey} / ${frds}` : row.reqKey;
  }
  if (row.source === 'frd') {
    return row.brdRef ? `${row.brdRef} / ${row.reqKey}` : row.reqKey;
  }
  return row.reqKey;
}

/** The first item of a list, with a "+N" when there are more — so a cell shows
 *  a representative value (as the mockup does) without losing the count. */
export function firstOf(items?: string[]): { text: string; more: number; full: string } {
  const list = (items || []).filter(Boolean);
  return { text: list[0] || '', more: Math.max(0, list.length - 1), full: list.join(' · ') };
}

/** What every tab receives from the dashboard shell: the selected run, the two
 *  live aggregates (dashboard + integrated matrix), the run list, the current
 *  username (for Jira/ADO reads) and a reload for the shared processing status. */
export interface RmTabProps {
  runId: string;
  dash: IntegrationDashboard | null;
  matrix: IntegratedMatrix | null;
  loadingGlobal: boolean;
  username: string;
  reloadGlobal: () => Promise<void>;
  /** Close the dashboard (used by the generation tab to hand off to the pipeline). */
  onClose: () => void;
  /** Switch the dashboard to another tab (used by "View All" links). */
  onNavigate: (view: 'brd' | 'frd' | 'analysis' | 'mapping' | 'generation') => void;
}

/** A page's worth of rows out of a longer list, plus the paging math. */
export function paginate<T>(rows: T[], page: number, pageSize: number): { slice: T[]; page: number; pageCount: number; from: number; to: number } {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safe = Math.min(Math.max(1, page), pageCount);
  const start = (safe - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return { slice, page: safe, pageCount, from: rows.length === 0 ? 0 : start + 1, to: Math.min(rows.length, start + pageSize) };
}

/** Case-insensitive "do any of these fields contain the query" test. */
export function matchesSearch(query: string, ...fields: (string | undefined | null)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f || '').toLowerCase().includes(q));
}

/** Human-readable byte size for an attachment. */
export function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The single worst review flag on a requirement, for a compact status cell. */
export function worstFlag(flags?: ReviewFlag[]): ReviewFlag['code'] | 'ok' {
  if (!flags || flags.length === 0) return 'ok';
  if (flags.some((f) => f.code === 'conflict')) return 'conflict';
  if (flags.some((f) => f.code === 'ambiguous')) return 'ambiguous';
  return 'incomplete';
}

/** The six-step processing pipeline the dashboard reports, derived from REAL
 *  backend aggregates — never a canned "success". A step is `done` only when the
 *  data proves it happened; `count` is shown when the step produced something. */
export interface ProcessingStep {
  key: string;
  label: string;
  done: boolean;
  count?: number;
  detail?: string;
}

export function buildProcessingSteps(dash: IntegrationDashboard | null, matrix: IntegratedMatrix | null): ProcessingStep[] {
  const brdDocs = dash?.requirements.brdDocs ?? 0;
  const frdDocs = dash?.requirements.frdDocs ?? 0;
  const imports = dash?.imports.total ?? 0;
  const reqs = dash?.requirements.total ?? 0;
  const rows = matrix?.rows ?? [];
  const mapped = rows.filter((r) => r.endpoints.length > 0).length;
  const cases = rows.reduce((n, r) => n + r.cases.length, 0);
  const scripts = rows.reduce((n, r) => n + (r.scriptPaths?.length || 0), 0);
  const runs = dash?.kpis.runs ?? 0;
  const lastPass = dash?.kpis.lastPassRate ?? null;

  return [
    { key: 'fetch', label: 'Document Fetching', done: brdDocs + frdDocs + imports > 0, count: brdDocs + frdDocs, detail: imports ? `${imports} imports` : undefined },
    { key: 'extract', label: 'Requirements Extracted', done: reqs > 0, count: reqs },
    { key: 'map', label: 'APIs Mapped', done: mapped > 0, count: mapped },
    { key: 'generate', label: 'Test Cases Generated', done: cases > 0, count: cases },
    { key: 'scripts', label: 'Automation Scripts Generated', done: scripts > 0, count: scripts },
    { key: 'execute', label: 'Execution Completed', done: runs > 0, count: runs, detail: lastPass != null ? `${lastPass}% pass` : undefined },
  ];
}

/** Coverage → donut segments (value + colour + label), skipping empties. */
export interface DonutSeg { label: string; value: number; color: string }
export function coverageSegments(c: IntegratedMatrix['summary'] | IntegrationDashboard['coverage'] | null | undefined): DonutSeg[] {
  if (!c) return [];
  return [
    { label: 'Covered', value: c.covered, color: '#10B981' },
    { label: 'Partial', value: c.partial, color: '#F59E0B' },
    { label: 'Failing', value: c.failing, color: '#EF4444' },
    { label: 'Uncovered', value: c.uncovered, color: '#D1D5DB' },
  ].filter((s) => s.value > 0);
}
