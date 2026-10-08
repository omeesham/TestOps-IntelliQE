/**
 * api-messaging.service.ts
 * ────────────────────────
 * Event/queue + gRPC testing. Produce/consume on a Kafka topic, and make a unary
 * gRPC call from a supplied .proto. Fills the "REST/GraphQL/WS/SSE only" gap.
 *
 * Standalone and opt-in: the pipeline is never involved. The heavy clients
 * (kafkajs, @grpc/grpc-js, @grpc/proto-loader) are OPTIONAL dependencies loaded
 * dynamically — if a host hasn't installed them, the tool returns a clear
 * "not installed" message instead of crashing (same graceful-degradation pattern
 * as the optional Playwright browsers). They are imported through a variable
 * specifier so a build without them still type-checks.
 */
import { randomBytes } from 'crypto';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/** Dynamic import via a non-literal specifier → stays `any`, never resolved at build time. */
async function optional(moduleName: string): Promise<any> {
  try { return await import(moduleName); }
  catch { throw new Error(`The "${moduleName}" package is not installed on this server. Run: npm install ${moduleName}`); }
}

/* ────────────────────────────────────────────────────────────────
   Kafka
   ──────────────────────────────────────────────────────────────── */

export interface KafkaInput {
  brokers: string | string[];
  topic: string;
  mode: 'produce' | 'consume';
  message?: string;
  key?: string;
  groupId?: string;
  fromBeginning?: boolean;
  ssl?: boolean;
  sasl?: { mechanism?: string; username?: string; password?: string };
  timeoutMs?: number;
}

export interface KafkaResult {
  mode: string;
  topic: string;
  produced?: { partition: number; offset?: string };
  messages?: { partition: number; offset: string; key: string | null; value: string; timestamp?: string }[];
  elapsedMs: number;
}

function brokerList(raw: string | string[]): string[] {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return arr.map((b) => String(b).trim()).filter(Boolean).slice(0, 10);
}

