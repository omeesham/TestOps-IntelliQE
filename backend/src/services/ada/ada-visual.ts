/**
 * UX / visual checks — what a designer would catch by looking at the page.
 *
 * Runs on a page that is already loaded, once per device profile. Two families:
 *
 *   LAYOUT INTEGRITY   objective, always scored
 *     ux-overlap            two controls drawn on top of each other
 *     ux-occluded           a control covered by another element (cannot be clicked)
 *     ux-overlay-blocks     one overlay (cookie bar, modal) covering many controls
 *     ux-overflow-x         the page scrolls sideways
 *     ux-clipped-text       a heading / button / label whose text is cut off
 *     ux-touch-target       (touch devices) a control smaller than the minimum target
 *
 *   DESIGN ADHERENCE   scored only against an uploaded design standard
 *     ux-font-family        font family not in the standard
 *     ux-font-not-loaded    declared web font did not load — fallback is rendering
 *     ux-font-size          size not on the type scale
 *     ux-font-weight        weight not in the standard
 *     ux-color-drift        a colour almost, but not exactly, a palette colour
 *     ux-color-off-palette  a colour nowhere near the palette
 *     ux-radius             button / input corner radius not in the standard
 *     ux-spacing            button padding not on the spacing scale
 *
 * Anything heuristic is marked `confidence: 'review'` — shown with evidence,
 * never scored: alignment near-misses, uneven gaps, and (when no standard is
 * uploaded) the site's own inconsistencies.
 */
import fs from 'fs/promises';
import path from 'path';
import type { Page } from '@playwright/test';
import type { Finding, Severity } from './ada-types.js';
import type { DeviceProfile } from './ada-devices.js';
import { type DesignStandard, deltaE, nearestColor, parseColor } from './ada-design-standard.js';

export type UxConfidence = 'high' | 'review';
export type UxFamily = 'layout' | 'adherence' | 'consistency';

interface RawEl {
  sel: string; tag: string; role: string; text: string;
  x: number; y: number; w: number; h: number;
  family: string; fontLoaded: boolean; size: number; weight: number;
  color: string; ownBg: string | null; border: string | null;
  radius: number; padX: number; padY: number; interactive: boolean;
}
interface RawIssue {
  kind: 'overlap' | 'occluded' | 'overlay' | 'overflow-x' | 'clipped' | 'touch-target' | 'misaligned' | 'uneven-gap';
  sel: string; text: string; x: number; y: number; w: number; h: number;
  other?: string; actual?: string; expected?: string; count?: number;
}
interface Collected { vw: number; vh: number; docWidth: number; elements: RawEl[]; issues: RawIssue[] }

interface Issue {
  ruleId: string; family: UxFamily; title: string; severity: Severity; confidence: UxConfidence;
  sel: string; text: string; rect: { x: number; y: number; w: number; h: number };
  actual?: string; expected?: string; description: string; count: number;
}

export interface VisualPageResult {
  findings: Finding[];
  layoutScore: number;
  /** null when no design standard was supplied. */
  adherenceScore: number | null;
  /** Typography and colour usage on this page, for the site-wide inventory. */
  typography: { role: string; family: string; size: number; weight: number; uses: number }[];
  colors: { hex: string; kind: 'text' | 'background' | 'border'; uses: number }[];
}

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, serious: 6, moderate: 3, minor: 1 };
const MAX_EVIDENCE_PER_RULE = 2;

