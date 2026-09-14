/**
 * api-auth.ts
 * ───────────
 * Normalisation for the credential configured on an API endpoint.
 *
 * The auth value reaches us from two places that both hand over more than a
 * bare token: the chat "API Configuration" form (users paste a whole header
 * line) and the LLM spec parser (which happily lifts an entire header block out
 * of a document). A value such as
 *
 *     "Authorization: Bearer {{valid_token}}\nContent-Type: application/json"
 *
 * was previously used verbatim, so every generated request carried
 * `Authorization: Bearer Authorization: Bearer {{valid_token}} …` — a header
 * with a duplicated scheme and an embedded newline. These helpers reduce such a
 * value to the credential itself and recognise the placeholders that must never
 * be sent as if they were real.
 */

/** Placeholder shapes that are template text, not a credential. */
const PLACEHOLDER_RE =
  /^(\{\{.*\}\}|<[^>]*>|\$\{.*\}|your[_\s-]?(api[_\s-]?key|token|secret)|api[_\s-]?key|access[_\s-]?token|valid[_\s-]?token|token|secret|x{3,}|\.{3,})$/i;

/**
 * Reduce a configured auth value to the bare credential:
 * first line only, without a pasted header name or a leading scheme.
 */
export function cleanAuthValue(raw: string | undefined | null): string {
  if (!raw) return '';
  // HTTP header values are single-line — a pasted block contributes only its
  // first meaningful line; the rest belongs in the Headers section, not here.
  let v = raw.split(/[\r\n]+/).map((s) => s.trim()).find(Boolean) || '';
  // Drop a pasted header NAME ("Authorization: …", "X-API-Key: …").
  v = v.replace(/^(authorization|x-api-key|api-key|x-auth-token)\s*:\s*/i, '');
  // Drop a scheme the caller already typed so it is never doubled up.
  v = v.replace(/^(bearer|basic|token)\s+/i, '');
  return v.trim();
}

/** True when the (cleaned) value is template text rather than a real secret. */
export function isPlaceholderSecret(value: string | undefined | null): boolean {
  const v = (value || '').trim();
  if (!v) return true;
  return PLACEHOLDER_RE.test(v);
}
