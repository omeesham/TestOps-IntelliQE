/**
 * postman-env.ts
 * ──────────────
 * Parse a Postman environment export (`*.postman_environment.json`) and merge its
 * variables with a collection's own `variable[]` so they can be mapped into an
 * IntelliQE environment.
 *
 * Postman has two variable scopes an export can carry:
 *   - COLLECTION variables — embedded in the collection JSON (`doc.variable[]`).
 *   - ENVIRONMENT variables — a separate export (`{ name, values: [...] }`).
 * At runtime Postman resolves environment over collection, so we apply the same
 * precedence here. Provenance (`source`) is preserved so the import preview can
 * show where each value came from. Pure and dependency-free.
 */

export interface MergedVariable {
  key: string;
  value: string;
  secret: boolean;
  /** Where the value won: the environment export, or the collection itself. */
  source: 'environment' | 'collection';
  /** True when the same key existed in both scopes (environment value kept). */
  conflict?: boolean;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Key names (or Postman `type: 'secret'`) that mark a value as a secret. */
const SECRET_KEY_RE = /(pass(word)?|secret|token|api[_-]?key|apikey|auth|credential|private[_-]?key|client[_-]?secret|access[_-]?key|bearer|session)/i;

/** True when a Postman variable should be stored as a secret. */
export function isSecretVariable(key: string, type?: unknown): boolean {
  if (String(type || '').toLowerCase() === 'secret') return true;
  return SECRET_KEY_RE.test(String(key || ''));
}

/** A collection's own `variable[]` → the shape we map from (enabled only). */
export function collectionVariables(doc: any): { key: string; value: string; secret: boolean }[] {
  const out: { key: string; value: string; secret: boolean }[] = [];
  const list = isObj(doc) && Array.isArray(doc.variable) ? doc.variable : [];
  for (const v of list) {
    if (!isObj(v) || !v.key) continue;
    if (v.disabled === true) continue;
    const key = String(v.key).trim();
    if (!key) continue;
    out.push({ key, value: String(v.value ?? ''), secret: isSecretVariable(key, v.type) });
  }
  return out;
}

/**
 * Parse a Postman environment export. Returns its name and enabled variables.
 * Throws a clear error when the document is not a Postman environment export.
 */
export function parsePostmanEnvironment(doc: any): { name: string; variables: { key: string; value: string; secret: boolean }[] } {
  if (!isObj(doc) || !Array.isArray(doc.values)) {
    throw new Error('This is not a Postman environment export. Export it from Postman via Environments → … → Export.');
  }
  const name = String(doc.name || 'Imported environment').trim().slice(0, 120) || 'Imported environment';
  const variables: { key: string; value: string; secret: boolean }[] = [];
  const seen = new Set<string>();
  for (const v of doc.values) {
    if (!isObj(v) || !v.key) continue;
    if (v.enabled === false) continue; // disabled variable — excluded
    const key = String(v.key).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    variables.push({ key, value: String(v.value ?? ''), secret: isSecretVariable(key, v.type) });
  }
  return { name, variables };
}

/**
 * Merge collection + environment variables with environment precedence.
 * A key present in both is reported as a `conflict` (environment value kept).
 */
export function mergePostmanVariables(
  collectionVars: { key: string; value: string; secret: boolean }[],
  envVars: { key: string; value: string; secret: boolean }[] = [],
): MergedVariable[] {
  const byKey = new Map<string, MergedVariable>();
  for (const v of collectionVars) {
    byKey.set(v.key, { key: v.key, value: v.value, secret: v.secret, source: 'collection' });
  }
  for (const v of envVars) {
    const existing = byKey.get(v.key);
    byKey.set(v.key, {
      key: v.key,
      value: v.value,
      // A key that was secret in either scope stays secret.
      secret: v.secret || !!existing?.secret,
      source: 'environment',
      conflict: !!existing,
    });
  }
  return [...byKey.values()];
}
