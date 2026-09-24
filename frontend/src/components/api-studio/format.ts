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
  e2e: 'Flow',
  flow: 'Flow',
};

/* ── Surfaces — the 3D language ──
   The workspace borrows the raised, tactile surfaces of Postman and Bruno
   while staying in the app's violet-indigo palette. Three rules keep it
   coherent: RAISED things (cards, buttons, chips) get a top highlight plus a
   violet-tinted drop shadow; INSET things (inputs, tables, wells) get an inner
   shadow; PRESSABLE things get a hard bottom edge that collapses on click.
   Purely presentational — no run logic depends on any of these classes. */

/*
 * Native alignment: the app's global stylesheet (src/index.css) already skins
 * `.bg-white.rounded-xl/2xl` cards, buttons, inputs and `thead` with the violet
 * raised/hover/inset polish shared by every native page. The studio used to opt
 * out (`data-surface="3d"`) and hand-roll the same effects here. It no longer
 * opts out, so these helpers are neutralised — the shared layer does the work,
 * and the tokens below carry only the native flat class strings. Kept as
 * exported names so call sites need no churn.
 */
export const RAISED = '';
export const RAISED_HOVER = '';
export const INSET = '';
export const CHIP_3D = '';
export const BAR_3D = '';
export const BUTTON_3D = '';
export const SECONDARY_3D = '';

/** The app's primary gradient — matches every native primary button. */
export const BRAND_BUTTON =
  'bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5]';
/** The primary call-to-action — native gradient + soft violet shadow. */
export const PRIMARY_BTN = `inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-semibold text-white ${BRAND_BUTTON} rounded-lg shadow-md shadow-purple-500/25 disabled:opacity-40 transition-all`;
/** The secondary call-to-action — the native white/outline button. */
export const SECONDARY_BTN = 'inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-[#7C3AED] transition-colors disabled:opacity-40';
/** The native card/panel — the global stylesheet adds the violet raise + hover. */
export const CARD = 'bg-white rounded-2xl border border-gray-100 shadow-sm';
/** An interactive card (hover handled globally, with an explicit fallback). */
export const CARD_HOVER = `${CARD} transition-shadow hover:shadow-md`;
/**
 * A form field WITHOUT a width, so the call site can size it. Use this whenever
 * the control is not meant to fill its row.
 *
 * Two utilities that set the same property never "override" each other by the
 * order they are written in a className — Tailwind emits them in its own order
 * and the later rule in the stylesheet wins. `INPUT w-auto` therefore stayed
 * full-width and stretched across the toolbar; `FIELD w-auto` has no conflict.
 */
export const FIELD = `px-2.5 py-1.5 text-[12px] text-gray-800 bg-[#FCFBFF] border border-[#E4E0F5] rounded-md outline-none placeholder-gray-300 focus:bg-white focus:border-[#A5B4FC] focus:ring-2 focus:ring-[#EDE9FE] disabled:bg-gray-50 disabled:text-gray-500 ${INSET}`;
/** The same field, filling its container — the common case in forms. */
export const INPUT = `w-full ${FIELD}`;
export const LABEL = 'block text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 mb-1';
/** Table header strip — the native `bg-gray-50` head (global CSS bevels it). */
export const THEAD = 'bg-gray-50';
/** Section/toolbar strip inside a card — a light native tint. */
export const STRIP = 'bg-gray-50/60 border-gray-100';
/** Icon tile — the little squircle that holds a lucide icon (native flat violet). */
export const TILE = 'bg-[#F5F3FF] border border-[#DDD6FE]';
export const TILE_ACTIVE = 'bg-gradient-to-br from-[#7C3AED] to-[#6366F1] border border-transparent';

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

/* ── Relative time ── */

export function relativeTime(iso: string | number | null | undefined): string {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

/* ── Catalogue helpers ── */

let seq = 0;
/** A client-side id for a catalogue endpoint — unique for the session. */
export function newEndpointId(): string {
  return `ep-${Date.now().toString(36)}-${(++seq).toString(36)}`;
}

/**
 * `https://api.x.com/v1/users?limit=1` → `/v1/users` (what the table shows).
 *
 * `URL.pathname` percent-encodes the braces of a templated path, so an OpenAPI
 * `/orders/{id}` would otherwise read `/orders/%7Bid%7D` everywhere it appears.
 */
export function pathOf(url: string): string {
  try {
    const path = new URL(url).pathname || '/';
    try { return decodeURIComponent(path); } catch { return path; }
  } catch { return url; }
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/** Human label for an import method id. */
export const IMPORT_METHOD_LABELS: Record<string, string> = {
  openapi: 'OpenAPI / Swagger',
  postman: 'Postman',
  endpoint: 'API URL',
  curl: 'cURL',
  'docs-url': 'Docs URL',
  connector: 'Connector',
  sdk: 'SDK',
  webhook: 'Webhook',
  graphql: 'GraphQL',
  mcp: 'MCP server',
  middleware: 'Middleware',
  manual: 'Manual',
  file: 'File',
};
