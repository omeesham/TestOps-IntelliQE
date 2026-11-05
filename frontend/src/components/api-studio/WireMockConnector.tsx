/**
 * WireMockConnector — the EXTERNAL mock-server bridge (API-013).
 *
 * IntelliQE already hosts its own stub (MockServer) and a Prism-parity proxy;
 * this tool instead talks to the two tools teams already run:
 *
 *   • WireMock — export the selected endpoints as stub mappings, push them to a
 *     live WireMock admin API (/__admin/mappings), or import existing mappings
 *     back into the catalogue as endpoints.
 *   • Prism    — export an example-bearing OpenAPI 3.0 spec that `prism mock`
 *     serves directly.
 *
 * Opt-in and standalone — nothing here touches the generate → execute → heal
 * pipeline.
 */
import { useState } from 'react';
import {
  X, Container, Download, Copy, Check, UploadCloud, Send, Plug, AlertTriangle, CheckCircle2, XCircle,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  exportWireMock, importWireMock, pushWireMock, pingWireMock, exportPrism, type WireMockPushResult,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import { MethodBadge } from './primitives';
import type { Catalog } from './hooks/useCatalog';
import type { CatalogEndpoint } from './types';

type Tab = 'wiremock' | 'prism' | 'import';

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function WireMockConnector({ endpoints, catalog, onClose }: { endpoints: CatalogEndpoint[]; catalog: Catalog; onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('wiremock');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  // WireMock push
  const [baseUrl, setBaseUrl] = useState('http://localhost:8080');
  const [reset, setReset] = useState(true);
  const [pushResults, setPushResults] = useState<WireMockPushResult[] | null>(null);
  const [ping, setPing] = useState<{ ok: boolean; count?: number; error?: string } | null>(null);

  // Import
  const [mappingsText, setMappingsText] = useState('');

  const copy = async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 1500); } catch { /* blocked */ }
  };

  const payload = () => endpoints.map((e) => ({
    method: e.method, url: e.url, path: e.pathTemplate, pathTemplate: e.pathTemplate,
    expectedStatus: e.expectedStatus, expectedResponse: e.expectedResponse, body: e.body, title: e.title,
  }));

  const doExportWireMock = async () => {
    if (!endpoints.length) { setError('No endpoints selected to export.'); return; }
    setBusy(true); setError('');
    try {
      const { mappings } = await exportWireMock(payload());
      download('wiremock-mappings.json', JSON.stringify({ mappings }, null, 2));
      toast.success('WireMock mappings exported', `${mappings.length} stub${mappings.length === 1 ? '' : 's'} written to wiremock-mappings.json`);
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Export failed.'); }
    finally { setBusy(false); }
  };

  const doExportPrism = async () => {
    if (!endpoints.length) { setError('No endpoints selected to export.'); return; }
    setBusy(true); setError('');
    try {
      const { spec, endpointCount } = await exportPrism(payload());
      download('intelliqe-mock.json', JSON.stringify(spec, null, 2));
      toast.success('Prism spec exported', `${endpointCount} path${endpointCount === 1 ? '' : 's'} — run “prism mock intelliqe-mock.json”`);
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Export failed.'); }
    finally { setBusy(false); }
  };

  const doPing = async () => {
    setBusy(true); setError(''); setPing(null);
    try { setPing(await pingWireMock(baseUrl)); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Ping failed.'); }
    finally { setBusy(false); }
  };

  const doPush = async () => {
    if (!endpoints.length) { setError('No endpoints selected to push.'); return; }
    setBusy(true); setError(''); setPushResults(null);
    try {
      const r = await pushWireMock(baseUrl, payload(), reset);
      setPushResults(r.results);
      if (r.failed === 0) toast.success('Pushed to WireMock', `${r.pushed} stub${r.pushed === 1 ? '' : 's'} live${r.reset ? ' (existing stubs reset)' : ''}.`);
      else toast.error('Partial push', `${r.pushed} ok · ${r.failed} failed.`);
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Push failed.'); }
    finally { setBusy(false); }
  };

  const doImport = async () => {
    if (!mappingsText.trim()) { setError('Paste WireMock mappings JSON first.'); return; }
    setBusy(true); setError('');
    try {
      const { endpoints: imported } = await importWireMock(mappingsText);
      if (!imported.length) { setError('No mappings found in that JSON.'); return; }
      const r = catalog.addEndpoints(imported, { method: 'capture', name: 'WireMock import', format: 'WireMock mappings', parser: 'wiremock' });
      toast.success('Imported from WireMock', `${r.added} endpoint${r.added === 1 ? '' : 's'} added${r.duplicates ? ` · ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'}` : ''}.`);
      setMappingsText('');
      onClose();
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Import failed.'); }
    finally { setBusy(false); }
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    try { setMappingsText(await file.text()); setError(''); } catch { setError('Could not read that file.'); }
  };

  const TabBtn = ({ id, label }: { id: Tab; label: string }) => (
    <button
      type="button"
      onClick={() => { setTab(id); setError(''); }}
      className={`px-3 py-1.5 text-[12px] font-semibold rounded-lg transition-colors ${tab === id ? 'bg-[#7C3AED] text-white' : 'text-gray-600 hover:bg-[#F5F3FF]'}`}
    >{label}</button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Container className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">WireMock / Prism connector</h3>
          <span className="text-[11px] text-gray-400">export · push · import</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-4 pt-3 flex items-center gap-1.5 flex-shrink-0">
          <TabBtn id="wiremock" label="WireMock" />
          <TabBtn id="prism" label="Prism" />
          <TabBtn id="import" label="Import" />
          <span className="ml-auto text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} selected</span>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {tab === 'wiremock' && (
            <>
              <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3">
                <label className={LABEL}>Export as stub mappings</label>
                <p className="text-[11px] text-gray-500 mb-2">Download the selected endpoints as a WireMock <code className="font-mono text-[#6D28D9]">mappings.json</code> — drop it into your WireMock <code className="font-mono text-[#6D28D9]">mappings/</code> folder, or import it via the admin API.</p>
                <button type="button" onClick={() => void doExportWireMock()} disabled={busy || !endpoints.length} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}Export mappings.json
                </button>
              </div>

              <div className="rounded-lg border border-[#E4E0F5] bg-white p-3">
                <label className={LABEL}>Push to a live WireMock</label>
                <div className="flex items-end gap-2">
                  <div className="flex-1 min-w-0">
                    <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setPing(null); }} placeholder="http://localhost:8080" className={INPUT} />
                  </div>
                  <button type="button" onClick={() => void doPing()} disabled={busy} className={SECONDARY_BTN}><Plug className="w-3.5 h-3.5" />Test</button>
                  <button type="button" onClick={() => void doPush()} disabled={busy || !endpoints.length} className={PRIMARY_BTN}>
                    {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}Push
                  </button>
                </div>
                <label className="flex items-center gap-1.5 mt-2 text-[11.5px] text-gray-600 cursor-pointer select-none">
                  <input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} className="accent-[#7C3AED]" />
                  Reset existing stubs before pushing
                </label>
                {ping && (
                  <div className={`mt-2 flex items-center gap-1.5 text-[11.5px] ${ping.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                    {ping.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                    {ping.ok ? `Reachable${typeof ping.count === 'number' ? ` · ${ping.count} existing stub${ping.count === 1 ? '' : 's'}` : ''}` : `Unreachable — ${ping.error || 'no admin API'}`}
                  </div>
                )}
                {pushResults && (
                  <div className="mt-2 border border-[#E9E5FB] rounded-lg divide-y divide-[#F0EDFA] max-h-40 overflow-y-auto">
                    {pushResults.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
                        {r.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                        <MethodBadge method={r.method} /><span className="font-mono text-gray-600 truncate">{r.path}</span>
                        {!r.ok && <span className="ml-auto text-red-500 truncate">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'prism' && (
            <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3">
              <label className={LABEL}>Export a Prism-runnable OpenAPI spec</label>
              <p className="text-[11px] text-gray-500 mb-2">Generates an OpenAPI 3.0 doc whose example responses Prism serves. Download it, then run:</p>
              <div className="flex items-center gap-1.5 mb-2">
                <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] rounded px-2 py-1.5">prism mock intelliqe-mock.json</code>
                <button type="button" onClick={() => void copy('prism mock intelliqe-mock.json', 'cmd')} className={SECONDARY_BTN}>{copied === 'cmd' ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}</button>
              </div>
              <button type="button" onClick={() => void doExportPrism()} disabled={busy || !endpoints.length} className={PRIMARY_BTN}>
                {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}Export intelliqe-mock.json
              </button>
              <p className="text-[10.5px] text-gray-400 mt-2">Prism has no admin API, so this is export-only — it serves the spec you run it against.</p>
            </div>
          )}

          {tab === 'import' && (
            <div className="rounded-lg border border-[#E4E0F5] bg-white p-3">
              <label className={LABEL}>Import WireMock mappings → catalogue</label>
              <p className="text-[11px] text-gray-500 mb-2">Paste a WireMock <code className="font-mono text-[#6D28D9]">mappings</code> document (or a single mapping), or upload the file. Each stub becomes a catalogue endpoint you can test, heal and report on.</p>
              <label className={`${SECONDARY_BTN} mb-2 cursor-pointer`}>
                <UploadCloud className="w-3.5 h-3.5" />Choose file…
                <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
              </label>
              <textarea
                value={mappingsText}
                onChange={(e) => { setMappingsText(e.target.value); setError(''); }}
                placeholder='{ "mappings": [ { "request": { "method": "GET", "urlPath": "/users" }, "response": { "status": 200, "jsonBody": { "ok": true } } } ] }'
                className={`${INPUT} font-mono text-[11px] h-40 resize-none`}
              />
              <div className="flex justify-end mt-2">
                <button type="button" onClick={() => void doImport()} disabled={busy || !mappingsText.trim()} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}Import to catalogue
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