const RULES: Record<string, { family: UxFamily; title: string; severity: Severity; confidence: UxConfidence }> = {
  'ux-overlap': { family: 'layout', title: 'Controls overlap each other', severity: 'serious', confidence: 'high' },
  'ux-occluded': { family: 'layout', title: 'Control is covered by another element', severity: 'serious', confidence: 'high' },
  'ux-overlay-blocks': { family: 'layout', title: 'An overlay covers several controls', severity: 'moderate', confidence: 'review' },
  'ux-overflow-x': { family: 'layout', title: 'Page scrolls sideways', severity: 'serious', confidence: 'high' },
  'ux-clipped-text': { family: 'layout', title: 'Text is cut off', severity: 'moderate', confidence: 'high' },
  'ux-touch-target': { family: 'layout', title: 'Touch target is too small', severity: 'moderate', confidence: 'high' },
  'ux-misaligned': { family: 'layout', title: 'Element is a few pixels out of line with its siblings', severity: 'minor', confidence: 'review' },
  'ux-uneven-gap': { family: 'layout', title: 'Uneven spacing between sibling elements', severity: 'minor', confidence: 'review' },
  'ux-font-family': { family: 'adherence', title: 'Font family is not in the design standard', severity: 'moderate', confidence: 'high' },
  'ux-font-not-loaded': { family: 'adherence', title: 'Web font did not load — a fallback font is showing', severity: 'moderate', confidence: 'high' },
  'ux-font-size': { family: 'adherence', title: 'Font size is not on the type scale', severity: 'minor', confidence: 'high' },
  'ux-font-weight': { family: 'adherence', title: 'Font weight is not in the design standard', severity: 'minor', confidence: 'high' },
  'ux-color-drift': { family: 'adherence', title: 'Colour is slightly off a palette colour', severity: 'minor', confidence: 'high' },
  'ux-color-off-palette': { family: 'adherence', title: 'Colour is not in the palette', severity: 'moderate', confidence: 'high' },
  'ux-radius': { family: 'adherence', title: 'Corner radius is not in the design standard', severity: 'minor', confidence: 'high' },
  'ux-spacing': { family: 'adherence', title: 'Button padding is not on the spacing scale', severity: 'minor', confidence: 'review' },
  'ux-inconsistent-type': { family: 'consistency', title: 'Same kind of text is styled differently on this page', severity: 'minor', confidence: 'review' },
  'ux-near-duplicate-color': { family: 'consistency', title: 'Two almost identical colours are in use', severity: 'minor', confidence: 'review' },
  'ux-many-font-families': { family: 'consistency', title: 'Many different font families on one page', severity: 'minor', confidence: 'review' },
};

/* ───────────────────────────── in-page collection ───────────────────────────── */

