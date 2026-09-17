/**
 * UX testing — the two halves that live inside the website audit panel:
 *
 *   UxSetup   (audit form)   choose device profiles and the customer's design
 *                            standard; upload a new standard (design tokens).
 *   UxReport  (report tab)   UX score split into layout integrity and design
 *                            adherence, per-device results, findings with
 *                            cropped evidence, and the typography / colour
 *                            actually in use across the site.
 *
 * Adherence is only ever scored against a standard the customer uploaded —
 * every design system is different, so there is no built-in "correct" look.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  listAdaDevices, listAdaStandards, uploadAdaStandard, deleteAdaStandard, getAdaFindings, getAdaEvidence,
  type AdaDevice, type AdaDesignStandard, type AdaFinding, type AdaSummary, type AdaSeverity, type AdaRemediation,
} from '@/services/api';
import { Monitor, Smartphone, Tablet, Upload, Trash2, Loader2, Palette, ChevronDown, ChevronRight, Eye, Info, CheckCircle2, AlertTriangle } from 'lucide-react';

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | undefined;
  return e?.response?.data?.error || e?.message || fallback;
}
function shortUrl(u: string): string {
  try { const x = new URL(u); return (x.pathname === '/' ? x.host : x.pathname) + (x.search || ''); } catch { return u; }
}
const KIND_ICON = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } as const;
const SEV_STYLE: Record<AdaSeverity, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200', serious: 'bg-orange-100 text-orange-700 border-orange-200',
  moderate: 'bg-amber-100 text-amber-700 border-amber-200', minor: 'bg-gray-100 text-gray-600 border-gray-200',
};
const tone = (s: number | null) => s === null ? 'text-gray-300' : s < 70 ? 'text-red-600' : s < 90 ? 'text-amber-600' : 'text-emerald-600';

/* ═════════════════════════════ SETUP (audit form) ═════════════════════════════ */

