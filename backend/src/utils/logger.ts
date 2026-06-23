/**
 * Structured JSON logger with built-in PII / PHI masking.
 *
 * Lightweight — no third-party logger to keep deps slim. Outputs newline-
 * delimited JSON which is what every cloud log ingester wants
 * (Azure Monitor / CloudWatch / Cloud Logging all parse it natively).
 *
 * Masking rules (applied to message string AND object values recursively):
 *   - Email addresses → `***@***.tld`
 *   - SSN-shaped strings (`123-45-6789`) → `***-**-****`
 *   - 16-digit card-shaped strings → `**** **** **** 1234` (last 4 only)
 *   - Bearer / Basic auth header values → `[REDACTED]`
 *   - Any value with key in `MASKED_KEYS` → `[REDACTED]`
 *
 * If you legitimately need to log a PII field, pass it pre-masked.
 */

const MASKED_KEYS = new Set([
  'password', 'pass', 'token', 'apiKey', 'api_key', 'apiToken', 'api_token',
  'secret', 'authorization', 'auth_header', 'cookie', 'session', 'anthropic_api_key',
  'ssn', 'dob', 'creditCard', 'card_number', 'cvv',
]);

const EMAIL_RE = /\b[\w.+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const BEARER_RE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._=-]{12,}/gi;
const ENC_RE = /__(?:ENC|AES)__[A-Za-z0-9+/=]+/g;

function maskString(s: string): string {
  if (typeof s !== 'string') return s;
  return s
    .replace(EMAIL_RE, (m) => {
      const at = m.indexOf('@');
      const dot = m.lastIndexOf('.');
      return '***@***' + m.slice(dot);
    })
    .replace(SSN_RE, '***-**-****')
    .replace(CARD_RE, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) return m;
      return '**** **** **** ' + digits.slice(-4);
    })
    .replace(BEARER_RE, '[REDACTED]')
    .replace(ENC_RE, '[REDACTED]');
}

function maskValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(maskValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (MASKED_KEYS.has(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = maskValue(v);
      }
    }
    return out;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): number {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
  return LEVEL_RANK[env] ?? LEVEL_RANK.info;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < currentLevel()) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: maskString(msg),
    ...(meta ? (maskValue(meta) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(record);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};

export function maskForLog<T>(value: T): T {
  return maskValue(value) as T;
}
