/**
 * flow-demo.ts — the M4 proof: a stateful create → read → delete → confirm-gone
 * journey, run LIVE against a public CRUD sandbox (api.restful-api.dev), with
 * {{var}} extraction carrying the created id from one step to the next.
 *
 * This writes to a sandbox API, so it runs with allowWrites: true. The object it
 * creates is deleted by the journey itself (step 3), then confirmed gone (step 4).
 */
import type { FlowStep } from './types';
import { runFlow } from './flow';

const API = 'https://api.restful-api.dev/objects';

const journey: FlowStep[] = [
  {
    name: 'create object',
    method: 'POST',
    url: API,
    body: '{"name":"IntelliQE proto {{$timestamp}}","data":{"year":2026,"kind":"flow-demo"}}',
    extract: { objId: 'id' }, // capture the minted id → {{objId}}
    checks: [
      { kind: 'status', equals: 200 },
      { kind: 'jsonProperty', path: 'id', exists: true },
      { kind: 'jsonProperty', path: 'name', type: 'string' },
    ],
  },
  {
    name: 'read it back by id',
    method: 'GET',
    url: `${API}/{{objId}}`, // uses the id the create step captured
    extract: { objName: 'name' },
    checks: [
      { kind: 'status', equals: 200 },
      { kind: 'jsonProperty', path: 'id', exists: true },
      { kind: 'jsonProperty', path: 'data.year', value: 2026 },
    ],
  },
  {
    name: 'delete it',
    method: 'DELETE',
    url: `${API}/{{objId}}`,
    checks: [
      { kind: 'status', equals: 200 },
      { kind: 'bodyContains', text: 'has been deleted' },
    ],
  },
  {
    name: 'confirm it is gone',
    method: 'GET',
    url: `${API}/{{objId}}`,
    checks: [{ kind: 'status', equals: 404 }],
  },
];

async function main(): Promise<void> {
  console.log('API Automation prototype — M4 flow proof (stateful CRUD journey, live)');
  console.log(`target: ${API}  ·  writes: ENABLED (public sandbox)\n`);

  const run = await runFlow(journey, { allowWrites: true });

  for (const s of run.steps) {
    const mark = s.ok ? '✓ PASS' : '✗ FAIL';
    console.log(`${mark}  step ${s.index + 1}: ${s.name}  ·  ${s.method} · ${s.status ?? '—'} · ${s.durationMs}ms`);
    console.log(`        ${s.url}`);
    if (s.error) console.log(`        ↳ ERROR: ${s.error}`);
    for (const c of s.checks) console.log(`        ↳ ${c.pass ? '✓' : '✗'} ${c.label}  | actual = ${c.actual ?? ''}`);
    for (const [k, v] of Object.entries(s.extracted)) console.log(`        ↳ extract: ${k} = ${v}`);
    console.log('');
  }

  console.log(`variable bag after run: ${JSON.stringify(run.variables)}`);
  console.log(`\n═══ FLOW ${run.passed ? 'PASSED' : 'FAILED'} — ${run.stepsRun}/${run.stepsTotal} steps, ${run.durationMs}ms ═══`);
  process.exit(run.passed ? 0 : 1);
}

main().catch((e) => {
  console.error('flow demo failed:', e);
  process.exit(2);
});
