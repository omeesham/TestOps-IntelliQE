/**
 * server.ts — the thin API + static UI.
 *
 * Three endpoints, down from the production platform's 60+:
 *   POST /api/generate  { spec }                  → { cases, source }
 *   POST /api/run       { cases, allowWrites }     → { results, summary }
 *   POST /api/curl      { curl }                   → { spec }
 * Plus GET /api/status and the static UI at /.
 *
 * generate and run are separate calls (as in production) so the user can review
 * and trim the designed suite before anything hits the network.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiSpec, NormalizedCase, FlowStep } from './types';
import { generate } from './generator';
import { runFlow } from './flow';
import { offlineGenerate, resetSeedIds } from './seed';
import { renderAll } from './renderer';
import { runSuite } from './executor';
import { hasCredentials, MODEL } from './llm';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, '..', 'web')));

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, model: MODEL, aiEnabled: hasCredentials() });
});

app.post('/api/generate', async (req, res) => {
  const spec = req.body?.spec as ApiSpec | undefined;
  if (!spec || !spec.url || !spec.method) {
    res.status(400).json({ error: 'spec with at least { method, url } is required' });
    return;
  }
  try {
    if (hasCredentials()) {
      const cases = await generate(spec);
      res.json({ cases, source: 'ai', model: MODEL });
    } else {
      resetSeedIds();
      const cases = offlineGenerate(spec);
      res.json({
        cases,
        source: 'offline',
        note: 'No ANTHROPIC_API_KEY set — these cases came from the deterministic offline heuristic, not the model. Set a key to use AI generation.',
      });
    }
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/run', async (req, res) => {
  const cases = req.body?.cases as NormalizedCase[] | undefined;
  const allowWrites = !!req.body?.allowWrites;
  if (!Array.isArray(cases) || cases.length === 0) {
    res.status(400).json({ error: 'cases[] is required' });
    return;
  }
  try {
    const { results, summary } = await runSuite(renderAll(cases), { allowWrites });
    res.json({ results, summary });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/flow/run', async (req, res) => {
  const steps = req.body?.steps as FlowStep[] | undefined;
  const variables = (req.body?.variables as Record<string, string> | undefined) || {};
  const allowWrites = !!req.body?.allowWrites;
  if (!Array.isArray(steps) || steps.length === 0) {
    res.status(400).json({ error: 'steps[] is required' });
    return;
  }
  try {
    const run = await runFlow(steps, { variables, allowWrites });
    res.json(run);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/curl', (req, res) => {
  const curl = String(req.body?.curl || '');
  if (!curl.trim()) {
    res.status(400).json({ error: 'curl text is required' });
    return;
  }
  res.json({ spec: parseCurl(curl) });
});

/** Minimal cURL → ApiSpec parser (the one convenience importer). */
export function parseCurl(curl: string): ApiSpec {
  // Join line-continuations, then tokenise respecting single/double quotes.
  const text = curl.replace(/\\\r?\n/g, ' ').trim();
  const tokens = text.match(/'[^']*'|"[^"]*"|\S+/g) || [];
  const unquote = (s: string): string => s.replace(/^['"]|['"]$/g, '');

  let method = '';
  let url = '';
  const headers: { key: string; value: string }[] = [];
  let body: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === 'curl') continue;
    if (t === '-X' || t === '--request') {
      method = unquote(tokens[++i] || 'GET').toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const h = unquote(tokens[++i] || '');
      const idx = h.indexOf(':');
      if (idx > 0) headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim() });
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
      body = unquote(tokens[++i] || '');
    } else if (!t.startsWith('-') && /^https?:\/\//i.test(unquote(t))) {
      url = unquote(t);
    }
  }
  if (!method) method = body ? 'POST' : 'GET';

  // Lift a recognised Authorization header into structured auth.
  let auth: ApiSpec['auth'];
  const authHeader = headers.find((h) => h.key.toLowerCase() === 'authorization');
  if (authHeader) {
    const m = /^bearer\s+(.+)$/i.exec(authHeader.value);
    if (m) auth = { type: 'bearer', value: m[1] };
  }
  const baseUrl = (() => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch {
      return undefined;
    }
  })();

  return {
    method,
    url,
    baseUrl,
    headers: headers.filter((h) => h.key.toLowerCase() !== 'authorization' || !auth),
    auth,
    body,
  };
}

const PORT = Number(process.env.PORT) || 4100;
// Only listen when run directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  app.listen(PORT, () => {
    console.log(`API Automation prototype → http://localhost:${PORT}`);
    console.log(`  model: ${MODEL}   AI generation: ${hasCredentials() ? 'ENABLED' : 'OFFLINE (no ANTHROPIC_API_KEY)'}`);
  });
}

export { app };
