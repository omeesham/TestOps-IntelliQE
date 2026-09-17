#!/usr/bin/env node
/**
 * intelliqe-api — command-line access to IntelliQE API Automation.
 *
 * Zero dependencies (Node 18+). Talks to the RESTful public API at
 * /api/v1/public/api-automation with the same Bearer token the UI uses.
 *
 *   intelliqe-api login --url https://intelliqe.example.com --user jbsadmin
 *   intelliqe-api import openapi.yaml                      # any spec/collection/doc → endpoints.json
 *   intelliqe-api import --url https://api.acme.com/openapi.json
 *   intelliqe-api import --curl "curl -X POST https://api.acme.com/login -d '{}'"
 *   intelliqe-api import --graphql https://api.acme.com/graphql
 *   intelliqe-api import --mcp https://mcp.acme.com/mcp
 *   intelliqe-api analyze endpoints.json                   # pattern intelligence
 *   intelliqe-api run endpoints.json --env staging --wait  # design → execute → heal → report
 *   intelliqe-api run --spec openapi.yaml --coverage standard --layers smoke,contract,negative --wait
 *   intelliqe-api projects | plans | builds | build <id> | session <buildId> <TC-001>
 *   intelliqe-api envs
 *   intelliqe-api whoami
 *
 * Config: ~/.intelliqe/config.json ({ url, token }) — or INTELLIQE_URL and
 * INTELLIQE_TOKEN environment variables, which take precedence (CI-friendly).
 * Output: human-readable tables by default, `--json` for machine-readable.
 * Exit codes: 0 ok · 1 usage/config error · 2 API error · 3 run had failures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const CONFIG_DIR = path.join(os.homedir(), '.intelliqe');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const API_BASE = '/api/v1/public/api-automation';

/* ───────────────────────── args ───────────────────────── */

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) args.flags[k] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args.flags[k] = argv[++i];
      else args.flags[k] = true;
    } else args._.push(a);
  }
  return args;
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* none yet */ }
  return {
    url: process.env.INTELLIQE_URL || cfg.url || '',
    token: process.env.INTELLIQE_TOKEN || cfg.token || '',
  };
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function die(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

async function prompt(question, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(question);
      const onData = (ch) => { if (ch.toString() === '\n' || ch.toString() === '\r') process.stdin.removeListener('data', onData); };
      rl.stdoutMuted = true;
      rl._writeToOutput = () => {};
      process.stdin.on('data', onData);
    }
    rl.question(hidden ? '' : question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

/* ───────────────────────── http ───────────────────────── */

async function api(cfg, method, route, body, { raw = false } = {}) {
  if (!cfg.url) die('No IntelliQE URL configured. Run `intelliqe-api login --url <url>` or set INTELLIQE_URL.');
  if (!cfg.token && !route.startsWith('/api/auth/')) die('Not logged in. Run `intelliqe-api login` or set INTELLIQE_TOKEN.');
  const url = cfg.url.replace(/\/+$/, '') + (route.startsWith('/api/') ? route : API_BASE + route);
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
  if (!res.ok) die(`${method} ${route} → ${res.status}: ${json.error || res.statusText}${json.details ? `\n  ${json.details.join('\n  ')}` : ''}`, 2);
  return raw ? json : (json.data !== undefined ? json : json);
}

/* ───────────────────────── output ───────────────────────── */

function table(rows, columns) {
  if (!rows.length) { console.log('(none)'); return; }
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const line = (cells) => cells.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log(line(columns.map((c) => c.label)));
  console.log(line(columns.map((_, i) => '─'.repeat(widths[i]))));
  for (const r of rows) console.log(line(columns.map((c) => c.get(r))));
}

function out(args, data, human) {
  if (args.flags.json) console.log(JSON.stringify(data, null, 2));
  else human();
}

const fmtDate = (s) => (s ? new Date(s).toLocaleString() : '');
const fmtMs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms || 0)}ms`);

/* ───────────────────────── commands ───────────────────────── */

async function cmdLogin(args) {
  const cfg = loadConfig();
  const url = args.flags.url || cfg.url || (await prompt('IntelliQE URL (e.g. https://intelliqe.example.com): '));
  const username = args.flags.user || (await prompt('Username: '));
  const password = args.flags.password || process.env.INTELLIQE_PASSWORD || (await prompt('Password: ', true));
  const res = await fetch(url.replace(/\/+$/, '') + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) die(`Login failed: ${json.error || res.status}`, 2);
  saveConfig({ url, token: json.token, username: json.user?.username, tenant: json.user?.tenantName, savedAt: new Date().toISOString() });
  console.log(`Logged in as ${json.user?.username} (${json.user?.tenantName}). Token saved to ${CONFIG_PATH}.`);
  console.log('Tokens expire (default 24h) — re-run `intelliqe-api login` or set INTELLIQE_TOKEN in CI.');
}

async function cmdWhoami(args) {
  const cfg = loadConfig();
  const { data } = await api(cfg, 'GET', '/me');
  out(args, data, () => console.log(`${data.username} · role ${data.role} · tenant ${data.tenant.name} · ${cfg.url}`));
}

function readSpecFile(file) {
  if (!file) die('Give a file to import, e.g. `intelliqe-api import openapi.yaml`.');
  if (!fs.existsSync(file)) die(`File not found: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

