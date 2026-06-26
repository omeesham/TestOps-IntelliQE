/**
 * mobile-context.ts
 * ─────────────────
 * Shared helpers that make the existing test-generation agents mobile-aware
 * WITHOUT changing their behavior for web/API. Each agent appends
 * `mobileContextNote(state.appContext)` to its Claude prompt; for non-mobile
 * contexts that returns an empty string, so web prompts are byte-identical.
 */
import type { AppContext } from './state.js';

export function isMobileContext(ctx?: AppContext | null): boolean {
  return ctx?.platform === 'android' || ctx?.platform === 'ios';
}

/** Human label for the platform. */
export function mobilePlatformLabel(ctx?: AppContext | null): string {
  return ctx?.platform === 'ios' ? 'iOS' : ctx?.platform === 'android' ? 'Android' : '';
}

/**
 * A prompt fragment describing the native app under test and steering test
 * generation toward mobile concerns. Returns '' for web/API.
 */
export function mobileContextNote(ctx?: AppContext | null): string {
  if (!isMobileContext(ctx)) return '';
  const platform = mobilePlatformLabel(ctx);
  const m = ctx!.appMetadata || {};
  const idPart = ctx!.platform === 'ios'
    ? (m.bundleId ? `bundle id "${m.bundleId}"` : 'bundle id unknown')
    : (m.packageName ? `package "${m.packageName}"` : 'package unknown');

  const lines: string[] = [
    '',
    `MOBILE APP UNDER TEST — generate NATIVE ${platform} mobile test cases (NOT web).`,
    `App: ${m.fileName || ctx!.appName || 'mobile build'} (${idPart}${m.versionName ? `, version ${m.versionName}` : ''}).`,
    `Cover mobile-specific concerns: tap / long-press / double-tap / swipe / scroll / pinch gestures; screen-to-screen navigation and the Android hardware/system back button; app cold start and launch; foreground/background lifecycle (backgrounding, resuming, process death & restore); runtime permission dialogs (grant/deny); system & push notifications; deep links; interruptions (incoming call, alarm); network loss & recovery and offline behavior; screen rotation/orientation; small-screen and accessibility (TalkBack / VoiceOver).`,
    `Use MOBILE verbs in titles and steps — "Tap", "Swipe", "Scroll to", "Launch the app", "Grant permission", "Rotate to landscape" — NOT web verbs like "Click" or "Navigate to URL".`,
  ];
  if (Array.isArray(m.permissions) && m.permissions.length) {
    lines.push(`Declared permissions to exercise with permission tests: ${m.permissions.slice(0, 20).join(', ')}.`);
  }
  if (m.mainActivity) lines.push(`Android launcher activity: ${m.mainActivity}.`);
  return lines.join('\n');
}