async function collect(page: Page, touch: boolean, minTarget: number): Promise<Collected> {
  return page.evaluate(({ touch, minTarget }) => {
    const MAX_TEXT = 600, MAX_INTERACTIVE = 200, MAX_PER_KIND = 25;
    const sx = window.scrollX, sy = window.scrollY;
    const vw = window.innerWidth, vh = window.innerHeight;
    const docWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);

    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let cur: Element | null = el;
      for (let depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++) {
        if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
        let part = cur.tagName.toLowerCase();
        const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter((c) => /^[A-Za-z_-][\w-]*$/.test(c)).slice(0, 2);
        if (cls.length) part += '.' + cls.join('.');
        const parent: Element | null = cur.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
        parts.unshift(part);
        cur = parent;
      }
      return parts.join(' > ');
    };
    // Computed colours come back in whatever space the site declared them in —
    // rgb(), oklch(), color(display-p3 …), lab()… Rather than parse each, let
    // the browser convert: paint one pixel and read it back as sRGB.
    const swatch = document.createElement('canvas');
    swatch.width = swatch.height = 1;
    const ink = swatch.getContext('2d', { willReadFrequently: true });
    const hexCache = new Map<string, string | null>();
    const toHex = (c: string): string | null => {
      if (!c || c === 'transparent') return null;
      const hit = hexCache.get(c);
      if (hit !== undefined) return hit;
      let out: string | null = null;
      if (ink) {
        ink.clearRect(0, 0, 1, 1);
        ink.fillStyle = '#000';
        ink.fillStyle = c; // an unparseable value leaves the previous fillStyle in place
        ink.fillRect(0, 0, 1, 1);
        const d = ink.getImageData(0, 0, 1, 1).data;
        if (d[3] >= 128) out = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      }
      hexCache.set(c, out);
      return out;
    };
    const visible = (el: Element, r: DOMRect, cs: CSSStyleDeclaration) =>
      r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05 &&
      r.right + sx > 0 && r.left + sx < docWidth + 1 && r.bottom + sy > 0;
    const isFixed = (el: Element): boolean => {
      for (let c: Element | null = el; c; c = c.parentElement) { const p = getComputedStyle(c).position; if (p === 'fixed' || p === 'sticky') return true; }
      return false;
    };
    const ownText = (el: Element) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent || '').join('').trim();
    const snippet = (el: Element) => ((el as HTMLElement).innerText || el.getAttribute('aria-label') || (el as HTMLInputElement).value || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const roleOf = (el: Element): string => {
      const t = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(t)) return t;
      if (t === 'button' || el.getAttribute('role') === 'button' || (t === 'input' && /^(submit|button|reset)$/.test((el as HTMLInputElement).type))) return 'button';
      if (t === 'a') return 'link';
      if (t === 'input' || t === 'select' || t === 'textarea') return 'input';
      if (t === 'label') return 'label';
      return 'body';
    };

    /* ── text / style sample ── */
    const elements: any[] = [];
    const textSel = 'h1,h2,h3,h4,h5,h6,p,li,a,button,[role="button"],input:not([type="hidden"]),select,textarea,label,th,td,blockquote,figcaption,summary';
    for (const el of Array.from(document.querySelectorAll(textSel))) {
      if (elements.length >= MAX_TEXT) break;
      const tag = el.tagName.toLowerCase();
      const isControl = tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button';
      if (!isControl && !ownText(el)) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!visible(el, r, cs)) continue;
      const family = (cs.fontFamily || '').split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
      let fontLoaded = true;
      try { fontLoaded = (document as any).fonts ? (document as any).fonts.check(`${cs.fontSize} "${family}"`) : true; } catch { fontLoaded = true; }
      const bw = parseFloat(cs.borderTopWidth) || 0;
      const rad = parseFloat(cs.borderTopLeftRadius) || 0;
      elements.push({
        sel: cssPath(el), tag, role: roleOf(el), text: snippet(el),
        x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height),
        family, fontLoaded, size: Math.round(parseFloat(cs.fontSize) * 100) / 100, weight: parseInt(cs.fontWeight, 10) || 400,
        color: toHex(cs.color) || '', ownBg: toHex(cs.backgroundColor), border: bw > 0 ? toHex(cs.borderTopColor) : null,
        radius: rad >= r.height / 2 - 0.5 ? -1 : Math.round(rad * 100) / 100, // -1 = pill / fully rounded
        padX: Math.round(parseFloat(cs.paddingLeft) * 100) / 100, padY: Math.round(parseFloat(cs.paddingTop) * 100) / 100,
        interactive: isControl || tag === 'a',
      });
    }

    /* ── interactive geometry ── */
    const issues: any[] = [];
    const counts: Record<string, number> = {};
    const add = (i: any) => { counts[i.kind] = (counts[i.kind] || 0) + 1; if (counts[i.kind] <= MAX_PER_KIND) issues.push(i); };
    const inter: { el: Element; r: DOMRect; fixed: boolean; href: string }[] = [];
    for (const el of Array.from(document.querySelectorAll('a[href],button,[role="button"],input:not([type="hidden"]),select,textarea,summary'))) {
      if (inter.length >= MAX_INTERACTIVE) break;
      const r = el.getBoundingClientRect();
      if (!visible(el, r, getComputedStyle(el))) continue;
      inter.push({ el, r, fixed: isFixed(el), href: (el as HTMLAnchorElement).href || '' });
    }
    const box = (el: Element, r: DOMRect) => ({ sel: cssPath(el), text: snippet(el), x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) });

    // Overlap: two controls sharing > 30% of the smaller one's area.
    for (let i = 0; i < inter.length; i++) {
      for (let j = i + 1; j < inter.length; j++) {
        const a = inter[i], b = inter[j];
        if (a.fixed !== b.fixed) continue; // sticky header over content is by design
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (a.href && a.href === b.href) continue; // image + title linking to the same place
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix <= 2 || iy <= 2) continue;
        const ratio = (ix * iy) / Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
        if (ratio > 0.3) add({ kind: 'overlap', ...box(a.el, a.r), other: cssPath(b.el), actual: `${Math.round(ratio * 100)}% of "${snippet(b.el) || b.el.tagName.toLowerCase()}" is underneath` });
      }
    }

    // Touch targets (touch devices only). Inline links inside running text are exempt, as in WCAG 2.5.8.
    if (touch) {
      for (const it of inter) {
        const el = it.el;
        if (el.tagName === 'A') {
          const parent = el.parentElement;
          if (parent && /^(P|LI|SPAN|TD|DD|BLOCKQUOTE)$/.test(parent.tagName) && ownText(parent).length > 20) continue;
        }
        if (it.r.width < minTarget - 0.5 || it.r.height < minTarget - 0.5) add({ kind: 'touch-target', ...box(el, it.r), actual: `${Math.round(it.r.width)} × ${Math.round(it.r.height)} px`, expected: `${minTarget} × ${minTarget} px` });
      }
    }

    // Clipped text on headings, buttons, labels and links.
    for (const el of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,button,[role="button"],label,th,nav a'))) {
      const h = el as HTMLElement;
      if (!ownText(el) && !h.innerText) continue;
      const cs = getComputedStyle(el);
      if (!(cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.textOverflow === 'ellipsis')) continue;
      if (h.scrollWidth <= h.clientWidth + 2) continue;
      const r = el.getBoundingClientRect();
      if (!visible(el, r, cs)) continue;
      add({ kind: 'clipped', ...box(el, r), actual: `${h.scrollWidth - h.clientWidth} px of text hidden` });
    }

    // Sideways scrolling, with the elements that cause it.
    if (docWidth > vw + 4) {
      const culprits: { el: Element; r: DOMRect }[] = [];
      for (const el of Array.from(document.body ? document.body.querySelectorAll('*') : []).slice(0, 4000)) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.right + sx <= vw + 4) continue;
        if (!visible(el, r, getComputedStyle(el))) continue;
        if (Array.from(el.children).some((c) => c.getBoundingClientRect().right + sx > vw + 4)) continue; // keep the deepest culprit
        culprits.push({ el, r });
      }
      culprits.sort((a, b) => b.r.right - a.r.right);
      const first = culprits[0];
      add({
        kind: 'overflow-x', ...(first ? box(first.el, first.r) : { sel: 'html', text: '', x: 0, y: 0, w: vw, h: 100 }),
        actual: `page is ${docWidth} px wide in a ${vw} px viewport`, expected: `${vw} px`,
        other: culprits.slice(0, 3).map((c) => cssPath(c.el)).join(' , '),
      });
    }

    // Alignment and spacing of sibling groups (review-level).
    const mode = (vals: number[]) => { const m = new Map<number, number>(); let best = vals[0], n = 0; for (const v of vals) { const c = (m.get(v) || 0) + 1; m.set(v, c); if (c > n) { n = c; best = v; } } return { value: best, count: n }; };
    let groups = 0;
    for (const parent of Array.from(document.querySelectorAll('ul,ol,nav,form,section,main,footer,header,div'))) {
      if (groups >= 250) break;
      const kids = Array.from(parent.children).filter((k) => { const r = k.getBoundingClientRect(); return visible(k, r, getComputedStyle(k)); });
      if (kids.length < 3 || kids.length > 40) continue;
      const tagMode = mode(kids.map((k) => k.tagName.charCodeAt(0) * 1000 + k.tagName.length));
      if (tagMode.count / kids.length < 0.8) continue;
      groups++;
      const rs = kids.map((k) => k.getBoundingClientRect());
      const stacked = rs.every((r, i) => i === 0 || r.top >= rs[i - 1].bottom - 2);
      const inRow = rs.every((r, i) => i === 0 || (r.left >= rs[i - 1].right - 2 && Math.abs(r.top - rs[0].top) < Math.max(40, rs[0].height)));
      if (!stacked && !inRow) continue;
      if (stacked) {
        const lefts = mode(rs.map((r) => Math.round(r.left)));
        if (lefts.count >= Math.ceil(kids.length * 0.6)) rs.forEach((r, i) => { const d = Math.abs(Math.round(r.left) - lefts.value); if (d >= 1 && d <= 4) add({ kind: 'misaligned', ...box(kids[i], r), actual: `left edge ${d} px off its ${lefts.count} siblings`, expected: `x = ${lefts.value}` }); });
      } else {
        const tops = mode(rs.map((r) => Math.round(r.top))), mids = mode(rs.map((r) => Math.round(r.top + r.height / 2))), bots = mode(rs.map((r) => Math.round(r.bottom)));
        rs.forEach((r, i) => {
          const dt = Math.abs(Math.round(r.top) - tops.value), dm = Math.abs(Math.round(r.top + r.height / 2) - mids.value), db = Math.abs(Math.round(r.bottom) - bots.value);
          const d = Math.min(dt, dm, db);
          if (d >= 1 && d <= 4 && Math.max(tops.count, mids.count, bots.count) >= Math.ceil(kids.length * 0.6)) add({ kind: 'misaligned', ...box(kids[i], r), actual: `${d} px off the row its siblings share`, expected: 'same top, centre or bottom as its siblings' });
        });
      }
      const gaps = rs.slice(1).map((r, i) => Math.round(stacked ? r.top - rs[i].bottom : r.left - rs[i].right));
      if (gaps.length >= 3) {
        const g = mode(gaps);
        if (g.count >= Math.ceil(gaps.length * 0.6)) gaps.forEach((v, i) => { const d = Math.abs(v - g.value); if (d >= 2 && d <= 16) add({ kind: 'uneven-gap', ...box(kids[i + 1], rs[i + 1]), actual: `${v} px gap`, expected: `${g.value} px like its ${g.count} siblings` }); });
      }
    }

    // Occlusion: is each control actually on top at its centre? Scroll it into view first.
    const prevBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    const occluders = new Map<Element, { el: Element; r: DOMRect }[]>();
    for (const it of inter.slice(0, 120)) {
      if (it.fixed) continue;
      try { (it.el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { continue; }
      const r = it.el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
      const top = document.elementFromPoint(cx, cy);
      if (!top || top === it.el || it.el.contains(top) || top.contains(it.el)) continue;
      if (top.tagName === 'LABEL' && (top as HTMLLabelElement).control === it.el) continue;
      const list = occluders.get(top) || [];
      list.push({ el: it.el, r: new DOMRect(r.left + window.scrollX - sx, r.top + window.scrollY - sy, r.width, r.height) });
      occluders.set(top, list);
    }
    window.scrollTo(sx, sy);
    document.documentElement.style.scrollBehavior = prevBehavior;
    for (const [top, covered] of occluders) {
      if (covered.length >= 4) {
        const r = top.getBoundingClientRect();
        add({ kind: 'overlay', ...box(top, r), count: covered.length, actual: `covers ${covered.length} controls`, other: covered.slice(0, 3).map((c) => cssPath(c.el)).join(' , ') });
      } else {
        for (const c of covered) add({ kind: 'occluded', ...box(c.el, c.r), other: cssPath(top), actual: `covered by ${cssPath(top)}` });
      }
    }

    return { vw, vh, docWidth, elements, issues };
  }, { touch, minTarget }) as Promise<Collected>;
}

