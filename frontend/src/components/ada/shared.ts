/**
 * Constants and helpers shared by the ADA Compliance page, its drawers and the
 * report: severity styling, button styles, schedule time helpers.
 */
import type { AdaSchedule, AdaSeverity } from '@/services/api';

export const SEVERITIES: AdaSeverity[] = ['critical', 'serious', 'moderate', 'minor'];
export const SEV_LABEL: Record<AdaSeverity, string> = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };
export const SEV_STYLE: Record<AdaSeverity, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  serious: 'bg-orange-100 text-orange-700 border-orange-200',
  moderate: 'bg-amber-100 text-amber-700 border-amber-200',
  minor: 'bg-gray-100 text-gray-600 border-gray-200',
};
export const SEV_DOT: Record<AdaSeverity, string> = {
  critical: 'bg-red-500', serious: 'bg-orange-500', moderate: 'bg-amber-400', minor: 'bg-gray-400',
};
export const SEV_HEX: Record<AdaSeverity, string> = {
  critical: '#EF4444', serious: '#F97316', moderate: '#FBBF24', minor: '#9CA3AF',
};

export const inputCls = 'w-full px-3.5 py-2.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all';
export const primaryBtn = 'px-4 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg flex items-center justify-center gap-2 shadow-md shadow-purple-500/20';
export const ghostBtn = 'px-4 py-2 bg-white border border-gray-200 hover:border-violet-300 text-gray-700 text-sm font-medium rounded-lg flex items-center justify-center gap-2 disabled:opacity-50';

export function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | undefined;
  return e?.response?.data?.error || e?.message || fallback;
}
export function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | undefined)?.response?.status;
}

export function scoreHex(score: number | null | undefined): string {
  if (score == null) return '#D1D5DB';
  return score >= 90 ? '#059669' : score >= 80 ? '#16a34a' : score >= 70 ? '#d97706' : score >= 60 ? '#ea580c' : '#dc2626';
}

/* ── schedule time helpers ── */

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function hourLabel(h: number): string {
  return new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The user picks a local hour (and weekday); the server stores the UTC equivalent. */
export function toUtcSlot(localHour: number, localWeekday: number | null): { runHourUtc: number; runWeekday: number | null } {
  const d = new Date();
  d.setHours(localHour, 0, 0, 0);
  if (localWeekday !== null) d.setDate(d.getDate() + ((localWeekday - d.getDay() + 7) % 7));
  return { runHourUtc: d.getUTCHours(), runWeekday: localWeekday === null ? null : d.getUTCDay() };
}

/** Describe a stored UTC slot in the viewer's local time. */
export function describeSlot(s: AdaSchedule): string {
  const d = new Date();
  d.setUTCHours(s.run_hour_utc, 0, 0, 0);
  if (s.frequency === 'weekly' && s.run_weekday !== null) d.setUTCDate(d.getUTCDate() + ((s.run_weekday - d.getUTCDay() + 7) % 7));
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return s.frequency === 'weekly' ? `Every ${WEEKDAYS[d.getDay()]} at ${time}` : `Every day at ${time}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}
