/**
 * api-async.service.ts
 * ────────────────────
 * Async / streaming probes — a standalone, opt-in tool for the protocols the
 * request/response pipeline can't express: WebSocket (ws/wss) and Server-Sent
 * Events (an http/https text/event-stream). It opens the connection, optionally
 * sends one message, collects what arrives inside a bounded window, and checks
 * an optional "expected substring". It connects to the live endpoint and stores
 * nothing; the generate → execute → heal pipeline is untouched.
 *
 * Uses Node's native global WebSocket and fetch — no external dependency and no
 * binary. Full binary gRPC (which needs proto compilation) is intentionally out
 * of scope here; WS + SSE cover the real-time streaming cases.
 */

export type AsyncProtocol = 'websocket' | 'sse';

export interface AsyncProbeInput {
  url: string;
  message?: string;            // WebSocket: a single frame to send after connecting
  headers?: { key: string; value: string }[]; // SSE only (WS in browsers/Node can't set arbitrary headers)
  waitMs?: number;
  expectContains?: string;
}

export interface AsyncFrame { at: number; preview: string }

export interface AsyncProbeResult {
  protocol: AsyncProtocol;
  url: string;
  connected: boolean;
  received: number;
  frames: AsyncFrame[];
  firstByteMs?: number;
  durationMs: number;
  matched?: boolean;           // only when expectContains was set
  expectContains?: string;
  error?: string;
}

const MAX_WAIT = 15_000;
const MIN_WAIT = 500;
const MAX_FRAMES = 50;
const FRAME_PREVIEW = 500;

function clampWait(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 4000;
  return Math.min(MAX_WAIT, Math.max(MIN_WAIT, n));
}

function coerce(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (ArrayBuffer.isView(data as ArrayBufferView)) return Buffer.from((data as ArrayBufferView).buffer).toString('utf8');
  } catch { /* fall through */ }
  return String(data);
}

function protocolFor(url: string): AsyncProtocol | null {
  if (/^wss?:\/\//i.test(url)) return 'websocket';
  if (/^https?:\/\//i.test(url)) return 'sse';
  return null;
}

async function probeWebSocket(input: AsyncProbeInput): Promise<AsyncProbeResult> {
  const url = input.url;
  const waitMs = clampWait(input.waitMs);
  const started = Date.now();
  const frames: AsyncFrame[] = [];
  let connected = false;
  let firstByteMs: number | undefined;

  return await new Promise<AsyncProbeResult>((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closing */ }
      const text = frames.map((f) => f.preview).join('\n');
      resolve({
        protocol: 'websocket', url, connected, received: frames.length, frames, firstByteMs,
        durationMs: Date.now() - started,
        matched: input.expectContains ? text.includes(input.expectContains) : undefined,
        expectContains: input.expectContains || undefined,
        error,
      });
    };
    const timer = setTimeout(() => finish(), waitMs);
    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish((err as Error).message || 'Could not open the WebSocket.');
      return;
    }
    ws.onopen = () => {
      connected = true;
      if (input.message) { try { ws.send(input.message); } catch { /* send is best-effort */ } }
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (firstByteMs === undefined) firstByteMs = Date.now() - started;
      if (frames.length < MAX_FRAMES) frames.push({ at: Date.now() - started, preview: coerce(ev.data).slice(0, FRAME_PREVIEW) });
      // Stop early once the expectation is satisfied.
      if (input.expectContains && frames.some((f) => f.preview.includes(input.expectContains!))) finish();
    };
    ws.onerror = () => { if (!connected) finish('The WebSocket connection failed (refused, TLS, or bad handshake).'); };
    ws.onclose = () => finish();
  });
}

async function probeSSE(input: AsyncProbeInput): Promise<AsyncProbeResult> {
  const url = input.url;
  const waitMs = clampWait(input.waitMs);
  const started = Date.now();
  const frames: AsyncFrame[] = [];
  let firstByteMs: number | undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), waitMs);

  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  for (const h of input.headers || []) { if (h?.key) headers[h.key] = h.value ?? ''; }

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      return { protocol: 'sse', url, connected: false, received: 0, frames, durationMs: Date.now() - started, error: `The stream did not open (HTTP ${res.status}).` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === undefined) firstByteMs = Date.now() - started;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line.
      let sep: number;
      while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + (buf[sep] === '\r' ? 4 : 2));
        const data = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (data && frames.length < MAX_FRAMES) frames.push({ at: Date.now() - started, preview: data.slice(0, FRAME_PREVIEW) });
        if (input.expectContains && data.includes(input.expectContains)) { try { await reader.cancel(); } catch { /* ignore */ } break outer; }
        if (frames.length >= MAX_FRAMES) { try { await reader.cancel(); } catch { /* ignore */ } break outer; }
      }
    }
    clearTimeout(timer);
    const text = frames.map((f) => f.preview).join('\n');
    return {
      protocol: 'sse', url, connected: true, received: frames.length, frames, firstByteMs,
      durationMs: Date.now() - started,
      matched: input.expectContains ? text.includes(input.expectContains) : undefined,
      expectContains: input.expectContains || undefined,
    };
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === 'AbortError';
    const text = frames.map((f) => f.preview).join('\n');
    // An abort is the normal end of the wait window, not a failure, if we got data.
    if (aborted && frames.length > 0) {
      return {
        protocol: 'sse', url, connected: true, received: frames.length, frames, firstByteMs,
        durationMs: Date.now() - started,
        matched: input.expectContains ? text.includes(input.expectContains) : undefined,
        expectContains: input.expectContains || undefined,
      };
    }
    return { protocol: 'sse', url, connected: frames.length > 0, received: frames.length, frames, durationMs: Date.now() - started, error: aborted ? 'No events arrived within the wait window.' : ((err as Error).message || 'The stream could not be read.') };
  }
}

export async function runAsyncProbe(raw: unknown): Promise<AsyncProbeResult> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const url = String(input.url || '').trim();
  const protocol = protocolFor(url);
  if (!protocol) throw new Error('Enter a ws:// or wss:// URL for WebSocket, or an http(s):// URL for Server-Sent Events.');
  const normalized: AsyncProbeInput = {
    url,
    message: typeof input.message === 'string' ? input.message.slice(0, 10_000) : undefined,
    headers: Array.isArray(input.headers) ? input.headers.filter((h: any) => h?.key).slice(0, 30).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })) : [],
    waitMs: input.waitMs,
    expectContains: typeof input.expectContains === 'string' && input.expectContains.trim() ? input.expectContains.slice(0, 500) : undefined,
  };
  return protocol === 'websocket' ? probeWebSocket(normalized) : probeSSE(normalized);
}