/* ───────────────────────────── checks ───────────────────────────── */

const near = (v: number, list: number[], tol: number) => list.some((x) => Math.abs(x - v) <= tol);
const nearest = (v: number, list: number[]) => list.reduce((best, x) => Math.abs(x - v) < Math.abs(best - v) ? x : best, list[0]);
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont', 'cursive', 'fantasy']);

function issue(ruleId: string, e: { sel: string; text: string; x: number; y: number; w: number; h: number }, description: string, extra: { actual?: string; expected?: string; count?: number } = {}): Issue {
  const r = RULES[ruleId];
  return { ruleId, family: r.family, title: r.title, severity: r.severity, confidence: r.confidence, sel: e.sel, text: e.text, rect: { x: e.x, y: e.y, w: e.w, h: e.h }, description, count: extra.count ?? 1, actual: extra.actual, expected: extra.expected };
}

function layoutIssues(c: Collected, device: DeviceProfile): Issue[] {
  const out: Issue[] = [];
  for (const i of c.issues) {
    const what = i.text ? `"${i.text}"` : i.sel;
    if (i.kind === 'overlap') out.push(issue('ux-overlap', i, `${what} and ${i.other} are drawn on top of each other — ${i.actual}.`, { actual: i.actual }));
    else if (i.kind === 'occluded') out.push(issue('ux-occluded', i, `${what} cannot be clicked at its centre: it is ${i.actual}.`, { actual: i.actual }));
    else if (i.kind === 'overlay') out.push(issue('ux-overlay-blocks', i, `${i.sel} ${i.actual} (${i.other}). If this is a cookie or consent bar it is expected on first load; if not, it is blocking the page.`, { actual: i.actual, count: 1 }));
    else if (i.kind === 'overflow-x') { const o = issue('ux-overflow-x', i, `The ${i.actual}, so it scrolls sideways on ${device.label}. Widest offenders: ${i.other || i.sel}.`, { actual: i.actual, expected: i.expected }); if (device.kind === 'desktop') o.severity = 'moderate'; out.push(o); }
    else if (i.kind === 'clipped') out.push(issue('ux-clipped-text', i, `${what} is cut off — ${i.actual}.`, { actual: i.actual }));
    else if (i.kind === 'touch-target') out.push(issue('ux-touch-target', i, `${what} is ${i.actual}; the minimum comfortable touch target is ${i.expected}.`, { actual: i.actual, expected: i.expected }));
    else if (i.kind === 'misaligned') out.push(issue('ux-misaligned', i, `${what}: ${i.actual}.`, { actual: i.actual, expected: i.expected }));
    else if (i.kind === 'uneven-gap') out.push(issue('ux-uneven-gap', i, `${what} has a ${i.actual}; expected ${i.expected}.`, { actual: i.actual, expected: i.expected }));
  }
  return out;
}

