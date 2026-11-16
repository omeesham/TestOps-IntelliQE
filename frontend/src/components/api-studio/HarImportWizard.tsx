/**
 * HarImportWizard — a two-step HAR import with a domain chooser (IQE-051.1 #4).
 *
 * A browser HAR recording routinely mixes the app's own API with CDNs and
 * third-party analytics/auth hosts. Step 1 previews the distinct domains (with
 * request counts) without creating anything; step 2 imports only the hosts the
 * reviewer ticks. Hosts that carry API-ish traffic are pre-selected.
 */
import { useEffect, useMemo, useState } from 'react';
import { Globe, Loader2, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import { previewHarDomains, importHarDomains, type HarDomain, type ApiImportResponse } from '@/services/api';

interface Props {
  file: File;
  onClose: () => void;
  onImported: (name: string, res: ApiImportResponse) => void;
}

export default function HarImportWizard({ file, onClose, onImported }: Props) {
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState(file.name);
  const [domains, setDomains] = useState<HarDomain[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  /* Step 1 — preview the domains. */
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    previewHarDomains(file)
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res.domains) ? res.domains : [];
        setDomains(list);
        setName(res.name || file.name);
        // Pre-select every host that carried API-ish traffic.
        setChosen(new Set(list.filter((d) => d.apiRequestCount > 0).map((d) => d.host)));
      })
      .catch((err: any) => { if (!cancelled) setError(err?.response?.data?.error || err?.message || 'Could not read the HAR file.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [file]);

  const totalApi = useMemo(() => domains.reduce((n, d) => n + d.apiRequestCount, 0), [domains]);
  const chosenApi = useMemo(() => domains.filter((d) => chosen.has(d.host)).reduce((n, d) => n + d.apiRequestCount, 0), [domains, chosen]);

  const toggle = (host: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(host)) next.delete(host); else next.add(host);
    return next;
  });
  const allOn = domains.length > 0 && chosen.size === domains.length;
  const toggleAll = () => setChosen(allOn ? new Set() : new Set(domains.map((d) => d.host)));

  /* Step 2 — import the chosen hosts. */
  const confirm = async () => {
    if (!chosen.size) return;
    setImporting(true); setError('');
    try {
      const res = await importHarDomains(file, [...chosen]);
      onImported(name, res);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Import failed.');
    } finally { setImporting(false); }
  };

  return (
    <div className="rounded-2xl border border-[#DDD6FE] bg-white shadow-[0_18px_44px_-28px_rgba(76,29,149,0.55)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 bg-[#F5F3FF] border-b border-[#EDE9FE]">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-[#0EA5E9]/15 border border-[#0EA5E9]/30 flex items-center justify-center flex-shrink-0">
            <Globe className="w-4 h-4 text-[#0EA5E9]" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[14px] font-bold text-[#1E1B4B] leading-tight">HAR import — choose domains</h3>
            <p className="text-[12px] text-gray-500 truncate">{name}</p>
          </div>
        </div>
        <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-white transition-colors" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5">
        {loading ? (
          <div className="flex items-center gap-2 text-[13px] text-gray-500 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the recording…
          </div>
        ) : error && !domains.length ? (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 px-3.5 py-3 text-[13px] text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> <span>{error}</span>
          </div>
        ) : !domains.length ? (
          <p className="text-[13px] text-gray-500 py-4 text-center">No domains with recorded requests were found in this HAR.</p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2.5">
              <p className="text-[12px] text-gray-500">
                {domains.length} domain{domains.length === 1 ? '' : 's'} · pick the host(s) whose requests should become endpoints.
              </p>
              <button type="button" onClick={toggleAll} className="text-[12px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]">
                {allOn ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div className="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
              {domains.map((d) => {
                const on = chosen.has(d.host);
                return (
                  <label key={d.host} className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all ${on ? 'border-[#C4B5FD] bg-[#F5F3FF]' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(d.host)} className="w-4 h-4 accent-[#7C3AED]" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-semibold text-gray-900 truncate">{d.host}</span>
                      <span className="block text-[11.5px] text-gray-500">
                        {d.apiRequestCount} API request{d.apiRequestCount === 1 ? '' : 's'}
                        {d.requestCount !== d.apiRequestCount ? ` · ${d.requestCount} total` : ''}
                      </span>
                    </span>
                    {d.apiRequestCount > 0 && (
                      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[#0EA5E9] bg-[#0EA5E9]/10 border border-[#0EA5E9]/25 rounded-full px-2 py-0.5 flex-shrink-0">API</span>
                    )}
                  </label>
                );
              })}
            </div>

            {error && (
              <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5 text-[12.5px] text-red-700">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> <span>{error}</span>
              </div>
            )}

            <div className="flex items-center justify-between mt-4 pt-3.5 border-t border-gray-100">
              <p className="text-[12px] text-gray-500">
                {chosen.size} of {domains.length} selected · ~{chosenApi} of {totalApi} API requests
              </p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-xl text-[13px] font-semibold text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                <button
                  type="button"
                  onClick={confirm}
                  disabled={!chosen.size || importing}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#7C3AED] text-white text-[13px] font-semibold hover:bg-[#6D28D9] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  {importing ? 'Importing…' : 'Import selected'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