export async function kafkaProbe(input: KafkaInput): Promise<KafkaResult> {
  const brokers = brokerList(input.brokers);
  if (!brokers.length) throw new Error('Provide at least one Kafka broker (host:port).');
  const topic = String(input.topic || '').trim();
  if (!topic) throw new Error('Provide a topic.');
  const timeoutMs = Math.min(30_000, Math.max(2_000, Number(input.timeoutMs) || 10_000));

  const { Kafka, logLevel } = await optional('kafkajs');
  const clientConfig: any = { clientId: 'intelliqe-tester', brokers, ssl: !!input.ssl, logLevel: logLevel?.NOTHING ?? 0, connectionTimeout: timeoutMs, requestTimeout: timeoutMs };
  if (input.sasl?.username) clientConfig.sasl = { mechanism: input.sasl.mechanism || 'plain', username: input.sasl.username, password: input.sasl.password || '' };
  const kafka = new Kafka(clientConfig);
  const started = Date.now();

  if (input.mode === 'produce') {
    const producer = kafka.producer();
    await producer.connect();
    try {
      const md = await producer.send({ topic, messages: [{ key: input.key || null, value: String(input.message ?? '') }] });
      const r = Array.isArray(md) && md[0] ? md[0] : {};
      return { mode: 'produce', topic, produced: { partition: Number(r.partition) || 0, offset: r.baseOffset }, elapsedMs: Date.now() - started };
    } finally { await producer.disconnect().catch(() => {}); }
  }

  // consume
  const groupId = input.groupId || `intelliqe-${randomBytes(4).toString('hex')}`;
  const consumer = kafka.consumer({ groupId, sessionTimeout: timeoutMs });
  const messages: NonNullable<KafkaResult['messages']> = [];
  await consumer.connect();
  try {
    await consumer.subscribe({ topic, fromBeginning: input.fromBeginning !== false });
    await consumer.run({
      eachMessage: async ({ partition, message }: any) => {
        if (messages.length >= 20) return;
        messages.push({
          partition,
          offset: String(message.offset),
          key: message.key ? message.key.toString() : null,
          value: message.value ? message.value.toString().slice(0, 4000) : '',
          timestamp: message.timestamp,
        });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return { mode: 'consume', topic, messages, elapsedMs: Date.now() - started };
  } finally { await consumer.disconnect().catch(() => {}); }
}

/* ────────────────────────────────────────────────────────────────
   gRPC (unary)
   ──────────────────────────────────────────────────────────────── */

export interface GrpcInput {
  target: string;
  protoText: string;
  service: string;
  method: string;
  requestJson?: string;
  tls?: boolean;
  metadata?: Record<string, string>;
  timeoutMs?: number;
}

export interface GrpcResult {
  ok: boolean;
  service: string;
  method: string;
  response?: unknown;
  error?: string;
  code?: number | string;
  elapsedMs: number;
}

/** Walk a loaded proto namespace to find a service definition by (possibly dotted) name. */
function findService(pkg: any, service: string): any {
  if (!service) return null;
  const direct = service.split('.').reduce((cur: any, seg: string) => (cur ? cur[seg] : undefined), pkg);
  if (direct && typeof direct === 'function' && direct.service) return direct;
  // Fall back: breadth-first search for a constructor whose name matches the last segment.
  const target = service.split('.').pop();
  const seen = new Set<any>();
  const stack = [pkg];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'function' && v.service && (k === target || k === service)) return v;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

export async function grpcCall(input: GrpcInput): Promise<GrpcResult> {
  const target = String(input.target || '').trim();
  if (!target) throw new Error('Provide a gRPC target (host:port).');
  if (!input.protoText || input.protoText.trim().length < 10) throw new Error('Paste the .proto definition.');
  const service = String(input.service || '').trim();
  const method = String(input.method || '').trim();
  if (!service || !method) throw new Error('Provide the service and method names.');
  const timeoutMs = Math.min(30_000, Math.max(1_000, Number(input.timeoutMs) || 10_000));

  const grpc = await optional('@grpc/grpc-js');
  const protoLoader = await optional('@grpc/proto-loader');

  const dir = await mkdtemp(join(tmpdir(), 'iqe-proto-'));
  const protoPath = join(dir, 'service.proto');
  const started = Date.now();
  try {
    await writeFile(protoPath, input.protoText, 'utf-8');
    const packageDef = await protoLoader.load(protoPath, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
    const loaded = grpc.loadPackageDefinition(packageDef);
    const ServiceCtor = findService(loaded, service);
    if (!ServiceCtor) throw new Error(`Service "${service}" not found in the proto. Use the fully-qualified name (package.Service).`);

    const creds = input.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    const client = new ServiceCtor(target, creds);
    if (typeof client[method] !== 'function') throw new Error(`Method "${method}" not found on service "${service}".`);

    let request: any = {};
    if (input.requestJson && input.requestJson.trim()) { try { request = JSON.parse(input.requestJson); } catch { throw new Error('requestJson is not valid JSON.'); } }

    const metadata = new grpc.Metadata();
    for (const [k, v] of Object.entries(input.metadata || {})) metadata.set(k, String(v));
    const deadline = new Date(Date.now() + timeoutMs);

    const response = await new Promise<unknown>((resolve, reject) => {
      client[method](request, metadata, { deadline }, (err: any, res: unknown) => {
        if (err) reject(err); else resolve(res);
      });
    });
    try { client.close?.(); } catch { /* ignore */ }
    return { ok: true, service, method, response, elapsedMs: Date.now() - started };
  } catch (err: any) {
    return { ok: false, service, method, error: err?.details || err?.message || String(err), code: err?.code, elapsedMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GrpcStreamResult { ok: boolean; service: string; method: string; messages: unknown[]; count: number; truncated: boolean; error?: string; code?: number | string; elapsedMs: number }

/** A server-streaming gRPC call: collect up to a bounded number of streamed messages. */
export async function grpcServerStream(input: GrpcInput & { maxMessages?: number }): Promise<GrpcStreamResult> {
  const target = String(input.target || '').trim();
  const service = String(input.service || '').trim();
  const method = String(input.method || '').trim();
  if (!target || !service || !method) throw new Error('Provide target, service and method.');
  if (!input.protoText || input.protoText.trim().length < 10) throw new Error('Paste the .proto definition.');
  const timeoutMs = Math.min(60_000, Math.max(1_000, Number(input.timeoutMs) || 15_000));
  const cap = Math.min(500, Math.max(1, Number(input.maxMessages) || 50));

  const grpc = await optional('@grpc/grpc-js');
  const protoLoader = await optional('@grpc/proto-loader');
  const dir = await mkdtemp(join(tmpdir(), 'iqe-proto-'));
  const protoPath = join(dir, 'service.proto');
  const started = Date.now();
  try {
    await writeFile(protoPath, input.protoText, 'utf-8');
    const packageDef = await protoLoader.load(protoPath, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
    const loaded = grpc.loadPackageDefinition(packageDef);
    const ServiceCtor = findService(loaded, service);
    if (!ServiceCtor) throw new Error(`Service "${service}" not found in the proto.`);
    const creds = input.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    const client = new ServiceCtor(target, creds);
    if (typeof client[method] !== 'function') throw new Error(`Method "${method}" not found on service "${service}".`);
    let request: any = {};
    if (input.requestJson && input.requestJson.trim()) { try { request = JSON.parse(input.requestJson); } catch { throw new Error('requestJson is not valid JSON.'); } }
    const metadata = new grpc.Metadata();
    for (const [k, v] of Object.entries(input.metadata || {})) metadata.set(k, String(v));

    const messages: unknown[] = [];
    let truncated = false;
    const call = client[method](request, metadata);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { try { call.cancel(); } catch { /* ignore */ } resolve(); }, timeoutMs);
      call.on('data', (m: unknown) => { if (messages.length < cap) messages.push(m); else { truncated = true; try { call.cancel(); } catch { /* ignore */ } } });
      call.on('end', () => { clearTimeout(timer); resolve(); });
      call.on('error', (e: any) => { clearTimeout(timer); if (e?.code === grpc.status?.CANCELLED) resolve(); else reject(e); });
    });
    try { client.close?.(); } catch { /* ignore */ }
    return { ok: true, service, method, messages, count: messages.length, truncated, elapsedMs: Date.now() - started };
  } catch (err: any) {
    return { ok: false, service, method, messages: [], count: 0, truncated: false, error: err?.details || err?.message || String(err), code: err?.code, elapsedMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GrpcReflectResult { ok: boolean; services: string[]; error?: string }

/** List services exposed by a reflection-enabled gRPC server (no .proto needed). */
export async function grpcReflect(input: { target: string; tls?: boolean }): Promise<GrpcReflectResult> {
  const target = String(input.target || '').trim();
  if (!target) throw new Error('Provide a gRPC target (host:port).');
  try {
    const grpc = await optional('@grpc/grpc-js');
    const reflection = await optional('grpc-reflection-js');
    const creds = input.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    const client = new reflection.Client(target, creds);
    const services: string[] = await client.listServices();
    return { ok: true, services: (services || []).filter((s) => !/^grpc\.reflection/.test(s)) };
  } catch (err) {
    return { ok: false, services: [], error: (err as Error).message };
  }
}
