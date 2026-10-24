/**
 * app-environments
 * ────────────────
 * One application under test can have several environments (QA, UAT,
 * Staging…), each with its own URL and test users.
 *
 * Stored in the Application Setup config (client_configurations.config_data):
 *
 *   {
 *     appName, environments: [{ id, name, baseUrl, roles[] }],
 *     // Mirror of the first environment, kept for older readers:
 *     baseUrl, environment, roles
 *   }
 *
 * Apps saved before environments existed have only the top-level fields; they
 * read as a single environment with id 'default', so no migration is needed.
 */
import { decryptStoredDeep } from '../utils/crypto.js';
import { parseSafety, type SafetySettings } from './uat-safety.service.js';

export interface AppRole { roleName: string; username: string; password: string }

export interface AppEnvironment {
  id: string;
  /** Display name, e.g. "QA", "UAT". */
  name: string;
  baseUrl: string;
  /** Passwords as stored (encrypted); see decryptRoles. */
  roles: AppRole[];
  /** Read-only protection for a shared environment; undefined when off. */
  safety?: SafetySettings;
}

function cleanRoles(v: unknown): AppRole[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({ roleName: String(r.roleName || 'user'), username: String(r.username || ''), password: String(r.password || '') }));
}

/** Every environment of an app, apps saved before environments included. */
export function appEnvironments(configData: Record<string, unknown> | null | undefined): AppEnvironment[] {
  const d = configData || {};
  if (Array.isArray(d.environments) && d.environments.length > 0) {
    return d.environments
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e, i) => ({
        id: String(e.id || `env-${i + 1}`),
        name: String(e.name || `Environment ${i + 1}`),
        baseUrl: String(e.baseUrl || '').trim(),
        roles: cleanRoles(e.roles),
        safety: parseSafety(e.safety),
      }));
  }
  return [{
    id: 'default',
    name: String(d.environment || 'Default'),
    baseUrl: String(d.baseUrl || '').trim(),
    roles: cleanRoles(d.roles),
    safety: parseSafety(d.safety),
  }];
}

/**
 * The environment to use: the requested one, else the first with a URL.
 * Returns undefined when `envId` is given but unknown (never silently swaps to
 * a different environment), or when no environment has a URL.
 */
export function pickEnvironment(configData: Record<string, unknown> | null | undefined, envId?: string): AppEnvironment | undefined {
  const envs = appEnvironments(configData);
  if (envId) {
    const e = envs.find((x) => x.id === envId);
    return e && e.baseUrl ? e : undefined;
  }
  return envs.find((x) => x.baseUrl);
}

/** Roles with passwords decrypted, for the agents only. Never send these to the browser. */
export function decryptRoles(roles: AppRole[]): AppRole[] {
  return roles.map((r) => ({ ...r, password: r.password ? decryptStoredDeep(r.password) : '' }));
}

/**
 * The read-only environment, across a tenant's applications, whose URL has the
 * same origin as `url`. Used so a typed URL cannot bypass an environment's
 * read-only setting.
 */
export function readOnlyEnvironmentForUrl(
  configs: { configData?: Record<string, unknown> | null }[],
  url: string | undefined,
): AppEnvironment | undefined {
  let origin: string;
  try { origin = new URL(String(url || '')).origin; } catch { return undefined; }
  for (const c of configs) {
    for (const e of appEnvironments(c.configData)) {
      if (!e.safety?.readOnly || !e.baseUrl) continue;
      try { if (new URL(e.baseUrl).origin === origin) return e; } catch { /* skip bad URL */ }
    }
  }
  return undefined;
}
