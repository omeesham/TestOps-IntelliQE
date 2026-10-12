/**
 * api-data-classify.service.ts
 * ────────────────────────────
 * Sensitive-data classification + shadow-API discovery — the Akto / Escape /
 * APIsec testing-relevant slice. Walks request/response bodies and URLs (from
 * the catalogue, and optionally from a captured-traffic session) and classifies
 * PII / secrets by field name AND value shape, then diffs observed traffic
 * against the known catalogue to flag SHADOW endpoints (seen but undocumented).
 *
 * Standalone, opt-in, read-only. Reuses api-capture's captureToEndpoints for the
 * traffic path; no pipeline coupling. Produces a data-sensitivity map + a score.
 */
import { captureToEndpoints } from './api-capture.service.js';

export type DataSeverity = 'high' | 'medium' | 'low';
export interface DataCategory { id: string; label: string; severity: DataSeverity }
export interface ClassifyFinding { endpoint: string; location: 'url' | 'request' | 'response'; field: string; category: string; severity: DataSeverity; sample: string }
export interface ShadowApi { method: string; path: string; signature: string }
export interface ClassifyReport {
  source: 'catalogue' | 'traffic';
  scanned: number;
  findings: ClassifyFinding[];
  sensitivity: { category: string; label: string; severity: DataSeverity; count: number }[];
  shadowApis: ShadowApi[];
  summary: { high: number; medium: number; low: number; fields: number };
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

interface ClEndpoint { method?: string; url?: string; body?: string; expectedResponse?: string; queryParams?: { name: string }[] }

/** Detectors: a key-name hint and/or a value pattern per category. */
const CATEGORIES: Record<string, { label: string; severity: DataSeverity; key?: RegExp; value?: RegExp }> = {
  password: { label: 'Password / credential', severity: 'high', key: /\b(pass(word|wd)?|pwd|secret|client_?secret)\b/i },
  token: { label: 'Token / API key', severity: 'high', key: /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|authorization|private[_-]?key)\b/i, value: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})\b/ },
  card: { label: 'Payment card (PAN)', severity: 'high', key: /\b(card|pan|cc[_-]?num|credit[_-]?card)\b/i, value: /\b(?:\d[ -]?){13,19}\b/ },
  cvv: { label: 'Card CVV', severity: 'high', key: /\b(cvv|cvc|cvv2|security[_-]?code)\b/i },
  ssn: { label: 'SSN / national id', severity: 'high', key: /\b(ssn|sin|national[_-]?id|nino|aadhaar|tax[_-]?id)\b/i, value: /\b\d{3}-\d{2}-\d{4}\b/ },
  iban: { label: 'Bank account / IBAN', severity: 'high', key: /\b(iban|account[_-]?number|acct[_-]?no|routing|sort[_-]?code|swift|bic)\b/i, value: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/ },
  email: { label: 'Email address', severity: 'medium', key: /\b(e-?mail)\b/i, value: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  phone: { label: 'Phone number', severity: 'medium', key: /\b(phone|mobile|tel|msisdn|cell)\b/i, value: /(?:\+?\d[\d ().-]{7,}\d)/ },
  dob: { label: 'Date of birth', severity: 'medium', key: /\b(dob|birth[_-]?date|date[_-]?of[_-]?birth)\b/i },
  name: { label: 'Person name', severity: 'low', key: /\b(first[_-]?name|last[_-]?name|full[_-]?name|surname|given[_-]?name|maiden)\b/i },
  address: { label: 'Postal address', severity: 'medium', key: /\b(address|street|postcode|zip[_-]?code|city|county)\b/i },
  passport: { label: 'Passport / licence', severity: 'high', key: /\b(passport|driver[_-]?licen[cs]e|dl[_-]?number)\b/i },
  ip: { label: 'IP address', severity: 'low', key: /\b(ip[_-]?addr(ess)?|client[_-]?ip|remote[_-]?addr)\b/i, value: /\b(\d{1,3}\.){3}\d{1,3}\b/ },
  geo: { label: 'Geolocation', severity: 'low', key: /\b(lat(itude)?|lon(gitude)?|lng|geo|coordinates)\b/i },
  health: { label: 'Health / PHI', severity: 'high', key: /\b(diagnos|patient|mrn|medical|prescription|icd[_-]?10|blood[_-]?type)\b/i },
};

function luhn(num: string): boolean { const d = num.replace(/\D/g, ''); if (d.length < 13 || d.length > 19) return false; let sum = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]!; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; }
function pathOf(u: string): string { try { return new URL(u).pathname || '/'; } catch { return u; } }
function mask(v: string): string { const s = String(v); if (s.length <= 4) return '••'; return s.slice(0, 2) + '•'.repeat(Math.min(6, s.length - 4)) + s.slice(-2); }
function signature(method: string, url: string): string {
  const p = pathOf(url).split('/').filter(Boolean).map((s) => /^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s) || /^[0-9a-f]{24}$/i.test(s) ? ':id' : s.toLowerCase()).join('/');
  return `${(method || 'GET').toUpperCase()} /${p}`;
}

