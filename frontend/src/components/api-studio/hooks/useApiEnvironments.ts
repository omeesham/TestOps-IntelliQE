/**
 * useApiEnvironments — the workspace's environments, and which one is active.
 *
 * One shared store behind two consumers: the toolbar picker (pick the active
 * environment) and the Environments tab (CRUD). Keeping them on the same list
 * means a create/rename/delete on the tab is reflected in the picker at once.
 *
 * "Active" is the Postman idea of a currently-selected environment: the run
 * resolves `{{vars}}` and the base URL against it. The choice is per-browser
 * (localStorage) and, until the user picks one, falls back to the tenant's
 * default environment — so a fresh session still runs against something sane.
 *
 *   null            → not chosen yet → use the default environment (if any)
 *   NONE ('__none__') → explicitly no environment (run endpoints as imported)
 *   <id>            → that environment
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listApiEnvironments } from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';
import type { ApiEnvironment, EnvVariable } from '../types';

const ACTIVE_KEY = 'intelliqe_api_active_env';
/** Sentinel stored when the user explicitly wants no environment. */
export const NO_ENVIRONMENT = '__none__';

/** Server row → the shape the views render, defensively. */
export function mapEnv(e: any): ApiEnvironment {
  return {
    id: String(e?.id ?? ''),
    name: String(e?.name ?? ''),
    baseUrl: String(e?.baseUrl ?? ''),
    color: e?.color ? String(e.color) : undefined,
    variables: Array.isArray(e?.variables)
      ? e.variables.map((v: any): EnvVariable => ({ key: String(v?.key ?? ''), value: String(v?.value ?? ''), secret: !!v?.secret }))
      : [],
    isDefault: !!e?.isDefault,
    createdBy: e?.createdBy,
    createdAt: String(e?.createdAt ?? ''),
    updatedAt: String(e?.updatedAt ?? ''),
  };
}

/**
 * A stable key for "the environment state a run was resolved against" — its id
 * plus its `updatedAt` stamp, so the key changes both when a *different*
 * environment is picked and when the *same* environment's variables are edited.
 * `null`/none both collapse to `'none'`, matching a run designed without one.
 */
export function envRunKey(env: ApiEnvironment | null | undefined): string {
  return env ? `${env.id}:${env.updatedAt || ''}` : 'none';
}

export interface ApiEnvironmentsStore {
  environments: ApiEnvironment[];
  loading: boolean;
  reload: () => Promise<void>;
  /** Raw selection: null (auto/default), NO_ENVIRONMENT, or an id. */
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  /** The environment a run would resolve against, or null for none. */
  activeEnvironment: ApiEnvironment | null;
  /** True when the user has explicitly chosen to run without an environment. */
  noneSelected: boolean;
}

export function useApiEnvironments(): ApiEnvironmentsStore {
  const toast = useToast();
  const [environments, setEnvironments] = useState<ApiEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
  });

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch { /* private mode / blocked storage — the choice just won't persist */ }
  }, []);

  const reload = useCallback(async () => {
    try {
      const { environments: list } = await listApiEnvironments();
      setEnvironments((Array.isArray(list) ? list : []).map(mapEnv));
    } catch (err) {
      toast.fromError(err);
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void reload(); }, [reload]);

  const noneSelected = activeId === NO_ENVIRONMENT;

  const activeEnvironment = useMemo<ApiEnvironment | null>(() => {
    if (noneSelected || !environments.length) return null;
    const chosen = activeId ? environments.find((e) => e.id === activeId) : null;
    // A stale id (env deleted elsewhere) falls through to the tenant default.
    return chosen || environments.find((e) => e.isDefault) || null;
  }, [environments, activeId, noneSelected]);

  return { environments, loading, reload, activeId, setActiveId, activeEnvironment, noneSelected };
}
