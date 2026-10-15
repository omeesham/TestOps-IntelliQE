/**
 * ModelGen — stateful model-based test generation.
 *
 * Instead of poking endpoints one at a time, this infers each resource's state
 * machine (created → updated → … → deleted) from the catalogue (or a pasted
 * OpenAPI spec) and generates long, valid business sequences that walk those
 * transitions end-to-end — the kind of multi-step journey a single-request
 * generator can't reach. Opt-in and isolated from the pipeline.
 */
import { useState } from 'react';
import { Workflow, GitBranch, X, AlertTriangle, ArrowRight, Boxes } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  generateModelSequences,
  type ModelGenResult,
  type MgSequence,
  type MgResourceModel,
  type MgStep,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN } from './format';
import { MethodBadge } from './primitives';
import type { CatalogEndpoint } from './types';

type Mode = 'catalogue' | 'spec';

export default function ModelGen({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('catalogue');
  const [spec, setSpec] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [maxSequences, setMaxSequences] = useState(8);
  const [result, setResult] = useState<ModelGenResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const canRun = mode === 'catalogue' ? endpoints.length > 0 : spec.trim().length > 0;

  const run = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      const input: Parameters<typeof generateModelSequences>[0] = {
        baseUrl: baseUrl.trim() || undefined,
        maxSequences: Number.isFinite(maxSequences) && maxSequences > 0 ? maxSequences : undefined,
      };
      if (mode === 'spec') input.spec = spec;
      else input.endpoints = endpoints.map((e) => ({ method: e.method, url: e.url, title: e.title }));
      setResult(await generateModelSequences(input));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Model-based generation failed.');
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Workflow className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Stateful model-based generation</h3>
          <span className="text-[11px] text-gray-400">infers resource state machines · generates business journeys</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Inputs */}
        <div className="px-4 py-3 border-b border-[#EDE9FE] flex-shrink-0 space-y-2.5">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-[12px] text-gray-600 cursor-pointer">
              <input type="radio" name="mg-mode" checked={mode === 'catalogue'} onChange={() => setMode('catalogue')} className="border-gray-300 text-[#7C3AED]" />
              From catalogue <span className="text-gray-400">({endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'})</span>
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-gray-600 cursor-pointer">
              <input type="radio" name="mg-mode" checked={mode === 'spec'} onChange={() => setMode('spec')} className="border-gray-300 text-[#7C3AED]" />
              Paste OpenAPI spec
            </label>
          </div>

          {mode === 'spec' && (
            <div>
              <label className={LABEL}>OpenAPI spec (JSON or YAML)</label>
              <textarea
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder={'{\n  "openapi": "3.0.0",\n  "paths": { "/orders": { "post": { … } } }\n}'}
                rows={6}
                className={`${INPUT} font-mono text-[11px] resize-y`}
              />
            </div>
          )}

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className={LABEL}>Base URL (optional)</label>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" className={INPUT} />
            </div>
            <div className="w-32 flex-shrink-0">
              <label className={LABEL}>Max sequences</label>
              <input type="number" min={1} max={50} value={maxSequences} onChange={(e) => setMaxSequences(Number(e.target.value))} className={`${FIELD} w-full`} />
            </div>
            <button type="button" onClick={() => void run()} disabled={loading || !canRun} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Workflow className="w-3.5 h-3.5" />}Generate
            </button>
          </div>
        </div>

        {result && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
            <Stat label="operations" value={result.operations} />
            <Stat label={`resource${result.resources.length === 1 ? '' : 's'}`} value={result.resources.length} />
            <Stat label={`sequence${result.sequences.length === 1 ? '' : 's'}`} value={result.sequences.length} />
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Inferring state machines and composing valid sequences…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : result ? (
            <div className="divide-y divide-gray-100">
              {result.models.length > 0 && (
                <section className="px-4 py-3">
                  <div className="flex items-center gap-1.5 mb-2"><GitBranch className="w-3.5 h-3.5 text-[#7C3AED]" /><h4 className="text-[12px] font-semibold text-gray-800">State machines</h4></div>
                  <div className="space-y-1.5">{result.models.map((m) => <ResourceModel key={m.resource} model={m} />)}</div>
                </section>
              )}

              {result.sequences.length > 0 && (
                <section className="px-4 py-3">
                  <div className="flex items-center gap-1.5 mb-2"><Boxes className="w-3.5 h-3.5 text-[#7C3AED]" /><h4 className="text-[12px] font-semibold text-gray-800">Sequences</h4></div>
                  <div className="space-y-2.5">{result.sequences.map((seq) => <Sequence key={seq.id} seq={seq} />)}</div>
                </section>
              )}

              {result.notes.length > 0 && (
                <section className="px-4 py-3 space-y-1">
                  {result.notes.map((n, i) => <p key={i} className="text-[11px] text-gray-400 leading-relaxed">{n}</p>)}
                </section>
              )}

              {result.models.length === 0 && result.sequences.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
                  <Workflow className="w-7 h-7 text-gray-300" />
                  <p className="text-[12.5px] text-gray-500 max-w-sm">No resource state machines could be inferred — the catalogue or spec needs create/read/update/delete operations on the same resource path.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
              <Workflow className="w-7 h-7 text-gray-300" />
              <p className="text-[12.5px] text-gray-500 max-w-sm">Pick an input, then <span className="text-gray-700 font-medium">Generate</span>. Each resource's lifecycle is modelled as a state machine, and long valid sequences are composed that walk it like a real user would.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1 px-2.5 py-1 rounded-md border border-[#DDD6FE] bg-[#F5F3FF]">
      <span className="text-[13px] font-semibold tabular-nums text-[#6D28D9]">{value}</span>
      <span className="text-[11px] text-gray-500">{label}</span>
    </span>
  );
}

function ResourceModel({ model }: { model: MgResourceModel }) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="rounded-lg border border-gray-100 bg-white">
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer list-none">
        <GitBranch className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
        <span className="text-[12px] font-mono font-semibold text-gray-700">{model.resource}</span>
        <span className="text-[10.5px] text-gray-400">{model.states.length} state{model.states.length === 1 ? '' : 's'} · {model.transitions.length} transition{model.transitions.length === 1 ? '' : 's'}</span>
        <span className="ml-auto text-[10.5px] text-gray-300">{open ? 'hide' : 'show'}</span>
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {model.states.map((st) => (
            <span
              key={st.name}
              className={`text-[10.5px] font-medium px-2 py-0.5 rounded-full border ${st.terminal ? 'text-gray-500 bg-gray-100 border-gray-300 line-through' : 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]'}`}
              title={st.terminal ? 'terminal state' : undefined}
            >
              {st.name}
            </span>
          ))}
        </div>
        <div className="space-y-1">
          {model.transitions.map((t, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[11px] text-gray-600 font-mono">
              <span className="text-gray-700">{t.from}</span>
              <ArrowRight className="w-3 h-3 text-gray-300 flex-shrink-0" />
              <span className="text-[9.5px] font-sans uppercase font-semibold text-[#6D28D9] px-1 py-0.5 rounded bg-[#F5F3FF] border border-[#DDD6FE]">{t.method} · {t.via}</span>
              <ArrowRight className="w-3 h-3 text-gray-300 flex-shrink-0" />
              <span className="text-gray-700">{t.to}</span>
              {t.action && <span className="text-[10px] text-gray-400 font-sans">({t.action})</span>}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function Sequence({ seq }: { seq: MgSequence }) {
  const long = seq.lengthClass === 'long';
  return (
    <div className={`${CARD} p-3`}>
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold text-gray-800 min-w-0 truncate" title={seq.name}>{seq.name}</span>
        <span className="text-[10.5px] font-mono text-gray-400 flex-shrink-0">{seq.resource}</span>
        <span className={`ml-auto flex-shrink-0 text-[9.5px] font-semibold uppercase px-1.5 py-0.5 rounded border ${long ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-gray-500 bg-gray-100 border-gray-300'}`}>
          {long ? 'business journey' : 'short'}
        </span>
      </div>
      {seq.note && <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">{seq.note}</p>}
      <ol className="mt-2 space-y-1">
        {seq.steps.map((step) => <Step key={step.order} step={step} />)}
      </ol>
    </div>
  );
}

function Step({ step }: { step: MgStep }) {
  return (
    <li className="flex items-center gap-2 text-[11px]">
      <span className="w-4 flex-shrink-0 text-right text-[10px] tabular-nums text-gray-300">{step.order}</span>
      <MethodBadge method={step.method} />
      <span className="font-mono text-gray-700 min-w-0 truncate" title={step.path}>{step.path}</span>
      {step.expectState && <span className="flex-shrink-0 text-[9.5px] font-medium px-1.5 py-0.5 rounded-full bg-[#F5F3FF] border border-[#DDD6FE] text-[#6D28D9]">→ {step.expectState}</span>}
      {(step.injects.length > 0 || step.extracts.length > 0) && (
        <span className="ml-auto flex-shrink-0 flex items-center gap-2 font-mono text-[10px] text-gray-400">
          {step.injects.map((inj, i) => <span key={`i${i}`} title={`injects ${inj.var} into ${inj.param}`}>{inj.param}={'{{'}{inj.var}{'}}'}</span>)}
          {step.extracts.map((ex, i) => <span key={`e${i}`} className="text-emerald-500" title={`extracts ${ex.field} → ${ex.var}`}>{ex.field} → {'{{'}{ex.var}{'}}'}</span>)}
        </span>
      )}
    </li>
  );
}