function adherenceIssues(c: Collected, s: DesignStandard): Issue[] {
  const out: Issue[] = [];
  const colorCheck = (e: RawEl, hex: string | null, what: string) => {
    if (!hex || !s.colors.length) return;
    if (s.allowBlackWhite && (hex === '#FFFFFF' || hex === '#000000')) return;
    const n = nearestColor(hex, s.colors);
    if (!n || n.deltaE <= s.tolerance.colorDeltaE) return;
    if (n.deltaE <= s.tolerance.driftDeltaE) out.push(issue('ux-color-drift', e, `${what} ${hex} is close to, but not, the palette colour ${n.color.name} ${n.color.hex} (ΔE ${n.deltaE.toFixed(1)}).`, { actual: hex, expected: `${n.color.hex} (${n.color.name})` }));
    else out.push(issue('ux-color-off-palette', e, `${what} ${hex} is not in the palette. Nearest is ${n.color.name} ${n.color.hex} (ΔE ${n.deltaE.toFixed(1)}).`, { actual: hex, expected: `a palette colour — nearest ${n.color.hex} (${n.color.name})` }));
  };
  for (const e of c.elements) {
    if (s.fontFamilies.length && e.family && !GENERIC.has(e.family)) {
      if (!s.fontFamilies.includes(e.family)) out.push(issue('ux-font-family', e, `${e.role} text uses "${e.family}", which is not in the design standard (${s.fontFamilies.join(', ')}).`, { actual: e.family, expected: s.fontFamilies.join(', ') }));
      else if (!e.fontLoaded) out.push(issue('ux-font-not-loaded', e, `"${e.family}" is declared but did not load, so the browser is showing a fallback font.`, { actual: `${e.family} (not loaded)`, expected: e.family }));
    }
    if (s.fontSizes.length && !near(e.size, s.fontSizes, s.tolerance.px)) out.push(issue('ux-font-size', e, `${e.role} text is ${e.size}px; the nearest size on the type scale is ${nearest(e.size, s.fontSizes)}px.`, { actual: `${e.size}px`, expected: `${nearest(e.size, s.fontSizes)}px` }));
    if (s.fontWeights.length && !s.fontWeights.includes(e.weight)) out.push(issue('ux-font-weight', e, `${e.role} text uses weight ${e.weight}; the standard allows ${s.fontWeights.join(', ')}.`, { actual: String(e.weight), expected: s.fontWeights.join(', ') }));
    colorCheck(e, e.color || null, 'Text colour');
    colorCheck(e, e.ownBg, 'Background colour');
    colorCheck(e, e.border, 'Border colour');
    if ((e.role === 'button' || e.role === 'input') && s.radii.length && e.radius > 0 && !near(e.radius, s.radii, s.tolerance.px)) out.push(issue('ux-radius', e, `Corner radius is ${e.radius}px; the standard allows ${s.radii.join(', ')}px.`, { actual: `${e.radius}px`, expected: `${nearest(e.radius, s.radii)}px` }));
    if (e.role === 'button' && s.spacing.length && e.padX > 0 && !near(e.padX, s.spacing, s.tolerance.px)) out.push(issue('ux-spacing', e, `Horizontal padding is ${e.padX}px; the nearest step on the spacing scale is ${nearest(e.padX, s.spacing)}px.`, { actual: `${e.padX}px`, expected: `${nearest(e.padX, s.spacing)}px` }));
  }
  return out;
}

