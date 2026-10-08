/**
 * api-failure-clusters.service.ts
 * ───────────────────────────────
 * Failure clustering — a standalone, opt-in analysis over a run's failures. It
 * groups similar failures by a normalised root-cause signature so a team fixes
 * one cluster instead of chasing N near-identical reds (testRigor's "group
 * similar issues, fix in place"). Optionally asks the tenant model for one
 * suggested fix per top cluster. Reads only what it is given; touches nothing.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';

export interface FailureItem { title?: string; method?: string; url?: string; error?: string; status?: number }

export interface FailureCluster {
  signature: string;
  label: string;
  category: string;
  count: number;
  members: string[];      // scenario titles in this cluster
  sample: FailureItem;
  suggestedFix?: string;  // present only when `explain` + an LLM is available
}

export interface FailureClusterReport {
  summary: { failures: number; clusters: number };
  clusters: FailureCluster[];
}

const CATEGORY_RULES: { category: string; re: RegExp }[] = [
  { category: 'timeout', re: /timeout|timed out|exceeded|deadline/i },
  { category: 'selector', re: /selector|locator|no element|not found|not visible|strict mode/i },
  { category: 'assertion', re: /expect|assert|to equal|to be|to contain|received|toHave/i },
  { category: 'auth', re: /401|403|unauthor|forbidden|token|credential/i },
  { category: 'server-5xx', re: /\b5\d\d\b|internal server|bad gateway|service unavailable/i },
  { category: 'not-found-404', re: /\b404\b|not found/i },
  { category: 'connection', re: /ECONNREFUSED|ENOTFOUND|network|fetch failed|socket|unreachable/i },
  { category: 'compile', re: /compile|syntax|cannot find module|is not defined|referenceerror|typeerror/i },
  { category: 'rate-limit', re: /\b429\b|rate.?limit|too many requests/i },
];

function categorize(text: string): string {
  for (const r of CATEGORY_RULES) if (r.re.test(text)) return r.category;
  return 'other';
}

/** Collapse volatile detail so near-identical errors share a signature. */
function normalizeError(err: string): string {
  return String(err || '')
    .toLowerCase()
    .replace(/https?:\/\/[^\s'")]+/g, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/["'`][^"'`]*["'`]/g, '<str>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

export function clusterFailures(failures: FailureItem[]): FailureCluster[] {
  const groups = new Map<string, FailureCluster>();
  for (const f of failures) {
    const errText = String(f.error || '');
    const category = categorize(`${errText} ${f.status ?? ''}`);
    const sig = `${category}::${normalizeError(errText) || `status-${f.status ?? '?'}`}`;
    let g = groups.get(sig);
    if (!g) {
      g = { signature: sig, label: normalizeError(errText) || `${category} failures`, category, count: 0, members: [], sample: f };
      groups.set(sig, g);
    }
    g.count++;
    if (g.members.length < 50) g.members.push(String(f.title || f.url || `${f.method || ''} failure`).slice(0, 160));
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export async function analyzeFailureClusters(failures: FailureItem[], opts: { explain?: boolean; llm?: LlmConfig | null } = {}): Promise<FailureClusterReport> {
  const list = (Array.isArray(failures) ? failures : []).slice(0, 2000);
  const clusters = clusterFailures(list);

  if (opts.explain && opts.llm && clusters.length) {
    // One cheap batched call: ask for a fix per top cluster.
    const top = clusters.slice(0, 12);
    const prompt = `You are a senior SDET. For each failure cluster below, give ONE concrete suggested fix (<=200 chars). Respond with STRICT JSON only:
{"fixes": [{"i": <cluster index>, "fix": "<concrete action>"}]}

CLUSTERS:
${top.map((c, i) => `#${i} [${c.category}] (${c.count}×): ${c.label} | e.g. ${(c.sample.error || '').slice(0, 200)}`).join('\n')}

Return the JSON now. No markdown.`;
    try {
      const out = await runLLM(prompt, { maxTokens: 900, llm: opts.llm });
      const parsed = parseJsonFromResponse<{ fixes?: { i: number; fix: string }[] }>(out);
      for (const f of parsed?.fixes || []) {
        if (typeof f.i === 'number' && top[f.i] && typeof f.fix === 'string') top[f.i]!.suggestedFix = f.fix.slice(0, 200);
      }
    } catch { /* suggestions are best-effort */ }
  }

  return { summary: { failures: list.length, clusters: clusters.length }, clusters };
}
