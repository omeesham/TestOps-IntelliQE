/**
 * Design standard — the customer's own rules, normalised.
 *
 * Every customer's design system is different, so UX adherence is never
 * judged against IntelliQE's taste: the customer uploads their tokens and the
 * audit compares what each page actually renders against them.
 *
 * Accepted uploads (all reduce to one `DesignStandard`):
 *   - W3C Design Tokens (DTCG)      { "color": { "brand": { "$value": "#6D28D9", "$type": "color" } } }
 *   - Style Dictionary               { "color": { "brand": { "value": "#6D28D9" } } }
 *   - Tokens Studio for Figma        value/type pairs, incl. composite `typography` tokens and {alias} references
 *   - Figma Variables export (REST)  { "meta": { "variables": { id: { name, resolvedType, valuesByMode } } } }
 *   - CSS custom properties          :root { --color-brand: #6D28D9; --font-size-lg: 1.125rem; }
 *   - IntelliQE simple format        { "colors": {...}, "fontFamilies": [...], "fontSizes": [...], ... }
 *
 * A raw .fig file cannot be read — Figma has no public file format — but each
 * of Figma's export paths above can.
 */

export interface StandardColor { name: string; hex: string }

export interface DesignStandard {
  colors: StandardColor[];
  /** Lower-cased family names, e.g. "inter", "segoe ui". Generic families (sans-serif…) are always allowed. */
  fontFamilies: string[];
  /** px */
  fontSizes: number[];
  fontWeights: number[];
  /** px */
  spacing: number[];
  /** px */
  radii: number[];
  /** Minimum touch target in CSS px for mobile profiles. Defaults to 44 (Apple HIG). */
  minTouchTarget: number;
  tolerance: {
    /** Colours closer than this (CIE76 ΔE) to a palette colour count as that colour. */
    colorDeltaE: number;
    /** A colour this close to a palette colour — but outside the tolerance — is reported as drift, not as off-palette. */
    driftDeltaE: number;
    /** px slack when matching sizes, spacing and radii. */
    px: number;
  };
  /** White, black and transparent are implicitly allowed unless the customer says otherwise. */
  allowBlackWhite: boolean;
}

export interface ParsedStandard {
  standard: DesignStandard;
  format: string;
  stats: { colors: number; fontFamilies: number; fontSizes: number; fontWeights: number; spacing: number; radii: number };
  warnings: string[];
}

const DEFAULTS = { minTouchTarget: 44, tolerance: { colorDeltaE: 2.5, driftDeltaE: 10, px: 0.5 }, allowBlackWhite: true };
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial']);
const WEIGHT_NAMES: Record<string, number> = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};

/* ───────────────────────────── value parsing ───────────────────────────── */

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Any CSS colour string → "#RRGGBB" (alpha dropped), or null. */
export function parseColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) { const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16)); return toHex(r, g, b); }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return '#' + m[1].toUpperCase();
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/.exec(s);
  if (m) {
    const ch = (v: string) => v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v);
    return toHex(ch(m[1]), ch(m[2]), ch(m[3]));
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(s);
  if (m) {
    const h = (parseFloat(m[1]) % 360) / 360, sat = parseFloat(m[2]) / 100, l = parseFloat(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
    const hue = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return toHex(hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255);
  }
  if (s === 'white') return '#FFFFFF';
  if (s === 'black') return '#000000';
  return null;
}

/** "16px" | "1rem" | "12pt" | 16 → px, or null. */
export function parsePx(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const m = /^(-?[\d.]+)\s*(px|rem|em|pt)?$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : m[2] === 'pt' ? n * (96 / 72) : n;
}

function parseWeight(raw: unknown): number | null {
  if (typeof raw === 'number') return raw >= 1 && raw <= 1000 ? Math.round(raw) : null;
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1 && n <= 1000) return Math.round(n);
  return WEIGHT_NAMES[raw.toLowerCase().replace(/[\s_-]/g, '')] ?? null;
}