async function doImport(cfg, args) {
  const f = args.flags;
  let payload;
  if (f.url) payload = { kind: 'url', url: f.url, format: f.format, name: f.name };
  else if (f.curl) payload = { kind: 'curl', text: f.curl === true ? readSpecFile(args._[1]) : f.curl, name: f.name || 'cURL' };
  else if (f.graphql) payload = { kind: 'graphql', url: f.graphql, headers: parseHeaders(f.header), auth: authFlag(f) };
  else if (f.mcp) payload = { kind: 'mcp', url: f.mcp, headers: parseHeaders(f.header), auth: authFlag(f) };
  else if (f.connector) payload = { kind: 'connector', text: readSpecFile(f.connector === true ? args._[1] : f.connector), name: f.name };
  else {
    const file = f.spec || args._[1];
    payload = { kind: 'text', text: readSpecFile(file), format: f.format || 'auto', name: path.basename(file) };
  }
  const { data, meta } = await api(cfg, 'POST', '/imports', payload);
  return { endpoints: data.endpoints, profile: data.profile, format: data.format, parser: data.parser, warnings: data.warnings, count: meta.count };
}

function parseHeaders(h) {
  if (!h) return {};
  const list = Array.isArray(h) ? h : [h];
  const out = {};
  for (const item of list) { const i = String(item).indexOf(':'); if (i > 0) out[item.slice(0, i).trim()] = item.slice(i + 1).trim(); }
  return out;
}
function authFlag(f) {
  if (f.bearer) return { type: 'bearer', value: String(f.bearer) };
  if (f['api-key']) return { type: 'apikey', value: String(f['api-key']) };
  if (f.basic) return { type: 'basic', value: String(f.basic) };
  return undefined;
}

async function cmdImport(args) {
  const cfg = loadConfig();
  const result = await doImport(cfg, args);
  const outFile = args.flags.out || 'endpoints.json';
  fs.writeFileSync(outFile, JSON.stringify(result.endpoints, null, 2));
  out(args, result, () => {
    console.log(`${result.count} endpoint${result.count === 1 ? '' : 's'} imported (${result.format} · ${result.parser}) → ${outFile}`);
    table(result.endpoints.slice(0, 40), [
      { label: 'METHOD', get: (e) => e.method },
      { label: 'URL', get: (e) => e.url.length > 70 ? e.url.slice(0, 67) + '…' : e.url },
      { label: 'AUTH', get: (e) => e.auth?.type || 'none' },
      { label: 'EXPECT', get: (e) => e.expectedStatus || '' },
      { label: 'RESOURCE', get: (e) => e.resource || '' },
    ]);
    if (result.endpoints.length > 40) console.log(`… and ${result.endpoints.length - 40} more`);
    for (const w of result.warnings || []) console.log(`warning: ${w}`);
    if (result.profile) printProfile(result.profile);
  });
}

function printProfile(p) {
  console.log(`\nAPI profile: ${p.summary}`);
  for (const line of p.patterns) console.log(`  • ${line}`);
  if (p.flows?.length) console.log(`  flows: ${p.flows.map((f) => f.name).join(', ')}`);
  for (const r of p.risks || []) console.log(`  ${r.level === 'high' ? '!!' : r.level === 'medium' ? ' !' : '  '} ${r.text}`);
  console.log(`  strategy: ${p.strategy.recommendedCoverage} depth · ~${p.strategy.estimatedTotal} scenarios (${p.strategy.layers.filter((l) => l.enabled).map((l) => `${l.id} ${l.estimatedCases}`).join(', ')})`);
  if (p.insights?.length) for (const i of p.insights) console.log(`  ◆ ${i}`);
}

async function cmdAnalyze(args) {
  const cfg = loadConfig();
  const file = args._[1] || 'endpoints.json';
  const endpoints = JSON.parse(readSpecFile(file));
  const { data } = await api(cfg, 'POST', '/analyze', { endpoints });
  out(args, data, () => printProfile(data));
}

