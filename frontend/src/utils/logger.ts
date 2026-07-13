/**
 * Central client-side logger / tracer for IntelliQE.
 *
 * Why this exists
 * ───────────────
 * Before this, frontend failures were scattered across ~33 raw `console.error`
 * calls and vanished the moment the tab closed — there was no way to answer
 * "the user clicked X and it failed; what exactly happened, and which backend
 * request was it?". This module is the single funnel every log flows through so
 * that question is answerable.
 *
 * Design (mirrors the backend `utils/logger.ts` philosophy — zero deps):
 *   - Leveled logging: debug | info | warn | error.
 *   - A capped in-memory ring buffer (last N entries) that the in-app
 *     Diagnostics panel renders live, so you can "see the logs" without
 *     opening devtools.
 *   - A breadcrumb trail of user actions / route changes / api calls, so an
 *     error entry can be read in the context of what led up to it.
 *   - Sensitive-field redaction (passwords, tokens, bearer headers, __ENC__
 *     blobs) so credentials never land in the buffer, an export, or the sink.
 *   - A stable per-tab `sessionId` and per-request `requestId` correlation so a
 *     client log lines up 1:1 with the backend's structured log + audit_log.
 *   - A best-effort remote sink that ships warn/error entries to the backend
 *     (`/api/client-logs`) so production failures are visible server-side too.
 *   - `exportBundle()` / `download()` to hand support a complete diagnostic
 *     snapshot (env + breadcrumbs + logs) for any reported issue.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;                 // ISO timestamp
  level: LogLevel;
  category: string;           // 'api' | 'ui' | 'route' | 'render' | 'global' | 'app' | custom
  message: string;
  data?: Record<string, unknown>;
  requestId?: string;         // correlates with backend X-Request-Id when present
  durationMs?: number;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const BUFFER_CAP = 500;       // keep the last 500 entries in memory
const SESSION_KEY = 'iqe_session_id';
const LEVEL_KEY = 'iqe_log_level';        // localStorage override for console mirroring
const SINK_DISABLED_KEY = 'iqe_log_sink_off';

const isDev = (import.meta as any).env?.MODE !== 'production';

/* ─────────────────────────────────────────────────────────────
   Identity — one session id per browser tab, reused across reloads
   within the same tab (sessionStorage). Lets every log in a sitting
   be grouped together.
   ───────────────────────────────────────────────────────────── */
export function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* fall through */ }
  // RFC4122-ish fallback for older/embedded webviews
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function readSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = newId();
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return newId(); // storage locked (private mode / iframe) — ephemeral id is fine
  }
}

const sessionId = readSessionId();

/* ─────────────────────────────────────────────────────────────
   Redaction — never let secrets reach the buffer / export / sink.
   Mirrors the sensitive-key set used by utils/crypto + backend logger.
   ───────────────────────────────────────────────────────────── */
const SENSITIVE_KEYS = new Set(
  [
    'password', 'pass', 'token', 'apitoken', 'api_token', 'apikey', 'api_key',
    'clientsecret', 'secret', 'secretkey', 'authorization', 'auth_header',
    'authvalue', 'bearertoken', 'accesskey', 'accesskeyid', 'secretaccesskey',
    'connstr', 'connectionstring', 'cookie', 'session', 'sastoken', 'accesstoken',
    'access_token', 'serviceaccountkey', 'smtppassword', 'app_password',
    'anthropic_api_key', 'databricks_token',
  ].map((k) => k.toLowerCase()),
);

const BEARER_RE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._=-]{12,}/gi;
const ENC_RE = /__(?:ENC|AES)__[A-Za-z0-9+/=]+/g;
const MAX_STRING = 2000;      // truncate giant strings (HTML dumps, stack traces)

function maskString(s: string): string {
  let out = s.replace(BEARER_RE, '[REDACTED]').replace(ENC_RE, '[REDACTED]');
  if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + `…(+${out.length - MAX_STRING} chars)`;
  return out;
}

function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return maskString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: maskString(value.message), stack: value.stack ? maskString(value.stack) : undefined };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/* ─────────────────────────────────────────────────────────────
   Ring buffer + subscribers
   ───────────────────────────────────────────────────────────── */
const buffer: LogEntry[] = [];
let seq = 0;
type Listener = (entry: LogEntry) => void;
const listeners = new Set<Listener>();

/** Subscribe to live log entries (used by the Diagnostics panel). Returns an unsubscribe fn. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Snapshot of the current buffer (newest last). */
export function getEntries(): LogEntry[] {
  return buffer.slice();
}

export function clearEntries(): void {
  buffer.length = 0;
}

/* ─────────────────────────────────────────────────────────────
   Console mirroring — gated by an effective level so prod stays quiet
   but support can flip it on per-browser via localStorage('iqe_log_level').
   ───────────────────────────────────────────────────────────── */
function effectiveConsoleLevel(): number {
  try {
    const override = (localStorage.getItem(LEVEL_KEY) || '').toLowerCase() as LogLevel;
    if (override in LEVEL_RANK) return LEVEL_RANK[override];
  } catch { /* ignore */ }
  return isDev ? LEVEL_RANK.debug : LEVEL_RANK.warn;
}