function parseFamilies(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : [];
  return list.map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase()).filter((f) => f && !GENERIC_FAMILIES.has(f));
}

/* ───────────────────────────── collectors ───────────────────────────── */

class Collector {
  colors = new Map<string, string>(); // hex → name
  families = new Set<string>();
  sizes = new Set<number>();
  weights = new Set<number>();
  spacing = new Set<number>();
  radii = new Set<number>();

  color(name: string, v: unknown) { const hex = parseColor(v); if (hex && !this.colors.has(hex)) this.colors.set(hex, name); return !!hex; }
  family(v: unknown) { const f = parseFamilies(v); f.forEach((x) => this.families.add(x)); return f.length > 0; }
  size(v: unknown) { const n = parsePx(v); if (n !== null && n > 0 && n <= 400) { this.sizes.add(round(n)); return true; } return false; }
  weight(v: unknown) { const n = parseWeight(v); if (n !== null) { this.weights.add(n); return true; } return false; }
  space(v: unknown) { const n = parsePx(v); if (n !== null && n >= 0 && n <= 512) { this.spacing.add(round(n)); return true; } return false; }
  radius(v: unknown) { const n = parsePx(v); if (n !== null && n >= 0) { this.radii.add(round(n)); return true; } return false; }

  /** Route a value by its declared type, falling back to the token's name and the value's shape. */
  add(name: string, type: string, value: unknown): boolean {
    const t = type.toLowerCase().replace(/[\s_-]/g, '');
    const n = name.toLowerCase();
    if (t === 'typography' && value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      let any = false;
      if (v.fontFamily !== undefined) any = this.family(v.fontFamily) || any;
      if (v.fontSize !== undefined) any = this.size(v.fontSize) || any;
      if (v.fontWeight !== undefined) any = this.weight(v.fontWeight) || any;
      return any;
    }
    if (t === 'color') return this.color(name, value);
    if (t === 'fontfamily' || t === 'fontfamilies') return this.family(value);
    if (t === 'fontsize' || t === 'fontsizes') return this.size(value);
    if (t === 'fontweight' || t === 'fontweights') return this.weight(value);
    if (t === 'spacing' || t === 'space' || t === 'gap') return this.space(value);
    if (t === 'borderradius' || t === 'radius' || t === 'radii') return this.radius(value);
    // Untyped, or a generic "dimension" / "number": decide from the name.
    if (/colou?r|palette|fill|background|\bbg\b|brand|surface|text-|border-color/.test(n) && this.color(name, value)) return true;
    // Size and weight names win over a bare "font"; a dimension is never a family name.
    if (/font.?size|text.?size|size.*(text|font)|(text|font).*size|type.?scale/.test(n)) return this.size(value);
    if (/font.?weight|weight/.test(n)) return this.weight(value);
    const isDimension = typeof value === 'number' || parsePx(value) !== null;
    if (/font.?famil|typeface|font/.test(n) && !isDimension && this.family(value)) return true;
    if (/radius|radii|corner|rounded/.test(n)) return this.radius(value);
    if (/spac|gap|padding|margin|inset|gutter/.test(n)) return this.space(value);
    // Last resort: a bare colour value is a colour.
    return this.color(name, value);
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/* ───────────────────────────── format readers ───────────────────────────── */

type Json = Record<string, unknown>;

function isTokenNode(o: Json): boolean { return '$value' in o || ('value' in o && (typeof o.value !== 'object' || o.value === null || 'type' in o || '$type' in o || isCompositeValue(o.value))); }
function isCompositeValue(v: unknown): boolean { return !!v && typeof v === 'object' && !Array.isArray(v) && ('fontFamily' in (v as Json) || 'fontSize' in (v as Json)); }

/** DTCG / Style Dictionary / Tokens Studio: walk the tree, resolving {aliases}. */
function readTokenTree(root: Json, c: Collector, warnings: string[]): number {
  const flat = new Map<string, { value: unknown; type: string }>();
  const walk = (node: unknown, path: string[], inheritedType: string) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const o = node as Json;
    const type = String(o.$type ?? o.type ?? inheritedType ?? '');
    if (isTokenNode(o)) { flat.set(path.join('.'), { value: o.$value ?? o.value, type }); return; }
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('$')) walk(v, [...path, k], type);
  };
  walk(root, [], '');

