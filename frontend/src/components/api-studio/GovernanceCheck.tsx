/**
 * GovernanceCheck — API design / governance linting.
 *
 * A Spectral-style lint that runs entirely client-side over the catalogue: it
 * never calls the network and changes nothing. It flags design smells (verbs in
 * paths, unversioned paths, writes with no auth, plain HTTP, …) so the surface
 * is clean before scenarios are designed.
 */
import { useMemo } from 'react';
import { X, ScrollText, AlertTriangle, Info, CircleAlert } from 'lucide-react';
import { MethodBadge } from './primitives';
import { CARD, STRIP, pathOf } from './format';
import type { CatalogEndpoint } from './types';

type Severity = 'error' | 'warn' | 'info';
interface LintFinding { rule: string; severity: Severity; message: string; endpointId?: string; endpointLabel?: string; method?: string }

const isWrite = (m: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((m || 'GET').toUpperCase());
const VERB_RE = /\/(get|create|update|delete|list|fetch|save|remove|add|edit|find)[A-Za-z]*/i;

function lint(endpoints: CatalogEndpoint[]): LintFinding[] {
  const out: LintFinding[] = [];
  const camel = /[a-z][A-Z]/;
  const snake = /_/;
  let sawCamel = false, sawSnake = false;

  for (const e of endpoints) {
    const path = pathOf(e.url);
    const label = e.title || `${e.method} ${path}`;
    const at = { endpointId: e.id, endpointLabel: label, method: e.method };

    if (/^http:\/\//i.test(e.url)) out.push({ rule: 'https-only', severity: 'warn', message: 'Served over plain HTTP — use HTTPS.', ...at });
    if (isWrite(e.method) && e.auth.type === 'none') out.push({ rule: 'write-needs-auth', severity: 'warn', message: `${e.method.toUpperCase()} endpoint has no authentication configured.`, ...at });
    if (!e.expectedStatus) out.push({ rule: 'expected-status', severity: 'info', message: 'No expected status declared — add one to make the contract explicit.', ...at });
    if (VERB_RE.test(path)) out.push({ rule: 'no-verbs-in-path', severity: 'info', message: 'Path contains a verb — REST paths should be nouns, with the HTTP method as the verb.', ...at });
    if (!/\/v\d+/i.test(path)) out.push({ rule: 'versioning', severity: 'info', message: 'Path has no version segment (e.g. /v1).', ...at });
    if (/[A-Z]/.test(path)) out.push({ rule: 'lowercase-path', severity: 'info', message: 'Path contains uppercase — prefer lower-case, hyphenated paths.', ...at });
    if (!e.title?.trim()) out.push({ rule: 'has-name', severity: 'info', message: 'Endpoint has no title/summary.', ...at });

    for (const q of e.queryParams || []) { if (camel.test(q.name)) sawCamel = true; if (snake.test(q.name)) sawSnake = true; }
  }
  if (sawCamel && sawSnake) out.push({ rule: 'consistent-casing', severity: 'info', message: 'Query parameters mix camelCase and snake_case across the API — pick one convention.' });
  return out;
}

const SEV_META: Record<Severity, { order: number; icon: React.ElementType; cls: string }> = {
  error: { order: 0, icon: CircleAlert, cls: 'text-red-700 bg-red-50 border-red-200' },
  warn: { order: 1, icon: AlertTriangle, cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  info: { order: 2, icon: Info, cls: 'text-blue-700 bg-blue-50 border-blue-200' },
};

export default function GovernanceCheck({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const findings = useMemo(() => lint(endpoints).sort((a, b) => SEV_META[a.severity].order - SEV_META[b.severity].order), [endpoints]);
  const counts = { error: findings.filter((f) => f.severity === 'error').length, warn: findings.filter((f) => f.severity === 'warn').length, info: findings.filter((f) => f.severity === 'info').length };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ScrollText className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">API governance</h3>
          <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} linted</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold ${counts.warn ? SEV_META.warn.cls : 'text-gray-400 bg-gray-50 border-gray-200'}`}>{counts.warn} Warnings</span>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold ${counts.info ? SEV_META.info.cls : 'text-gray-400 bg-gray-50 border-gray-200'}`}>{counts.info} Info</span>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {findings.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-[12px] text-gray-500">No governance issues found. 🎉</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {findings.map((f, i) => {
                const Icon = SEV_META[f.severity].icon;
                return (
                  <div key={i} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${f.severity === 'warn' ? 'text-amber-500' : f.severity === 'error' ? 'text-red-500' : 'text-blue-500'}`} />
                      <span className="text-[10px] font-mono font-semibold text-gray-500 flex-shrink-0">{f.rule}</span>
                      {f.method && <MethodBadge method={f.method} />}
                      {f.endpointLabel && <span className="text-[11.5px] text-gray-600 min-w-0 flex-1 truncate">{f.endpointLabel}</span>}
                    </div>
                    <p className="mt-1 ml-5 text-[11px] text-gray-600">{f.message}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
