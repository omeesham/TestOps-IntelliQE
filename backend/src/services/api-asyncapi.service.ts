/**
 * api-asyncapi.service.ts
 * ───────────────────────
 * Event-driven (AsyncAPI) contract testing. Parse an AsyncAPI 2.x/3.x document,
 * surface its channels + message payload schemas, and validate a concrete event
 * payload against a channel's schema — so a Kafka/MQ/WebSocket message can be
 * contract-checked the way an OpenAPI response is. Pairs with the Kafka probe
 * (consume a message, then validate it here).
 *
 * Standalone and opt-in: reuses the bundled `yaml` + `ajv`; no new deps; the
 * pipeline is never involved.
 */
import YAML from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export interface AsyncChannel { name: string; operations: string[]; messageNames: string[]; hasSchema: boolean }
export interface AsyncApiSummary { title: string; version: string; asyncapi: string; channels: AsyncChannel[] }

interface ParsedDoc { raw: any; channels: Record<string, { operations: string[]; schema: any | null; messageNames: string[] }> }

function resolveRef(doc: any, ref: string): any {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let cur = doc;
  for (const seg of ref.slice(2).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Follow a single level of $ref (bounded) and return the payload schema of a message. */
function payloadOf(doc: any, message: any): any | null {
  let m = message;
  if (m && m.$ref) m = resolveRef(doc, m.$ref);
  if (!m) return null;
  let payload = m.payload;
  if (payload && payload.$ref) payload = resolveRef(doc, payload.$ref);
  return payload || null;
}

function parse(text: string): ParsedDoc {
  let doc: any;
  const trimmed = text.trim();
  try { doc = trimmed.startsWith('{') ? JSON.parse(trimmed) : YAML.parse(trimmed); }
  catch (e) { throw new Error(`Could not parse AsyncAPI document: ${(e as Error).message}`); }
  if (!doc || (!doc.asyncapi && !doc.channels)) throw new Error('This does not look like an AsyncAPI document (no "asyncapi"/"channels").');

  const channels: ParsedDoc['channels'] = {};
  const rawChannels = doc.channels || {};
  for (const [name, chRaw] of Object.entries<any>(rawChannels)) {
    const ch = chRaw || {};
    const operations: string[] = [];
    const messageNames: string[] = [];
    let schema: any | null = null;

    // AsyncAPI 2.x: channel.publish/subscribe.message. 3.x: channel.messages + operations elsewhere.
    for (const op of ['publish', 'subscribe']) {
      if (ch[op]) {
        operations.push(op);
        let msg = ch[op].message;
        if (msg && msg.oneOf && Array.isArray(msg.oneOf)) msg = msg.oneOf[0];
        if (msg) { const p = payloadOf(doc, msg); if (p && !schema) schema = p; messageNames.push(msg.name || msg.$ref || op); }
      }
    }
    if (ch.messages && typeof ch.messages === 'object') {
      for (const [mn, mRaw] of Object.entries<any>(ch.messages)) {
        messageNames.push(mn);
        const p = payloadOf(doc, mRaw);
        if (p && !schema) schema = p;
      }
      if (!operations.length) operations.push('message');
    }
    channels[name] = { operations, schema, messageNames };
  }
  return { raw: doc, channels };
}

export function summarizeAsyncApi(text: string): AsyncApiSummary {
  const { raw, channels } = parse(text);
  return {
    title: raw.info?.title || 'AsyncAPI',
    version: raw.info?.version || '',
    asyncapi: raw.asyncapi || '',
    channels: Object.entries(channels).map(([name, c]) => ({ name, operations: c.operations, messageNames: c.messageNames, hasSchema: !!c.schema })),
  };
}

export interface AsyncValidateResult { valid: boolean; channel: string; errors: { path: string; message: string }[]; schemaFound: boolean }

export function validateAsyncMessage(text: string, channelName: string, payload: unknown): AsyncValidateResult {
  const { channels } = parse(text);
  const ch = channels[channelName];
  if (!ch) throw new Error(`Channel "${channelName}" not found. Available: ${Object.keys(channels).join(', ') || '(none)'}`);
  if (!ch.schema) return { valid: true, channel: channelName, errors: [], schemaFound: false };

  let data = payload;
  if (typeof payload === 'string') { try { data = JSON.parse(payload); } catch { /* keep as string */ } }

  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  let validateFn;
  try { validateFn = ajv.compile(ch.schema); }
  catch (e) { throw new Error(`Message schema for "${channelName}" could not be compiled: ${(e as Error).message}`); }
  const valid = !!validateFn(data);
  const errors = (validateFn.errors || []).slice(0, 50).map((e) => ({ path: e.instancePath || '(root)', message: e.message || 'invalid' }));
  return { valid, channel: channelName, errors, schemaFound: true };
}
