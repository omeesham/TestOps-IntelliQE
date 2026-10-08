/**
 * CiPipeline — first-party GitHub Action / CI.
 *
 * Lets an admin enable CI for the tenant, mint a capability token, and copy a
 * ready-to-use pipeline snippet (GitHub Actions, GitLab CI or Jenkins) that
 * POSTs the selected catalogue endpoints to IntelliQE, polls the run to
 * completion, and gates the build on the reported pass rate. The token is the
 * only secret the pipeline needs; the generated YAML references it as a CI
 * secret and never inlines the real value. Opt-in and standalone — it changes
 * nothing in the catalogue or the pipeline run itself.
 */
import { useEffect, useMemo, useState } from 'react';
import { GitBranch, X, RefreshCw, Download, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { getCiConfig, rotateCiToken, setCiEnabled, type CiConfigView } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import { CopyButton, CodeBlock, Section } from './primitives';
import { downloadText } from './generators';
import type { CatalogEndpoint } from './types';

/* The GitHub Actions secret reference, kept as a plain (non-template) string so
 * the literal `${{ secrets.INTELLIQE_CI_TOKEN }}` survives into the output YAML
 * instead of being read as a JS interpolation. */
const SECRET_REF = '${{ secrets.INTELLIQE_CI_TOKEN }}';

/** Wrap a value as a POSIX-sh single-quoted literal, escaping embedded quotes. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Build the three CI snippets from the current selection and settings. */
function buildSnippets(endpoints: CatalogEndpoint[], server: string, failUnder: number) {
  const srv = (server || '').trim().replace(/\/+$/, '') || 'https://your-intelliqe-host';
  const payload = {
    title: 'CI run',
    coverage: 'standard',
    execute: true,
    endpoints: endpoints.map((e) => ({
      title: e.title,
      method: e.method,
      url: e.url,
      headers: e.headers,
      auth: e.auth,
      body: e.body,
      expectedStatus: e.expectedStatus,
    })),
  };
  const shBody = shQuote(JSON.stringify(payload));

  const github = `# .github/workflows/intelliqe.yml
# Store the IntelliQE CI token as an Actions secret named INTELLIQE_CI_TOKEN.
# ubuntu-latest already provides curl + jq.
name: IntelliQE API tests

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  intelliqe:
    runs-on: ubuntu-latest
    env:
      SERVER: "${srv}"
      FAIL_UNDER: "${failUnder}"
      INTELLIQE_CI_TOKEN: ${SECRET_REF}
    steps:
      - name: Run IntelliQE and gate on pass rate
        run: |
          set -eu
          BODY=${shBody}
          echo "Triggering IntelliQE run on $SERVER"
          JOB=$(curl -sS -X POST "$SERVER/api/ci/$INTELLIQE_CI_TOKEN/runs" -H 'content-type: application/json' -d "$BODY" | jq -r '.jobId')
          if [ -z "$JOB" ] || [ "$JOB" = "null" ]; then echo "No jobId returned"; exit 1; fi
          echo "Started job $JOB"
          STATUS=""
          while [ "$STATUS" != "completed" ] && [ "$STATUS" != "failed" ]; do
            sleep 5
            RES=$(curl -sS "$SERVER/api/ci/$INTELLIQE_CI_TOKEN/runs/$JOB")
            STATUS=$(echo "$RES" | jq -r '.status')
            echo "  status: $STATUS"
          done
          RATE=$(echo "$RES" | jq -r '.stats.passRate // 0')
          echo "Pass rate: $RATE% (gate: >= $FAIL_UNDER%)"
          awk "BEGIN { exit !($RATE >= $FAIL_UNDER) }"
`;

  const gitlab = `# .gitlab-ci.yml
# Add INTELLIQE_CI_TOKEN as a masked CI/CD variable (Settings -> CI/CD -> Variables).
# The image must provide curl + jq.
intelliqe-api-tests:
  stage: test
  image: badouralix/curl-jq
  variables:
    SERVER: "${srv}"
    FAIL_UNDER: "${failUnder}"
  script:
    - |
      set -eu
      BODY=${shBody}
      JOB=$(curl -sS -X POST "$SERVER/api/ci/$INTELLIQE_CI_TOKEN/runs" -H 'content-type: application/json' -d "$BODY" | jq -r '.jobId')
      if [ -z "$JOB" ] || [ "$JOB" = "null" ]; then echo "No jobId returned"; exit 1; fi
      echo "Started job $JOB"
      STATUS=""
      while [ "$STATUS" != "completed" ] && [ "$STATUS" != "failed" ]; do
        sleep 5
        RES=$(curl -sS "$SERVER/api/ci/$INTELLIQE_CI_TOKEN/runs/$JOB")
        STATUS=$(echo "$RES" | jq -r '.status')
        echo "  status: $STATUS"
      done
      RATE=$(echo "$RES" | jq -r '.stats.passRate // 0')
      echo "Pass rate: $RATE% (gate: >= $FAIL_UNDER%)"
      awk "BEGIN { exit !($RATE >= $FAIL_UNDER) }"
`;

  const jenkins = `// Jenkinsfile (declarative) — add a 'Secret text' credential with ID intelliqe-ci-token.
// The agent must provide curl + jq.
pipeline {
  agent any
  environment {
    SERVER = "${srv}"
    FAIL_UNDER = "${failUnder}"
    INTELLIQE_CI_TOKEN = credentials('intelliqe-ci-token')
  }
  stages {
    stage('IntelliQE API tests') {
      steps {
        sh '''
          set -eu
          BODY=${shBody}
          JOB=$(curl -sS -X POST "$SERVER/api/ci/$INTELLIQE_CI_TOKEN/runs" -H 'content-type: application/json' -d "$BODY" | jq -r '.jobId')
          if [ -z "$JOB" ] || [ "$JOB" = "null" ]; then echo "No jobId returned"; exit 1; fi
          echo "Started job $JOB"
          STATUS=""
          while [ "$STATUS" != "completed" ] && [ "$STATUS" != "failed" ]; do
            sleep 5
            RES=$(curl -sS "$SERVER/api/ci/$INTELLIQE_CI_TOKEN/runs/$JOB")
            STATUS=$(echo "$RES" | jq -r '.status')
            echo "  status: $STATUS"
          done
          RATE=$(echo "$RES" | jq -r '.stats.passRate // 0')
          echo "Pass rate: $RATE% (gate: >= $FAIL_UNDER%)"
          awk "BEGIN { exit !($RATE >= $FAIL_UNDER) }"
        '''
      }
    }
  }
}
`;

  return { github, gitlab, jenkins };
}

export default function CiPipeline({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [config, setConfig] = useState<CiConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [mintedToken, setMintedToken] = useState('');
  const [server, setServer] = useState(() => (typeof window !== 'undefined' ? window.location.origin : 'https://your-intelliqe-host'));
  const [failUnder, setFailUnder] = useState(80);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await getCiConfig();
        if (alive) setConfig(c);
      } catch (e: any) {
        if (alive) setError(e?.response?.data?.error || e?.message || 'Request failed.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const toggleEnabled = async (next: boolean) => {
    setTogglingEnabled(true); setError('');
    try {
      const updated = await setCiEnabled(next);
      setConfig(updated);
      toast.success(next ? 'CI enabled' : 'CI disabled');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally {
      setTogglingEnabled(false);
    }
  };

  const rotate = async () => {
    setRotating(true); setError('');
    try {
      const { token } = await rotateCiToken();
      setMintedToken(token);
      toast.success('CI token generated', 'Copy it now — it is shown only once.');
      try { setConfig(await getCiConfig()); } catch { /* keep the prior masked view */ }
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally {
      setRotating(false);
    }
  };

  const snippets = useMemo(() => buildSnippets(endpoints, server, failUnder), [endpoints, server, failUnder]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <GitBranch className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">GitHub Action / CI</h3>
          <span className="text-[11px] text-gray-400">trigger a run from your pipeline and gate on pass rate</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-[#7C3AED]"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              {/* Enable + token status */}
              {config && (
                <div className="rounded-lg border border-[#E9E5FB] bg-[#FBFAFF] px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={config.enabled}
                      disabled={togglingEnabled}
                      onClick={() => void toggleEnabled(!config.enabled)}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${config.enabled ? 'bg-[#7C3AED]' : 'bg-gray-300'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${config.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                    <span className="text-[12.5px] font-semibold text-gray-800">CI {config.enabled ? 'enabled' : 'disabled'}</span>
                    {togglingEnabled && <Spinner className="w-3.5 h-3.5 animate-spin text-gray-400" />}
                    <span className="ml-auto text-[11px] text-gray-500">
                      Token: {config.hasToken ? <code className="font-mono text-[#6D28D9]">{config.tokenMasked}</code> : 'none yet'}
                    </span>
                  </div>
                  <p className="text-[10.5px] text-gray-400 font-mono break-all">POST {config.triggerPath}</p>
                </div>
              )}

              {/* Mint / rotate token */}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void rotate()} disabled={rotating} className={PRIMARY_BTN}>
                  {rotating ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {config?.hasToken ? 'Rotate token' : 'Generate token'}
                </button>
                {config?.hasToken && !mintedToken && <span className="text-[11px] text-gray-400">rotating invalidates the current token</span>}
              </div>

              {mintedToken && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" />
                    <p className="text-[11.5px] text-amber-700 min-w-0">Copy it now — it won&apos;t be shown again. Store it as a CI secret named <code className="font-mono font-semibold">INTELLIQE_CI_TOKEN</code>.</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-white border border-[#DDD6FE] rounded px-2 py-1.5">{mintedToken}</code>
                    <CopyButton text={mintedToken} />
                  </div>
                </div>
              )}

              {/* Settings */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className={LABEL}>Server URL</label>
                  <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://intelliqe.example.com" className={`${INPUT} font-mono text-[11.5px]`} />
                </div>
                <div>
                  <label className={LABEL}>Fail under (%)</label>
                  <input type="number" min={0} max={100} value={failUnder} onChange={(e) => setFailUnder(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className={INPUT} />
                </div>
              </div>

              {endpoints.length === 0 && (
                <p className="text-[11px] text-amber-600">No endpoints in the catalogue — the snippets will post an empty selection until you import some.</p>
              )}

              {/* GitHub Actions workflow */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className={`${LABEL} mb-0`}>GitHub Actions — .github/workflows/intelliqe.yml</label>
                  <div className="ml-auto flex items-center gap-1.5">
                    <CopyButton text={snippets.github} />
                    <button type="button" onClick={() => downloadText('intelliqe.yml', snippets.github, 'text/yaml')} className={SECONDARY_BTN}>
                      <Download className="w-3.5 h-3.5" />Download
                    </button>
                  </div>
                </div>
                <CodeBlock code={snippets.github} className="max-h-80 p-3 bg-[#FBFAFF] border border-[#E9E5FB] rounded-lg" />
              </div>

              {/* Other providers */}
              <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                <Section title="GitLab CI (.gitlab-ci.yml)" defaultOpen={false} action={<CopyButton text={snippets.gitlab} />}>
                  <CodeBlock code={snippets.gitlab} className="max-h-72 p-3 bg-[#FBFAFF] border border-[#E9E5FB] rounded-lg" />
                </Section>
                <Section title="Jenkins (Jenkinsfile)" defaultOpen={false} action={<CopyButton text={snippets.jenkins} />}>
                  <CodeBlock code={snippets.jenkins} className="max-h-72 p-3 bg-[#FBFAFF] border border-[#E9E5FB] rounded-lg" />
                </Section>
              </div>

              <p className="text-[10.5px] text-gray-400">The token is the capability: anyone who has it can trigger runs for this tenant. Rotate it if it leaks.</p>

              {error && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