  const resolve = (v: unknown, depth = 0): unknown => {
    if (depth > 10) return v;
    if (typeof v === 'string') {
      const m = /^\{([^}]+)\}$/.exec(v.trim()) || /^\$([\w.-]+)$/.exec(v.trim());
      if (m) { const ref = flat.get(m[1].trim()); return ref ? resolve(ref.value, depth + 1) : v; }
      return v;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, resolve(x, depth + 1)]));
    return v;
  };

  let used = 0;
  for (const [name, t] of flat) {
    const ok = c.add(name, t.type, resolve(t.value));
    if (ok) used++;
  }
  if (flat.size && used < flat.size) warnings.push(`${flat.size - used} of ${flat.size} tokens were not colours, fonts, sizes, weights, spacing or radii and were ignored (shadows, durations, opacity…).`);
  return used;
}

/** Figma Variables REST export. */
function readFigmaVariables(root: Json, c: Collector): number {
  const meta = (root.meta as Json | undefined) || root;
  const vars = meta.variables as Record<string, Json> | undefined;
  if (!vars || typeof vars !== 'object') return 0;
  let used = 0;
  for (const v of Object.values(vars)) {
    const name = String(v.name || '');
    const modes = (v.valuesByMode as Record<string, unknown>) || {};
    const first = Object.values(modes)[0];
    if (v.resolvedType === 'COLOR' && first && typeof first === 'object' && 'r' in (first as Json)) {
      const f = first as { r: number; g: number; b: number };
      if (c.color(name, toHex(f.r * 255, f.g * 255, f.b * 255))) used++;
    } else if (v.resolvedType === 'FLOAT' && typeof first === 'number') {
      if (c.add(name, '', first)) used++;
    } else if (v.resolvedType === 'STRING' && typeof first === 'string') {
      if (c.add(name, '', first)) used++;
    }
  }
  return used;
}

/** `--token-name: value;` declarations. */
function readCssVariables(text: string, c: Collector): number {
  let used = 0;
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)[;}]/g)) {
    const name = m[1].slice(2), value = m[2].trim();
    if (/^var\(/.test(value)) continue;
    if (c.add(name, '', value)) used++;
  }
  return used;
}

/** IntelliQE's own simple format. */
function readSimple(root: Json, c: Collector): number {
  let used = 0;
  const each = (v: unknown, fn: (name: string, x: unknown) => boolean) => {
    if (Array.isArray(v)) v.forEach((x, i) => { if (fn(String(i + 1), x)) used++; });
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Json)) if (fn(k, x)) used++;
  };
  each(root.colors ?? root.palette, (n, x) => c.color(n, x));
  each(root.fontFamilies ?? root.fonts, (_n, x) => c.family(x));
  each(root.fontSizes, (_n, x) => c.size(x));
  each(root.fontWeights, (_n, x) => c.weight(x));
  each(root.spacing, (_n, x) => c.space(x));
  each(root.radii ?? root.borderRadius, (_n, x) => c.radius(x));
  return used;
}

/* ───────────────────────────── entry point ───────────────────────────── */