export function UxSetup({ enabled, onEnabled, devices, onDevices, standardId, onStandardId }: {
  enabled: boolean; onEnabled: (v: boolean) => void;
  devices: string[]; onDevices: (ids: string[]) => void;
  standardId: string; onStandardId: (id: string) => void;
}) {
  const [catalogue, setCatalogue] = useState<AdaDevice[]>([]);
  const [standards, setStandards] = useState<AdaDesignStandard[]>([]);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);

  useEffect(() => {
    listAdaDevices().then((r) => {
      setCatalogue(r.devices);
      if (!seeded.current && devices.length === 0) { seeded.current = true; onDevices(r.recommended); }
    }).catch(() => setCatalogue([]));
    listAdaStandards().then(setStandards).catch(() => setStandards([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => onDevices(devices.includes(id) ? devices.filter((d) => d !== id) : [...devices, id]);

  const upload = async (file: File) => {
    setUploading(true); setNote(null);
    try {
      const content = await file.text();
      const s = await uploadAdaStandard(file.name.replace(/\.[^.]+$/, ''), content);
      setStandards((prev) => [s, ...prev]);
      onStandardId(s.id);
      const st = s.stats;
      setNote({ ok: true, text: `Read as ${s.source_format}: ${st.colors} colours, ${st.fontFamilies} font families, ${st.fontSizes} font sizes, ${st.fontWeights} weights, ${st.spacing} spacing steps, ${st.radii} radii.${s.warnings.length ? ' ' + s.warnings.join(' ') : ''}` });
    } catch (err: unknown) {
      setNote({ ok: false, text: errorMessage(err, 'Could not read that file.') });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this design standard? Past reports keep their scores.')) return;
    try { await deleteAdaStandard(id); setStandards((p) => p.filter((s) => s.id !== id)); if (standardId === id) onStandardId(''); } catch (err: unknown) { setNote({ ok: false, text: errorMessage(err, 'Delete failed') }); }
  };

  const selected = standards.find((s) => s.id === standardId);
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3 space-y-3">
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} className="w-4 h-4 mt-0.5 rounded border-gray-300 text-violet-600" />
        <span>
          <span className="block text-xs font-medium text-gray-700">UX testing on desktop and mobile</span>
          <span className="block text-[11px] text-gray-500">Overlapping or covered controls, cut-off text, sideways scrolling, touch-target size, alignment — plus fonts, colours, spacing and radius against your design standard.</span>
        </span>
      </label>

      {enabled && (
        <>
          <div>
            <p className="text-[11px] font-medium text-gray-600 mb-1.5">Devices <span className="font-normal text-gray-400">— one phone per screen width is recommended; each extra device adds time</span></p>
            <div className="flex flex-wrap gap-1.5">
              {catalogue.map((d) => {
                const Icon = KIND_ICON[d.kind];
                const on = d.primary || devices.includes(d.id);
                return (
                  <button
                    key={d.id} type="button" disabled={d.primary} onClick={() => toggle(d.id)} aria-pressed={on}
                    title={`${d.viewport.width} × ${d.viewport.height}${d.primary ? ' — always included: the main audit runs here' : ''}`}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${on ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'} ${d.primary ? 'opacity-80 cursor-default' : ''}`}
                  >
                    <Icon className="w-3 h-3" /> {d.label} <span className="text-gray-400">{d.viewport.width}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[11px] font-medium text-gray-600 mb-1.5 flex items-center gap-1.5"><Palette className="w-3 h-3" /> Design standard <span className="font-normal text-gray-400">— your design system's tokens; design adherence is scored only against it</span></p>
            <div className="flex flex-wrap items-center gap-2">
              <select value={standardId} onChange={(e) => onStandardId(e.target.value)} className="flex-1 min-w-[12rem] px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-700 outline-none focus:border-violet-400">
                <option value="">No design standard — adherence will not be scored</option>
                {standards.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.stats.colors} colours, {s.stats.fontFamilies} fonts, {s.stats.fontSizes} sizes</option>)}
              </select>
              <input ref={fileRef} type="file" accept=".json,.tokens,.css,.scss,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="text-xs px-2.5 py-1.5 bg-white border border-gray-200 hover:border-violet-300 text-gray-700 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Upload
              </button>
              {selected && <button type="button" onClick={() => remove(selected.id)} className="text-gray-300 hover:text-red-500" title="Delete this design standard"><Trash2 className="w-4 h-4" /></button>}
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5">Accepts design tokens as JSON — W3C Design Tokens, Style Dictionary, Tokens Studio or a Figma Variables export — or a CSS file of custom properties. A raw .fig file cannot be read; export its variables or tokens instead.</p>
            {selected && selected.preview.colors.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 mt-1.5">
                {selected.preview.colors.map((c) => <span key={c.hex} title={`${c.name} ${c.hex}`} className="w-4 h-4 rounded border border-black/10" style={{ background: c.hex }} />)}
                <span className="text-[11px] text-gray-500 ml-1">{selected.preview.fontFamilies.join(', ')}{selected.preview.fontSizes.length ? ` · ${selected.preview.fontSizes.join(' / ')} px` : ''}</span>
              </div>
            )}
            {note && <p className={`text-[11px] mt-1.5 flex items-start gap-1.5 ${note.ok ? 'text-emerald-700' : 'text-red-600'}`}>{note.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-px flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />}{note.text}</p>}
          </div>
        </>
      )}
    </div>
  );
}

/* ═════════════════════════════ REPORT (tab) ═════════════════════════════ */

function Evidence({ scanId, file, alt }: { scanId: string; file: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let url: string | null = null; let alive = true;
    getAdaEvidence(scanId, file).then((u) => { if (alive) { url = u; setSrc(u); } else URL.revokeObjectURL(u); }).catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [scanId, file]);
  if (!src) return null;
  return (
    <button type="button" onClick={() => setBig((v) => !v)} className="block mt-1.5" title={big ? 'Shrink' : 'Enlarge'}>
      <img src={src} alt={alt} className={`rounded border border-gray-200 ${big ? 'max-w-full' : 'max-h-28 max-w-[280px]'} object-contain bg-white`} />
    </button>
  );
}

function ScoreTile({ label, score, sub }: { label: string; score: number | null; sub: string }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${score === null ? 'border-dashed border-gray-200 bg-gray-50' : 'border-gray-100 bg-white'}`}>
      <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-2xl font-bold leading-tight ${tone(score)}`}>{score === null ? '—' : score}</p>
      <p className="text-[11px] text-gray-500">{sub}</p>
    </div>
  );
}

type TypeFilter = 'all' | 'layout' | 'adherence' | 'review';

export function UxReport({ scanId, summary }: { scanId: string; summary: AdaSummary }) {
  const ux = summary.categories.ux;
  const [findings, setFindings] = useState<AdaFinding[] | null>(null);
  const [device, setDevice] = useState('all');
  const [type, setType] = useState<TypeFilter>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    getAdaFindings(scanId, { category: 'visual', limit: 2000 }).then((r) => { if (alive) setFindings(r.findings); }).catch(() => { if (alive) setFindings([]); });
    return () => { alive = false; };
  }, [scanId]);

  const groups = useMemo(() => {
    const d = (f: AdaFinding) => (f.details || {}) as Record<string, unknown>;
    const list = (findings || []).filter((f) => (device === 'all' || d(f).device === device) && (type === 'all' || (type === 'review' ? d(f).confidence !== 'high' : d(f).confidence === 'high' && d(f).family === type)));
    const m = new Map<string, AdaFinding[]>();
    for (const f of list) m.set(f.rule_id, [...(m.get(f.rule_id) || []), f]);
    const sevOrder: Record<AdaSeverity, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    return [...m.entries()].sort((a, b) => Number(d(b[1][0]).confidence === 'high') - Number(d(a[1][0]).confidence === 'high') || sevOrder[a[1][0].severity] - sevOrder[b[1][0].severity] || b[1].length - a[1].length);
  }, [findings, device, type]);

  if (!ux) return <p className="px-4 py-6 text-xs text-gray-400">UX testing was not part of this audit. Start a new audit with "UX testing on desktop and mobile" ticked.</p>;

  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const th = 'py-1.5 px-2 font-medium text-[11px] text-gray-400 text-left';
  return (
    <div className="p-4 space-y-4 text-xs">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <ScoreTile label="UX score" score={ux.score} sub={`${ux.issues.toLocaleString()} issues · ${ux.needsReview.toLocaleString()} to review`} />
        <ScoreTile label="Layout integrity" score={ux.layout.score} sub="Overlaps, covered controls, cut-off text, sideways scrolling, touch targets" />
        <ScoreTile label="Design adherence" score={ux.adherence.score} sub={ux.standard ? `Against "${ux.standard.name}" — fonts, sizes, colours, radius, spacing` : 'Not scored — no design standard was uploaded for this audit'} />
      </div>
      {!ux.standard && (
        <p className="flex items-start gap-1.5 text-gray-600 bg-violet-50/60 border border-violet-100 rounded-lg px-3 py-2"><Info className="w-3.5 h-3.5 mt-px text-violet-500 flex-shrink-0" />Every design system is different, so design adherence is only scored against your own standard. Upload your design tokens on the audit form and re-run. Until then the audit lists the site's own inconsistencies as items to review, unscored.</p>
      )}

      <div>
        <p className="font-semibold text-gray-700 mb-1">Devices</p>
        <table className="w-full">
          <thead><tr className="border-b border-gray-100"><th className={th}>Device</th><th className={th}>Viewport</th><th className={`${th} text-right`}>Pages</th><th className={`${th} text-right`}>Issues</th><th className={`${th} text-right`}>Layout</th><th className={`${th} text-right`}>Adherence</th></tr></thead>
          <tbody>
            {ux.devices.map((d) => { const Icon = KIND_ICON[d.kind]; return (
              <tr key={d.id} className="border-b border-gray-50">
                <td className="py-1.5 px-2 text-gray-700"><Icon className="w-3.5 h-3.5 inline mr-1.5 text-gray-400" />{d.label}</td>
                <td className="py-1.5 px-2 text-gray-500">{d.viewport}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">{d.pagesChecked}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">{d.issues}</td>
                <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${tone(d.layoutScore)}`}>{d.layoutScore ?? '—'}</td>
                <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${tone(d.adherenceScore)}`}>{d.adherenceScore ?? '—'}</td>
              </tr>
            ); })}
          </tbody>
        </table>
        <p className="text-[11px] text-gray-400 mt-1">{ux.emulationNote}</p>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <span className="font-semibold text-gray-700 mr-1">Findings</span>
          {(['all', 'layout', 'adherence', 'review'] as TypeFilter[]).map((t) => (
            <button key={t} onClick={() => setType(t)} className={`px-2 py-0.5 rounded-full border text-[11px] ${type === t ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>{t === 'all' ? 'All' : t === 'layout' ? 'Layout' : t === 'adherence' ? 'Design adherence' : 'To review'}</button>
          ))}
          <span className="w-px h-4 bg-gray-200 mx-1" />
          <button onClick={() => setDevice('all')} className={`px-2 py-0.5 rounded-full border text-[11px] ${device === 'all' ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-gray-200 text-gray-500'}`}>All devices</button>
          {ux.devices.map((d) => <button key={d.id} onClick={() => setDevice(d.id)} className={`px-2 py-0.5 rounded-full border text-[11px] ${device === d.id ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>{d.label}</button>)}
        </div>
        {findings === null ? <p className="text-gray-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
          : groups.length === 0 ? <p className="text-gray-400 py-3">Nothing found for this filter.</p>
          : (
            <div className="space-y-1.5">
              {groups.map(([ruleId, rows]) => {
                const first = rows[0];
                const det = (first.details || {}) as Record<string, unknown>;
                const rem = det.remediation as AdaRemediation | undefined;
                const occ = rows.reduce((a, f) => a + f.occurrences, 0);
                const isOpen = open.has(ruleId);
                return (
                  <div key={ruleId} className="border border-gray-100 rounded-lg">
                    <button onClick={() => toggle(ruleId)} className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-gray-50/60">
                      {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${SEV_STYLE[first.severity]}`}>{first.severity}</span>
                      {det.confidence !== 'high' && <span className="px-1.5 py-0.5 rounded border border-violet-200 bg-violet-50 text-violet-700 text-[10px] font-medium flex items-center gap-1"><Eye className="w-3 h-3" />review</span>}
                      <span className="text-gray-800 font-medium flex-1">{first.title}</span>
                      <span className="text-gray-500 tabular-nums">{occ.toLocaleString()} on {new Set(rows.map((r) => r.page_url)).size} page{new Set(rows.map((r) => r.page_url)).size === 1 ? '' : 's'}</span>
                    </button>
                    {isOpen && (
                      <div className="px-3 pb-3 space-y-2 border-t border-gray-100 pt-2">
                        {rem && (
                          <div className="bg-violet-50/60 border border-violet-100 rounded-lg px-3 py-2">
                            <p className="text-gray-700">{rem.problem}{rem.impact ? <span className="text-gray-500"> {rem.impact}</span> : null}</p>
                            <ol className="list-decimal ml-4 mt-1 text-gray-600 space-y-0.5">{rem.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                          </div>
                        )}
                        {rows.slice(0, 25).map((f) => { const d = (f.details || {}) as Record<string, unknown>; return (
                          <div key={f.id} className="border-b border-gray-50 pb-2 last:border-0">
                            <p className="text-gray-700">{f.description}</p>
                            <p className="text-[11px] text-gray-400 mt-0.5">
                              <a href={f.page_url} target="_blank" rel="noopener noreferrer" className="hover:text-violet-600">{shortUrl(f.page_url)}</a> · {String(d.deviceLabel || '')} ({String(d.viewport || '')})
                              {d.actual ? <> · <span className="text-red-600 font-mono">{String(d.actual)}</span>{d.expected ? <> → <span className="text-emerald-700 font-mono">{String(d.expected)}</span></> : null}</> : null}
                            </p>
                            {f.element && <code className="block text-[10px] text-violet-700 break-all mt-0.5">{f.element}</code>}
                            {typeof d.evidence === 'string' && <Evidence scanId={scanId} file={d.evidence} alt={`${f.title} — ${String(d.deviceLabel || '')}`} />}
                          </div>
                        ); })}
                        {rows.length > 25 && <p className="text-gray-400">Showing 25 of {rows.length} — narrow by device, or download the issues CSV.</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <p className="font-semibold text-gray-700 mb-1">Typography in use <span className="font-normal text-gray-400">(desktop, most used first)</span></p>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-100"><th className={th}>Text</th><th className={th}>Family</th><th className={`${th} text-right`}>Size</th><th className={`${th} text-right`}>Weight</th><th className={`${th} text-right`}>Uses</th></tr></thead>
              <tbody>{ux.typography.map((t, i) => <tr key={i} className="border-b border-gray-50"><td className="py-1 px-2 text-gray-600">{t.role}</td><td className="py-1 px-2 text-gray-700">{t.family}</td><td className="py-1 px-2 text-right tabular-nums text-gray-700">{t.size}px</td><td className="py-1 px-2 text-right tabular-nums text-gray-700">{t.weight}</td><td className="py-1 px-2 text-right tabular-nums text-gray-500">{t.uses.toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
        <div>
          <p className="font-semibold text-gray-700 mb-1">Colours in use <span className="font-normal text-gray-400">(desktop, most used first)</span></p>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-100"><th className={th}>Colour</th><th className={th}>Used as</th><th className={`${th} text-right`}>Uses</th><th className={th}>{ux.standard ? 'In standard' : ''}</th></tr></thead>
              <tbody>{ux.colors.map((c, i) => (
                <tr key={i} className="border-b border-gray-50">
                  <td className="py-1 px-2 font-mono text-gray-700"><span className="inline-block w-3 h-3 rounded border border-black/10 align-middle mr-1.5" style={{ background: c.hex }} />{c.hex}</td>
                  <td className="py-1 px-2 text-gray-600">{c.kind}</td>
                  <td className="py-1 px-2 text-right tabular-nums text-gray-500">{c.uses.toLocaleString()}</td>
                  <td className="py-1 px-2 text-[11px]">{ux.standard ? (c.inStandard ? <span className="text-emerald-700">yes</span> : <span className="text-red-600" title={c.nearest ? `Nearest: ${c.nearest.name} ${c.nearest.hex}` : ''}>no{c.nearest ? ` · nearest ${c.nearest.hex} (ΔE ${c.nearest.deltaE})` : ''}</span>) : null}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
