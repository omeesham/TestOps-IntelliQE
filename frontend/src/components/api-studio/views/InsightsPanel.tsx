/**
 * InsightsPanel — what the platform understood about the catalogued API.
 *
 * The analysis is what makes generation more than a template: it decides which
 * layers are worth running, which endpoints depend on which, and what will
 * fail before it is ever executed. So the panel shows the reasoning, not just
 * the headline — the method and auth mix, each resource's CRUD completeness
 * and what it is missing, the lifecycle chains, the dependency edges, the
 * risks with the endpoints they touch, and the AI's deeper reading when asked.
 */
import { useState } from 'react';
import {
  Brain, Loader2, Sparkles, AlertTriangle, GitBranch, Layers, ShieldAlert, Network,
  ChevronDown, ChevronRight, Radar, Clock,
} from 'lucide-react';
import { CARD, BRAND_CHIP, MUTED_CHIP, SECONDARY_BTN, STRIP, relativeTime, pathOf } from '../format';
import type { ApiProfile, CatalogEndpoint, CrudOp } from '../types';

const CRUD: CrudOp[] = ['list', 'create', 'read', 'update', 'delete'];
const CRUD_SHORT: Record<CrudOp, string> = { list: 'L', create: 'C', read: 'R', update: 'U', delete: 'D' };

/** HTTP methods in the order a reader expects them, then anything else. */
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_SHADE: Record<string, string> = {
  GET: '#8B5CF6', POST: '#6366F1', PUT: '#A78BFA', PATCH: '#C4B5FD', DELETE: '#4F46E5', HEAD: '#DDD6FE', OPTIONS: '#E4DDFB',
};
const AUTH_LABEL: Record<string, string> = {
  none: 'Public', bearer: 'Bearer token', basic: 'Basic', apikey: 'API key', oauth2: 'OAuth 2', custom: 'Custom',
};
/** Unauthenticated is always the grey slice; every real scheme takes a violet. */
const AUTH_SHADE = ['#7C3AED', '#6366F1', '#A78BFA', '#818CF8', '#C4B5FD'];