export function parseDesignStandard(rawText: string): ParsedStandard {
  const text = (rawText || '').trim();
  if (!text) throw new Error('The file is empty.');
  if (text.length > 5_000_000) throw new Error('The file is larger than 5 MB. Export only the tokens, not the whole design file.');
  const c = new Collector();
  const warnings: string[] = [];
  let format = '';
  let overrides: Partial<DesignStandard> = {};

  let json: Json | null = null;
  if (text.startsWith('{') || text.startsWith('[')) {
    try { json = JSON.parse(text) as Json; } catch (e) { throw new Error(`The file is not valid JSON: ${(e as Error).message}`); }
  }

  if (json && !Array.isArray(json)) {
    const simpleKeys = ['colors', 'palette', 'fontFamilies', 'fonts', 'fontSizes', 'fontWeights', 'radii'];
    const looksSimple = simpleKeys.some((k) => k in json!) && !JSON.stringify(json).includes('"$value"') && !/"value"\s*:/.test(JSON.stringify(json).slice(0, 20000));
    if ((json.meta as Json | undefined)?.variables || (json.variables && typeof json.variables === 'object' && Object.values(json.variables as Json).some((v) => (v as Json)?.resolvedType))) {
      format = 'Figma Variables export';
      readFigmaVariables(json, c);
    } else if (looksSimple) {
      format = 'IntelliQE simple format';
      readSimple(json, c);
      if (typeof json.minTouchTarget === 'number') overrides.minTouchTarget = json.minTouchTarget;
      if (typeof json.allowBlackWhite === 'boolean') overrides.allowBlackWhite = json.allowBlackWhite;
      if (json.tolerance && typeof json.tolerance === 'object') overrides.tolerance = { ...DEFAULTS.tolerance, ...(json.tolerance as Partial<DesignStandard['tolerance']>) };
    } else {
      const s = JSON.stringify(json).slice(0, 50000);
      format = s.includes('"$value"') ? 'W3C Design Tokens (DTCG)' : /"type"\s*:\s*"(fontFamilies|fontSizes|borderRadius|typography|spacing)"/.test(s) ? 'Tokens Studio for Figma' : 'Style Dictionary';
      readTokenTree(json, c, warnings);
    }
  } else if (/--[\w-]+\s*:/.test(text)) {
    format = 'CSS custom properties';
    readCssVariables(text, c);
  } else {
    throw new Error('Unrecognised format. Upload design tokens as JSON (W3C, Style Dictionary, Tokens Studio or a Figma Variables export) or a CSS file of custom properties.');
  }

  const standard: DesignStandard = {
    colors: [...c.colors.entries()].map(([hex, name]) => ({ name, hex })),
    fontFamilies: [...c.families],
    fontSizes: [...c.sizes].sort((a, b) => a - b),
    fontWeights: [...c.weights].sort((a, b) => a - b),
    spacing: [...c.spacing].sort((a, b) => a - b),
    radii: [...c.radii].sort((a, b) => a - b),
    ...DEFAULTS,
    ...overrides,
  };
  const stats = { colors: standard.colors.length, fontFamilies: standard.fontFamilies.length, fontSizes: standard.fontSizes.length, fontWeights: standard.fontWeights.length, spacing: standard.spacing.length, radii: standard.radii.length };
  if (Object.values(stats).every((n) => n === 0)) throw new Error(`Read the file as ${format}, but found no colours, fonts, sizes, spacing or radii in it.`);
  if (!stats.colors) warnings.push('No colours found — colour adherence will not be checked.');
  if (!stats.fontFamilies) warnings.push('No font families found — font family adherence will not be checked.');
  if (!stats.fontSizes) warnings.push('No font sizes found — the type scale will not be checked.');
  return { standard, format, stats, warnings };
}

/* ───────────────────────────── colour distance ───────────────────────────── */

function hexToLab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 ΔE between two "#RRGGBB" colours. ~2.3 is a just-noticeable difference. */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = hexToLab(a), [l2, a2, b2] = hexToLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

export function nearestColor(hex: string, palette: StandardColor[]): { color: StandardColor; deltaE: number } | null {
  let best: { color: StandardColor; deltaE: number } | null = null;
  for (const p of palette) { const d = deltaE(hex, p.hex); if (!best || d < best.deltaE) best = { color: p, deltaE: d }; }
  return best;
}
