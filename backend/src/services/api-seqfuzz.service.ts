/**
 * api-seqfuzz.service.ts
 * ──────────────────────
 * Stateful, dependency-aware sequence fuzzing — the RESTler / EvoMaster
 * black-box idea the single-param fuzzer (api-fuzz) can't reach. It infers
 * producer→consumer chains over the catalogue (POST mints an id → GET/PUT/DELETE
 * consume it), executes those sequences live, and fuzzes ALONG them: malformed
 * identifiers injected into the chaining variable, and an auth-stripped variant
 * per step to catch broken object-level authorization. Reaches deep states a
 * flat fuzzer never sees (5xx, auth bypass, state leaks).
 *
 * STRICTLY non-destructive by default: write steps (POST/PUT/PATCH/DELETE) run
 * ONLY when allowWrites is set; otherwise read-only chains execute and the write
 * steps are reported as "skipped". Bounded (resources, sequences, timeout).
 * Standalone, opt-in; reuses the shared HTTP helper, nothing from the pipeline.
 */
import { buildRequestInit, fetchFull, clampInt, type HttpEndpoint } from '../utils/api-http.js';

export interface SeqFuzzEndpoint extends HttpEndpoint { title?: string; expectedStatus?: number }
export type StepFinding = 'ok' | 'server-error' | 'auth-bypass' | 'bad-request-handled' | 'unexpected-2xx' | 'skipped' | 'error';
export interface SeqStep { label: string; method: string; url: string; variant: 'baseline' | 'malformed-id' | 'auth-stripped'; status?: number; finding: StepFinding; note: string }
export interface Sequence { resource: string; ran: boolean; idCaptured: string | null; steps: SeqStep[]; issues: string[] }
export interface SeqFuzzReport {
  sequences: Sequence[];
  summary: { sequencesBuilt: number; sequencesRan: number; stepsRun: number; issues: Record<string, number> };
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  allowWrites: boolean;
  note: string;
}

const MALFORMED_IDS = ['0', '-1', '999999999999999999', "1' OR '1'='1", '../../etc/passwd', 'null', '%00', 'NaN', '😀', 'a'.repeat(512)];

function path(u: string): string { try { return new URL(u).pathname || '/'; } catch { return u; } }
function origin(u: string): string { try { const x = new URL(u); return x.origin; } catch { return ''; } }
function methodOf(e: SeqFuzzEndpoint): string { return (e.method || 'GET').toUpperCase(); }
function secured(e: SeqFuzzEndpoint): boolean { return !!(e.auth && e.auth.type && e.auth.type !== 'none' && e.auth.value); }

/** Resource key: the collection path with id-ish and version segments stripped. */
function resourceKey(u: string): string {
  const segs = path(u).split('/').filter(Boolean).filter((s) => !/^v\d+$/i.test(s));
  const out: string[] = [];
  for (const s of segs) {
    if (/^\{[^}]*\}$/.test(s) || /^:/.test(s) || /^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s) || /^[0-9a-f]{24}$/i.test(s)) break;
    out.push(s.toLowerCase());
  }
  return (origin(u) + '/' + out.join('/')) || path(u);
}

/** Pull an id-shaped value out of a JSON response body. */
function captureId(bodyText: string, resource: string): string | null {
  let obj: any;
  try { obj = JSON.parse(bodyText); } catch { return null; }
  const node = Array.isArray(obj) ? obj[0] : (obj?.data && typeof obj.data === 'object' ? (Array.isArray(obj.data) ? obj.data[0] : obj.data) : obj);
  if (!node || typeof node !== 'object') return null;
  const res = resource.split('/').filter(Boolean).pop() || '';
  const singular = res.replace(/s$/, '');
  const keys = ['id', '_id', 'uuid', `${singular}Id`, `${singular}_id`, 'key', 'slug'];
  for (const k of Object.keys(node)) if (keys.some((want) => k.toLowerCase() === want.toLowerCase())) { const v = node[k]; if (v != null && (typeof v === 'string' || typeof v === 'number')) return String(v); }
  return null;
}

