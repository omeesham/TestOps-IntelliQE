/**
 * BugReport — turn a single API failure into a tracker-ready report.
 *
 * The engineer describes the failure (the request, what was expected, what came
 * back); the service writes a Markdown report, a Jira-shaped payload and a
 * GitHub-shaped payload, picks a severity and labels, and — when it can — adds
 * an AI root-cause diagnosis. Everything is copyable so it drops straight into a
 * tracker. Standalone; nothing here files the issue for you.
 */
import { useState } from 'react';
import { Bug, X, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN } from './format';
import { MethodBadge, CopyButton } from './primitives';
import type { CatalogEndpoint } from './types';
import { buildBugReport, type BugReport as BugReportResult } from '@/services/api';

const TAB_ACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-[#6D28D9] border-b-2 border-[#7C3AED]';
const TAB_INACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-gray-500 hover:text-gray-700';

const CHIP = 'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

type Tab = 'markdown' | 'jira' | 'github';

/** Map a severity into the app's standard chip tone. */
function severityTone(sev: string): string {
  switch ((sev || '').toLowerCase()) {
    case 'critical': return 'text-red-700 bg-red-50 border-red-200';
    case 'high': return 'text-amber-700 bg-amber-50 border-amber-200';
    case 'medium': return 'text-blue-700 bg-blue-50 border-blue-200';
    default: return 'text-gray-600 bg-gray-50 border-gray-200';
  }
}

export default function BugReport({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [method, setMethod] = useState(() => endpoints[0]?.method || 'GET');
  const [url, setUrl] = useState(() => endpoints[0]?.url || '');
  const [expectedStatus, setExpectedStatus] = useState('');
  const [responseStatus, setResponseStatus] = useState('');
  const [environment, setEnvironment] = useState('');
  const [assertion, setAssertion] = useState('');
  const [requestBody, setRequestBody] = useState('');
  const [responseBody, setResponseBody] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BugReportResult | null>(null);
  const [tab, setTab] = useState<Tab>('markdown');

  const generate = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      const res = await buildBugReport({
        title: title || undefined,
        method,
        url,
        error: assertion || undefined,
        expectedStatus: expectedStatus ? Number(expectedStatus) : undefined,
        responseStatus: responseStatus ? Number(responseStatus) : undefined,
        environment: environment || undefined,
        requestBody: requestBody || undefined,
        responseBody: responseBody || undefined,
      });
      setResult(res);
      setTab('markdown');
      toast.success('Report generated');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not generate the report.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Bug className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Bug report</h3>
          <span className="text-[11px] text-gray-400">A tracker-ready report from a failure</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
              <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* Failure description */}
          <div className="space-y-3">
            <div>
              <label className={LABEL}>Title (optional)</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary of the failure" className={INPUT} />
            </div>

            <div className="flex items-center gap-2">
              <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${FIELD} w-24`}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input value={url} onChange={(e) => setUrl(e.target.value)} list="bug-urls" placeholder="https://api.example.com/path" className={INPUT} />
            </div>
            <datalist id="bug-urls">
              {endpoints.map((e) => <option key={e.id} value={e.url} />)}
            </datalist>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={LABEL}>Expected status</label>
                <input type="number" value={expectedStatus} onChange={(e) => setExpectedStatus(e.target.value)} placeholder="200" className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>Response status</label>
                <input type="number" value={responseStatus} onChange={(e) => setResponseStatus(e.target.value)} placeholder="500" className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>Environment</label>
                <input value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="staging" className={INPUT} />
              </div>
            </div>

            <div>
              <label className={LABEL}>Error / assertion</label>
              <textarea value={assertion} onChange={(e) => setAssertion(e.target.value)} placeholder="The error or failed assertion" className={`${INPUT} min-h-[52px] resize-y`} />
            </div>
            <div>
              <label className={LABEL}>Request body</label>
              <textarea value={requestBody} onChange={(e) => setRequestBody(e.target.value)} placeholder="{ … }" className={`${INPUT} min-h-[64px] resize-y font-mono text-[11.5px]`} />
            </div>
            <div>
              <label className={LABEL}>Response body</label>
              <textarea value={responseBody} onChange={(e) => setResponseBody(e.target.value)} placeholder="{ … }" className={`${INPUT} min-h-[64px] resize-y font-mono text-[11.5px]`} />
            </div>

            <div className="flex justify-end">
              <button type="button" onClick={() => void generate()} disabled={loading || !url.trim()} className={PRIMARY_BTN}>
                {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Bug className="w-3.5 h-3.5" />}Generate report
              </button>
            </div>
          </div>

          {/* Result */}
          {result && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`${CHIP} ${severityTone(result.severity)}`}>{result.severity}</span>
                <MethodBadge method={method} />
                <span className="text-[13px] font-semibold text-gray-900 min-w-0 flex-1 truncate">{result.title}</span>
              </div>

              {result.labels.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {result.labels.map((l) => (
                    <span key={l} className={`${CHIP} text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]`}>{l}</span>
                  ))}
                </div>
              )}

              {result.diagnosis && (
                <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">AI root cause</span>
                    <span className={`${CHIP} text-blue-700 bg-blue-50 border-blue-200`}>{result.diagnosis.category}</span>
                    <span className={`${CHIP} text-gray-600 bg-gray-50 border-gray-200`}>{result.diagnosis.confidence} confidence</span>
                  </div>
                  <p className="text-[12px] text-gray-700"><span className="font-medium text-gray-800">Root cause: </span>{result.diagnosis.rootCause}</p>
                  <p className="text-[12px] text-gray-700"><span className="font-medium text-gray-800">Suggested fix: </span>{result.diagnosis.suggestedFix}</p>
                </div>
              )}

              {/* Tabs */}
              <div className="flex items-center gap-1 border-b border-[#EDE9FE]">
                <button type="button" onClick={() => setTab('markdown')} className={tab === 'markdown' ? TAB_ACTIVE : TAB_INACTIVE}>Markdown</button>
                <button type="button" onClick={() => setTab('jira')} className={tab === 'jira' ? TAB_ACTIVE : TAB_INACTIVE}>Jira</button>
                <button type="button" onClick={() => setTab('github')} className={tab === 'github' ? TAB_ACTIVE : TAB_INACTIVE}>GitHub</button>
              </div>

              {tab === 'markdown' && (
                <div className="space-y-2">
                  <div className="flex justify-end"><CopyButton text={result.markdown} label="Copy Markdown" /></div>
                  <pre className="font-mono text-[11px] leading-[1.6] text-gray-800 bg-[#FAF9FE] border border-[#E4E0F5] rounded-lg p-3 whitespace-pre-wrap break-words max-h-80 overflow-auto">{result.markdown}</pre>
                </div>
              )}

              {tab === 'jira' && (
                <div className="space-y-2">
                  <div className="flex justify-end"><CopyButton text={JSON.stringify(result.jira, null, 2)} label="Copy JSON" /></div>
                  <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-1.5 text-[12px] text-gray-700">
                    <div><span className="font-medium text-gray-800">Summary: </span>{result.jira.summary}</div>
                    <div><span className="font-medium text-gray-800">Issue type: </span>{result.jira.issuetype}</div>
                    <div><span className="font-medium text-gray-800">Priority: </span>{result.jira.priority}</div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-gray-800">Labels:</span>
                      {result.jira.labels.map((l) => <span key={l} className={`${CHIP} text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]`}>{l}</span>)}
                    </div>
                  </div>
                </div>
              )}

              {tab === 'github' && (
                <div className="space-y-2">
                  <div className="flex justify-end"><CopyButton text={JSON.stringify(result.github, null, 2)} label="Copy JSON" /></div>
                  <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-1.5 text-[12px] text-gray-700">
                    <div><span className="font-medium text-gray-800">Title: </span>{result.github.title}</div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-gray-800">Labels:</span>
                      {result.github.labels.map((l) => <span key={l} className={`${CHIP} text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]`}>{l}</span>)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
