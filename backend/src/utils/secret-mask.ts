/**
 * secret-mask.ts
 * ──────────────
 * Redact credential-like values from a run result BEFORE it leaves the API, so a
 * captured token / password never lands in the UI's fixtures panel, the JSON
 * response, a response-body preview, or a JUnit report published to CI.
 *
 * This runs at the response boundary only — the flow engine keeps the real
 * values while it executes (so a later step can still send the real token, and
 * a suite still threads it between flows). Masking the returned copy is purely
 * cosmetic and never affects what the engine sends.
 *
 * A variable is treated as secret by NAME (token / password / secret / api-key /
 * authorization / bearer / credential / client-secret). Its real value is then
 * also redacted wherever it appears verbatim in a response-body preview.
 */

const SECRET_NAME_RE = /(^|[_.-])(token|password|passwd|secret|api[_-]?key|apikey|authorization|bearer|credential|client[_-]?secret|access[_-]?key)([_.-]|$)/i;
const MASK = '••••••';
const MIN_REDACT_LEN = 4;   // don't redact very short values (too many false hits)

export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name || '');
}

/**
 * Pattern-based scrub of credential-like values from a FREE-TEXT blob (a failure
 * URL, error message, endpoint) before it is written to an external tracker, a
 * stored defect link, or a log. Unlike maskResult (which masks a known variable
 * bag), this redacts secrets embedded in arbitrary text: URL basic-auth
 * userinfo, sensitive query-string values, and Bearer/Basic auth tokens.
 */
export function scrubSecrets(text: string | undefined | null): string {
  let t = String(text ?? '');
  if (!t) return t;
  // URL userinfo: scheme://user:pass@host  →  scheme://••••:••••@host
  t = t.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://' + MASK + ':' + MASK + '@');
  // Sensitive query params: ?token=xxx&api_key=yyy  →  value masked
  t = t.replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|token|key|password|passwd|secret|authorization|auth|client[_-]?secret|sig|signature)=)[^&\s#]+/gi, '$1' + MASK);
  // Bearer / Basic tokens in text
  t = t.replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1' + MASK);
  t = t.replace(/\b(basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1' + MASK);
  return t;
}

interface StepLike { extracted?: Record<string, string>; bodyPreview?: string }
interface RunLike { variables?: Record<string, string>; steps?: StepLike[] }
interface SuiteFlowLike { run?: RunLike }
interface SuiteLike { variables?: Record<string, string>; flows?: SuiteFlowLike[] }
interface DatasetRowLike { run?: RunLike }
interface DatasetLike { rows?: DatasetRowLike[] }

/** Mask secret-named entries in a bag; collect their real values into `seen` for body redaction. */
function maskVars(vars: Record<string, string> | undefined, seen: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (isSecretName(k) && v) { seen.add(String(v)); out[k] = MASK; }
    else out[k] = v;
  }
  return out;
}

/** Redact any collected secret value wherever it appears verbatim in a text blob. */
function redactText(text: string | undefined, seen: Set<string>): string {
  let t = text || '';
  if (!t) return t;
  for (const sv of seen) { if (sv && sv.length >= MIN_REDACT_LEN) t = t.split(sv).join(MASK); }
  return t;
}

/**
 * Mask a set of runs sharing one secret pool: pass 1 masks every variables/
 * extracted bag (collecting secret values), pass 2 redacts every body preview —
 * so a token captured in one step is also redacted from another step's body.
 */
function maskRuns(runs: RunLike[], topVars?: Record<string, string>): { runs: RunLike[]; topVars?: Record<string, string> } {
  const seen = new Set<string>();
  const maskedTop = topVars ? maskVars(topVars, seen) : undefined;
  const stage1 = runs.map((r) => ({
    ...r,
    variables: maskVars(r.variables, seen),
    steps: (r.steps || []).map((s) => ({ ...s, extracted: maskVars(s.extracted, seen) })),
  }));
  const stage2 = stage1.map((r) => ({
    ...r,
    steps: (r.steps || []).map((s) => ({ ...s, bodyPreview: redactText(s.bodyPreview, seen) })),
  }));
  return { runs: stage2, topVars: maskedTop };
}

function maskFlow(result: RunLike): RunLike {
  return maskRuns([result]).runs[0]!;
}

function maskSuite(result: SuiteLike): SuiteLike {
  const flows = result.flows || [];
  const { runs, topVars } = maskRuns(flows.map((f) => f.run || {}), result.variables);
  return { ...result, variables: topVars ?? result.variables, flows: flows.map((f, i) => ({ ...f, run: runs[i] })) };
}

function maskDataset(result: DatasetLike): DatasetLike {
  const rows = result.rows || [];
  const { runs } = maskRuns(rows.map((r) => r.run || {}));
  // Row inputs are user-provided test data (not captured), so they're left as-is.
  return { ...result, rows: rows.map((r, i) => ({ ...r, run: runs[i] })) };
}

/** Mask a run result of the given kind. Unknown/empty input is returned untouched. */
export function maskResult(kind: 'flow' | 'suite' | 'dataset', result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  if (kind === 'suite') return maskSuite(result as SuiteLike);
  if (kind === 'dataset') return maskDataset(result as DatasetLike);
  return maskFlow(result as RunLike);
}
