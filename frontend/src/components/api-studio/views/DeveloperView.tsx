/**
 * DeveloperView — programmatic access.
 *
 * The RESTful public API (projects, plans, builds, sessions, runs, imports),
 * the CLI, and the connector manifest schema — with the caller's own token
 * and base URL substituted so every snippet is copy-paste ready.
 */
import { useMemo, useState } from 'react';
import { Terminal, Globe, Puzzle, KeyRound, Eye, EyeOff } from 'lucide-react';
import { CARD, BRAND_CHIP, MUTED_CHIP, SECONDARY_BTN, STRIP, INSET, CHIP_3D, methodColor } from '../format';
import { CodeBlock, CopyButton } from '../primitives';

const BASE = '/api/v1/public/api-automation';

const ROUTES: { method: string; path: string; what: string; body?: string }[] = [
  { method: 'GET', path: '/me', what: 'Who the token belongs to (tenant, role)' },
  { method: 'GET', path: '/projects', what: 'Projects — API run titles grouped, with run counts and last pass rate' },
  { method: 'GET', path: '/plans', what: 'Test plans — every API run with its scenario count. `?page=&pageSize=`' },
  { method: 'GET', path: '/plans/:id', what: 'One plan with every scenario and its request/expected response' },
  { method: 'GET', path: '/builds', what: 'Builds — executed runs with pass/fail/duration from the report' },
  { method: 'GET', path: '/builds/:id', what: 'One build: stats + per-scenario status' },
  { method: 'GET', path: '/builds/:id/sessions/:tc', what: 'One session — a single scenario\'s result, error and timing' },
  { method: 'POST', path: '/runs', what: 'Start a headless run: import → analyze → design → execute → heal → report. Returns 202 + jobId', body: '{ "endpoints": [...] | "source": {kind,...}, "environmentId"?, "coverage"?, "layers"?, "title"? }' },
  { method: 'GET', path: '/runs/:jobId', what: 'Poll the run job: status, progress, phases, result' },
  { method: 'POST', path: '/imports', what: 'Import without running. `kind`: text | url | curl | graphql | mcp | connector', body: '{ "kind": "url", "url": "https://api.acme.com/openapi.json" }' },
  { method: 'GET', path: '/imports', what: 'Import history' },
  { method: 'POST', path: '/analyze', what: 'Pattern intelligence for a set of endpoints', body: '{ "endpoints": [...] }' },
  { method: 'GET', path: '/environments', what: 'Environments (secrets masked)' },
];

