/**
 * API Studio — pure formatting helpers.
 *
 * Split out of primitives.tsx so that file exports only components: mixing the
 * two breaks fast refresh, and these are the pieces the tabs reach for without
 * wanting a component.
 */

/* ── The standard colour code ──
 *
 * The studio used to colour-code HTTP methods and scenario categories with a
 * palette of its own — emerald, blue, amber, orange, cyan, slate. Nothing else
 * in IntelliQE does that, so the screen read as a different product bolted on.
 *
 * The rule now: colour means OUTCOME and nothing else. Passed is green, failed
 * is red, a warning is amber — the same three the Reports page and the run
 * notifications use. Every other badge (method, category, priority) is the
 * app's standard violet-indigo chip, exactly like the Web/API markers on the
 * Reports page, and its LABEL is what tells it apart.
 */

/** The app's standard badge: violet-600 text on the violet-50 surface. */
export const BRAND_CHIP = 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]';
/** A badge for something intentionally de-emphasised. */
export const MUTED_CHIP = 'text-[#6B7280] bg-gray-50 border-gray-200';

/* ── HTTP method ── */

export function methodColor(method: string): string {
  return (method || '').trim() ? BRAND_CHIP : MUTED_CHIP;
}

/* ── Scenario category ──

 * The generator's `type` is a coverage category — the reader is scanning for
 * "is my error handling covered?", so it is labelled that way rather than by
 * the raw enum value.
 */

const CATEGORY_LABELS: Record<string, string> = {
  positive: 'Contract',
  api: 'Contract',
  negative: 'Negative',
  security: 'Auth',
  data: 'Schema',
  edge: 'Edge',
  performance: 'Perf',
};

export function categoryMeta(type: string) {
  const key = (type || '').toLowerCase();
  return { label: CATEGORY_LABELS[key] || type || 'Other', cls: CATEGORY_LABELS[key] ? BRAND_CHIP : MUTED_CHIP };
}

/* ── Query parameters ──
 *
 * The URL bar stays the single source of truth for the run — every stage reads
 * `url`. The Params editor is a structured view over that URL's query string:
 * `parseQueryParams` reads rows out of it, `buildUrlWithParams` writes them back.
 * Both are total (never throw) so a half-typed URL still round-trips cleanly.
 */
import type { QueryParamRow } from './types';

function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

/** Read the `?key=value&…` of a URL into editor rows. Missing query → no rows. */
export function parseQueryParams(url: string): QueryParamRow[] {
  const q = url.indexOf('?');
  if (q === -1) return [];
  let search = url.slice(q + 1);
  const hash = search.indexOf('#');
  if (hash !== -1) search = search.slice(0, hash);
  if (!search) return [];
  return search.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    return { key: safeDecode(rawKey), value: safeDecode(rawVal), enabled: true };
  });
}

/**
 * Replace a URL's query string with the enabled, named rows — preserving the
 * part before the `?`. A disabled or blank-key row contributes nothing, so
 * unchecking a param drops it from the URL without losing it from the table.
 */
export function buildUrlWithParams(url: string, params: QueryParamRow[]): string {
  const q = url.indexOf('?');
  const base = q === -1 ? url : url.slice(0, q);
  const qs = params
    .filter((p) => p.enabled && p.key.trim())
    .map((p) => `${encodeURIComponent(p.key.trim())}=${encodeURIComponent(p.value)}`)
    .join('&');
  return qs ? `${base}?${qs}` : base;
}

/** Pretty-print JSON when it parses; otherwise show the text as given. */
export function prettyJson(text: string | undefined): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/* ── Durations and clock times ── */

/* ── Formatting ─────────────────────────────────────────────────────────── */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return `${m}m ${rest}s`;
}

export function clock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