/** With no standard to compare against, report only the page's own inconsistencies — as observations. */
function consistencyIssues(c: Collected): Issue[] {
  const out: Issue[] = [];
  const byRole = new Map<string, Map<string, RawEl[]>>();
  for (const e of c.elements) {
    if (!/^h[1-6]$|^button$/.test(e.role)) continue;
    const styles = byRole.get(e.role) || new Map<string, RawEl[]>();
    const key = `${e.family} ${e.size}px ${e.weight}`;
    styles.set(key, [...(styles.get(key) || []), e]);
    byRole.set(e.role, styles);
  }
  for (const [role, styles] of byRole) {
    if (styles.size < 2) continue;
    const sorted = [...styles.entries()].sort((a, b) => b[1].length - a[1].length);
    const [dominant, domEls] = sorted[0];
    if (domEls.length < 2) continue;
    for (const [style, els] of sorted.slice(1)) out.push(issue('ux-inconsistent-type', els[0], `${els.length} ${role} element${els.length === 1 ? '' : 's'} use ${style} while ${domEls.length} use ${dominant}.`, { actual: style, expected: dominant, count: els.length }));
  }
  const colorUse = new Map<string, { n: number; el: RawEl }>();
  for (const e of c.elements) for (const hex of [e.color, e.ownBg, e.border]) if (hex) { const u = colorUse.get(hex); if (u) u.n++; else colorUse.set(hex, { n: 1, el: e }); }
  const hexes = [...colorUse.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 40);
  for (let i = 0; i < hexes.length; i++) for (let j = i + 1; j < hexes.length; j++) {
    const d = deltaE(hexes[i][0], hexes[j][0]);
    if (d > 0 && d < 3) out.push(issue('ux-near-duplicate-color', hexes[j][1].el, `${hexes[j][0]} (${hexes[j][1].n} uses) is almost identical to ${hexes[i][0]} (${hexes[i][1].n} uses), ΔE ${d.toFixed(1)}. One of them is probably unintended.`, { actual: hexes[j][0], expected: hexes[i][0], count: hexes[j][1].n }));
  }
  const families = new Set(c.elements.map((e) => e.family).filter((f) => f && !GENERIC.has(f)));
  if (families.size > 3 && c.elements[0]) out.push(issue('ux-many-font-families', c.elements[0], `${families.size} font families on one page: ${[...families].join(', ')}.`, { actual: `${families.size} families`, expected: '3 or fewer' }));
  return out;
}

