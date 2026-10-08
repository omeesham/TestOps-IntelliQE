/**
 * PactBroker — consumer-driven contracts.
 *
 * A lightweight Pact broker: consumers publish contracts (the interactions they
 * expect from a provider), a provider is verified against a stored contract by
 * replaying its interactions at a live base URL, deployments are recorded per
 * environment, and "can I deploy?" answers whether a pacticipant version is safe
 * to release given what has been verified. Opt-in and self-contained — nothing
 * here runs the pipeline.
 */
import { useEffect, useState } from 'react';
import { X, Handshake, Play, Trash2, AlertTriangle, CheckCircle2, XCircle, Plus } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { listPacts, publishPact, deletePact, verifyPact, recordPactDeployment, canIDeploy, type StoredPact, type PactVerification, type CanIDeployResult } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';

export default function PactBroker({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [error, setError] = useState('');

  // (A) Publish
  const [contractText, setContractText] = useState('');
  const [pConsumer, setPConsumer] = useState('');
  const [pProvider, setPProvider] = useState('');
  const [pVersion, setPVersion] = useState('');
  const [pBranch, setPBranch] = useState('');
  const [publishing, setPublishing] = useState(false);

  // (B) Pacts list
  const [pacts, setPacts] = useState<StoredPact[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifyOpenId, setVerifyOpenId] = useState('');
  const [providerBaseUrl, setProviderBaseUrl] = useState('');
  const [providerVersion, setProviderVersion] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<PactVerification | null>(null);

  // (C) Deployment check
  const [dPacticipant, setDPacticipant] = useState('');
  const [dVersion, setDVersion] = useState('');
  const [dEnvironment, setDEnvironment] = useState('production');
  const [deployBusy, setDeployBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [canDeploy, setCanDeploy] = useState<CanIDeployResult | null>(null);

  const load = async () => {
    const { pacts: list } = await listPacts();
    setPacts(list);
  };

  useEffect(() => {
    (async () => {
      try { await load(); }
      catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not load pacts.'); }
      finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const publish = async () => {
    let contract: any;
    try { contract = JSON.parse(contractText); }
    catch { setError('Pact contract must be valid JSON.'); return; }
    setPublishing(true); setError('');
    try {
      const { pact } = await publishPact({
        consumer: pConsumer.trim() || undefined,
        provider: pProvider.trim() || undefined,
        version: pVersion.trim() || undefined,
        branch: pBranch.trim() || undefined,
        contract,
      });
      setContractText('');
      await load();
      toast.success('Pact published', `${pact.consumer} → ${pact.provider}`);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not publish the pact.');
    } finally { setPublishing(false); }
  };

  const openVerify = (p: StoredPact) => {
    if (verifyOpenId === p.id) { setVerifyOpenId(''); return; }
    setVerifyOpenId(p.id);
    setProviderBaseUrl('');
    setProviderVersion(p.version);
    setVerification(null);
    setError('');
  };

  const runVerify = async (id: string) => {
    if (!providerBaseUrl.trim()) { setError('Provider base URL is required to verify.'); return; }
    setVerifying(true); setError(''); setVerification(null);
    try {
      const { verification: v } = await verifyPact(id, providerBaseUrl.trim(), providerVersion.trim() || undefined);
      setVerification(v);
      await load();
      toast[v.success ? 'success' : 'warning'](v.success ? 'Verification passed' : 'Verification failed');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Verification failed.');
    } finally { setVerifying(false); }
  };

  const remove = async (p: StoredPact) => {
    if (!window.confirm(`Delete the pact ${p.consumer} → ${p.provider} @ ${p.version}?`)) return;
    setError('');
    try {
      await deletePact(p.id);
      if (verifyOpenId === p.id) { setVerifyOpenId(''); setVerification(null); }
      await load();
      toast.success('Pact deleted');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not delete the pact.');
    }
  };

  const recordDeployment = async () => {
    if (!dPacticipant.trim() || !dVersion.trim()) { setError('Pacticipant and version are required.'); return; }
    setDeployBusy(true); setError('');
    try {
      await recordPactDeployment({ pacticipant: dPacticipant.trim(), version: dVersion.trim(), environment: dEnvironment.trim() || 'production' });
      toast.success('Deployment recorded', `${dPacticipant.trim()} @ ${dVersion.trim()} · ${dEnvironment.trim() || 'production'}`);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not record the deployment.');
    } finally { setDeployBusy(false); }
  };

  const check = async () => {
    if (!dPacticipant.trim() || !dVersion.trim()) { setError('Pacticipant and version are required.'); return; }
    setCheckBusy(true); setError(''); setCanDeploy(null);
    try {
      setCanDeploy(await canIDeploy(dPacticipant.trim(), dVersion.trim(), dEnvironment.trim() || 'production'));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not run the deployment check.');
    } finally { setCheckBusy(false); }
  };

  const okChip = (ok: boolean) => (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${ok ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
      {ok ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}{ok ? 'ok' : 'fail'}
    </span>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Handshake className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Pact broker</h3>
          <span className="text-[11px] text-gray-400">consumer-driven contracts</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* (A) Publish */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-2">
            <label className={LABEL}>Publish a pact</label>
            <textarea
              value={contractText}
              onChange={(e) => { setContractText(e.target.value); setError(''); }}
              rows={8}
              spellCheck={false}
              className={`${INPUT} font-mono text-[11px] leading-[1.5] resize-y`}
              placeholder='{"consumer":{"name":"web"},"provider":{"name":"orders"},"interactions":[…]}'
            />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <input value={pConsumer} onChange={(e) => setPConsumer(e.target.value)} placeholder="consumer" className={`${INPUT} py-1`} />
              <input value={pProvider} onChange={(e) => setPProvider(e.target.value)} placeholder="provider" className={`${INPUT} py-1`} />
              <input value={pVersion} onChange={(e) => setPVersion(e.target.value)} placeholder="version" className={`${INPUT} py-1`} />
              <input value={pBranch} onChange={(e) => setPBranch(e.target.value)} placeholder="branch" className={`${INPUT} py-1`} />
            </div>
            <p className="text-[10px] text-gray-400">Consumer / provider / version fall back to the contract when left blank.</p>
            <div className="flex justify-end">
              <button type="button" onClick={() => void publish()} disabled={publishing || !contractText.trim()} className={PRIMARY_BTN}>
                {publishing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Publish
              </button>
            </div>
          </div>

          {/* (B) Pacts list */}
          <div>
            <label className={LABEL}>Pacts</label>
            {loading ? (
              <div className="flex items-center justify-center py-6 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
            ) : pacts.length === 0 ? (
              <div className="text-center py-5 text-[12px] text-gray-400">No pacts published yet.</div>
            ) : (
              <div className="space-y-1.5">
                {pacts.map((p) => {
                  const lv = p.lastVerification;
                  return (
                    <div key={p.id} className="rounded-lg border border-[#E9E5FB] overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[#FCFBFF]">
                        <span className="text-[12px] font-medium text-gray-700 truncate">{p.consumer} <span className="text-gray-400">→</span> {p.provider}</span>
                        <span className="text-[10.5px] font-mono text-gray-500 tabular-nums">{p.version}</span>
                        <span className="text-[10.5px] text-gray-400">{p.branch}</span>
                        <span className="text-[10.5px] text-gray-400 tabular-nums">{p.interactionCount} int.</span>
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${lv ? (lv.success ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200') : 'text-gray-500 bg-gray-50 border-gray-200'}`}>
                          {lv ? (lv.success ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />) : null}
                          {lv ? (lv.success ? 'verified' : 'failed') : 'unverified'}
                        </span>
                        <div className="ml-auto flex items-center gap-1.5">
                          <button type="button" onClick={() => openVerify(p)} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-gray-200 text-gray-600 bg-white hover:text-[#7C3AED] hover:border-[#DDD6FE]">
                            <Play className="w-3 h-3" />Verify
                          </button>
                          <button type="button" onClick={() => void remove(p)} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete pact"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>

                      {verifyOpenId === p.id && (
                        <div className="px-2.5 py-2 space-y-2 border-t border-[#EDE9FE] bg-white">
                          <div className="flex flex-wrap items-end gap-2">
                            <div className="flex-1 min-w-[180px]">
                              <label className={LABEL}>Provider base URL</label>
                              <input value={providerBaseUrl} onChange={(e) => setProviderBaseUrl(e.target.value)} placeholder="https://orders.staging.example.com" className={`${INPUT} py-1 font-mono text-[11px]`} />
                            </div>
                            <div className="w-32">
                              <label className={LABEL}>Provider version</label>
                              <input value={providerVersion} onChange={(e) => setProviderVersion(e.target.value)} placeholder="1.0.0" className={`${INPUT} py-1`} />
                            </div>
                            <button type="button" onClick={() => void runVerify(p.id)} disabled={verifying} className={SECONDARY_BTN}>
                              {verifying ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run verification
                            </button>
                          </div>

                          {verification && verification.pactId === p.id && (
                            <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                              <table className="w-full text-[11.5px]">
                                <thead>
                                  <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                                    <th className="font-semibold px-2.5 py-1.5">Interaction</th>
                                    <th className="font-semibold px-2.5 py-1.5 text-right">expected</th>
                                    <th className="font-semibold px-2.5 py-1.5 text-right">actual</th>
                                    <th className="font-semibold px-2.5 py-1.5 text-center">ok</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                  {verification.results.map((r, i) => (
                                    <tr key={i}>
                                      <td className="px-2.5 py-1.5 text-gray-700">
                                        {r.description}
                                        {r.error && <div className="text-[10.5px] text-red-500 whitespace-pre-wrap break-words">{r.error}</div>}
                                      </td>
                                      <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.expected}</td>
                                      <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.actual ?? '—'}</td>
                                      <td className="px-2.5 py-1.5 text-center">{okChip(r.ok)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* (C) Deployment check */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-2">
            <label className={LABEL}>Deployment check</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input value={dPacticipant} onChange={(e) => setDPacticipant(e.target.value)} placeholder="pacticipant (e.g. web)" className={`${INPUT} py-1`} />
              <input value={dVersion} onChange={(e) => setDVersion(e.target.value)} placeholder="version" className={`${INPUT} py-1`} />
              <input value={dEnvironment} onChange={(e) => setDEnvironment(e.target.value)} placeholder="environment" className={`${INPUT} py-1`} />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => void recordDeployment()} disabled={deployBusy} className={SECONDARY_BTN}>
                {deployBusy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}Record deployment
              </button>
              <button type="button" onClick={() => void check()} disabled={checkBusy} className={PRIMARY_BTN}>
                {checkBusy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Can I deploy?
              </button>
            </div>

            {canDeploy && (
              <div className="space-y-2">
                <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${canDeploy.deployable ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                  {canDeploy.deployable ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                  <span className={`text-[12.5px] font-semibold ${canDeploy.deployable ? 'text-emerald-700' : 'text-red-700'}`}>
                    {canDeploy.deployable ? 'Safe to deploy' : 'Not safe to deploy'}
                  </span>
                  <span className="ml-auto text-[11px] text-gray-500 font-mono tabular-nums">{canDeploy.pacticipant} @ {canDeploy.version} · {canDeploy.environment}</span>
                </div>
                {canDeploy.reasons.length > 0 && (
                  <ul className="text-[11.5px] text-gray-600 space-y-0.5 list-disc pl-5">
                    {canDeploy.reasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
                {canDeploy.pairs.length > 0 && (
                  <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                    <table className="w-full text-[11.5px]">
                      <thead>
                        <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                          <th className="font-semibold px-2.5 py-1.5">Consumer</th>
                          <th className="font-semibold px-2.5 py-1.5">Provider</th>
                          <th className="font-semibold px-2.5 py-1.5 text-center">verified</th>
                          <th className="font-semibold px-2.5 py-1.5">detail</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {canDeploy.pairs.map((pr, i) => (
                          <tr key={i}>
                            <td className="px-2.5 py-1.5 text-gray-700">{pr.consumer}</td>
                            <td className="px-2.5 py-1.5 text-gray-700">{pr.provider}</td>
                            <td className="px-2.5 py-1.5 text-center">{okChip(pr.verified)}</td>
                            <td className="px-2.5 py-1.5 text-gray-500">{pr.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
