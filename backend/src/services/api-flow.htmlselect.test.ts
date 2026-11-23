import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { runFlow } from './api-flow.service';

// Exercises the new `htmlSelect` check kind end-to-end: a real flow runs against
// a local server returning an HTML page, and the DOM/CSS-selector assertions are
// evaluated by the actual runChecks() branch (no mocks).
const HTML = `<!doctype html>
<html><body>
  <h1 class="title">Welcome</h1>
  <a id="home" href="/home">Home</a>
  <ul class="items"><li>one</li><li>two</li></ul>
  <p>Price: $42</p>
</body></html>`;

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}/`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function checkPasses(checks: any[]): Promise<boolean[]> {
  const result = await runFlow({ steps: [{ id: 's1', method: 'GET', url: base, checks } as any] });
  const step = (result as any).steps?.[0];
  return (step?.checks ?? []).map((c: any) => !!c.pass);
}

describe('htmlSelect check kind', () => {
  it('element exists / absent', async () => {
    const [present, absent] = await checkPasses([
      { kind: 'htmlSelect', path: 'h1.title', op: 'exists' },
      { kind: 'htmlSelect', path: '.does-not-exist', op: 'exists' },
    ]);
    expect(present).toBe(true);
    expect(absent).toBe(false);
  });

  it('text equals / contains (pass and fail)', async () => {
    const [eqOk, eqBad, containsOk] = await checkPasses([
      { kind: 'htmlSelect', path: 'h1.title', op: 'equals', value: 'Welcome' },
      { kind: 'htmlSelect', path: 'h1.title', op: 'equals', value: 'Wrong' },
      { kind: 'htmlSelect', path: 'p', op: 'contains', value: '$42' },
    ]);
    expect(eqOk).toBe(true);
    expect(eqBad).toBe(false);
    expect(containsOk).toBe(true);
  });

  it('attribute assertion via `name`', async () => {
    const [hrefOk, hrefBad] = await checkPasses([
      { kind: 'htmlSelect', path: 'a#home', op: 'equals', name: 'href', value: '/home' },
      { kind: 'htmlSelect', path: 'a#home', op: 'equals', name: 'href', value: '/elsewhere' },
    ]);
    expect(hrefOk).toBe(true);
    expect(hrefBad).toBe(false);
  });

  it('attribute + op:exists asserts the attribute is present, not just the element', async () => {
    const [attrPresent, attrAbsent] = await checkPasses([
      { kind: 'htmlSelect', path: 'a#home', op: 'exists', name: 'href' },        // href IS present → pass
      { kind: 'htmlSelect', path: 'a#home', op: 'exists', name: 'data-missing' }, // element exists but attr absent → fail
    ]);
    expect(attrPresent).toBe(true);
    expect(attrAbsent).toBe(false);
  });

  it('case-insensitive compare', async () => {
    const [ci] = await checkPasses([
      { kind: 'htmlSelect', path: 'h1.title', op: 'equals', value: 'WELCOME', caseInsensitive: true },
    ]);
    expect(ci).toBe(true);
  });

  it('invalid selector fails cleanly (not a crash)', async () => {
    const result = await runFlow({ steps: [{ id: 's1', method: 'GET', url: base, checks: [{ kind: 'htmlSelect', path: '###', op: 'exists' }] } as any] });
    const check = (result as any).steps?.[0]?.checks?.[0];
    expect(check.pass).toBe(false);
    expect(String(check.detail || '')).toMatch(/selector|HTML/i);
  });
});