export default function InsightsPanel({ profile, analyzing, error, endpoints, onDeepAnalyze, onFocusResource }: {
  profile: ApiProfile | null; analyzing: boolean; error: string; endpoints?: CatalogEndpoint[];
  onDeepAnalyze: () => void; onFocusResource: (name: string | null) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ surface: true, resources: true, flows: true, deps: false, risks: true, insights: true });
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
  const total = profile.totalEndpoints || 1;
  const methodEntries = Object.entries(profile.methods).sort(
    (a, b) => (METHOD_ORDER.indexOf(a[0]) + 1 || 99) - (METHOD_ORDER.indexOf(b[0]) + 1 || 99),
  );
  const authEntries = Object.entries(profile.auth.schemes).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const risksByLevel = { high: 0, medium: 0, low: 0 };
  for (const r of profile.risks) risksByLevel[r.level]++;
  const riskSummary = (['high', 'medium', 'low'] as const).filter((l) => risksByLevel[l] > 0).map((l) => `${risksByLevel[l]} ${l}`).join(' · ');

  /** An endpoint index only means something while the catalogue is unchanged. */
  const epLabel = (i: number) => {
    const e = endpoints?.[i];
    return e ? `${e.method} ${pathOf(e.url)}` : `endpoint #${i + 1}`;
  };

  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className={`px-4 pt-3.5 pb-3 border-b border-[#EDE9FE] ${STRIP}`}>
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[12.5px] font-semibold text-gray-900">Pattern intelligence</h3>
          {analyzing && <Loader2 className="w-3.5 h-3.5 text-[#7C3AED] animate-spin" />}
          <span className={`ml-auto inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${BRAND_CHIP}`} title={profile.style === 'mixed' ? Object.entries(profile.styles).map(([s, n]) => `${s}: ${n}`).join(' · ') : `Every endpoint reads as ${styleLabel}`}>{styleLabel}</span>
        </div>
        <p className="mt-2 text-[11.5px] text-gray-600 leading-relaxed">{profile.summary}</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Fact label="endpoints" value={profile.totalEndpoints} title="Endpoints in the catalogue when this analysis ran" />
          <Fact label="resources" value={profile.resources.length} title="Distinct collections detected from the path shapes" />
          <Fact label="hosts" value={profile.hosts.length} title={profile.hosts.join(', ')} />
          {profile.versions.length > 0 && <Fact label="versions" value={profile.versions.join(', ')} title="Version segments found in the paths" />}
          <Fact label="protected" value={`${profile.auth.protected}/${profile.totalEndpoints}`} title={`${profile.auth.public} endpoint${profile.auth.public === 1 ? '' : 's'} declare no authentication`} />
          <Fact label="with examples" value={`${profile.withExamples}/${profile.totalEndpoints}`} title="Endpoints that carry an example response — schema assertions for the rest are inferred on the first run" />
          {profile.pagination.detected && <Fact label="pagination" value={profile.pagination.params.join(', ') || 'yes'} title={`${profile.pagination.endpoints.length} endpoint${profile.pagination.endpoints.length === 1 ? '' : 's'} paginate`} />}
          {profile.dependencies.length > 0 && <Fact label="dependencies" value={profile.dependencies.length} title="Ordering constraints between endpoints" />}
        </div>
        {profile.patterns.length > 0 && (
          <ul className="mt-2.5 space-y-0.5">
            {profile.patterns.slice(0, 6).map((p, i) => <li key={i} className="text-[11px] text-gray-500 flex gap-1.5"><span className="text-[#7C3AED]">•</span><span>{p}</span></li>)}
            {profile.patterns.length > 6 && <li className="text-[10.5px] text-gray-400 pl-3.5">+{profile.patterns.length - 6} more</li>}
          </ul>
        )}
        {profile.analyzedAt && (
          <p className="mt-2 flex items-center gap-1 text-[9.5px] text-gray-400"><Clock className="w-2.5 h-2.5" />Analysed {relativeTime(profile.analyzedAt)}</p>
        )}
      </div>

      {/* ── The shape of the surface ── */}
      <Group id="surface" icon={Radar} title="Surface" open={open.surface} onToggle={tog}>
        <Meter label="Methods" segments={methodEntries.map(([m, n]) => ({ key: m, label: m, value: n, colour: METHOD_SHADE[m] || '#DDD6FE' }))} total={total} />
        <div className="mt-2.5">
          <Meter
            label="Authentication"
            segments={authEntries.map(([scheme, n], i) => ({ key: scheme, label: AUTH_LABEL[scheme] || scheme, value: n, colour: scheme === 'none' ? '#E5E7EB' : AUTH_SHADE[i % AUTH_SHADE.length]! }))}
            total={total}
          />
          {profile.auth.mixed && <p className="mt-1 text-[10px] text-amber-600">Mixed — some endpoints are protected and some are not, so auth scenarios only apply to part of the surface.</p>}
        </div>
        <dl className="mt-2.5 space-y-1">
          {profile.hosts.length > 0 && <Detail term="Hosts" desc={profile.hosts.join(', ')} />}
          {profile.contentTypes.length > 0 && <Detail term="Content types" desc={profile.contentTypes.join(', ')} />}
          {profile.filtering.params.length > 0 && <Detail term="Filter params" desc={profile.filtering.params.join(', ')} />}
          {profile.pagination.detected && <Detail term="Pagination" desc={`${profile.pagination.params.join(', ') || 'detected'} — on ${profile.pagination.endpoints.length} endpoint${profile.pagination.endpoints.length === 1 ? '' : 's'}`} />}
          <Detail term="Examples" desc={`${profile.withExamples} of ${profile.totalEndpoints} endpoints ship a response example`} />
        </dl>
      </Group>

      {/* Resources */}
      <Group id="resources" icon={Layers} title={`Resources · ${profile.resources.length}`} open={open.resources} onToggle={tog}>
        {profile.resources.length === 0 ? <p className="text-[11px] text-gray-400">No collection pattern detected.</p> : (
          <div className="space-y-1">
            {profile.resources.map((r) => {
              const missing = CRUD.filter((op) => typeof r.operations[op] !== 'number');
              return (
                <button key={r.name + r.host} type="button" onClick={() => onFocusResource(r.name)} title={`Filter the table to ${r.name}${r.pattern ? ` — ${r.pattern}` : ''}`} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[#F5F3FF] transition-colors">
                  <span className="flex items-center gap-2">
                    <span className="text-[11.5px] font-medium text-gray-800 truncate">{r.parent ? <span className="text-gray-400">{r.parent} › </span> : null}{r.name}</span>
                    <span className="ml-auto flex gap-0.5 flex-shrink-0">
                      {CRUD.map((op) => (
                        <span key={op} title={`${op}${typeof r.operations[op] === 'number' ? '' : ' — not in the catalogue'}`} className={`w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center ${typeof r.operations[op] === 'number' ? 'bg-gradient-to-b from-[#EDE9FE] to-[#DDD6FE] text-[#6D28D9] shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_1px_1px_rgba(30,27,75,0.15)]' : 'bg-gray-100 text-gray-300 shadow-[inset_0_1px_2px_rgba(30,27,75,0.08)]'}`}>{CRUD_SHORT[op]}</span>
                      ))}
                    </span>
                    <span className="text-[10px] font-mono text-gray-400 tabular-nums w-6 text-right flex-shrink-0">{r.endpoints.length}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-gray-400 min-w-0">
                    <span className="font-mono truncate" title={r.pattern}>{r.pattern}</span>
                    {r.idParam && <span className="flex-shrink-0">· id <span className="font-mono text-gray-500">{r.idParam}</span></span>}
                    {/* The greyed L/C/R/U/D letters already say which are missing. */}
                    <span className="ml-auto flex-shrink-0" title={missing.length ? `No ${missing.join(', ')} endpoint in the catalogue` : 'Every CRUD operation is present'}>{missing.length === 0 ? <span className="text-emerald-600">full CRUD</span> : `${r.crudScore}/5 CRUD`}</span>
                  </span>
                </button>
              );
            })}
            <button type="button" onClick={() => onFocusResource(null)} className="text-[10.5px] text-gray-400 hover:text-[#7C3AED] px-2">Show all endpoints</button>
          </div>
        )}
      </Group>

      {/* Flows */}
      <Group id="flows" icon={GitBranch} title={`Lifecycle flows · ${profile.flows.length}`} open={open.flows} onToggle={tog}>
        {profile.flows.length === 0 ? <p className="text-[11px] text-gray-400">No create→read→update→delete chains found — flows need at least a create and a read on the same resource.</p> : (
          <div className="space-y-1.5">
            {profile.flows.map((f) => (
              <div key={f.id} className="px-2 py-1.5 rounded-md bg-white border border-[#EDE9FE] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_5px_-3px_rgba(76,29,149,0.3)]">
                <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-gray-800">
                  <span className="truncate">{f.name}</span>
                  <span className="ml-auto flex-shrink-0 font-mono text-[9.5px] text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-1 tabular-nums">{f.steps.length} steps</span>
                </p>
                <p className="text-[10.5px] text-gray-500 mt-0.5">{f.description}</p>
                {endpoints?.length ? (
                  <p className="mt-1 text-[9.5px] font-mono text-gray-400 leading-snug break-words">{f.steps.map(epLabel).join('  →  ')}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Group>

      {/* Dependencies — what has to run before what */}
      <Group id="deps" icon={Network} title={`Dependencies · ${profile.dependencies.length}`} open={open.deps} onToggle={tog}>
        {profile.dependencies.length === 0 ? <p className="text-[11px] text-gray-400">No ordering constraints found — every endpoint can be exercised on its own.</p> : (
          <ul className="space-y-1">
            {profile.dependencies.slice(0, 10).map((d, i) => (
              <li key={i} className="px-2 py-1 rounded-md bg-[#FCFBFF] border border-[#EDE9FE]">
                <p className="text-[10px] font-mono text-gray-600 leading-snug break-words">{epLabel(d.from)} <span className="text-[#7C3AED]">→</span> {epLabel(d.to)}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">{d.reason}</p>
              </li>
            ))}
            {profile.dependencies.length > 10 && <li className="text-[10.5px] text-gray-400 px-2">+{profile.dependencies.length - 10} more</li>}
          </ul>
        )}
      </Group>

      {/* Risks */}
      <Group id="risks" icon={ShieldAlert} title={`Risks · ${profile.risks.length}`} badge={riskSummary} open={open.risks} onToggle={tog}>
        {profile.risks.length === 0 ? <p className="text-[11px] text-gray-400">Nothing flagged.</p> : (
          <ul className="space-y-1.5">
            {[...profile.risks].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.level] - ({ high: 0, medium: 1, low: 2 })[b.level]).map((r, i) => (
              <li key={i} className={`flex gap-1.5 px-2 py-1.5 rounded-md border text-[11px] ${r.level === 'high' ? 'bg-red-50 border-red-200/70' : r.level === 'medium' ? 'bg-amber-50 border-amber-200/70' : 'bg-gray-50 border-gray-200/70'}`}>
                <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 mt-px ${r.level === 'high' ? 'text-red-500' : r.level === 'medium' ? 'text-amber-500' : 'text-gray-400'}`} />
                <span className="min-w-0">
                  <span className={r.level === 'high' ? 'text-red-800' : r.level === 'medium' ? 'text-amber-900' : 'text-gray-600'}>{r.text}</span>
                  {r.endpoints?.length ? <span className="block mt-0.5 text-[9.5px] font-mono text-gray-400 leading-snug break-words" title={r.endpoints.map(epLabel).join('\n')}>{r.endpoints.slice(0, 3).map(epLabel).join(' · ')}{r.endpoints.length > 3 ? ` +${r.endpoints.length - 3}` : ''}</span> : null}
                </span>
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

function Fact({ label, value, title }: { label: string; value: string | number; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${MUTED_CHIP}`}><span className="font-semibold text-gray-700">{value}</span>{label}</span>;
}

/** A proportional bar with its own legend — the mix at a glance, then the numbers. */
function Meter({ label, segments, total }: { label: string; segments: { key: string; label: string; value: number; colour: string }[]; total: number }) {
  if (segments.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <div className="mt-1 flex h-2 rounded-full overflow-hidden shadow-[inset_0_1px_2px_rgba(30,27,75,0.12)] bg-[#F3F1FB]">
        {segments.map((s) => <span key={s.key} title={`${s.label} · ${s.value}`} style={{ width: `${(s.value / total) * 100}%`, background: s.colour }} />)}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1 text-[9.5px] text-gray-500">
            <span className="w-1.5 h-1.5 rounded-sm flex-shrink-0" style={{ background: s.colour }} />
            {s.label}<span className="font-mono tabular-nums text-gray-400">{s.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** One "term — value" line for the facts that do not deserve a chip. */
function Detail({ term, desc }: { term: string; desc: string }) {
  return (
    <div className="flex gap-2 text-[10.5px] min-w-0">
      <dt className="text-gray-400 flex-shrink-0 w-[86px]">{term}</dt>
      <dd className="text-gray-600 min-w-0 break-words">{desc}</dd>
    </div>
  );
}

function Group({ id, icon: Icon, title, badge, open, onToggle, children }: { id: string; icon: React.ElementType; title: string; badge?: string; open: boolean; onToggle: (id: string) => void; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button type="button" onClick={() => onToggle(id)} className="w-full flex items-center gap-1.5 px-4 py-2 text-left hover:bg-[#FAFAFE] transition-colors">
        {open ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />}
        <Icon className="w-3.5 h-3.5 text-[#7C3AED]" />
        <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">{title}</span>
        {badge && <span className="ml-auto text-[9.5px] text-gray-400 truncate">{badge}</span>}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}
