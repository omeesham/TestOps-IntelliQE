/**
 * API regression: every read endpoint that existed before keeps its status and
 * response shape (field names and types, not data). New fields are allowed;
 * missing fields, changed types or changed statuses fail unless listed in
 * expected-differences.ts.
 *
 * REG_RECORD=1 records approved/api-shapes.json from the build under test
 * (do this only on the known-good build).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiAsAdmin, requireCredentials, shapeOf, missingFields } from './helpers';
import { API_DIFFERENCES } from './expected-differences';

const APPROVED_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'approved', 'api-shapes.json');
const RECORD = process.env.REG_RECORD === '1';

/** Read endpoints of the product as of the approved build. */
const ENDPOINTS = [
  '/api/health',
  '/api/agents/status', '/api/agents/queue',
  '/api/chat/conversations',
  '/api/jira/status', '/api/testrail/status', '/api/confluence/status', '/api/sharepoint/status',
  '/api/test-cases', '/api/test-cases/facets',
  '/api/configurations',
  '/api/reports/summary', '/api/reports/coverage',
  '/api/tenant-settings/anthropic-key',
  '/api/pipeline/list', '/api/pipeline-pages', '/api/pipeline-pages/tree',
  '/api/pipeline-admin/pipeline-definition', '/api/pipeline-admin/agent-types', '/api/pipeline-admin/usage',
  '/api/pipeline-admin/worker-status', '/api/pipeline-admin/ai-config',
  '/api/pipeline-worker/next-task',
  '/api/automation-scripts',
  '/api/users', '/api/users/menu-config', '/api/users/feature-flags', '/api/users/tenants',
  '/api/allure/status',
  '/api/recordings/runs',
];

type Approved = Record<string, { status: number; shape: unknown }>;

let api: APIRequestContext;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  requireCredentials();
  api = await apiAsAdmin();
  // Data so list endpoints return rows and their item shapes can be compared.
  const app = await api.put('/api/configurations/app-regression-shop', {
    data: { appName: 'Regression Shop', baseUrl: 'https://shop.example.test', environment: 'QA', roles: [] },
  });
  expect(app.ok(), 'save an application').toBeTruthy();
  const run = await api.post('/api/test-cases/save', {
    data: {
      username: 'regression', storyTitle: 'Regression seed suite', source: 'text', columns: ['title', 'steps', 'expected'],
      testCases: [{ title: 'Seed case', steps: ['Open the page'], expectedResult: 'Page opens', priority: 'P1', type: 'positive' }],
    },
  });
  expect(run.ok(), 'save a test suite').toBeTruthy();
});

test.afterAll(async () => { await api?.dispose(); });

test('read endpoints keep their status and response shape', async () => {
  const approved: Approved = fs.existsSync(APPROVED_FILE) ? JSON.parse(fs.readFileSync(APPROVED_FILE, 'utf8')) : {};
  const observed: Approved = {};
  const problems: string[] = [];
  const accepted: string[] = [];

  for (const url of ENDPOINTS) {
    const res = await api.get(url);
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    observed[url] = { status: res.status(), shape: shapeOf(body) };
    if (RECORD) continue;

    const before = approved[url];
    if (!before) { problems.push(`${url}: no approved result (record on the known-good build)`); continue; }
    const issues = [
      ...(before.status !== res.status() ? [`status was ${before.status}, now ${res.status()}`] : []),
      ...missingFields(before.shape, observed[url].shape),
    ];
    if (!issues.length) continue;
    const reason = API_DIFFERENCES[`GET ${url}`];
    (reason ? accepted : problems).push(`${url}: ${issues.join('; ')}${reason ? ` (expected: ${reason})` : ''}`);
  }

  if (RECORD) {
    fs.mkdirSync(path.dirname(APPROVED_FILE), { recursive: true });
    fs.writeFileSync(APPROVED_FILE, `${JSON.stringify(observed, null, 2)}\n`);
    test.info().annotations.push({ type: 'recorded', description: `${ENDPOINTS.length} endpoints → ${APPROVED_FILE}` });
    return;
  }
  if (accepted.length) test.info().annotations.push({ type: 'expected differences', description: accepted.join('\n') });
  expect(problems, `API regressions:\n${problems.join('\n')}`).toEqual([]);
});
