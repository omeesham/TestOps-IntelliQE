/**
 * apiFailure — turn a raw execution error into a plain-language explanation.
 *
 * The runner reports real Playwright / Node errors: a request-context failure
 * ("apiRequestContext.get: getaddrinfo ENOTFOUND …"), a JSON parse error, a
 * socket errno, a TLS complaint. Those are the truth, but they read like a
 * stack trace, which makes a genuinely-executed run look broken or fake.
 *
 * This maps the ones a tester can act on to a short sentence that says what
 * happened and where to fix it — "the API is unreachable" or "your collection
 * is misconfigured" — while keeping the real technical text as a secondary
 * `detail` so nothing is hidden. A genuine assertion failure (expected 200,
 * got 404) is already meaningful, so it passes through unchanged as the
 * message.
 *
 * This is a DISPLAY concern only: the raw error is what the healer, the Allure
 * report and the notifications keep working from. Feed it the stored raw error,
 * once, at render time — never re-feed a message it produced.
 */

export interface ApiFailure {
  /** The clear, human-facing headline. */
  message: string;
  /** The real underlying error, kept for anyone who needs the specifics. */
  detail?: string;
}

/** First non-empty line of the raw error, trimmed for use as a compact detail. */
function firstLine(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) || raw.trim();
  return line.length > 220 ? `${line.slice(0, 220)}…` : line;
}

/**
 * Classify a raw runner error. Order matters: the most specific / most
 * actionable signatures are matched first. Anything unrecognised is treated as
 * a real test failure and returned verbatim.
 */
export function humanizeApiFailure(raw?: string | null): ApiFailure {
  const text = (raw || '').trim();
  if (!text) return { message: 'The test failed, but the runner returned no error message.' };

  const t = text.toLowerCase();
  const clear = (message: string): ApiFailure => ({ message, detail: firstLine(text) });

  /* ── The API could not be reached — an environment/infra problem ──────── */
  if (/enotfound|getaddrinfo|eai_again/.test(t))
    return clear('This API host could not be found — the URL may be wrong or the service is offline. Check the endpoint in your collection.');
  if (/econnrefused/.test(t))
    return clear('The API refused the connection — nothing is listening at that host and port. Check the endpoint (and that the service is running) in your collection.');
  if (/econnreset|socket hang up|\bepipe\b/.test(t))
    return clear('The connection to the API dropped mid-request. It may be down or rejecting requests.');
  if (/etimedout|timed out|exceeded.*\bms\b|\bms\b.*exceeded/.test(t))
    return clear('The API did not respond in time. It may be slow, overloaded, or unreachable.');
  if (/self[- ]signed|unable to verify|\bcert(ificate)?\b|\bssl\b|\btls\b|cert_/.test(t))
    return clear('The API’s HTTPS certificate could not be verified. Check http vs https and the environment in your collection.');

  /* ── The collection / request itself is misconfigured ─────────────────── */
  if (/api\.example\.com/.test(t))
    return clear('This endpoint still points at the placeholder host api.example.com. Set the real URL in your collection.');
  if (/invalid url|invalid uri|err_invalid_url|navigate to invalid/.test(t))
    return clear('The endpoint URL is not valid. Fix it in your collection.');
  if (/is not valid json|unexpected token.*json|unexpected end of json|json\.parse|not valid json/.test(t))
    return clear('The API returned a non-JSON response where JSON was expected. Check the endpoint or the expected content type in your collection.');

  /* ── The generated script could not run at all ────────────────────────── */
  if (/cannot find module|failed to load|0 runnable tests|no tests found|transform error|syntaxerror|ts\(\d+\)/.test(t))
    return clear('This test script could not be compiled or loaded. Re-generate the scenarios for this case, then run again.');

  /* ── A real assertion failure: already meaningful, keep it verbatim. ──── */
  return { message: text };
}

/** Convenience: just the headline, for one-line banners, toasts and logs. */
export function apiFailureMessage(raw?: string | null): string {
  return humanizeApiFailure(raw).message;
}
