import type { ReactNode } from 'react';
import { useFeature } from '@/contexts/FeatureToggleContext';

/**
 * Conditionally render children based on a feature toggle for the current role.
 * Renders `fallback` (default: nothing) when the feature is disabled.
 *
 * Usage:
 *   <FeatureGate feature="bug-tracker"><DeleteButton /></FeatureGate>
 */
export default function FeatureGate({
  feature,
  children,
  fallback = null,
}: {
  feature: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const enabled = useFeature(feature);
  return <>{enabled ? children : fallback}</>;
}
