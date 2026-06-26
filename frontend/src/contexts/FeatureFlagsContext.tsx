/**
 * FeatureFlagsContext
 * ───────────────────
 * Loads the tenant's feature on/off map once (after auth) and exposes
 * `isEnabled(key)` for app-wide gating. A missing key defaults to ENABLED so
 * existing tenants keep the full app until something is explicitly turned off.
 *
 * Kept separate from AuthContext so the auth flow is untouched.
 */
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { getFeatureFlags } from '@/services/api';

interface FeatureFlagsContextType {
  flags: Record<string, boolean>;
  loaded: boolean;
  /** A feature is enabled unless it is explicitly set to false. */
  isEnabled: (key?: string) => boolean;
  /** Optimistically update local flags (used after a save). */
  setFlags: (flags: Record<string, boolean>) => void;
  /** Re-fetch flags from the server. */
  reload: () => void;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextType | null>(null);

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    if (!isAuthenticated) {
      setFlags({});
      setLoaded(true);
      return;
    }
    setLoaded(false);
    getFeatureFlags()
      .then((d) => setFlags(d.flags || {}))
      .catch(() => setFlags({})) // on error, fail open (everything enabled)
      .finally(() => setLoaded(true));
  }, [isAuthenticated]);

  useEffect(() => { reload(); }, [reload]);

  const isEnabled = useCallback((key?: string) => {
    if (!key) return true;
    return flags[key] !== false;
  }, [flags]);

  return (
    <FeatureFlagsContext.Provider value={{ flags, loaded, isEnabled, setFlags, reload }}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

export function useFeatureFlags() {
  const ctx = useContext(FeatureFlagsContext);
  if (!ctx) throw new Error('useFeatureFlags must be used within FeatureFlagsProvider');
  return ctx;
}
