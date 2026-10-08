/**
 * api-synth-data.service.ts
 * ─────────────────────────
 * AI synthetic test-data factory. Produces realistic, DETERMINISTIC (seeded) rows
 * for a set of fields — with optional PII masking and appended edge-case rows
 * (nulls, max-length, unicode, injection-ish). GenRocket / Tonic parity, with the
 * anti-hallucination angle: a seed makes a run reproducible, and the generators
 * are deterministic faker-lite functions, NOT free-form LLM output. An LLM is used
 * only (optionally) to INFER a field schema from a sample body or an endpoint —
 * the values themselves are generated deterministically.
 *
 * Standalone and opt-in: emits rows the caller can feed into Data-driven testing
 * or download as CSV/JSON. The pipeline is never involved.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';

export type SynthFieldType =
  | 'firstName' | 'lastName' | 'fullName' | 'email' | 'phone' | 'uuid' | 'int' | 'float'
  | 'bool' | 'date' | 'datetime' | 'city' | 'country' | 'company' | 'word' | 'sentence'
  | 'url' | 'ipv4' | 'currency' | 'enum' | 'ssn' | 'creditCard' | 'string';

export interface SynthField {
  name: string;
  type: SynthFieldType;
  /** enum: the allowed values. int/float: [min,max]. string: max length. */
  options?: string[];
  min?: number;
  max?: number;
  /** Mark as PII so masking (when on) redacts it. Auto-inferred for email/phone/ssn/creditCard. */
  pii?: boolean;
}

export interface SynthDataInput {
  fields?: SynthField[];
  /** Infer fields from this sample JSON body (object or array of objects). */
  sampleBody?: string;
  /** Infer fields from this endpoint via the LLM (name + method + a short description). */
  endpoint?: { method: string; url: string; description?: string };
  count?: number;
  seed?: number;
  locale?: 'en' | 'generic';
  piiMask?: boolean;
  edgeCases?: boolean;
}

export interface SynthDataResult {
  rows: Record<string, unknown>[];
  columns: string[];
  fields: SynthField[];
  seed: number;
  csv: string;
  notes: string[];
}

/* ── Deterministic PRNG (mulberry32) ── */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ava', 'Liam', 'Noah', 'Mia', 'Olivia', 'Ethan', 'Sophia', 'Lucas', 'Isla', 'Aarav', 'Diya', 'Kai', 'Zara', 'Omar', 'Chloe', 'Leo', 'Nina', 'Raj', 'Sara', 'Theo'];
const LAST = ['Smith', 'Johnson', 'Patel', 'Garcia', 'Khan', 'Chen', 'Mueller', 'Rossi', 'Silva', 'Novak', 'Kim', 'Ivanov', 'Haddad', 'Nguyen', 'Dubois', 'Costa'];
const CITY = ['Austin', 'Berlin', 'Mumbai', 'Toronto', 'Lisbon', 'Nairobi', 'Osaka', 'Bogotá', 'Oslo', 'Dubai', 'Seoul', 'Lima'];
const COUNTRY = ['USA', 'Germany', 'India', 'Canada', 'Portugal', 'Kenya', 'Japan', 'Colombia', 'Norway', 'UAE', 'South Korea', 'Peru'];
const COMPANY = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Soylent', 'Pied Piper'];
const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'nova', 'pixel', 'quartz', 'river', 'solar', 'tiger', 'vortex', 'zephyr'];

function pick<T>(rng: () => number, arr: T[]): T { return arr[Math.floor(rng() * arr.length)]!; }
function intIn(rng: () => number, min: number, max: number): number { return Math.floor(rng() * (max - min + 1)) + min; }
function pad(n: number, w = 2): string { return String(n).padStart(w, '0'); }

