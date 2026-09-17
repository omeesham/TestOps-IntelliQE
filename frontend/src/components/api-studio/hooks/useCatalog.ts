/**
 * useCatalog — the workspace's ground truth.
 *
 * Owns the endpoint catalogue (whatever the twelve import methods produced),
 * which of it is selected to run, the pattern profile the platform derived
 * from it, the reviewer's strategy choices, and the environments. Persisted
 * to sessionStorage so a page refresh in the middle of a long review does not
 * throw an hour of imports away.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeApi, listApiEnvironments, createApiEnvironment, updateApiEnvironment, deleteApiEnvironment,
} from '@/services/api';
import { newEndpointId } from '../format';
import type { CatalogEndpoint, ApiProfile, Strategy, ApiEnvironment, StrategyLayerId, ImportMethod } from '../types';

const STORAGE_KEY = 'intelliqe_api_catalog_v2';
const MAX_ENDPOINTS = 600;

export interface ImportRecord {
  id: string;
  at: number;
  method: ImportMethod;
  name: string;
  format: string;
  parser: string;
  count: number;
  warnings: string[];
  notice?: string;
}

interface Persisted {
  endpoints: CatalogEndpoint[];
  selected: string[];
  profile: ApiProfile | null;
  strategy: Strategy;
  activeEnvId: string | null;
  imports: ImportRecord[];
}

const DEFAULT_STRATEGY: Strategy = {
  coverage: 'standard',
  layers: ['smoke', 'contract', 'schema', 'negative', 'auth', 'security', 'performance', 'flow'],
};

function load(): Persisted | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !Array.isArray(p.endpoints)) return null;
    return {
      endpoints: p.endpoints,
      selected: Array.isArray(p.selected) ? p.selected : [],
      profile: p.profile || null,
      strategy: p.strategy && Array.isArray(p.strategy.layers) ? p.strategy : DEFAULT_STRATEGY,
      activeEnvId: p.activeEnvId || null,
      imports: Array.isArray(p.imports) ? p.imports : [],
    };
  } catch { return null; }
}

/** Server endpoint shape → catalogue entry with a client id. */
export function toCatalogEndpoint(e: any, method?: ImportMethod): CatalogEndpoint {
  return {
    id: newEndpointId(),
    title: String(e.title || `${String(e.method || 'GET').toUpperCase()} ${e.url}`),
    method: String(e.method || 'GET').toUpperCase(),
    url: String(e.url || ''),
    headers: Array.isArray(e.headers) ? e.headers.filter((h: any) => h && h.key).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })) : [],
    auth: { type: (['none', 'bearer', 'basic', 'apikey'].includes(e.auth?.type) ? e.auth.type : 'none'), value: e.auth?.value || undefined, headerName: e.auth?.headerName || undefined },
    body: e.body || undefined,
    expectedStatus: typeof e.expectedStatus === 'number' ? e.expectedStatus : undefined,
    expectedResponse: e.expectedResponse || undefined,
    description: e.description || undefined,
    operationId: e.operationId || undefined,
    tags: Array.isArray(e.tags) ? e.tags : undefined,
    resource: e.resource || undefined,
    pathTemplate: e.pathTemplate || undefined,
    pathParams: e.pathParams || undefined,
    queryParams: e.queryParams || undefined,
    style: e.style || 'rest',
    source: e.source || (method ? { method, name: '' } : undefined),
    deprecated: !!e.deprecated,
    discovered: !!e.discovered,
    importedAt: Date.now(),
  };
}

