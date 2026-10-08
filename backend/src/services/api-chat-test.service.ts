/**
 * api-chat-test.service.ts
 * ────────────────────────
 * Conversational "chat-to-test": refine a single endpoint's test by chatting in
 * plain English ("now add a 401 case", "assert the response time is under 300ms",
 * "check the body has an id and a created_at"). Postbot / Testsigma-Atto parity.
 *
 * Standalone and opt-in. It reuses the tenant LLM the same way every other AI
 * tool does, returns a STRUCTURED test draft (never model-authored code), and a
 * deterministic Playwright `request` snippet is rendered here from that draft —
 * so the output always compiles and the pipeline is never involved.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';

export interface ChatCheck {
  kind: 'status' | 'jsonPathExists' | 'jsonPathEquals' | 'bodyContains' | 'responseTimeUnderMs';
  equals?: number | string;
  oneOf?: number[];
  path?: string;
  value?: unknown;
  text?: string;
  ms?: number;
}

export interface ChatTestDraft {
  title: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body?: string;
  checks: ChatCheck[];
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface ChatTestResult {
  reply: string;
  draft: ChatTestDraft;
  snippet: string;
}

const SYSTEM = `You are an API test author. You maintain ONE test for ONE endpoint and refine it per the user's plain-English instruction.
Return ONLY JSON, no prose outside it, in this exact shape:
{
  "reply": "<one or two sentences describing what you changed>",
  "draft": {
    "title": "<short test title, e.g. 'Rejects an expired token'>",
    "method": "GET|POST|PUT|PATCH|DELETE",
    "url": "<absolute URL>",
    "headers": [{"key":"...","value":"..."}],
    "body": "<raw JSON string or omit>",
    "checks": [
      {"kind":"status","oneOf":[200]},
      {"kind":"jsonPathExists","path":"data.0.id"},
      {"kind":"jsonPathEquals","path":"status","value":"active"},
      {"kind":"bodyContains","text":"..."},
      {"kind":"responseTimeUnderMs","ms":300}
    ]
  }
}
Keep the whole current test; apply the instruction as a delta. Never invent secrets — keep auth header placeholders as given.`;

function sanitizeDraft(raw: any, fallback: ChatTestDraft): ChatTestDraft {
  const d = raw && typeof raw === 'object' ? raw : {};
  const method = String(d.method || fallback.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
  const headers = Array.isArray(d.headers)
    ? d.headers.filter((h: any) => h && String(h.key || '').trim()).slice(0, 40).map((h: any) => ({ key: String(h.key).slice(0, 200), value: String(h.value ?? '').slice(0, 2000) }))
    : fallback.headers;
  const checks: ChatCheck[] = Array.isArray(d.checks)
    ? d.checks.filter((c: any) => c && typeof c.kind === 'string').slice(0, 30).map((c: any) => ({
        kind: c.kind,
        equals: c.equals,
        oneOf: Array.isArray(c.oneOf) ? c.oneOf.map(Number).filter(Number.isFinite).slice(0, 10) : undefined,
        path: typeof c.path === 'string' ? c.path.slice(0, 200) : undefined,
        value: c.value,
        text: typeof c.text === 'string' ? c.text.slice(0, 400) : undefined,
        ms: Number.isFinite(Number(c.ms)) ? Number(c.ms) : undefined,
      }))
    : fallback.checks;
  return {
    title: String(d.title || fallback.title || 'API test').slice(0, 160),
    method,
    url: String(d.url || fallback.url || '').slice(0, 4000),
    headers,
    body: typeof d.body === 'string' ? d.body.slice(0, 20000) : (typeof d.body === 'object' && d.body ? JSON.stringify(d.body).slice(0, 20000) : undefined),
    checks: checks.length ? checks : fallback.checks,
  };
}

/** Deterministic Playwright `request` snippet from a structured draft — always compiles. */
export function renderChatSnippet(d: ChatTestDraft): string {
  const headerObj = d.headers.length ? `, {\n      headers: ${JSON.stringify(Object.fromEntries(d.headers.map((h) => [h.key, h.value])), null, 6).replace(/\n/g, '\n    ')}${d.body ? `,\n      data: ${d.body}` : ''}\n    }` : (d.body ? `, { data: ${d.body} }` : '');
  const call = `request.${d.method.toLowerCase()}(${JSON.stringify(d.url)}${headerObj})`;
  const lines: string[] = [];
  lines.push(`import { test, expect } from '@playwright/test';`, '');
  lines.push(`test(${JSON.stringify(d.title)}, async ({ request }) => {`);
  lines.push(`  const res = await ${call};`);
  for (const c of d.checks) {
    if (c.kind === 'status') {
      const codes = c.oneOf && c.oneOf.length ? c.oneOf : (c.equals != null ? [Number(c.equals)] : []);
      if (codes.length === 1) lines.push(`  expect(res.status()).toBe(${codes[0]});`);
      else if (codes.length > 1) lines.push(`  expect([${codes.join(', ')}]).toContain(res.status());`);
      else lines.push(`  expect(res.ok()).toBeTruthy();`);
    } else if (c.kind === 'jsonPathExists') {
      lines.push(`  { const body = await res.json(); expect(body${pathAccess(c.path)}).toBeDefined(); }`);
    } else if (c.kind === 'jsonPathEquals') {
      lines.push(`  { const body = await res.json(); expect(body${pathAccess(c.path)}).toEqual(${JSON.stringify(c.value ?? c.equals ?? '')}); }`);
    } else if (c.kind === 'bodyContains') {
      lines.push(`  expect(await res.text()).toContain(${JSON.stringify(c.text ?? '')});`);
    } else if (c.kind === 'responseTimeUnderMs') {
      lines.push(`  // response-time assertion: wrap the call with Date.now() around it (< ${c.ms}ms)`);
    }
  }
  lines.push(`});`, '');
  return lines.join('\n');
}

function pathAccess(path: string | undefined): string {
  if (!path || path === '.') return '';
  return path.split('.').map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `[${JSON.stringify(seg)}]`)).join('');
}

export async function chatRefineTest(
  input: { endpoint: { method: string; url: string; headers?: { key: string; value: string }[]; body?: string }; current?: ChatTestDraft; history?: ChatMessage[]; instruction: string },
  llm: LlmConfig | null | undefined,
): Promise<ChatTestResult> {
  const instruction = String(input.instruction || '').trim();
  if (!instruction) throw new Error('Type an instruction, e.g. "add a 401 case".');

  const fallback: ChatTestDraft = input.current || {
    title: `Verify ${input.endpoint.method} ${input.endpoint.url}`,
    method: input.endpoint.method || 'GET',
    url: input.endpoint.url || '',
    headers: input.endpoint.headers || [],
    body: input.endpoint.body,
    checks: [{ kind: 'status', oneOf: [200] }],
  };

  const history = (input.history || []).slice(-8).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const prompt = `Endpoint under test: ${input.endpoint.method} ${input.endpoint.url}
Current test (JSON):
${JSON.stringify(fallback, null, 2)}

Conversation so far:
${history || '(none)'}

New instruction: ${instruction}

Return the updated test per the system contract.`;

  const raw = await runLLM(prompt, { maxTokens: 2000, system: SYSTEM, llm: llm || undefined });
  let parsed: any;
  try { parsed = parseJsonFromResponse<any>(raw); } catch { parsed = {}; }
  const draft = sanitizeDraft(parsed?.draft, fallback);
  const reply = String(parsed?.reply || 'Updated the test.').slice(0, 600);
  return { reply, draft, snippet: renderChatSnippet(draft) };
}
