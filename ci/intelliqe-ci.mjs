/**
 * intelliqe-ci.mjs — headless IntelliQE runner for CI pipelines.
 *
 * Invoked as `node ci/intelliqe-ci.mjs …` (see Usage below) — no shebang is
 * needed, and omitting it keeps the file importable by the unit tests, whose
 * runner does not strip a leading `#!` the way Node's ESM loader does.
 *
 * Zero dependencies (Node 18+ global fetch). Runs a saved flow, a suite, or a
 * local flow JSON against an IntelliQE backend via POST /flows/ci-run, writes a
 * JUnit report, prints a summary, and EXITS NON-ZERO when the run fails — so a
 * pull request gate actually blocks on a red API test.
 *
 * Usage:
 *   INTELLIQE_URL=https://intelliqe.example.com \
 *   INTELLIQE_TOKEN=xxxxx \
 *   node intelliqe-ci.mjs --flow <flowId> [--junit report.xml]
 *   node intelliqe-ci.mjs --suite <id1,id2,...> [--stop-on-failure]
 *   node intelliqe-ci.mjs --file flow.json          # { "steps": [...], "variables": {...} }
 *
 * Options:
 *   --flow <id>         run one saved flow by id
 *   --suite <id,id,..>  run several saved flows as a suite
 *   --file <path>       run an ad-hoc flow from a local JSON file
 *   --junit <path>      write the JUnit XML report to this path (default: junit.xml)
 *   --no-junit          do not request/write JUnit
 *   --allow-writes      permit write-method (POST/PUT/PATCH/DELETE) requests
 *   --stop-on-failure   suite: stop at the first failing flow
 *   --name <text>       report/suite name
 *   -h, --help          print this help
 *
 * Env: INTELLIQE_URL (required), INTELLIQE_TOKEN (required).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = { junit: 'junit.xml' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--flow': out.flow = next(); break;
      case '--suite': out.suite = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--file': out.file = next(); break;
      case '--junit': out.junit = next(); break;
      case '--no-junit': out.junit = ''; break;
      case '--allow-writes': out.allowWrites = true; break;
      case '--stop-on-failure': out.stopOnFailure = true; break;
      case '--name': out.name = next(); break;
      case '-h': case '--help': out.help = true; break;
      default: if (a && a.startsWith('--')) out[a.slice(2)] = true;
    }
  }
  return out;
}

const HELP = `intelliqe-ci — run IntelliQE API tests in CI and gate on the result.

  INTELLIQE_URL=... INTELLIQE_TOKEN=... node intelliqe-ci.mjs --flow <id> [--junit report.xml]

  --flow <id> | --suite <id,id> | --file <flow.json>
  --junit <path> (default junit.xml) | --no-junit
  --allow-writes | --stop-on-failure | --name <text> | --help

Exit code is 0 when the run passed, 1 when it failed (or on error).`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.flow && !args.suite && !args.file)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 2);
  }
  const base = (process.env.INTELLIQE_URL || '').replace(/\/+$/, '');
  const token = process.env.INTELLIQE_TOKEN || '';
  if (!base || !token) {
    console.error('ERROR: set INTELLIQE_URL and INTELLIQE_TOKEN in the environment.');
    process.exit(2);
  }

  const body = { name: args.name, allowWrites: !!args.allowWrites, stopOnFailure: !!args.stopOnFailure, junit: !!args.junit };
  if (args.flow) body.flowId = args.flow;
  else if (args.suite) body.suiteFlowIds = args.suite;
  else if (args.file) {
    const parsed = JSON.parse(readFileSync(args.file, 'utf8'));
    body.steps = parsed.steps || parsed;
    if (parsed.variables) body.variables = parsed.variables;
  }

  let data;
  try {
    const r = await fetch(`${base}/api/api-automation/flows/ci-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch { /* keep raw */ }
      console.error(`ERROR: ${r.status} — ${msg}`);
      process.exit(2);
    }
    data = JSON.parse(text);
  } catch (e) {
    console.error(`ERROR: could not reach ${base} — ${e.message}`);
    process.exit(2);
  }

  const s = data.summary || {};
  console.log(`\nIntelliQE — ${s.line || (data.passed ? 'PASS' : 'FAIL')}`);
  if (args.junit && data.junit) {
    writeFileSync(args.junit, data.junit);
    console.log(`JUnit report written to ${args.junit}`);
  }
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : (data.passed ? 0 : 1);
  console.log(exitCode === 0 ? '✓ gate passed' : '✗ gate failed');
  process.exit(exitCode);
}

// Run only when executed directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();

export { parseArgs };