async function cmdRun(args) {
  const cfg = loadConfig();
  const f = args.flags;
  let endpoints;
  if (f.spec || f.url || f.curl || f.graphql || f.mcp || f.connector) {
    const imported = await doImport(cfg, args);
    endpoints = imported.endpoints;
    console.log(`${endpoints.length} endpoints imported (${imported.format}).`);
  } else {
    endpoints = JSON.parse(readSpecFile(args._[1] || 'endpoints.json'));
  }
  let environmentId = f.env;
  if (environmentId && !/^[0-9a-f-]{36}$/i.test(environmentId)) {
    const { data: envs } = await api(cfg, 'GET', '/environments');
    const match = envs.find((e) => e.name.toLowerCase() === String(environmentId).toLowerCase());
    if (!match) die(`No environment named "${environmentId}". Available: ${envs.map((e) => e.name).join(', ') || '(none)'}`);
    environmentId = match.id;
  }
  const body = {
    endpoints,
    title: f.title,
    coverage: f.coverage,
    layers: f.layers ? String(f.layers).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    environmentId,
    execute: f['no-execute'] ? false : true,
    heal: f['no-heal'] ? false : true,
    requirements: f.requirements,
  };
  const { data: started } = await api(cfg, 'POST', '/runs', body);
  console.log(`Run started: job ${started.jobId}`);
  if (!f.wait) { out(args, started, () => console.log(`Poll with: intelliqe-api job ${started.jobId}`)); return; }
  const result = await waitForJob(cfg, started.jobId);
  finishRun(args, result);
}

