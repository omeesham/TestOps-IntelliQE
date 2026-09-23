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

/** A raised surface: white highlight along the top edge, soft violet ambient shadow. */
export const RAISED =
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05),0_12px_28px_-16px_rgba(76,29,149,0.4)]';
/** A raised surface that lifts further on hover. */
export const RAISED_HOVER =
  'transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.05),0_20px_36px_-16px_rgba(76,29,149,0.5)]';
/** A recessed surface: inputs, wells, table bodies. */
export const INSET =
  'shadow-[inset_0_1.5px_3px_rgba(30,27,75,0.08),inset_0_0_0_1px_rgba(221,214,254,0.35)]';
/** Small embossed chip: badges, pills, status codes. */
export const CHIP_3D =
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_1px_2px_rgba(30,27,75,0.10)]';

export const BRAND_BUTTON =
  'bg-gradient-to-b from-[#8B5CF6] to-[#6366F1] hover:from-[#7C3AED] hover:to-[#4F46E5]';
export const BAR_3D =
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05),0_8px_20px_-10px_rgba(76,29,149,0.35)]';
/** The primary key: a hard bottom edge for the raised face, a soft violet
    ambient glow, a lift on hover and a real press-down on click. */
export const BUTTON_3D =
  'shadow-[0_3px_0_0_#4338CA,0_8px_18px_-6px_rgba(99,102,241,0.55)] ' +
  'hover:-translate-y-px hover:shadow-[0_4px_0_0_#4338CA,0_12px_24px_-6px_rgba(99,102,241,0.6)] ' +
  'active:translate-y-[3px] active:shadow-[0_0_0_0_#4338CA,0_4px_10px_-6px_rgba(99,102,241,0.5)] ' +
  'disabled:translate-y-0 disabled:shadow-[0_2px_0_0_#c7d2fe] ' +
  'ring-1 ring-inset ring-white/25';
/** The secondary key: the same press mechanics on a white face with a violet edge. */
export const SECONDARY_3D =
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_0_0_#DDD6FE,0_6px_14px_-8px_rgba(76,29,149,0.35)] ' +
  'hover:-translate-y-px hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_3px_0_0_#C4B5FD,0_10px_18px_-8px_rgba(76,29,149,0.45)] ' +
  'active:translate-y-[2px] active:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_0_0_0_#DDD6FE,0_2px_6px_-6px_rgba(76,29,149,0.3)] ' +
  'disabled:translate-y-0 disabled:shadow-[0_1px_0_0_#EDE9FE]';
/** The primary call-to-action, fully assembled. */
export const PRIMARY_BTN = `inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-semibold text-white ${BRAND_BUTTON} ${BUTTON_3D} rounded-lg disabled:opacity-40 transition-all`;
export const SECONDARY_BTN = `inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium text-gray-600 bg-gradient-to-b from-white to-[#FAFAFE] border border-[#E4E0F5] rounded-md hover:text-[#7C3AED] hover:border-[#DDD6FE] transition-all disabled:opacity-40 ${SECONDARY_3D}`;
export const CARD = `bg-gradient-to-b from-white to-[#FCFBFF] border border-[#E9E5FB] rounded-xl ${RAISED}`;
/** An interactive card that lifts on hover. */
export const CARD_HOVER = `${CARD} ${RAISED_HOVER}`;
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
/** Table header strip: a light gradient with a bevelled bottom edge. */
export const THEAD = 'bg-gradient-to-b from-[#FAFAFE] to-[#F3F1FB] shadow-[inset_0_-1px_0_#E9E5FB,inset_0_1px_0_rgba(255,255,255,0.9)]';
/** Section/toolbar strip inside a card. */
export const STRIP = 'bg-gradient-to-b from-[#FCFBFF] to-[#F7F5FE] shadow-[inset_0_-1px_0_#EDE9FE,inset_0_1px_0_rgba(255,255,255,0.9)]';
/** Icon tile — the little squircle that holds a lucide icon. */
export const TILE = 'bg-gradient-to-br from-[#F5F3FF] to-[#EDE9FE] border border-[#DDD6FE] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_5px_-2px_rgba(76,29,149,0.35)]';
export const TILE_ACTIVE = 'bg-gradient-to-br from-[#8B5CF6] to-[#6366F1] border border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_4px_10px_-3px_rgba(124,58,237,0.6)]';

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