function genValue(f: SynthField, rng: () => number): unknown {
  switch (f.type) {
    case 'firstName': return pick(rng, FIRST);
    case 'lastName': return pick(rng, LAST);
    case 'fullName': return `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
    case 'email': return `${pick(rng, FIRST).toLowerCase()}.${pick(rng, LAST).toLowerCase()}${intIn(rng, 1, 999)}@example.com`;
    case 'phone': return `+1${intIn(rng, 200, 999)}${intIn(rng, 200, 999)}${pad(intIn(rng, 0, 9999), 4)}`;
    case 'uuid': {
      const hex = '0123456789abcdef';
      let s = '';
      for (let i = 0; i < 32; i++) s += hex[Math.floor(rng() * 16)];
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
    }
    case 'int': return intIn(rng, f.min ?? 0, f.max ?? 1000);
    case 'float': return +(((f.min ?? 0) + rng() * ((f.max ?? 1000) - (f.min ?? 0))).toFixed(2));
    case 'bool': return rng() > 0.5;
    case 'date': return `${intIn(rng, 2020, 2026)}-${pad(intIn(rng, 1, 12))}-${pad(intIn(rng, 1, 28))}`;
    case 'datetime': return `${intIn(rng, 2020, 2026)}-${pad(intIn(rng, 1, 12))}-${pad(intIn(rng, 1, 28))}T${pad(intIn(rng, 0, 23))}:${pad(intIn(rng, 0, 59))}:${pad(intIn(rng, 0, 59))}Z`;
    case 'city': return pick(rng, CITY);
    case 'country': return pick(rng, COUNTRY);
    case 'company': return pick(rng, COMPANY);
    case 'word': return pick(rng, WORDS);
    case 'sentence': return `${pick(rng, WORDS)} ${pick(rng, WORDS)} ${pick(rng, WORDS)} ${pick(rng, WORDS)}.`;
    case 'url': return `https://${pick(rng, WORDS)}.example.com/${pick(rng, WORDS)}/${intIn(rng, 1, 9999)}`;
    case 'ipv4': return `${intIn(rng, 1, 254)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 1, 254)}`;
    case 'currency': return +((rng() * 1000).toFixed(2));
    case 'ssn': return `${intIn(rng, 100, 899)}-${pad(intIn(rng, 0, 99))}-${pad(intIn(rng, 1, 9999), 4)}`;
    case 'creditCard': return `4${pad(intIn(rng, 0, 999), 3)} ${pad(intIn(rng, 0, 9999), 4)} ${pad(intIn(rng, 0, 9999), 4)} ${pad(intIn(rng, 0, 9999), 4)}`;
    case 'enum': return f.options && f.options.length ? pick(rng, f.options) : 'A';
    case 'string':
    default: {
      const len = f.max ?? 8;
      let s = '';
      while (s.length < len) s += pick(rng, WORDS);
      return s.slice(0, len);
    }
  }
}

const PII_TYPES = new Set<SynthFieldType>(['email', 'phone', 'ssn', 'creditCard', 'fullName']);

function maskValue(f: SynthField, value: unknown): unknown {
  const s = String(value);
  if (f.type === 'email') { const [u, d] = s.split('@'); return `${(u || '').slice(0, 2)}***@${d || 'example.com'}`; }
  if (f.type === 'ssn') return `***-**-${s.slice(-4)}`;
  if (f.type === 'creditCard') return `**** **** **** ${s.slice(-4)}`;
  if (f.type === 'phone') return `${s.slice(0, 3)}******${s.slice(-2)}`;
  return s.length <= 2 ? '**' : `${s[0]}***${s[s.length - 1]}`;
}

/** Infer a field type from a JSON key name + sample value. */
function inferType(key: string, sample: unknown): SynthFieldType {
  const k = key.toLowerCase();
  if (/email/.test(k)) return 'email';
  if (/phone|mobile|tel/.test(k)) return 'phone';
  if (/ssn|social/.test(k)) return 'ssn';
  if (/card|cc_?num/.test(k)) return 'creditCard';
  if (/uuid|guid|^id$|_id$/.test(k)) return 'uuid';
  if (/first_?name/.test(k)) return 'firstName';
  if (/last_?name|surname/.test(k)) return 'lastName';
  if (/name/.test(k)) return 'fullName';
  if (/city/.test(k)) return 'city';
  if (/country/.test(k)) return 'country';
  if (/company|org/.test(k)) return 'company';
  if (/url|link|href/.test(k)) return 'url';
  if (/ip(_?addr)?/.test(k)) return 'ipv4';
  if (/price|amount|total|cost/.test(k)) return 'currency';
  if (/date_?time|timestamp|_at$/.test(k)) return 'datetime';
  if (/date|dob|birth/.test(k)) return 'date';
  if (typeof sample === 'boolean') return 'bool';
  if (typeof sample === 'number') return Number.isInteger(sample) ? 'int' : 'float';
  return 'string';
}