async function waitForJob(cfg, jobId) {
  let lastPhase = '';
  for (;;) {
    const { data: job } = await api(cfg, 'GET', `/runs/${jobId}`);
    const phase = job.progress?.detail ? `${job.progress.phase}: ${job.progress.detail}` : '';
    if (phase && phase !== lastPhase) { console.log(`  [${new Date().toLocaleTimeString()}] ${phase}`); lastPhase = phase; }
    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') die(`Run failed: ${job.error}`, 2);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function finishRun(args, result) {
  out(args, result, () => {
    console.log(`\nRun: ${result.title}${result.runId ? ` (${result.runId})` : ''}`);
    console.log(`Scenarios: ${result.scenarios.total} (${Object.entries(result.scenarios.byType).map(([k, v]) => `${v} ${k}`).join(', ')})`);
    if (result.stats) {
      console.log(`Result: ${result.stats.passed}/${result.stats.total} passed · ${result.stats.failed} failed · ${result.stats.notRun} not run · ${result.stats.passRate}% in ${fmtMs(result.stats.durationMs)}`);
      if (result.healed) console.log(`Healing: ${result.healed.fixed} of ${result.healed.attempted} repaired`);
      if (result.reportUrl) console.log(`Report: ${loadConfig().url.replace(/\/+$/, '')}${result.reportUrl}`);
      if (result.failures.length) {
        console.log('\nFailures:');
        for (const fl of result.failures) console.log(`  ✗ ${fl.testCaseId} ${fl.title}${fl.error ? `\n      ${fl.error.split('\n')[0].slice(0, 160)}` : ''}`);
      }
    } else console.log('Not executed.');
  });
  if (result.stats && (result.stats.failed > 0 || result.stats.notRun > 0)) process.exit(3);
}

async function cmdJob(args) {
  const cfg = loadConfig();
  const id = args._[1];
  if (!id) die('Give the job id.');
  if (args.flags.wait) { finishRun(args, await waitForJob(cfg, id)); return; }
  const { data } = await api(cfg, 'GET', `/runs/${id}`);
  out(args, data, () => console.log(`${data.status}${data.progress ? ` — ${data.progress.phase}: ${data.progress.detail}` : ''}${data.error ? ` — ${data.error}` : ''}`));
}

async function cmdProjects(args) {
  const { data } = await api(loadConfig(), 'GET', '/projects');
  out(args, data, () => table(data, [
    { label: 'PROJECT', get: (p) => p.name },
    { label: 'BUILDS', get: (p) => p.builds },
    { label: 'SCENARIOS', get: (p) => p.scenarios },
    { label: 'LAST PASS', get: (p) => (p.lastPassRate === null ? '—' : `${p.lastPassRate}%`) },
    { label: 'LAST BUILD', get: (p) => fmtDate(p.lastBuildAt) },
  ]));
}

async function cmdPlans(args) {
  const { data, meta } = await api(loadConfig(), 'GET', `/plans?page=${args.flags.page || 1}&pageSize=${args.flags.limit || 20}`);
  out(args, { data, meta }, () => table(data, [
    { label: 'PLAN ID', get: (p) => p.id },
    { label: 'TITLE', get: (p) => p.title.slice(0, 50) },
    { label: 'SCENARIOS', get: (p) => p.scenarios },
    { label: 'EXECUTED', get: (p) => (p.executed ? 'yes' : 'no') },
    { label: 'CREATED', get: (p) => fmtDate(p.createdAt) },
  ]));
}

async function cmdBuilds(args) {
  const { data, meta } = await api(loadConfig(), 'GET', `/builds?page=${args.flags.page || 1}&pageSize=${args.flags.limit || 20}`);
  out(args, { data, meta }, () => table(data, [
    { label: 'BUILD ID', get: (b) => b.id },
    { label: 'TITLE', get: (b) => b.title.slice(0, 40) },
    { label: 'STATUS', get: (b) => b.status },
    { label: 'PASS', get: (b) => `${b.stats.passed}/${b.stats.total} (${b.stats.passRate}%)` },
    { label: 'DURATION', get: (b) => fmtMs(b.stats.durationMs) },
    { label: 'STARTED', get: (b) => fmtDate(b.startedAt) },
  ]));
}

async function cmdBuild(args) {
  const id = args._[1];
  if (!id) die('Give the build id.');
  const { data } = await api(loadConfig(), 'GET', `/builds/${id}`);
  out(args, data, () => {
    console.log(`${data.title} — ${data.stats ? `${data.stats.passed}/${data.stats.total} passed (${data.stats.passRate}%)` : 'not executed'}`);
    table(data.sessions, [
      { label: 'ID', get: (s) => s.id },
      { label: 'STATUS', get: (s) => s.status },
      { label: 'TYPE', get: (s) => s.type },
      { label: 'MS', get: (s) => s.durationMs ?? '' },
      { label: 'SCENARIO', get: (s) => s.title.slice(0, 70) },
    ]);
  });
}

async function cmdSession(args) {
  const [, build, tc] = args._;
  if (!build || !tc) die('Usage: intelliqe-api session <buildId> <TC-001>');
  const { data } = await api(loadConfig(), 'GET', `/builds/${build}/sessions/${tc}`);
  out(args, data, () => {
    console.log(`${data.id} ${data.title}\nstatus: ${data.status}${data.durationMs !== undefined ? ` · ${data.durationMs}ms` : ''} · ${data.type} · ${data.priority}`);
    if (data.request) console.log(`request: ${data.request.method} ${data.request.endpoint}${data.request.queryParams ? `?${data.request.queryParams}` : ''} → expects ${data.request.expectedStatus}`);
  });
}

async function cmdEnvs(args) {
  const { data } = await api(loadConfig(), 'GET', '/environments');
  out(args, data, () => table(data, [
    { label: 'ID', get: (e) => e.id },
    { label: 'NAME', get: (e) => e.name + (e.isDefault ? ' (default)' : '') },
    { label: 'BASE URL', get: (e) => e.baseUrl },
    { label: 'VARS', get: (e) => e.variables.map((v) => v.key + (v.secret ? '🔒' : '')).join(', ') },
  ]));
}

function usage() {
  console.log(`intelliqe-api — IntelliQE API Automation from the terminal

Commands
  login [--url U] [--user N] [--password P]     authenticate and store the token
  whoami                                         show the current user / tenant
  import <file> [--format F] [--out endpoints.json]
  import --url <spec-or-docs-url> | --curl "<cmd>" | --graphql <url> | --mcp <url> | --connector <file>
  analyze [endpoints.json]                       API pattern intelligence
  run [endpoints.json] [--spec F|--url U|...] [--env NAME] [--coverage essential|standard|exhaustive]
      [--layers smoke,contract,schema,negative,auth,security,performance,flow] [--title T]
      [--no-execute] [--no-heal] [--wait]
  job <jobId> [--wait]                           poll a started run
  projects | plans | builds | build <id> | session <buildId> <TC-id> | envs
Options
  --json      machine-readable output          --header "Name: value" (repeatable)
  --bearer T | --api-key K | --basic user:pass  credentials for graphql/mcp introspection
Environment
  INTELLIQE_URL, INTELLIQE_TOKEN override ~/.intelliqe/config.json (use in CI)
Exit codes: 0 ok · 1 usage · 2 API error · 3 the run had failures`);
}

const COMMANDS = {
  login: cmdLogin, whoami: cmdWhoami, import: cmdImport, analyze: cmdAnalyze, run: cmdRun, job: cmdJob,
  projects: cmdProjects, plans: cmdPlans, builds: cmdBuilds, build: cmdBuild, session: cmdSession, envs: cmdEnvs,
  environments: cmdEnvs,
};

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (!cmd || cmd === 'help' || args.flags.help) { usage(); process.exit(0); }
if (!COMMANDS[cmd]) die(`Unknown command "${cmd}". Run \`intelliqe-api help\`.`);
COMMANDS[cmd](args).catch((err) => die(err?.message || String(err), 2));