/** Build the member URL (collection + id) for read/update/delete of a captured resource. */
function memberUrl(collectionUrl: string, id: string): string {
  const base = collectionUrl.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(id)}`;
}

async function runStep(ep: SeqFuzzEndpoint, label: string, variant: SeqStep['variant'], urlOverride: string | null, timeoutMs: number): Promise<SeqStep> {
  const url = urlOverride || ep.url;
  const method = methodOf(ep);
  const { init } = buildRequestInit({ ...ep, url }, { omitAuth: variant === 'auth-stripped' });
  const res = await fetchFull(url, init, timeoutMs, 1200);
  let finding: StepFinding = 'ok';
  let note = '';
  if (res.error) { finding = 'error'; note = res.error; }
  else if ((res.status || 0) >= 500) { finding = 'server-error'; note = `Server error ${res.status} on a ${variant} request — unhandled input reaches the backend.`; }
  else if (variant === 'auth-stripped' && secured(ep) && (res.status || 0) >= 200 && (res.status || 0) < 300) { finding = 'auth-bypass'; note = `Returned ${res.status} with NO credentials on a secured endpoint — possible broken authorization (BOLA/BFLA).`; }
  else if (variant === 'malformed-id' && (res.status || 0) >= 200 && (res.status || 0) < 300) { finding = 'unexpected-2xx'; note = `Accepted a malformed identifier with ${res.status} — weak input validation.`; }
  else if (variant === 'malformed-id') { finding = 'bad-request-handled'; note = `Rejected the malformed identifier with ${res.status}.`; }
  return { label, method, url, variant, status: res.status, finding, note };
}

export async function runSeqFuzz(endpoints: SeqFuzzEndpoint[], opts: { allowWrites?: boolean; maxResources?: number; timeoutMs?: number } = {}): Promise<SeqFuzzReport> {
  const allowWrites = !!opts.allowWrites;
  const maxResources = clampInt(opts.maxResources, 6, 1, 12);
  const timeoutMs = clampInt(opts.timeoutMs, 8000, 1000, 15000);

  // Group by resource.
  const groups = new Map<string, SeqFuzzEndpoint[]>();
  for (const e of endpoints) { if (!/^https?:\/\//i.test(e.url || '')) continue; const k = resourceKey(e.url); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(e); }

  const sequences: Sequence[] = [];
  const issues: Record<string, number> = {};
  let sequencesRan = 0, stepsRun = 0;
  const bump = (f: StepFinding) => { if (['server-error', 'auth-bypass', 'unexpected-2xx', 'error'].includes(f)) issues[f] = (issues[f] || 0) + 1; };

  for (const [resource, eps] of [...groups.entries()].slice(0, maxResources)) {
    const create = eps.find((e) => methodOf(e) === 'POST');
    const list = eps.find((e) => methodOf(e) === 'GET');
    const update = eps.find((e) => ['PUT', 'PATCH'].includes(methodOf(e)));
    const del = eps.find((e) => methodOf(e) === 'DELETE');
    const steps: SeqStep[] = [];
    const seqIssues: string[] = [];
    let idCaptured: string | null = null;
    let ran = false;

    // 1) CREATE (write — only with allowWrites).
    if (create) {
      if (allowWrites) {
        ran = true;
        const { init } = buildRequestInit(create);
        const res = await fetchFull(create.url, init, timeoutMs, 2000);
        stepsRun++;
        const finding: StepFinding = res.error ? 'error' : (res.status || 0) >= 500 ? 'server-error' : 'ok';
        steps.push({ label: 'create', method: 'POST', url: create.url, variant: 'baseline', status: res.status, finding, note: res.error || `Created → ${res.status}` });
        bump(finding);
        idCaptured = captureId(res.bodyText, resource);
        if (!idCaptured) seqIssues.push('Could not extract an id from the create response — downstream steps use a synthetic id.');
      } else {
        steps.push({ label: 'create', method: 'POST', url: create.url, variant: 'baseline', finding: 'skipped', note: 'Write step skipped — enable "allow writes" to mint a real resource.' });
      }
    }

    const probeId = idCaptured || '1';
    const base = create?.url || list?.url || eps[0]!.url;
    const collection = base.replace(/\/\{[^}]*\}$/, '').replace(/\/:[^/]+$/, '');

    // 2) READ the member (always safe — GET).
    if (list || create) {
      ran = true;
      const readEp: SeqFuzzEndpoint = { ...(list || eps[0]!), method: 'GET', url: memberUrl(collection, probeId) };
      const ok = await runStep(readEp, 'read', 'baseline', null, timeoutMs); steps.push(ok); stepsRun++; bump(ok.finding);
      // Fuzz the id.
      for (const bad of MALFORMED_IDS.slice(0, 4)) {
        const s = await runStep({ ...readEp, url: memberUrl(collection, bad) }, `read·malformed(${bad.slice(0, 12)})`, 'malformed-id', null, timeoutMs);
        steps.push(s); stepsRun++; bump(s.finding);
      }
      // Auth-stripped (BOLA/BFLA).
      if (secured(readEp)) { const s = await runStep(readEp, 'read·no-auth', 'auth-stripped', null, timeoutMs); steps.push(s); stepsRun++; bump(s.finding); }
    }

    // 3) UPDATE then 4) DELETE (writes — only with allowWrites).
    for (const [label, ep] of [['update', update], ['delete', del]] as const) {
      if (!ep) continue;
      if (!allowWrites) { steps.push({ label, method: methodOf(ep), url: memberUrl(collection, probeId), variant: 'baseline', finding: 'skipped', note: 'Write step skipped — enable "allow writes".' }); continue; }
      ran = true;
      const wEp: SeqFuzzEndpoint = { ...ep, url: memberUrl(collection, probeId) };
      const s = await runStep(wEp, label, 'baseline', null, timeoutMs); steps.push(s); stepsRun++; bump(s.finding);
      const s2 = await runStep({ ...wEp, url: memberUrl(collection, MALFORMED_IDS[3]!) }, `${label}·malformed`, 'malformed-id', null, timeoutMs); steps.push(s2); stepsRun++; bump(s2.finding);
    }

    if (ran) sequencesRan++;
    for (const s of steps) if (['server-error', 'auth-bypass', 'unexpected-2xx'].includes(s.finding)) seqIssues.push(`${s.label}: ${s.note}`);
    sequences.push({ resource, ran, idCaptured, steps, issues: seqIssues });
  }

  const totalIssues = Object.values(issues).reduce((a, b) => a + b, 0);
  const grade: SeqFuzzReport['grade'] = (issues['auth-bypass'] || 0) > 0 ? 'F' : totalIssues === 0 ? 'A' : totalIssues <= 2 ? 'B' : totalIssues <= 5 ? 'C' : 'D';
  return {
    sequences,
    summary: { sequencesBuilt: sequences.length, sequencesRan, stepsRun, issues },
    grade, allowWrites,
    note: allowWrites ? 'Write sequences executed — run against a disposable/test environment.' : 'Read-only: write steps were skipped. Enable "allow writes" against a test environment to fuzz full CRUD chains.',
  };
}
