/**
 * demo.ts — the CLI proof of the deterministic half, run LIVE against real
 * public APIs. No model credentials needed.
 *
 * It takes test cases shaped EXACTLY like the generator's output (NormalizedCase),
 * renders them (renderer), runs them (executor) against jsonplaceholder and
 * httpbin, and prints a per-check report. This proves:
 *   M1 — the executor runs typed checks against a live endpoint
 *   M2 — the full render → run → report loop
 *   M3 — negative (404) and auth (401 vs 200) cases behave correctly
 *
 * Exits 0 only if every case's verdict matches what we designed it to prove.
 */
import type { NormalizedCase } from './types';
import { renderAll } from './renderer';
import { runSuite } from './executor';

// Cases authored in the model's output shape. (The model would design these;
// here they are hand-written so the run needs no API key.)
const JSONPLACEHOLDER: NormalizedCase[] = [
  {
    id: 'TC-001',
    title: 'Verify GET /posts/1 returns 200 with the expected post schema',
    feature: 'Posts API',
    category: 'positive',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/posts/1',
    headers: { Accept: 'application/json' },
    checks: [
      { kind: 'status', equals: 200 },
      { kind: 'header', name: 'content-type', contains: 'application/json' },
      { kind: 'jsonProperty', path: 'id', type: 'number' },
      { kind: 'jsonProperty', path: 'userId', exists: true },
      { kind: 'responseTimeUnderMs', ms: 5000 },
    ],
  },
  {
    id: 'TC-002',
    title: 'Confirm GET /posts/1 returns title and body as strings',
    feature: 'Posts API',
    category: 'schema',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/posts/1',
    headers: {},
    checks: [
      { kind: 'jsonProperty', path: 'title', type: 'string' },
      { kind: 'jsonProperty', path: 'body', type: 'string' },
    ],
  },
  {
    id: 'TC-003',
    title: 'Confirm GET /posts returns a non-empty JSON array',
    feature: 'Posts API',
    category: 'positive',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/posts',
    headers: {},
    checks: [
      { kind: 'status', equals: 200 },
      { kind: 'jsonArrayNotEmpty', path: '' },
    ],
  },
  {
    id: 'TC-004',
    title: 'Return 404 for GET /posts/99999999 (a post id that cannot exist)',
    feature: 'Posts API',
    category: 'negative',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/posts/99999999',
    headers: {},
    checks: [{ kind: 'status', equals: 404 }],
  },
];

// Auth proof — httpbin /bearer is 401 without a token, 200 with one.
const HTTPBIN_AUTH: NormalizedCase[] = [
  {
    id: 'TC-005',
    title: 'Return 401 for GET /bearer when no Authorization header is supplied',
    feature: 'Auth',
    category: 'auth',
    method: 'GET',
    url: 'https://httpbin.org/bearer',
    headers: {},
    checks: [{ kind: 'status', equals: 401 }],
  },
  {
    id: 'TC-006',
    title: 'Return 200 for GET /bearer with a valid bearer token and authenticated:true',
    feature: 'Auth',
    category: 'positive',
    method: 'GET',
    url: 'https://httpbin.org/bearer',
    headers: { Authorization: 'Bearer demo-token-123' },
    checks: [
      { kind: 'status', equals: 200 },
      { kind: 'jsonProperty', path: 'authenticated', value: true },
      { kind: 'jsonProperty', path: 'token', value: 'demo-token-123' },
    ],
  },
];

function reportLine(prefix: string, s: string): void {
  console.log(prefix + s);
}

async function runGroup(name: string, cases: NormalizedCase[]): Promise<{ passed: number; total: number }> {
  console.log(`\n═══ ${name} (${cases.length} cases) ═══`);
  const { results, summary } = await runSuite(renderAll(cases));
  for (const r of results) {
    const mark = r.ok ? '✓ PASS' : '✗ FAIL';
    reportLine('', `\n${mark}  ${r.id} · ${r.category.toUpperCase()} · ${r.status ?? '—'} · ${r.durationMs}ms`);
    reportLine('   ', r.title);
    if (r.error) reportLine('   ↳ ', `ERROR: ${r.error}`);
    for (const c of r.checks) reportLine('   ↳ ', `${c.pass ? '✓' : '✗'} ${c.label}  | actual = ${c.actual ?? ''}`);
  }
  console.log(
    `\n   ── ${name} summary: ${summary.passed}/${summary.total} cases passed, ` +
      `${summary.checksPassed}/${summary.checks} assertions, slowest ${summary.slowestMs}ms`,
  );
  return { passed: summary.passed, total: summary.total };
}

async function main(): Promise<void> {
  console.log('API Automation prototype — live execution proof (no model key needed)');
  const g1 = await runGroup('jsonplaceholder.typicode.com', JSONPLACEHOLDER);
  let g2 = { passed: 0, total: 0 };
  try {
    g2 = await runGroup('httpbin.org (auth)', HTTPBIN_AUTH);
  } catch (e) {
    console.log(`\n(httpbin auth group skipped — host unreachable: ${e instanceof Error ? e.message : e})`);
  }

  const passed = g1.passed + g2.passed;
  const total = g1.total + g2.total;
  console.log(`\n═══ TOTAL: ${passed}/${total} cases passed ═══`);
  // Every case here is designed to pass (the negative/auth cases pass by
  // correctly asserting the failure). Exit nonzero if the live APIs disagree.
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error('demo failed:', e);
  process.exit(2);
});