function fieldsFromSample(sampleBody: string): SynthField[] {
  let parsed: any;
  try { parsed = JSON.parse(sampleBody); } catch { return []; }
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).slice(0, 40).map(([name, v]) => {
    const type = inferType(name, v);
    return { name, type, pii: PII_TYPES.has(type) };
  });
}

async function fieldsFromEndpoint(ep: { method: string; url: string; description?: string }, llm: LlmConfig | null | undefined): Promise<SynthField[]> {
  if (!llm) return [];
  const prompt = `For the API endpoint "${ep.method} ${ep.url}"${ep.description ? ` (${ep.description})` : ''}, infer a realistic request/record schema.
Return ONLY a JSON array of fields: [{"name":"email","type":"email"},{"name":"age","type":"int","min":18,"max":90}].
Allowed types: firstName,lastName,fullName,email,phone,uuid,int,float,bool,date,datetime,city,country,company,word,sentence,url,ipv4,currency,enum,ssn,creditCard,string.
Up to 15 fields. No prose.`;
  try {
    const raw = await runLLM(prompt, { maxTokens: 900, llm });
    const arr = parseJsonFromResponse<any[]>(raw);
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 20).map((f: any) => ({
      name: String(f?.name || 'field').slice(0, 60),
      type: (String(f?.type || 'string') as SynthFieldType),
      options: Array.isArray(f?.options) ? f.options.map(String).slice(0, 20) : undefined,
      min: Number.isFinite(Number(f?.min)) ? Number(f.min) : undefined,
      max: Number.isFinite(Number(f?.max)) ? Number(f.max) : undefined,
      pii: !!f?.pii || PII_TYPES.has(String(f?.type) as SynthFieldType),
    }));
  } catch { return []; }
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

export async function generateSyntheticData(input: SynthDataInput, llm?: LlmConfig | null): Promise<SynthDataResult> {
  const notes: string[] = [];
  let fields: SynthField[] = Array.isArray(input.fields) ? input.fields.slice(0, 40) : [];
  if (!fields.length && input.sampleBody) { fields = fieldsFromSample(input.sampleBody); if (fields.length) notes.push(`Inferred ${fields.length} fields from the sample body.`); }
  if (!fields.length && input.endpoint) { fields = await fieldsFromEndpoint(input.endpoint, llm); if (fields.length) notes.push(`Inferred ${fields.length} fields from the endpoint via the LLM.`); }
  if (!fields.length) throw new Error('No fields to generate. Provide fields, a sample body, or an endpoint (with an LLM configured).');

  // Normalise + default pii flags.
  fields = fields.map((f) => ({ ...f, name: String(f.name || 'field').slice(0, 60), type: (f.type || 'string') as SynthFieldType, pii: f.pii ?? PII_TYPES.has(f.type) }));

  const count = Math.min(500, Math.max(1, Math.floor(input.count ?? 20)));
  const seed = Number.isFinite(Number(input.seed)) ? Number(input.seed) >>> 0 : (Date.now() >>> 0);
  const rng = mulberry32(seed);
  const piiMask = !!input.piiMask;

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, unknown> = {};
    for (const f of fields) {
      let v = genValue(f, rng);
      if (piiMask && f.pii) v = maskValue(f, v);
      row[f.name] = v;
    }
    rows.push(row);
  }

  if (input.edgeCases) {
    // A handful of deliberately nasty rows for negative/boundary testing.
    const edge: Record<string, unknown>[] = [];
    const mk = (fill: (f: SynthField) => unknown) => Object.fromEntries(fields.map((f) => [f.name, fill(f)]));
    edge.push(mk(() => null));
    edge.push(mk(() => ''));
    edge.push(mk((f) => (f.type === 'int' || f.type === 'float' || f.type === 'currency' ? Number.MAX_SAFE_INTEGER : 'Ω✓𝕏🚀 — ünïçödé')));
    edge.push(mk((f) => (f.type === 'string' || f.type === 'word' || f.type === 'sentence' ? 'A'.repeat(1024) : genValue(f, rng))));
    edge.push(mk(() => `' OR 1=1 --`));
    edge.push(mk(() => `<script>alert(1)</script>`));
    rows.push(...edge);
    notes.push(`Appended ${edge.length} edge-case rows (null, empty, overflow, unicode, injection-ish).`);
  }

  if (piiMask) notes.push('PII fields are masked in the output.');
  const columns = fields.map((f) => f.name);
  return { rows, columns, fields, seed, csv: toCsv(columns, rows), notes };
}
