import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { useAuth, type UserRole } from './AuthContext';
import { getFeatureToggles } from '@/services/api';

/**
 * Per-role feature map: { [featureKey]: { admin?: bool, qa_engineer?: bool, data_analyst?: bool } }
 *
 * Fail-open semantics (deliberately non-breaking):
 *   - a feature key that is absent  → ENABLED
 *   - a role flag that is absent    → ENABLED
 *   - toggles that fail to load     → everything ENABLED
 * So the app behaves exactly as before until an admin explicitly disables
 * something for a specific role.
 */
export type FeatureMap = Record<string, Partial<Record<UserRole, boolean>>>;

interface FeatureToggleContextType {
  /** the full per-role map (all roles) — used by the admin dashboard */
  features: FeatureMap;
  /** true once the initial fetch has completed (success or failure) */
  loaded: boolean;
  /** is a feature enabled for the CURRENT user's role? */
  isEnabled: (featureKey: string) => boolean;
  /** re-fetch from the server (call after saving in the dashboard) */
  refresh: () => Promise<void>;
}

const FeatureToggleContext = createContext<FeatureToggleContextType | null>(null);

export function FeatureToggleProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const [features, setFeatures] = useState<FeatureMap>({});
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!isAuthenticated) {
      setFeatures({});
      setLoaded(false);
      return;
    }
    try {
      const data = await getFeatureToggles();
      setFeatures((data?.features as FeatureMap) || {});
    } catch {
      // Fail open — never block the UI because toggles couldn't be fetched.
      setFeatures({});
    } finally {
      setLoaded(true);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    load();
  }, [load]);

  const role = (user?.role as UserRole) || 'admin';

  const isEnabled = useCallback(
    (featureKey: string): boolean => {
      const entry = features[featureKey];
      if (!entry) return true; // unknown/unset feature → enabled
      const flag = entry[role];
      return flag === undefined ? true : flag; // unset for this role → enabled
    },
    [features, role],
  );

  return (
    <FeatureToggleContext.Provider value={{ features, loaded, isEnabled, refresh: load }}>
      {children}
    </FeatureToggleContext.Provider>
  );
}

export function useFeatureToggles() {
  const ctx = useContext(FeatureToggleContext);
  if (!ctx) throw new Error('useFeatureToggles must be used within a FeatureToggleProvider');
  return ctx;
}

/** Convenience hook: is this single feature enabled for the current user? */
export function useFeature(featureKey: string): boolean {
  return useFeatureToggles().isEnabled(featureKey);
}
