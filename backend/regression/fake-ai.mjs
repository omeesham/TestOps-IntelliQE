#!/usr/bin/env node
/**
 * Fake Anthropic Messages API for the regression suite.
 *
 * The backend calls the real SDK; pointing it here makes every AI step return
 * a fixed, valid answer, so runs are fast, free and repeatable:
 *   ANTHROPIC_API_KEY=regression ANTHROPIC_BASE_URL=http://localhost:4599
 *
 * Each AI step is recognised by a phrase in its prompt. Answers never contain
 * those phrases, because earlier answers are embedded in later prompts.
 * The generated scripts test a page they build themselves (page.setContent),
 * so execution needs no application; the script of the case titled
 * "...broken locator..." fails until it is healed.
 *
 * GET /calls lists the AI steps called so far; POST /reset clears the list.
 * Usage: node regression/fake-ai.mjs [port]   (default 4599)
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.FAKE_AI_PORT || 4599);
const calls = [];

const PASSING_SPEC = (title) => `import { test, expect } from '@playwright/test';

test(${JSON.stringify(title)}, async ({ page }) => {
  await page.setContent('<main><h1>Regression Shop</h1><button>Sign in</button></main>');
  await expect(page.getByRole('heading', { name: 'Regression Shop' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
`;
const FAILING_SPEC = (title) => PASSING_SPEC(title).replace("name: 'Sign in' }", "name: 'Log in' }");

const CASES = [
  ['Verify the shop heading is shown on the home page', 'positive', 'P0'],
  ['Verify the sign-in button is available', 'positive', 'P1'],
  ['Verify a broken locator is healed', 'negative', 'P2'],
].map(([title, type, priority], i) => ({
  traceabilityId: `REQ-SHOP-0${i + 1}`,
  module: 'Storefront',
  feature: 'Home page',
  title,
  description: 'Regression suite case.',
  precondition: 'The home page is open.',
  testData: {},
  testSteps: [
    { step: 1, action: 'Open the home page', expected: 'The page loads' },
    { step: 2, action: 'Look at the page content', expected: 'The expected element is visible' },
  ],
  expectedResult: 'The expected element is visible.',
  type,
  priority,
  severity: 'Major',
  tags: ['regression'],
  category: type,
}));

/** First balanced JSON array after `label` in the prompt, or []. */
function jsonArrayAfter(prompt, label) {
  const start = prompt.indexOf('[', Math.max(0, prompt.indexOf(label)));
  if (start < 0) return [];
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < prompt.length; i++) {
    const c = prompt[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try { return JSON.parse(prompt.slice(start, i + 1)); } catch { return []; }
    }
  }
  return [];
}

