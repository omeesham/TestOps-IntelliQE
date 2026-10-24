/** Shared helpers for the regression suite. */
import { expect, request as pwRequest, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

export const API_URL = process.env.REG_API_URL || 'http://localhost:3001';
export const USER = process.env.REG_USER || '';
export const PASSWORD = process.env.REG_PASSWORD || '';
/** Set when running against the older build the approved results were recorded from. */
export const BASELINE = process.env.REG_BASELINE === '1';

export function requireCredentials(): void {
  if (!USER || !PASSWORD) throw new Error('Set REG_USER and REG_PASSWORD (an admin account of this build).');
}

/** API client signed in as the regression admin. */
export async function apiAsAdmin(): Promise<APIRequestContext> {
  const anon = await pwRequest.newContext({ baseURL: API_URL });
  const res = await anon.post('/api/auth/login', { data: { username: USER, password: PASSWORD } });
  expect(res.status(), 'admin sign-in').toBe(200);
  const { token } = await res.json();
  await anon.dispose();
  return pwRequest.newContext({ baseURL: API_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

/**
 * Starts every page of `context` signed in as the regression admin (the UI keeps
 * the session in sessionStorage), so journeys do not repeat the sign-in form.
 */
export async function startSignedIn(context: BrowserContext): Promise<void> {
  const anon = await pwRequest.newContext({ baseURL: API_URL });
  const res = await anon.post('/api/auth/login', { data: { username: USER, password: PASSWORD } });
  expect(res.status(), 'admin sign-in').toBe(200);
  const { token, user } = await res.json();
  await anon.dispose();
  await context.addInitScript(([t, u]) => {
    sessionStorage.setItem('intelliqe_token', t);
    sessionStorage.setItem('intelliqe_user', u);
  }, [token, JSON.stringify(user)]);
}

/**
 * Collects browser errors and failed API calls (5xx) on a page, so a journey
 * fails when something breaks behind the screen. `ignore` lists known issues.
 */
export function watchForErrors(page: Page, ignore: RegExp[] = []): () => string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500 && r.url().includes('/api/') && !ignore.some((p) => p.test(r.url()))) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return () => errors.splice(0);
}

/** Signs in through the UI and waits for Chat. */
export async function signIn(page: Page, username = USER, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type="text"], input[name="username"]').first().fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/chat/, { timeout: 20_000 });
}

/**
 * Shape of a JSON value: field names and types, not the data. Arrays are
 * described by their first item, so the shape does not depend on row counts.
 */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (typeof value !== 'object') return typeof value;
  if (depth >= 3) return 'object';
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) out[key] = shapeOf((value as Record<string, unknown>)[key], depth + 1);
  return out;
}

/** Field paths present in `approved` but missing (or of another type) in `actual`. */
export function missingFields(approved: unknown, actual: unknown, path = ''): string[] {
  if (approved === 'null' || actual === 'null') return [];
  if (Array.isArray(approved)) {
    if (!approved.length) return [];
    if (!Array.isArray(actual)) return [`${path || '(root)'}: expected an array`];
    return actual.length ? missingFields(approved[0], actual[0], `${path}[]`) : [];
  }
  if (approved && typeof approved === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return [`${path || '(root)'}: expected an object`];
    return Object.keys(approved).flatMap((k) =>
      k in (actual as object)
        ? missingFields((approved as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], path ? `${path}.${k}` : k)
        : [`${path ? `${path}.` : ''}${k}: missing`]);
  }
  return approved === actual ? [] : [`${path || '(root)'}: was ${String(approved)}, now ${String(actual)}`];
}