export default function DeveloperView() {
  const [showToken, setShowToken] = useState(false);
  const token = useMemo(() => { try { return sessionStorage.getItem('intelliqe_token') || ''; } catch { return ''; } }, []);
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://intelliqe.example.com';
  const masked = token ? `${token.slice(0, 10)}…${token.slice(-4)}` : '(sign in to get a token)';

  const curlRun = `curl -s -X POST ${origin}${BASE}/runs \\
  -H "Authorization: Bearer $INTELLIQE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Orders API — nightly",
    "source": { "kind": "url", "url": "https://api.acme.com/openapi.json" },
    "coverage": "standard",
    "layers": ["smoke", "contract", "negative", "auth", "flow"]
  }'
# → { "data": { "jobId": "…", "pollUrl": "${BASE}/runs/…" } }

curl -s ${origin}${BASE}/runs/$JOB_ID -H "Authorization: Bearer $INTELLIQE_TOKEN"`;

  const cli = `# install (Node 18+, zero dependencies)
cd cli && npm link           # → intelliqe-api on your PATH

intelliqe-api login --url ${origin} --user <username>

intelliqe-api import openapi.yaml                     # OpenAPI / Swagger
intelliqe-api import orders.postman_collection.json   # Postman
intelliqe-api import api-docs.pdf                     # PDF / Word / Excel — AI-read
intelliqe-api import --url https://docs.acme.com/reference
intelliqe-api import --curl "curl https://api.acme.com/v1/orders"
intelliqe-api import --graphql https://api.acme.com/graphql --bearer $TOKEN
intelliqe-api import --mcp https://mcp.acme.com/mcp

intelliqe-api analyze endpoints.json                  # pattern intelligence
intelliqe-api run endpoints.json --env Staging --coverage standard --wait
intelliqe-api builds --limit 10
intelliqe-api build <runId>
intelliqe-api session <runId> TC-003

# CI (no config file): INTELLIQE_URL + INTELLIQE_TOKEN env vars
# exit codes: 0 ok · 1 error · 2 usage · 3 run had failures`;

  const manifest = `{
  "name": "Orders API",
  "baseUrl": "https://api.acme.com/v1",
  "auth": { "type": "bearer", "value": "{{token}}" },
  "headers": [{ "key": "Accept", "value": "application/json" }],
  "variables": { "token": "…" },
  "endpoints": [
    { "name": "List orders",  "method": "GET",  "path": "/orders?page=1" },
    { "name": "Create order", "method": "POST", "path": "/orders",
      "body": { "sku": "A1", "qty": 2 }, "expectedStatus": 201 },
    { "name": "Get order",    "method": "GET",  "path": "/orders/{id}" },
    { "name": "Delete order", "method": "DELETE", "path": "/orders/{id}", "expectedStatus": 204 }
  ]
}`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-6 py-5 space-y-4">
        <div>
          <h2 className="text-[14px] font-semibold text-gray-900">Developer access</h2>
          <p className="text-[11.5px] text-gray-500">Everything the workspace does is available over a RESTful API and a CLI — standard GET / POST / PUT / DELETE, JSON in, <code className="font-mono">{'{ data, meta }'}</code> out, Bearer auth.</p>
        </div>

        {/* Token */}
        <div className={`${CARD} p-4`}>
          <div className="flex items-center gap-2"><KeyRound className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Your token</h3><span className="text-[11px] text-gray-400">the same session token this browser uses</span></div>
          <div className="mt-2 flex items-center gap-2">
            <code className={`flex-1 min-w-0 font-mono text-[11.5px] text-gray-700 bg-[#FCFBFF] border border-[#E4E0F5] rounded-md px-2.5 py-1.5 truncate ${INSET}`}>{showToken ? token || masked : masked}</code>
            <button type="button" onClick={() => setShowToken((s) => !s)} className={SECONDARY_BTN}>{showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}{showToken ? 'Hide' : 'Reveal'}</button>
            <CopyButton text={token} label="Copy token" />
          </div>
          <p className="mt-2 text-[10.5px] text-gray-400">Base URL: <code className="font-mono">{origin}{BASE}</code> · header <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>. For CI, mint a token with <code className="font-mono">POST /api/auth/login</code>.</p>
        </div>

        {/* REST */}
        <div className={`${CARD} overflow-hidden`}>
          <div className={`flex items-center gap-2 px-4 h-11 border-b border-[#EDE9FE] ${STRIP}`}><Globe className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">REST API</h3><span className={`inline-flex px-1.5 py-0.5 rounded border text-[9.5px] font-semibold ${BRAND_CHIP}`}>v1</span></div>
          <table className="w-full text-[12px]">
            <tbody>
              {ROUTES.map((r) => (
                <tr key={r.method + r.path} className="border-b border-gray-50 last:border-b-0 align-top">
                  <td className="px-4 py-2 w-[70px]"><span className={`inline-flex px-1.5 py-0.5 rounded border font-mono text-[10px] font-bold ${CHIP_3D} ${methodColor(r.method)}`}>{r.method}</span></td>
                  <td className="px-2 py-2 w-[280px] font-mono text-[11.5px] text-gray-800">{BASE.replace('/api/v1/public', '…')}{r.path}</td>
                  <td className="px-2 py-2 text-gray-600">{r.what}{r.body && <pre className="mt-1 font-mono text-[10.5px] text-gray-500 whitespace-pre-wrap">{r.body}</pre>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-3 border-t border-[#EDE9FE]">
            <div className="flex items-center gap-2 mb-1.5"><span className="text-[11px] font-semibold text-gray-700">Start a run from anywhere</span><CopyButton text={curlRun} className="ml-auto" /></div>
            <CodeBlock code={curlRun} className={`bg-[#FCFBFF] border border-[#E4E0F5] rounded-md p-3 ${INSET}`} />
          </div>
        </div>

        {/* CLI */}
        <div className={`${CARD} overflow-hidden`}>
          <div className={`flex items-center gap-2 px-4 h-11 border-b border-[#EDE9FE] ${STRIP}`}><Terminal className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Command line</h3><span className={`inline-flex px-1.5 py-0.5 rounded border text-[9.5px] font-mono ${MUTED_CHIP}`}>cli/intelliqe-api.mjs</span><CopyButton text={cli} className="ml-auto" /></div>
          <CodeBlock code={cli} className="p-4" />
        </div>

        {/* Connector manifest */}
        <div className={`${CARD} overflow-hidden`}>
          <div className={`flex items-center gap-2 px-4 h-11 border-b border-[#EDE9FE] ${STRIP}`}><Puzzle className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Custom connector manifest</h3><span className="text-[11px] text-gray-400">keep it next to the code; import it with the Connector method, the CLI or POST /imports</span><CopyButton text={manifest} className="ml-auto" /></div>
          <CodeBlock code={manifest} className="p-4" />
        </div>
      </div>
    </div>
  );
}