/** Scripts for the saved cases in the prompt, echoing their ids. */
function scriptsFor(prompt, label) {
  return jsonArrayAfter(prompt, label).map((tc, i) => {
    const title = String(tc.title || `Case ${i + 1}`);
    const slug = `${String(tc.tcNumber || tc.id || i + 1)}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    return { testCaseId: tc.id, fileName: `${slug}.spec.ts`, code: /broken locator/i.test(title) ? FAILING_SPEC(title) : PASSING_SPEC(title) };
  });
}

/** Ordered: more specific phrases first (the generator's follow-up prompts also contain its first-pass phrase). */
const ROUTES = [
  ['generator-follow-up', /test cases for scenarios you have NOT yet covered|GAP FILL: the cases already written|THIS PASS: /, () => JSON.stringify(CASES)],
  ['healing', /Playwright auto-healing specialist/, (p) => {
    const title = (p.match(/test\((["'])(.*?)\1/) || [])[2] || 'Healed case';
    return JSON.stringify({ fileName: 'healed.spec.ts', diagnosis: 'The button name changed.', fix: 'Use the current button name.', code: PASSING_SPEC(title) });
  }],
  ['scripts-for-run', /builds resilient Playwright automation using the Page Object Model/, (p) => JSON.stringify(scriptsFor(p, 'Test Cases (JSON):'))],
  ['scripts-mobile', /You are a Principal Mobile SDET/, (p) => JSON.stringify(scriptsFor(p, 'Test Cases (JSON):'))],
  ['scripts-pipeline', /You are a senior Playwright automation engineer/, (p) =>
    JSON.stringify(jsonArrayAfter(p, 'Test cases (JSON):').map((tc, i) => ({ testCaseId: tc.id, fileName: `pipeline-${i + 1}.spec.ts`, code: PASSING_SPEC(String(tc.title || `Case ${i + 1}`)) })))],
  ['prompt-suggestions', /Write exactly 3 improved versions of their text/, () => JSON.stringify({ suggestions: [
    { title: 'Focused', why: 'Names the page and the checks.', prompt: 'Test the shop home page: the heading and the sign-in button are visible.' },
    { title: 'With negatives', why: 'Adds failure cases.', prompt: 'Test the shop home page, including a missing heading and a disabled sign-in button.' },
    { title: 'End to end', why: 'Covers the whole visit.', prompt: 'Test a visitor opening the shop home page and starting sign-in.' },
  ] })],
  ['explore', /Reverse-engineer it into a clear functional specification/, () => '# Regression Shop\nA home page with a heading and a sign-in button.'],
  ['requirements', /You are a Senior QA Requirements Analyst/, () => JSON.stringify({
    features: ['Home page'], modules: [{ module: 'Storefront', features: ['Home page'] }], actors: ['Visitor'],
    flows: ['Visitor opens the home page and sees the heading'], edgeCases: ['Heading missing'], dataRules: [],
    acceptanceCriteria: ['Given a visitor When the home page opens Then the heading is shown'],
    nonFunctionalRequirements: {}, businessRisks: [{ feature: 'Home page', risk: 'Medium', rationale: 'Entry point' }], personaMatrix: [],
  })],
  ['audit', /You are a QA security and edge-case auditor/, () => JSON.stringify({ additionalEdgeCases: [], securityConcerns: [], additionalDataRules: [] })],
  ['planner', /produce a risk-based test plan/, () => JSON.stringify({
    uiTests: 3, apiTests: 0, dataTests: 0, e2eTests: 0, securityTests: 0, accessibilityTests: 0, performanceTests: 0,
    priority: 'P1', coverageAreas: ['Home page'], testStrategy: 'Check the home page content.',
    moduleStrategy: [{ module: 'Storefront', riskLevel: 'Medium', estimatedTestCount: 3, testTypes: ['positive', 'negative'] }],
    environmentMatrix: { browsers: ['Chrome 120+'], devices: ['Desktop 1920x1080'] }, entryCriteria: ['Build deployed'], exitCriteria: ['All P0 pass'],
  })],
  ['generator', /You are a Senior QA Engineer writing test cases/, () => JSON.stringify(CASES)],
];

function answer(prompt) {
  for (const [name, pattern, reply] of ROUTES) if (pattern.test(prompt)) return { name, text: reply(prompt) };
  return { name: 'unknown', text: '{}' };
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/calls') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(calls)); return; }
  if (req.method === 'POST' && req.url === '/reset') { calls.length = 0; res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end(); return; }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* answered as unknown */ }
    const content = payload.messages?.[0]?.content;
    const prompt = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((b) => b.text || '').join('\n') : '');
    const { name, text } = answer(prompt);
    calls.push({ step: name, model: payload.model, at: new Date().toISOString() });
    if (name === 'unknown') console.warn(`[fake-ai] no route for prompt: ${prompt.slice(0, 120).replace(/\s+/g, ' ')}`);

    const message = { id: `msg_reg_${calls.length}`, type: 'message', role: 'assistant', model: payload.model || 'fake', stop_sequence: null };
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (!payload.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sse(res, 'message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage } });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
});

server.listen(PORT, () => console.log(`[fake-ai] listening on http://localhost:${PORT}`));