export function useCatalog() {
  const initial = useRef<Persisted | null>(load());
  const [endpoints, setEndpoints] = useState<CatalogEndpoint[]>(initial.current?.endpoints || []);
  const [selected, setSelected] = useState<Set<string>>(new Set(initial.current?.selected || []));
  const [profile, setProfile] = useState<ApiProfile | null>(initial.current?.profile || null);
  const [strategy, setStrategyState] = useState<Strategy>(initial.current?.strategy || DEFAULT_STRATEGY);
  const [imports, setImports] = useState<ImportRecord[]>(initial.current?.imports || []);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState('');

  const [environments, setEnvironments] = useState<ApiEnvironment[]>([]);
  const [envLoading, setEnvLoading] = useState(false);
  const [activeEnvId, setActiveEnvId] = useState<string | null>(initial.current?.activeEnvId || null);

  /* ── Persist ── */
  useEffect(() => {
    try {
      const p: Persisted = { endpoints, selected: [...selected], profile, strategy, activeEnvId, imports: imports.slice(0, 30) };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch { /* quota — the session simply is not persisted */ }
  }, [endpoints, selected, profile, strategy, activeEnvId, imports]);

  /* ── Analysis — re-derived whenever the catalogue changes ── */
  const analyze = useCallback(async (list: CatalogEndpoint[], deep = false) => {
    if (list.length === 0) { setProfile(null); return null; }
    setAnalyzing(true);
    setAnalysisError('');
    try {
      const { profile: p } = await analyzeApi(list, deep);
      setProfile((prev) => (deep || !prev?.insights ? p : { ...p, insights: prev.insights }));
      return p as ApiProfile;
    } catch (err: any) {
      setAnalysisError(err?.response?.data?.error || err?.message || 'Analysis failed.');
      return null;
    } finally {
      setAnalyzing(false);
    }
  }, []);

  /* ── Catalogue mutations ──
     The current list is mirrored in a ref so mutations can compute the next
     list synchronously (and kick off analysis) without side effects inside a
     state updater, which strict mode would run twice. */
  const endpointsRef = useRef(endpoints);
  useEffect(() => { endpointsRef.current = endpoints; }, [endpoints]);

  const addEndpoints = useCallback((incoming: any[], meta: { method: ImportMethod; name: string; format: string; parser: string; warnings?: string[]; notice?: string; profile?: ApiProfile | null; replace?: boolean }) => {
    const fresh = incoming.map((e) => toCatalogEndpoint(e, meta.method)).map((e) => ({ ...e, source: { method: e.source?.method || meta.method, name: e.source?.name || meta.name } }));
    const base = meta.replace ? [] : endpointsRef.current;
    const seen = new Set(base.map((e) => `${e.method} ${e.url}`.toLowerCase()));
    const merged = [...base];
    const addedIds: string[] = [];
    for (const e of fresh) {
      const key = `${e.method} ${e.url}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(e);
      addedIds.push(e.id);
    }
    const next = merged.slice(0, MAX_ENDPOINTS);
    endpointsRef.current = next;
    setEndpoints(next);
    // Everything new is selected to run by default — the reviewer narrows.
    setSelected((sel) => new Set([...(meta.replace ? [] : [...sel]), ...addedIds.filter((id) => next.some((n) => n.id === id))]));
    // A profile computed by the server for THIS import only describes this
    // import; when it joins an existing catalogue the merged set is re-analysed.
    if (meta.profile && (meta.replace || base.length === 0)) setProfile(meta.profile);
    else void analyze(next);
    setImports((prev) => [{ id: newEndpointId(), at: Date.now(), method: meta.method, name: meta.name, format: meta.format, parser: meta.parser, count: fresh.length, warnings: meta.warnings || [], notice: meta.notice }, ...prev].slice(0, 30));
    return { added: addedIds.length, total: fresh.length, duplicates: fresh.length - addedIds.length };
  }, [analyze]);

  const removeEndpoints = useCallback((ids: string[]) => {
    const drop = new Set(ids);
    const next = endpointsRef.current.filter((e) => !drop.has(e.id));
    endpointsRef.current = next;
    setEndpoints(next);
    setSelected((prev) => new Set([...prev].filter((id) => !drop.has(id))));
    void analyze(next);
  }, [analyze]);

  const updateEndpoint = useCallback((id: string, patch: Partial<CatalogEndpoint>) => {
    const next = endpointsRef.current.map((e) => (e.id === id ? { ...e, ...patch } : e));
    endpointsRef.current = next;
    setEndpoints(next);
    void analyze(next);
  }, [analyze]);

  const clearCatalog = useCallback(() => {
    endpointsRef.current = [];
    setEndpoints([]);
    setSelected(new Set());
    setProfile(null);
  }, []);

  const toggle = useCallback((id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const selectMany = useCallback((ids: string[], on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  }), []);
  const selectAll = useCallback(() => setSelected(new Set(endpoints.map((e) => e.id))), [endpoints]);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const selectedEndpoints = useMemo(() => endpoints.filter((e) => selected.has(e.id)), [endpoints, selected]);

  /* ── Strategy ── */
  const setStrategy = useCallback((patch: Partial<Strategy>) => setStrategyState((prev) => ({ ...prev, ...patch })), []);
  const toggleLayer = useCallback((layer: StrategyLayerId) => setStrategyState((prev) => ({
    ...prev,
    layers: prev.layers.includes(layer) ? prev.layers.filter((l) => l !== layer) : [...prev.layers, layer],
  })), []);
  /** Adopt the platform's recommendation (depth + every layer that applies). */
  const adoptRecommendation = useCallback(() => {
    if (!profile) return;
    setStrategyState({ coverage: profile.strategy.recommendedCoverage, layers: profile.strategy.layers.filter((l) => l.enabled).map((l) => l.id) });
  }, [profile]);

  /* ── Environments ── */
  const loadEnvironments = useCallback(async () => {
    setEnvLoading(true);
    try {
      const { environments: list } = await listApiEnvironments();
      setEnvironments(list);
      setActiveEnvId((cur) => (cur && list.some((e: ApiEnvironment) => e.id === cur) ? cur : (list.find((e: ApiEnvironment) => e.isDefault)?.id || null)));
    } catch { /* the workspace works without environments */ }
    finally { setEnvLoading(false); }
  }, []);
  useEffect(() => { void loadEnvironments(); }, [loadEnvironments]);

  const saveEnvironment = useCallback(async (input: { id?: string; name: string; baseUrl?: string; variables?: any[]; isDefault?: boolean }) => {
    const { environment } = input.id ? await updateApiEnvironment(input.id, input) : await createApiEnvironment(input);
    await loadEnvironments();
    return environment as ApiEnvironment;
  }, [loadEnvironments]);
  const removeEnvironment = useCallback(async (id: string) => {
    await deleteApiEnvironment(id);
    if (activeEnvId === id) setActiveEnvId(null);
    await loadEnvironments();
  }, [activeEnvId, loadEnvironments]);
  const activeEnv = useMemo(() => environments.find((e) => e.id === activeEnvId) || null, [environments, activeEnvId]);

  return {
    endpoints, selected, selectedEndpoints, profile, strategy, imports,
    analyzing, analysisError,
    addEndpoints, removeEndpoints, updateEndpoint, clearCatalog,
    toggle, selectMany, selectAll, clearSelection,
    analyze: (deep = false) => analyze(endpoints, deep),
    setStrategy, toggleLayer, adoptRecommendation,
    environments, envLoading, activeEnv, activeEnvId, setActiveEnvId, loadEnvironments, saveEnvironment, removeEnvironment,
  };
}

export type Catalog = ReturnType<typeof useCatalog>;
