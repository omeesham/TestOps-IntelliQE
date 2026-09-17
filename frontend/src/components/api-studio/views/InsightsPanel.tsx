/**
 * InsightsPanel — what the platform understood about the catalogued API.
 *
 * Style, hosts, resources with their CRUD completeness, the lifecycle flows it
 * will exercise, the risks it found, and the AI's deeper reading when asked.
 * It sits beside the endpoint table so the reviewer sees the pattern and the
 * raw endpoints together.
 */
import { useState } from 'react';
import { Brain, Loader2, Sparkles, AlertTriangle, GitBranch, Layers, ShieldAlert, ChevronDown, ChevronRight } from 'lucide-react';
import { CARD, BRAND_CHIP, MUTED_CHIP, SECONDARY_BTN, STRIP } from '../format';
import type { ApiProfile, CrudOp } from '../types';

const CRUD: CrudOp[] = ['list', 'create', 'read', 'update', 'delete'];
const CRUD_SHORT: Record<CrudOp, string> = { list: 'L', create: 'C', read: 'R', update: 'U', delete: 'D' };

export default function InsightsPanel({ profile, analyzing, error, onDeepAnalyze, onFocusResource }: {
  profile: ApiProfile | null; analyzing: boolean; error: string; onDeepAnalyze: () => void; onFocusResource: (name: string | null) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ resources: true, flows: true, risks: true, insights: true });
  const tog = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  if (!profile) {
    return (
      <div className={`${CARD} p-4`}>
        <div className="flex items-center gap-2"><Brain className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Pattern intelligence</h3>{analyzing && <Loader2 className="w-3.5 h-3.5 text-[#7C3AED] animate-spin ml-auto" />}</div>
        <p className="mt-2 text-[11.5px] text-gray-500 leading-relaxed">{analyzing ? 'Reading the catalogue…' : error || 'Import endpoints and the platform will map resources, CRUD lifecycles, dependencies and risks before designing any test.'}</p>
      </div>
    );
  }

  const styleLabel = profile.style === 'mixed' ? 'Mixed' : profile.style.toUpperCase();
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className={`px-4 pt-3.5 pb-3 border-b border-[#EDE9FE] ${STRIP}`}>
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[12.5px] font-semibold text-gray-900">Pattern intelligence</h3>
          {analyzing && <Loader2 className="w-3.5 h-3.5 text-[#7C3AED] animate-spin" />}
          <span className={`ml-auto inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${BRAND_CHIP}`}>{styleLabel}</span>
        </div>
        <p className="mt-2 text-[11.5px] text-gray-600 leading-relaxed">{profile.summary}</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Fact label="endpoints" value={profile.totalEndpoints} />
          <Fact label="resources" value={profile.resources.length} />
          <Fact label="hosts" value={profile.hosts.length} />
          {profile.versions.length > 0 && <Fact label="versions" value={profile.versions.join(', ')} />}
          <Fact label="protected" value={`${profile.auth.protected}/${profile.totalEndpoints}`} />
          {profile.pagination.detected && <Fact label="pagination" value={profile.pagination.params.join(', ') || 'yes'} />}
        </div>
        {profile.patterns.length > 0 && (
          <ul className="mt-2.5 space-y-0.5">
            {profile.patterns.slice(0, 6).map((p, i) => <li key={i} className="text-[11px] text-gray-500 flex gap-1.5"><span className="text-[#7C3AED]">•</span><span>{p}</span></li>)}
          </ul>
        )}
      </div>

      {/* Resources */}
      <Group id="resources" icon={Layers} title={`Resources · ${profile.resources.length}`} open={open.resources} onToggle={tog}>
        {profile.resources.length === 0 ? <p className="text-[11px] text-gray-400">No collection pattern detected.</p> : (
          <div className="space-y-1">
            {profile.resources.map((r) => (
              <button key={r.name + r.host} type="button" onClick={() => onFocusResource(r.name)} className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#F5F3FF] transition-colors group">
                <span className="text-[11.5px] font-medium text-gray-800 truncate">{r.parent ? <span className="text-gray-400">{r.parent} › </span> : null}{r.name}</span>
                <span className="ml-auto flex gap-0.5">
                  {CRUD.map((op) => (
                    <span key={op} title={op} className={`w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center ${typeof r.operations[op] === 'number' ? 'bg-gradient-to-b from-[#EDE9FE] to-[#DDD6FE] text-[#6D28D9] shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_1px_1px_rgba(30,27,75,0.15)]' : 'bg-gray-100 text-gray-300 shadow-[inset_0_1px_2px_rgba(30,27,75,0.08)]'}`}>{CRUD_SHORT[op]}</span>
                  ))}
                </span>
                <span className="text-[10px] font-mono text-gray-400 tabular-nums w-6 text-right">{r.endpoints.length}</span>
              </button>
            ))}
            <button type="button" onClick={() => onFocusResource(null)} className="text-[10.5px] text-gray-400 hover:text-[#7C3AED] px-2">Show all endpoints</button>
          </div>
        )}
      </Group>

      {/* Flows */}
      <Group id="flows" icon={GitBranch} title={`Lifecycle flows · ${profile.flows.length}`} open={open.flows} onToggle={tog}>
        {profile.flows.length === 0 ? <p className="text-[11px] text-gray-400">No create→read→update→delete chains found — flows need at least a create and a read on the same resource.</p> : (
          <div className="space-y-1.5">
            {profile.flows.map((f) => (
              <div key={f.id} className="px-2 py-1.5 rounded-md bg-gradient-to-b from-white to-[#FAFAFE] border border-[#EDE9FE] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_5px_-3px_rgba(76,29,149,0.3)]">
                <p className="text-[11.5px] font-medium text-gray-800">{f.name}</p>
                <p className="text-[10.5px] text-gray-500 mt-0.5">{f.description}</p>
              </div>
            ))}
          </div>
        )}
      </Group>

      {/* Risks */}
      <Group id="risks" icon={ShieldAlert} title={`Risks · ${profile.risks.length}`} open={open.risks} onToggle={tog}>
        {profile.risks.length === 0 ? <p className="text-[11px] text-gray-400">Nothing flagged.</p> : (
          <ul className="space-y-1">
            {profile.risks.map((r, i) => (
              <li key={i} className="flex gap-1.5 text-[11px]">
                <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 mt-px ${r.level === 'high' ? 'text-red-500' : r.level === 'medium' ? 'text-amber-500' : 'text-gray-400'}`} />
                <span className="text-gray-600">{r.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Group>

      {/* AI insights */}
      <Group id="insights" icon={Sparkles} title={`AI insights${profile.insights?.length ? ` · ${profile.insights.length}` : ''}`} open={open.insights} onToggle={tog}>
        {profile.insights?.length ? (
          <ul className="space-y-1.5">
            {profile.insights.map((s, i) => <li key={i} className="text-[11px] text-gray-600 leading-relaxed flex gap-1.5"><span className="text-[#7C3AED]">•</span><span>{s}</span></li>)}
          </ul>
        ) : (
          <p className="text-[11px] text-gray-400 leading-relaxed">Ask the platform's AI to read the whole surface for business rules, ordering constraints and edge cases the deterministic analysis cannot see. Its findings become context for scenario design.</p>
        )}
        <button type="button" onClick={onDeepAnalyze} disabled={analyzing} className={`${SECONDARY_BTN} mt-2`}>
          {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {profile.insights?.length ? 'Re-run deep analysis' : 'Deep analysis'}
        </button>
        {error && <p className="mt-1.5 text-[11px] text-red-600">{error}</p>}
      </Group>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${MUTED_CHIP}`}><span className="font-semibold text-gray-700">{value}</span>{label}</span>;
}

function Group({ id, icon: Icon, title, open, onToggle, children }: { id: string; icon: React.ElementType; title: string; open: boolean; onToggle: (id: string) => void; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button type="button" onClick={() => onToggle(id)} className="w-full flex items-center gap-1.5 px-4 py-2 text-left hover:bg-[#FAFAFE] transition-colors">
        {open ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />}
        <Icon className="w-3.5 h-3.5 text-[#7C3AED]" />
        <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">{title}</span>
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}
