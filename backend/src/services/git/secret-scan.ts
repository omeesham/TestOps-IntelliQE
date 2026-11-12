/**
 * secret-scan.ts
 * ──────────────
 * IQE-053.2 — "Secret check before any code push (shared by all git providers)".
 *
 * A pre-push scanner invoked ONCE in git.routes.ts before `provider.publish(...)`,
 * so the SAME check guards GitHub, GitLab, Bitbucket and (future) Azure DevOps
 * pushes from a single place. If any file to be committed contains a real secret
 * (token, password, API key or private key), the push is STOPPED and the caller
 * is told the file + line, with the secret's value masked.
 *
 * Design goals (per the acceptance criteria):
 *  - Normal IntelliQE output reads secrets from the environment (process.env.*,
 *    {{vars}}, ${...}) and carries NO literals, so a clean push is never blocked.
 *  - Only literal, high-confidence secrets trip the scan — we deliberately avoid
 *    false positives on env references, placeholders and blank `.env.example`
 *    template values.
 */
import { maskSecret } from '../../utils/crypto.js';
import type { GitFile } from './git.types.js';

export interface SecretFinding {
  /** Repo-relative file path the secret was found in. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** What kind of secret matched (e.g. "AWS access key", "Private key"). */
  kind: string;
  /** The offending value, MASKED — never the real secret. */
  masked: string;
}

export interface SecretScanResult {
  clean: boolean;
  findings: SecretFinding[];
}

/** A value that is an env reference / placeholder / template var — never a real secret. */
const PLACEHOLDER_RE =
  /^\s*(process\.env\.|import\.meta\.env\.|os\.environ|System\.getenv|ENV\[|\$\{|\{\{|<[^>]+>|your[_-]?|changeme|placeholder|example|dummy|xxx+|\*{3,}|•+|redacted|\.{3,})/i;

/** Obvious non-secret filler often seen in sample values. */
const FILLER_RE = /^(password|secret|token|apikey|api[_-]?key|changeme|example|test|null|undefined|true|false|none)$/i;

/** True when `value` looks like a reference/placeholder rather than a literal secret. */
function isPlaceholder(value: string): boolean {
  const v = value.trim().replace(/^['"`]|['"`]$/g, '').trim();
  if (!v) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (FILLER_RE.test(v)) return true;
  // References another variable (JS/TS): `config.token`, `creds.password`, bareword.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(v) && !/[0-9]{4,}/.test(v)) return true;
  return false;
}

/**
 * High-confidence provider token / key shapes. Each entry: a label + a regex
 * whose FULL match is the secret value to mask. These are specific enough that a
 * match is almost certainly a real credential regardless of surrounding code.
 */
const TOKEN_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: 'GitLab personal access token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Stripe secret key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { kind: 'OpenAI / Anthropic key', re: /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'URL with embedded credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]{3,}@[^\s/]+/gi },
];

/** Private-key PEM header — the whole block is a secret; one line is enough to flag. */
const PEM_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/;

/**
 * Assignment of a credential-named key to a literal string:
 *   password = "hunter2"   api_key: 'abc123...'   AUTH_TOKEN="…"
 * Group 1 = the value (without quotes). Env refs / placeholders are filtered out
 * by isPlaceholder so `password: process.env.PW` and blank templates don't trip.
 */
const ASSIGN_RE =
  /\b(?:password|passwd|pwd|pass_?hash|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|private[_-]?key|session[_-]?token)\b\s*[:=]\s*['"`]([^'"`\n]{4,})['"`]/gi;

/** Scan a single line, pushing any findings for `path` at `lineNo`. */
function scanLine(path: string, lineNo: number, line: string, out: SecretFinding[]): void {
  if (PEM_RE.test(line)) {
    out.push({ path, line: lineNo, kind: 'Private key', masked: '-----BEGIN PRIVATE KEY----- •••' });
  }
  for (const { kind, re } of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      out.push({ path, line: lineNo, kind, masked: maskSecret(m[0]) });
    }
  }
  ASSIGN_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = ASSIGN_RE.exec(line)) !== null) {
    const value = a[1] ?? '';
    if (isPlaceholder(value)) continue;
    out.push({ path, line: lineNo, kind: 'Hardcoded credential', masked: maskSecret(value) });
  }
}

/**
 * Scan every file's content for secrets. Returns { clean, findings }.
 * Dedupes identical (path,line,masked) hits so a value repeated on one line is
 * reported once.
 */
export function scanFilesForSecrets(files: GitFile[]): SecretScanResult {
  const findings: SecretFinding[] = [];
  for (const f of files) {
    if (!f || typeof f.content !== 'string' || !f.content) continue;
    // `.env.example` and other *.example templates ship intentionally-blank
    // values; they're caught by isPlaceholder, but skip binary-ish huge blobs.
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      scanLine(f.path, i + 1, lines[i] ?? '', findings);
    }
  }
  const seen = new Set<string>();
  const deduped = findings.filter((x) => {
    const k = `${x.path}:${x.line}:${x.kind}:${x.masked}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { clean: deduped.length === 0, findings: deduped };
}

/** One-line-per-finding summary for an error message / API response. */
export function formatSecretFindings(findings: SecretFinding[]): string {
  return findings
    .slice(0, 50)
    .map((f) => `  • ${f.path}:${f.line} — ${f.kind}: ${f.masked}`)
    .join('\n');
}