const CONSOLE_FN: Record<LogLevel, (...a: unknown[]) => void> = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/* ─────────────────────────────────────────────────────────────
   Remote sink — best-effort shipping of warn/error to the backend.
   Batched + flushed on a timer and on page hide via sendBeacon so we
   don't lose the last error when the user navigates away.
   ───────────────────────────────────────────────────────────── */
const sinkQueue: LogEntry[] = [];
let sinkTimer: ReturnType<typeof setTimeout> | null = null;
const SINK_URL = '/api/client-logs';
const SINK_MIN_RANK = LEVEL_RANK.warn;

function sinkEnabled(): boolean {
  try { return localStorage.getItem(SINK_DISABLED_KEY) !== '1'; } catch { return true; }
}

function scheduleFlush(): void {
  if (sinkTimer) return;
  sinkTimer = setTimeout(flushSink, 4000);
}

function flushSink(useBeacon = false): void {
  sinkTimer = null;
  if (!sinkQueue.length || !sinkEnabled()) return;
  const batch = sinkQueue.splice(0, sinkQueue.length);
  const payload = JSON.stringify({ sessionId, userAgent: navigator.userAgent, url: location.href, entries: batch });
  try {
    if (useBeacon && 'sendBeacon' in navigator) {
      navigator.sendBeacon(SINK_URL, new Blob([payload], { type: 'application/json' }));
      return;
    }
    // keepalive lets the request outlive a navigation; we deliberately do NOT
    // route this through the app's axios client to avoid recursive logging.
    void fetch(SINK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => { /* sink is best-effort — never surface its own failure */ });
  } catch { /* ignore */ }
}

/* ─────────────────────────────────────────────────────────────
   Core emit
   ───────────────────────────────────────────────────────────── */
function emit(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): LogEntry {
  const entry: LogEntry = {
    id: ++seq,
    ts: new Date().toISOString(),
    level,
    category,
    message: maskString(String(message)),
    data: data ? (redact(data) as Record<string, unknown>) : undefined,
    requestId: typeof data?.requestId === 'string' ? data.requestId : undefined,
    durationMs: typeof data?.durationMs === 'number' ? data.durationMs : undefined,
  };

  buffer.push(entry);
  if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP);

  if (LEVEL_RANK[level] >= effectiveConsoleLevel()) {
    const tag = `%c[${category}]`;
    const color =
      level === 'error' ? 'color:#ef4444' :
      level === 'warn' ? 'color:#f59e0b' :
      level === 'info' ? 'color:#7C3AED' : 'color:#6b7280';
    CONSOLE_FN[level](tag, color, entry.message, entry.data ?? '');
  }

  // Fan out to live subscribers (Diagnostics panel). Never let a buggy
  // listener break logging.
  for (const fn of listeners) { try { fn(entry); } catch { /* ignore */ } }

  // Ship warn/error to the backend for server-side correlation.
  if (LEVEL_RANK[level] >= SINK_MIN_RANK && sinkEnabled()) {
    sinkQueue.push(entry);
    scheduleFlush();
  }

  return entry;
}

/* ─────────────────────────────────────────────────────────────
   Public API
   ───────────────────────────────────────────────────────────── */
export const log = {
  debug: (category: string, message: string, data?: Record<string, unknown>) => emit('debug', category, message, data),
  info: (category: string, message: string, data?: Record<string, unknown>) => emit('info', category, message, data),
  warn: (category: string, message: string, data?: Record<string, unknown>) => emit('warn', category, message, data),
  error: (category: string, message: string, data?: Record<string, unknown>) => emit('error', category, message, data),

  /** Record a user-action breadcrumb (click, navigation, submit). Info level, `ui` category. */
  action: (message: string, data?: Record<string, unknown>) => emit('info', 'ui', message, data),

  getSessionId: () => sessionId,
  getEntries,
  clearEntries,
  subscribe,
  flushSink: () => flushSink(false),

  /** A complete diagnostic snapshot to copy/download and attach to a bug report. */
  exportBundle() {
    return {
      generatedAt: new Date().toISOString(),
      sessionId,
      url: location.href,
      userAgent: navigator.userAgent,
      appMode: isDev ? 'development' : 'production',
      viewport: { w: window.innerWidth, h: window.innerHeight },
      user: safeUser(),
      entries: getEntries(),
    };
  },

  /** Trigger a browser download of the diagnostic bundle as JSON. */
  download() {
    try {
      const blob = new Blob([JSON.stringify(this.exportBundle(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `intelliqe-diagnostics-${sessionId.slice(0, 8)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      emit('warn', 'app', 'Diagnostics download failed', { err: String(e) });
    }
  },
};

/** Best-effort read of the logged-in user for the export header (never throws). */
function safeUser(): unknown {
  try {
    const raw = sessionStorage.getItem('intelliqe_user');
    if (!raw) return null;
    const u = JSON.parse(raw);
    return { username: u?.username, role: u?.role, tenantName: u?.tenantName };
  } catch { return null; }
}

// Flush any pending warn/error logs when the tab is hidden/closed.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushSink(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSink(true);
  });
}

export default log;