/* ───────────────────────────── evidence ───────────────────────────── */

/** Evidence is spread across the whole audit: a few images per rule per device, not all spent on the first pages. */
export interface EvidenceBudget { dir: string | null; left: number; seq: number; perRuleDevice?: Map<string, number> }
const MAX_EVIDENCE_PER_RULE_DEVICE = 3;
/** Rules where each element has its own measurement — one finding per page, elements listed inside it. */
const GROUP_BY_RULE = new Set(['ux-touch-target', 'ux-overlap', 'ux-occluded', 'ux-clipped-text', 'ux-misaligned', 'ux-uneven-gap']);

async function capture(page: Page, rect: Issue['rect'], budget: EvidenceBudget): Promise<string | undefined> {
  if (!budget.dir || budget.left <= 0 || rect.w < 1 || rect.h < 1) return undefined;
  const PAD = 24;
  try {
    const clip = await page.evaluate(({ rect, PAD }) => {
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, Math.max(0, rect.y - Math.max(PAD, (window.innerHeight - rect.h) / 2)));
      const mark = document.createElement('div');
      mark.id = '__iqe_evidence__';
      mark.style.cssText = `position:absolute;left:${rect.x - 3}px;top:${rect.y - 3}px;width:${rect.w + 6}px;height:${rect.h + 6}px;outline:3px solid #E11D48;outline-offset:0;background:rgba(225,29,72,.08);z-index:2147483647;pointer-events:none;box-sizing:border-box;`;
      document.body.appendChild(mark);
      const x = Math.max(0, rect.x - window.scrollX - PAD), y = Math.max(0, rect.y - window.scrollY - PAD);
      return { x, y, width: Math.max(8, Math.min(window.innerWidth - x, rect.w + PAD * 2)), height: Math.max(8, Math.min(window.innerHeight - y, rect.h + PAD * 2)) };
    }, { rect, PAD });
    await fs.mkdir(budget.dir, { recursive: true });
    const file = `e${String(++budget.seq).padStart(4, '0')}.jpg`;
    await page.screenshot({ path: path.join(budget.dir, file), type: 'jpeg', quality: 72, clip, scale: 'css', animations: 'disabled' });
    budget.left--;
    return file;
  } catch {
    return undefined;
  } finally {
    await page.evaluate(() => { document.getElementById('__iqe_evidence__')?.remove(); window.scrollTo(0, 0); }).catch(() => { /* page navigated */ });
  }
}