/** Walk a JSON value, invoking cb(keyPath, key, scalarValue) for each leaf. */
function walk(node: any, keyPath: string, cb: (path: string, key: string, value: string) => void, depth = 0): void {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) { for (const v of node.slice(0, 50)) walk(v, keyPath, cb, depth + 1); return; }
  if (typeof node === 'object') { for (const [k, v] of Object.entries(node)) { if (v != null && typeof v !== 'object') cb(keyPath ? `${keyPath}.${k}` : k, k, String(v)); else walk(v, keyPath ? `${keyPath}.${k}` : k, cb, depth + 1); } return; }
}

function classifyField(key: string, value: string): { category: string; severity: DataSeverity } | null {
  for (const [id, c] of Object.entries(CATEGORIES)) {
    if (c.key && c.key.test(key)) return { category: id, severity: c.severity };
  }
  for (const [id, c] of Object.entries(CATEGORIES)) {
    if (c.value && c.value.test(value)) {
      if (id === 'card' && !luhn(value)) continue;
      return { category: id, severity: c.severity };
    }
  }
  return null;
}

function classifyEndpoint(e: ClEndpoint, findings: ClassifyFinding[]): void {
  const label = `${(e.method || 'GET').toUpperCase()} ${pathOf(e.url || '')}`;
  // URL query param names.
  for (const q of e.queryParams || []) { const c = classifyField(q.name || '', ''); if (c) findings.push({ endpoint: label, location: 'url', field: q.name, category: c.category, severity: c.severity, sample: '(query param)' }); }
  for (const [loc, text] of [['request', e.body], ['response', e.expectedResponse]] as const) {
    if (!text) continue;
    let obj: any; try { obj = JSON.parse(text); } catch { continue; }
    walk(obj, '', (p, k, v) => { const c = classifyField(k, v); if (c) findings.push({ endpoint: label, location: loc, field: p, category: c.category, severity: c.severity, sample: c.severity === 'high' ? mask(v) : v.slice(0, 40) }); });
  }
}

export async function classifyData(tenantId: string, input: { endpoints?: ClEndpoint[]; sessionId?: string }): Promise<ClassifyReport> {
  const catalogue = (input.endpoints || []).filter((e) => e && e.url);
  let scanSet: ClEndpoint[] = catalogue;
  let source: 'catalogue' | 'traffic' = 'catalogue';
  const shadowApis: ShadowApi[] = [];

  if (input.sessionId) {
    source = 'traffic';
    const traffic = await captureToEndpoints(tenantId, String(input.sessionId));
    scanSet = traffic.endpoints as ClEndpoint[];
    const known = new Set(catalogue.map((e) => signature(e.method || 'GET', e.url || '')));
    const seen = new Set<string>();
    for (const t of scanSet) {
      const sig = signature(t.method || 'GET', t.url || '');
      if (!known.has(sig) && !seen.has(sig)) { seen.add(sig); shadowApis.push({ method: (t.method || 'GET').toUpperCase(), path: pathOf(t.url || ''), signature: sig }); }
    }
  }

  const findings: ClassifyFinding[] = [];
  for (const e of scanSet.slice(0, 500)) classifyEndpoint(e, findings);

  // De-dup findings on (endpoint, location, field, category).
  const seen = new Set<string>();
  const deduped = findings.filter((f) => { const k = `${f.endpoint}|${f.location}|${f.field}|${f.category}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const byCat = new Map<string, number>();
  for (const f of deduped) byCat.set(f.category, (byCat.get(f.category) || 0) + 1);
  const sensitivity = [...byCat.entries()].map(([id, count]) => ({ category: id, label: CATEGORIES[id]!.label, severity: CATEGORIES[id]!.severity, count })).sort((a, b) => b.count - a.count);

  const summary = { high: deduped.filter((f) => f.severity === 'high').length, medium: deduped.filter((f) => f.severity === 'medium').length, low: deduped.filter((f) => f.severity === 'low').length, fields: deduped.length };
  const penalty = summary.high * 8 + summary.medium * 3 + summary.low * 1 + shadowApis.length * 5;
  const score = Math.max(0, Math.round(100 - Math.min(100, (penalty / Math.max(10, scanSet.length * 6)) * 100)));
  const grade: ClassifyReport['grade'] = shadowApis.length > 0 && summary.high > 0 ? 'F' : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  return { source, scanned: scanSet.length, findings: deduped.slice(0, 400), sensitivity, shadowApis, summary, score, grade };
}
