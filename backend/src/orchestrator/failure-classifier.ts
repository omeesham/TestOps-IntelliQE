export type FailureClass =
  | 'selector_not_found'
  | 'selector_ambiguous'
  | 'assertion_mismatch'
  | 'typescript_compile'
  | 'missing_test_cases'
  | 'missing_selectors'
  | 'network_api_error'
  | 'auth_failure'
  | 'timeout'
  | 'unknown';

export interface ClassifiedFailure {
  failureClass: FailureClass;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  upstreamBlame: string | null;
}

const PATTERNS: Array<{
  pattern: RegExp;
  failureClass: FailureClass;
  upstream: string | null;
  confidence: 'high' | 'medium' | 'low';
}> = [
  { pattern: /strict mode violation.*resolved to (\d+) elements/i, failureClass: 'selector_ambiguous', upstream: 'planning', confidence: 'high' },
  { pattern: /waiting for (locator|selector).*to be visible/i, failureClass: 'selector_not_found', upstream: 'planning', confidence: 'high' },
  { pattern: /locator.*resolved to 0 elements/i, failureClass: 'selector_not_found', upstream: 'planning', confidence: 'high' },
  { pattern: /No element matches selector/i, failureClass: 'selector_not_found', upstream: 'planning', confidence: 'high' },
  { pattern: /TS\d{4}:/i, failureClass: 'typescript_compile', upstream: null, confidence: 'high' },
  { pattern: /error TS/i, failureClass: 'typescript_compile', upstream: null, confidence: 'high' },
  { pattern: /expect\(received\)\.to(Equal|Be|Contain|Have)/i, failureClass: 'assertion_mismatch', upstream: null, confidence: 'medium' },
  { pattern: /Expected.*Received/i, failureClass: 'assertion_mismatch', upstream: null, confidence: 'medium' },
  { pattern: /net::ERR_/i, failureClass: 'network_api_error', upstream: null, confidence: 'high' },
  { pattern: /status (?:4\d{2}|5\d{2})/i, failureClass: 'network_api_error', upstream: null, confidence: 'medium' },
  { pattern: /ECONNREFUSED/i, failureClass: 'network_api_error', upstream: null, confidence: 'high' },
  { pattern: /login|sign.?in|sso|unauthorized|403/i, failureClass: 'auth_failure', upstream: null, confidence: 'medium' },
  { pattern: /timeout.*exceeded/i, failureClass: 'timeout', upstream: null, confidence: 'high' },
  { pattern: /test.*timed out/i, failureClass: 'timeout', upstream: null, confidence: 'high' },
];

export function classifyFailure(resultData: Record<string, unknown>): ClassifiedFailure {
  const searchText = extractSearchableText(resultData);
  for (const { pattern, failureClass, upstream, confidence } of PATTERNS) {
    const match = searchText.match(pattern);
    if (match) {
      return { failureClass, confidence, evidence: match[0].slice(0, 200), upstreamBlame: upstream };
    }
  }
  return { failureClass: 'unknown', confidence: 'low', evidence: searchText.slice(0, 200), upstreamBlame: null };
}

function extractSearchableText(data: Record<string, unknown>): string {
  const parts: string[] = [];
  function collect(obj: unknown, depth: number) {
    if (depth > 5) return;
    if (typeof obj === 'string') { parts.push(obj); return; }
    if (Array.isArray(obj)) { obj.forEach(v => collect(v, depth + 1)); return; }
    if (obj && typeof obj === 'object') {
      Object.values(obj as Record<string, unknown>).forEach(v => collect(v, depth + 1));
    }
  }
  collect(data, 0);
  return parts.join('\n').slice(0, 10_000);
}
