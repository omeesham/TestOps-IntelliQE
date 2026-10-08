/**
 * EventGrpc — message-queue (Kafka) and gRPC testing.
 *
 * Opt-in and standalone, closing the "REST / GraphQL / WS / SSE only" gap. Two
 * tabs, each self-contained: Kafka either produces one message to a topic or
 * consumes a short burst from it; gRPC loads a .proto inline and calls one
 * method. Both talk to the live service and store nothing — the HTTP pipeline
 * and the catalogue are untouched. The kafkajs / @grpc transports are optional
 * server deps, so a "not installed" reply is expected and shown plainly.
 */
import { useState } from 'react';
import { X, Radio, Play, AlertTriangle, CheckCircle2, XCircle, ChevronDown, ListTree } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { kafkaProbe, grpcCall, grpcServerStream, grpcReflect, type KafkaResult, type GrpcResult, type GrpcStreamResult, type GrpcReflectResult } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, INSET } from './format';

type Tab = 'kafka' | 'grpc';
type KafkaMode = 'produce' | 'consume';
type SaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512';
type GrpcCallType = 'unary' | 'stream';

export default function EventGrpc({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('kafka');

  /* ── Kafka tab state ── */
  const [kBrokers, setKBrokers] = useState('');
  const [kTopic, setKTopic] = useState('');
  const [kMode, setKMode] = useState<KafkaMode>('produce');
  const [kMessage, setKMessage] = useState('');
  const [kKey, setKKey] = useState('');
  const [kGroupId, setKGroupId] = useState('');
  const [kFromBeginning, setKFromBeginning] = useState(false);
  const [kAdvanced, setKAdvanced] = useState(false);
  const [kSsl, setKSsl] = useState(false);
  const [kSaslMech, setKSaslMech] = useState<SaslMechanism>('plain');
  const [kSaslUser, setKSaslUser] = useState('');
  const [kSaslPass, setKSaslPass] = useState('');
  const [kResult, setKResult] = useState<KafkaResult | null>(null);
  const [kLoading, setKLoading] = useState(false);
  const [kError, setKError] = useState('');

  /* ── gRPC tab state ── */
  const [gTarget, setGTarget] = useState('');
  const [gTls, setGTls] = useState(false);
  const [gProto, setGProto] = useState('');
  const [gService, setGService] = useState('');
  const [gMethod, setGMethod] = useState('');
  const [gRequest, setGRequest] = useState('');
  const [gCallType, setGCallType] = useState<GrpcCallType>('unary');
  const [gMaxMessages, setGMaxMessages] = useState(20);
  const [gResult, setGResult] = useState<GrpcResult | null>(null);
  const [gStreamResult, setGStreamResult] = useState<GrpcStreamResult | null>(null);
  const [gReflect, setGReflect] = useState<GrpcReflectResult | null>(null);
  const [gReflecting, setGReflecting] = useState(false);
  const [gLoading, setGLoading] = useState(false);
  const [gError, setGError] = useState('');

  const runKafka = async () => {
    setKLoading(true); setKError(''); setKResult(null);
    try {
      const hasSasl = kSaslUser.trim() !== '' || kSaslPass !== '';
      setKResult(await kafkaProbe({
        brokers: kBrokers.trim(),
        topic: kTopic.trim(),
        mode: kMode,
        message: kMode === 'produce' && kMessage ? kMessage : undefined,
        key: kMode === 'produce' && kKey.trim() ? kKey.trim() : undefined,
        groupId: kMode === 'consume' && kGroupId.trim() ? kGroupId.trim() : undefined,
        fromBeginning: kMode === 'consume' ? kFromBeginning : undefined,
        ssl: kSsl || undefined,
        sasl: hasSasl ? { mechanism: kSaslMech, username: kSaslUser.trim() || undefined, password: kSaslPass || undefined } : undefined,
      }));
    } catch (e: any) {
      setKError(e?.response?.data?.error || e?.message || 'Kafka probe failed.');
    } finally {
      setKLoading(false);
    }
  };

  const runGrpc = async () => {
    setGLoading(true); setGError(''); setGResult(null); setGStreamResult(null);
    try {
      const input = {
        target: gTarget.trim(),
        protoText: gProto,
        service: gService.trim(),
        method: gMethod.trim(),
        requestJson: gRequest.trim() || undefined,
        tls: gTls || undefined,
      };
      if (gCallType === 'stream') setGStreamResult(await grpcServerStream({ ...input, maxMessages: gMaxMessages }));
      else setGResult(await grpcCall(input));
    } catch (e: any) {
      setGError(e?.response?.data?.error || e?.message || 'gRPC call failed.');
    } finally {
      setGLoading(false);
    }
  };

  const reflect = async () => {
    setGReflecting(true); setGError(''); setGReflect(null);
    try {
      setGReflect(await grpcReflect({ target: gTarget.trim(), tls: gTls || undefined }));
    } catch (e: any) {
      setGError(e?.response?.data?.error || e?.message || 'gRPC reflection failed.');
    } finally {
      setGReflecting(false);
    }
  };

  const kafkaReady = kBrokers.trim() !== '' && kTopic.trim() !== '';
  const grpcReady = gTarget.trim() !== '' && gProto.trim() !== '' && gService.trim() !== '' && gMethod.trim() !== '';

  const tabClass = (id: Tab) =>
    `px-3 py-1.5 text-[12px] font-medium rounded-lg border transition-colors ${
      tab === id ? 'bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]' : 'bg-white border-gray-200 text-gray-600 hover:text-[#7C3AED]'
    }`;
  const modeClass = (m: KafkaMode) =>
    `px-2.5 py-1 text-[11.5px] font-medium rounded-md border transition-colors ${
      kMode === m ? 'bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]' : 'bg-white border-gray-200 text-gray-600 hover:text-[#7C3AED]'
    }`;
  const modeClass2 = (m: GrpcCallType) =>
    `px-2.5 py-1 text-[11.5px] font-medium rounded-md border transition-colors ${
      gCallType === m ? 'bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]' : 'bg-white border-gray-200 text-gray-600 hover:text-[#7C3AED]'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Radio className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Events &amp; gRPC</h3>
          <span className="text-[11px] text-gray-400">Kafka topics and gRPC services</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setTab('kafka')} className={tabClass('kafka')}>Kafka</button>
            <button type="button" onClick={() => setTab('grpc')} className={tabClass('grpc')}>gRPC</button>
          </div>

          {/* ── Kafka ── */}
          {tab === 'kafka' && (
            <div className="space-y-3">
              <div>
                <label className={LABEL}>Brokers</label>
                <input value={kBrokers} onChange={(e) => setKBrokers(e.target.value)} placeholder="host:9092, host2:9092" className={`${INPUT} font-mono text-[11.5px]`} />
              </div>
              <div>
                <label className={LABEL}>Topic</label>
                <input value={kTopic} onChange={(e) => setKTopic(e.target.value)} placeholder="orders.events" className={`${INPUT} font-mono text-[11.5px]`} />
              </div>

              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => setKMode('produce')} className={modeClass('produce')}>Produce</button>
                <button type="button" onClick={() => setKMode('consume')} className={modeClass('consume')}>Consume</button>
              </div>

              {kMode === 'produce' ? (
                <>
                  <div>
                    <label className={LABEL}>Message</label>
                    <textarea value={kMessage} onChange={(e) => setKMessage(e.target.value)} rows={3} placeholder='{"orderId":123,"status":"paid"}' className={`${INPUT} font-mono text-[11.5px] resize-y`} />
                  </div>
                  <div>
                    <label className={LABEL}>Key <span className="text-gray-400 font-normal">— optional partition key</span></label>
                    <input value={kKey} onChange={(e) => setKKey(e.target.value)} placeholder="order-123" className={`${INPUT} font-mono text-[11.5px]`} />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className={LABEL}>Group ID <span className="text-gray-400 font-normal">— optional consumer group</span></label>
                    <input value={kGroupId} onChange={(e) => setKGroupId(e.target.value)} placeholder="intelliqe-probe" className={`${INPUT} font-mono text-[11.5px]`} />
                  </div>
                  <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
                    <input type="checkbox" checked={kFromBeginning} onChange={(e) => setKFromBeginning(e.target.checked)} className="w-3.5 h-3.5" />
                    Read from the beginning of the topic
                  </label>
                </>
              )}

              {/* Advanced — TLS + SASL */}
              <div>
                <button type="button" onClick={() => setKAdvanced((v) => !v)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:underline">
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${kAdvanced ? '' : '-rotate-90'}`} />Advanced — TLS &amp; SASL
                </button>
                {kAdvanced && (
                  <div className="mt-2 space-y-2.5 border border-[#E9E5FB] rounded-lg p-3">
                    <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
                      <input type="checkbox" checked={kSsl} onChange={(e) => setKSsl(e.target.checked)} className="w-3.5 h-3.5" />
                      Use SSL / TLS
                    </label>
                    <div>
                      <label className={LABEL}>SASL mechanism</label>
                      <select value={kSaslMech} onChange={(e) => setKSaslMech(e.target.value as SaslMechanism)} className={INPUT}>
                        <option value="plain">plain</option>
                        <option value="scram-sha-256">scram-sha-256</option>
                        <option value="scram-sha-512">scram-sha-512</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={LABEL}>Username</label>
                        <input value={kSaslUser} onChange={(e) => setKSaslUser(e.target.value)} className={INPUT} />
                      </div>
                      <div>
                        <label className={LABEL}>Password</label>
                        <input type="password" value={kSaslPass} onChange={(e) => setKSaslPass(e.target.value)} className={INPUT} />
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-400">SASL is sent only when a username or password is filled.</p>
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <button type="button" onClick={() => void runKafka()} disabled={kLoading || !kafkaReady} className={PRIMARY_BTN}>
                  {kLoading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {kLoading ? 'Running…' : 'Run'}
                </button>
              </div>

              {kError && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{kError}</p>
                </div>
              )}

              {kResult && (
                <div className="space-y-2">
                  {kResult.produced && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-emerald-50 border-emerald-200">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                      <span className="text-[12px] font-medium text-emerald-800">Produced to partition {kResult.produced.partition} at offset {kResult.produced.offset ?? '—'}</span>
                    </div>
                  )}
                  {kResult.messages && (
                    <div className="space-y-1.5">
                      {kResult.messages.length === 0 && <div className="text-[11.5px] text-gray-500">No messages received within the window.</div>}
                      {kResult.messages.map((m, i) => (
                        <div key={i} className={`font-mono text-[11px] bg-[#FCFBFF] border border-[#E4E0F5] rounded-md p-2 ${INSET}`}>
                          <div className="text-gray-400 mb-1">
                            p{m.partition} · offset {m.offset}{m.key ? ` · key ${m.key}` : ''}{m.timestamp ? ` · ${m.timestamp}` : ''}
                          </div>
                          <pre className="whitespace-pre-wrap break-all text-gray-700 m-0">{m.value}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-[11px] text-gray-400 tabular-nums">
                    {kResult.mode} · topic {kResult.topic}{kResult.messages ? ` · ${kResult.messages.length} message${kResult.messages.length === 1 ? '' : 's'}` : ''} · {kResult.elapsedMs}ms
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── gRPC ── */}
          {tab === 'grpc' && (
            <div className="space-y-3">
              <div>
                <label className={LABEL}>Target</label>
                <input value={gTarget} onChange={(e) => setGTarget(e.target.value)} placeholder="host:50051" className={`${INPUT} font-mono text-[11.5px]`} />
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
                  <input type="checkbox" checked={gTls} onChange={(e) => setGTls(e.target.checked)} className="w-3.5 h-3.5" />
                  Use TLS
                </label>
                <button type="button" onClick={() => void reflect()} disabled={gReflecting || gTarget.trim() === ''} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:underline disabled:opacity-40">
                  {gReflecting ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <ListTree className="w-3.5 h-3.5" />}Reflect services
                </button>
              </div>
              {gReflect && (
                gReflect.ok
                  ? <div className="flex flex-wrap gap-1.5">
                      {gReflect.services.length === 0 && <span className="text-[11px] text-gray-400">No services returned.</span>}
                      {gReflect.services.map((s) => (
                        <button key={s} type="button" onClick={() => setGService(s)} title="Use this service" className="inline-flex items-center px-2 py-0.5 rounded border border-[#DDD6FE] bg-[#F5F3FF] text-[#6D28D9] text-[10.5px] font-mono hover:bg-[#EDE9FE]">{s}</button>
                      ))}
                    </div>
                  : <p className="text-[11px] text-amber-600">Reflection unavailable: {gReflect.error || 'not supported by the server'}. Paste the .proto instead.</p>
              )}
              <div>
                <label className={LABEL}>Proto definition</label>
                <textarea value={gProto} onChange={(e) => setGProto(e.target.value)} rows={8} placeholder="paste your .proto" className={`${INPUT} font-mono text-[11.5px] resize-y`} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={LABEL}>Service</label>
                  <input value={gService} onChange={(e) => setGService(e.target.value)} placeholder="package.ServiceName" className={`${INPUT} font-mono text-[11.5px]`} />
                </div>
                <div>
                  <label className={LABEL}>Method</label>
                  <input value={gMethod} onChange={(e) => setGMethod(e.target.value)} placeholder="GetOrder" className={`${INPUT} font-mono text-[11.5px]`} />
                </div>
              </div>
              <div>
                <label className={LABEL}>Request JSON</label>
                <textarea value={gRequest} onChange={(e) => setGRequest(e.target.value)} rows={4} placeholder='{"id":"123"}' className={`${INPUT} font-mono text-[11.5px] resize-y`} />
              </div>

              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => setGCallType('unary')} className={modeClass2('unary')}>Unary</button>
                <button type="button" onClick={() => setGCallType('stream')} className={modeClass2('stream')}>Server stream</button>
                {gCallType === 'stream' && (
                  <label className="flex items-center gap-1 text-[11px] text-gray-500 ml-1">
                    max <input type="number" min={1} max={200} value={gMaxMessages} onChange={(e) => setGMaxMessages(Math.min(200, Math.max(1, Number(e.target.value))))} className={`${INPUT} w-16 py-1`} /> msgs
                  </label>
                )}
              </div>

              <div className="flex justify-end">
                <button type="button" onClick={() => void runGrpc()} disabled={gLoading || !grpcReady} className={PRIMARY_BTN}>
                  {gLoading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {gLoading ? (gCallType === 'stream' ? 'Streaming…' : 'Calling…') : (gCallType === 'stream' ? 'Stream' : 'Call')}
                </button>
              </div>

              {gError && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{gError}</p>
                </div>
              )}

              {gResult && (
                <div className="space-y-2">
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${gResult.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                    {gResult.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />}
                    <span className={`text-[12px] font-medium min-w-0 whitespace-pre-wrap break-words ${gResult.ok ? 'text-emerald-800' : 'text-red-800'}`}>
                      {gResult.ok ? 'Call succeeded' : (gResult.error || 'Call failed')}
                      {!gResult.ok && gResult.code !== undefined ? ` (code ${gResult.code})` : ''}
                    </span>
                  </div>
                  {gResult.ok && gResult.response !== undefined && (
                    <pre className={`font-mono text-[11px] text-gray-700 bg-[#FCFBFF] border border-[#E4E0F5] rounded-md p-2.5 max-h-72 overflow-auto whitespace-pre-wrap break-all m-0 ${INSET}`}>
                      {JSON.stringify(gResult.response, null, 2)}
                    </pre>
                  )}
                  <div className="text-[11px] text-gray-400 tabular-nums">{gResult.service}/{gResult.method} · {gResult.elapsedMs}ms</div>
                </div>
              )}

              {gStreamResult && (
                <div className="space-y-2">
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${gStreamResult.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                    {gStreamResult.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />}
                    <span className={`text-[12px] font-medium min-w-0 whitespace-pre-wrap break-words ${gStreamResult.ok ? 'text-emerald-800' : 'text-red-800'}`}>
                      {gStreamResult.ok ? `Received ${gStreamResult.count} message${gStreamResult.count === 1 ? '' : 's'}${gStreamResult.truncated ? ` (capped at ${gMaxMessages})` : ''}` : (gStreamResult.error || 'Stream failed')}
                      {!gStreamResult.ok && gStreamResult.code !== undefined ? ` (code ${gStreamResult.code})` : ''}
                    </span>
                  </div>
                  {gStreamResult.messages.length > 0 && (
                    <div className="space-y-1.5">
                      {gStreamResult.messages.map((m, i) => (
                        <pre key={i} className={`font-mono text-[11px] text-gray-700 bg-[#FCFBFF] border border-[#E4E0F5] rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all m-0 ${INSET}`}>
                          <span className="text-gray-400">#{i + 1}</span> {JSON.stringify(m, null, 2)}
                        </pre>
                      ))}
                    </div>
                  )}
                  <div className="text-[11px] text-gray-400 tabular-nums">{gStreamResult.service}/{gStreamResult.method} · {gStreamResult.elapsedMs}ms</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