/* ───────────────────────────── entry point ───────────────────────────── */

export async function runVisualCheck(page: Page, pageUrl: string, device: DeviceProfile, standard: DesignStandard | null, budget: EvidenceBudget): Promise<VisualPageResult> {
  const collected = await collect(page, device.hasTouch, standard?.minTouchTarget ?? 44);
  const issues = [...layoutIssues(collected, device), ...(standard ? adherenceIssues(collected, standard) : consistencyIssues(collected))];

  // One finding per (rule, actual → expected), counting every element it applies to.
  const groups = new Map<string, Issue[]>();
  for (const i of issues) { const k = GROUP_BY_RULE.has(i.ruleId) ? i.ruleId : `${i.ruleId}|${i.actual ?? ''}|${i.expected ?? ''}`; groups.set(k, [...(groups.get(k) || []), i]); }

  // Score once per RULE (not per distinct value): ten undersized buttons of ten
  // different sizes are one problem, not ten.
  const perRule = new Map<string, { issue: Issue; occ: number }>();
  for (const i of issues) { if (i.confidence !== 'high') continue; const r = perRule.get(i.ruleId); if (r) r.occ += i.count; else perRule.set(i.ruleId, { issue: i, occ: i.count }); }
  let layoutPenalty = 0, adherencePenalty = 0;
  for (const { issue: i, occ } of perRule.values()) {
    const p = SEVERITY_WEIGHT[i.severity] * Math.min(occ, 10);
    if (i.family === 'layout') layoutPenalty += p; else if (i.family === 'adherence') adherencePenalty += p;
  }

  const evidencePerRule = new Map<string, number>();
  budget.perRuleDevice = budget.perRuleDevice || new Map<string, number>();
  const findings: Finding[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const occurrences = list.reduce((a, i) => a + i.count, 0);
    let evidence: string | undefined;
    const used = evidencePerRule.get(first.ruleId) || 0;
    const rdKey = `${first.ruleId}|${device.id}`;
    const usedAcrossAudit = budget.perRuleDevice.get(rdKey) || 0;
    if (used < MAX_EVIDENCE_PER_RULE && usedAcrossAudit < MAX_EVIDENCE_PER_RULE_DEVICE) {
      evidence = await capture(page, first.rect, budget);
      if (evidence) { evidencePerRule.set(first.ruleId, used + 1); budget.perRuleDevice.set(rdKey, usedAcrossAudit + 1); }
    }
    findings.push({
      pageUrl, category: 'visual', ruleId: first.ruleId, severity: first.severity, title: first.title,
      description: occurrences > 1 ? `${first.description} ${occurrences} elements on this page.` : first.description,
      element: first.sel.slice(0, 1000), htmlSnippet: first.text || undefined, occurrences,
      details: {
        device: device.id, deviceLabel: device.label, deviceKind: device.kind, viewport: `${collected.vw} × ${collected.vh}`,
        family: first.family, confidence: first.confidence, actual: first.actual, expected: first.expected, evidence,
        examples: list.slice(0, 8).map((i) => ({ selector: i.sel, text: i.text, actual: i.actual })),
      },
    });
  }

  // Usage inventory for the site-wide typography and colour tables.
  const typo = new Map<string, { role: string; family: string; size: number; weight: number; uses: number }>();
  const cols = new Map<string, { hex: string; kind: 'text' | 'background' | 'border'; uses: number }>();
  for (const e of collected.elements) {
    const tk = `${e.role}|${e.family}|${e.size}|${e.weight}`;
    const t = typo.get(tk); if (t) t.uses++; else typo.set(tk, { role: e.role, family: e.family, size: e.size, weight: e.weight, uses: 1 });
    for (const [hex, kind] of [[e.color, 'text'], [e.ownBg, 'background'], [e.border, 'border']] as [string | null, 'text' | 'background' | 'border'][]) {
      const h = hex ? parseColor(hex) : null; if (!h) continue;
      const ck = `${kind}|${h}`; const cu = cols.get(ck); if (cu) cu.uses++; else cols.set(ck, { hex: h, kind, uses: 1 });
    }
  }

  return {
    findings,
    layoutScore: Math.max(0, 100 - layoutPenalty),
    adherenceScore: standard ? Math.max(0, 100 - adherencePenalty) : null,
    typography: [...typo.values()],
    colors: [...cols.values()],
  };
}
