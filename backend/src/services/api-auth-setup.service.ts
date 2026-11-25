/**
 * api-auth-setup.service.ts
 * ─────────────────────────
 * Suite-level auth/login chaining. The auto-generated per-endpoint suite injects
 * auth only from a static value (an endpoint's `auth.value`, or the environment's
 * `token`/`jwt`/… variable). For a password-login API (POST /auth/login → token)
 * there is no static token, so every authenticated endpoint is sent with no
 * Authorization header → 401.
 *
 * This runs the environment's configured login request ONCE before a run, extracts
 * the token (JSONPath), and injects it as the environment variable the generator
 * already falls back to — so the existing render path picks it up unchanged.
 *
 * Secrets are never persisted in the auth setup: the login request references them
 * as `{{var}}` and they resolve from the environment's encrypted variables here.
 */
import {
  getEnvironment, environmentVarMap, fillTemplate,
  type ApiEnvironment,
} from './api-environments.service.js';
import { applyGlobals } from './api-global-variables.service.js';
import { buildRequestInit, fetchFull, type HttpEndpoint } from '../utils/api-http.js';
import { queryPath } from '../utils/assert-engine.js';

export interface MintResult { token?: string; varName?: string; diagnostic?: string }

/** Minted tokens are reused briefly so one run's design/render/execute passes
 *  don't each re-login. Keyed by env id + a signature of the setup, so editing
 *  the login config busts the entry. */
const cache = new Map<string, { at: number; token: string }>();
const TTL_MS = Number(process.env.API_AUTH_SETUP_TTL_MS) || 300_000;

/** Run the environment's login request and return the extracted token (or a
 *  diagnostic). No-op (empty result) when there is no enabled auth setup. */
export async function mintAuthToken(env: ApiEnvironment | null | undefined): Promise<MintResult> {
  const setup = env?.authSetup;
  if (!env || !setup || !setup.enabled) return {};
  const varName = (setup.varName || 'token').trim() || 'token';
  const sig = `${env.id}:${JSON.stringify(setup)}`;
  const hit = cache.get(sig);
  if (hit && Date.now() - hit.at < TTL_MS) return { token: hit.token, varName };

  try {
    const vars = environmentVarMap(env);
    const ep: HttpEndpoint = {
      method: setup.request.method || 'POST',
      url: fillTemplate(setup.request.url, vars) || setup.request.url,
      headers: (setup.request.headers || []).map((h) => ({ key: h.key, value: fillTemplate(h.value, vars) || '' })),
      body: fillTemplate(setup.request.body, vars),
      auth: setup.request.auth
        ? { ...setup.request.auth, value: fillTemplate(setup.request.auth.value, vars) }
        : undefined,
    };
    if (!/^https?:\/\//i.test(ep.url)) return { diagnostic: 'Auth setup: the login URL did not resolve to an absolute http(s) URL.' };

    const { url, init } = buildRequestInit(ep);
    const res = await fetchFull(url, init, 20_000);
    if (res.error) return { diagnostic: `Auth setup: login request failed — ${res.error}` };
    if (!res.ok) return { diagnostic: `Auth setup: login returned HTTP ${res.status} — check the credentials and URL.` };

    let parsed: unknown;
    try { parsed = JSON.parse(res.bodyText); } catch { return { diagnostic: 'Auth setup: the login response was not JSON — cannot extract a token.' }; }
    const token = queryPath(parsed, setup.tokenPath).values.find((v) => typeof v === 'string' && v) as string | undefined;
    if (!token) return { diagnostic: `Auth setup: no token found at "${setup.tokenPath}" in the login response.` };

    cache.set(sig, { at: Date.now(), token });
    return { token, varName };
  } catch (e) {
    return { diagnostic: `Auth setup: ${(e as Error).message || String(e)}` };
  }
}

/** Return the environment with the minted token added as a variable, so the
 *  generator's env-token fallback resolves it. No-op without a token. */
export function injectAuthToken<E extends ApiEnvironment>(env: E | null, mint: MintResult): E | null {
  if (!env || !mint.token || !mint.varName) return env;
  const variables = [
    ...env.variables.filter((v) => v.key !== mint.varName),
    { key: mint.varName, value: mint.token, secret: false },
  ];
  return { ...env, variables };
}

/** Reveal an environment for a run and inject its minted auth token. Combines the
 *  reveal + mint + inject every run entry point needs. Returns the (possibly
 *  null) environment plus any mint diagnostic to surface. */
export async function revealEnvForRun(
  tenantId: string,
  envId: string | null | undefined,
): Promise<{ env: ApiEnvironment | null; diagnostic?: string }> {
  if (!envId) return { env: null };
  const env0 = await getEnvironment(tenantId, envId, { reveal: true });
  if (!env0) return { env: null };
  // Widen with workspace globals (env vars win) before minting, so the login
  // request and the run both see {{globals}}.
  const env = await applyGlobals(tenantId, env0);
  const mint = await mintAuthToken(env);
  return { env: injectAuthToken(env, mint), diagnostic: mint.diagnostic };
}
