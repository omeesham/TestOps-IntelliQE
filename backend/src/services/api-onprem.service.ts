/**
 * api-onprem.service.ts
 * ─────────────────────
 * On-prem / air-gapped packaging + data-residency posture.
 *
 * Two jobs for an enterprise deal:
 *   1. Emit the deployment artifacts to run IntelliQE inside the customer's
 *      own boundary — Docker Compose, a Kubernetes/Helm values snippet, and an
 *      air-gapped .env that pins a self-hosted LLM and turns off all egress.
 *   2. Assess the endpoint catalogue against a data-residency policy: which
 *      target hosts sit outside the allowed regions, and (in air-gapped mode)
 *      which hosts would breach the no-egress boundary.
 *
 * Standalone and opt-in: pure analysis + string templating, no IO. Region
 * inference is an honest heuristic over the host (TLD + cloud-region hints) —
 * it flags what to verify, it does not geolocate.
 */
export interface OnPremEndpoint { method: string; url: string }

export type DeployMode = 'docker' | 'kubernetes' | 'airgapped';
export interface DeployArtifact { path: string; language: string; content: string }

export interface RegionInfo { id: string; label: string }
/** The residency regions an operator can pin to. */
const REGIONS: RegionInfo[] = [
  { id: 'eu', label: 'European Union (GDPR)' },
  { id: 'us', label: 'United States' },
  { id: 'uk', label: 'United Kingdom' },
  { id: 'apac', label: 'Asia-Pacific' },
  { id: 'canada', label: 'Canada' },
  { id: 'anz', label: 'Australia / New Zealand' },
  { id: 'onprem', label: 'On-prem / private network' },
];

export function listResidencyRegions(): RegionInfo[] { return REGIONS.map((r) => ({ ...r })); }

function host(u: string): string { try { return new URL(u).host.toLowerCase(); } catch { return ''; } }
function isPrivateHost(h: string): boolean {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /\.(local|internal|corp|lan|intranet)$/.test(h) || !h.includes('.');
}

/** Best-effort region guess from a host. Returns null when there is no signal. */
function regionOf(h: string): string | null {
  if (!h) return null;
  if (isPrivateHost(h)) return 'onprem';
  // Explicit cloud region tokens, e.g. eu-west-1, us-east1, ap-south-1, uksouth.
  if (/\b(eu|europe)[-.]?(west|central|north|south)?\b|eu-\w+-?\d|europe-\w+/.test(h)) return 'eu';
  if (/\b(uk|london)\b|uksouth|ukwest/.test(h)) return 'uk';
  if (/\b(us|usa)[-.]?(east|west|central)?\b|us-\w+-?\d|(east|west)us\d?|northcentralus|southcentralus/.test(h)) return 'us';
  if (/\b(ap|asia|apac)[-.]?(south|east|northeast|southeast)?\b|ap-\w+-?\d|asia-\w+|southeastasia|eastasia/.test(h)) return 'apac';
  if (/\bca(nada)?[-.]?(central|east)?\b|canadacentral|canadaeast/.test(h)) return 'canada';
  if (/\b(au|australia|anz|sydney)\b|australia\w*|ap-southeast-2/.test(h)) return 'anz';
  // Country-code TLD fallback.
  const tld = h.split('.').pop() || '';
  const byTld: Record<string, string> = { eu: 'eu', de: 'eu', fr: 'eu', nl: 'eu', es: 'eu', it: 'eu', ie: 'eu', uk: 'uk', us: 'us', ca: 'canada', au: 'anz', nz: 'anz', in: 'apac', sg: 'apac', jp: 'apac', hk: 'apac' };
  return byTld[tld] || null;
}

export interface ResidencyFinding {
  host: string;
  endpoints: number;
  region: string | null;
  regionLabel: string;
  status: 'allowed' | 'disallowed' | 'egress' | 'unknown';
  note: string;
}
export interface ResidencyReport {
  mode: DeployMode;
  allowedRegions: string[];
  findings: ResidencyFinding[];
  summary: { allowed: number; disallowed: number; egress: number; unknown: number };
  compliant: boolean;
}

export function assessResidency(eps: OnPremEndpoint[], allowedRegions: string[], mode: DeployMode): ResidencyReport {
  const allow = new Set((allowedRegions || []).filter(Boolean));
  const byHost = new Map<string, number>();
  for (const e of eps || []) {
    const h = host(e.url);
    if (!h) continue;
    byHost.set(h, (byHost.get(h) || 0) + 1);
  }
  const findings: ResidencyFinding[] = [];
  for (const [h, count] of byHost) {
    const region = regionOf(h);
    const label = REGIONS.find((r) => r.id === region)?.label || 'Unknown';
    const privateHost = isPrivateHost(h);
    let status: ResidencyFinding['status'];
    let note: string;
    if (mode === 'airgapped' && !privateHost) {
      status = 'egress';
      note = 'External host — unreachable from an air-gapped deployment. Mirror it internally or exclude it.';
    } else if (region == null) {
      status = 'unknown';
      note = 'Region could not be inferred from the host — confirm where this service runs.';
    } else if (allow.size === 0 || allow.has(region)) {
      status = 'allowed';
      note = `Resolves to ${label}, within the allowed regions.`;
    } else {
      status = 'disallowed';
      note = `Resolves to ${label}, outside the allowed regions — data would leave the residency boundary.`;
    }
    findings.push({ host: h, endpoints: count, region, regionLabel: label, status, note });
  }
  findings.sort((a, b) => (a.status === b.status ? b.endpoints - a.endpoints : a.status.localeCompare(b.status)));
  const summary = { allowed: 0, disallowed: 0, egress: 0, unknown: 0 };
  for (const f of findings) summary[f.status]++;
  return { mode, allowedRegions: [...allow], findings, summary, compliant: summary.disallowed === 0 && summary.egress === 0 };
}

export interface DeployPlanInput {
  mode?: DeployMode;
  allowedRegions?: string[];
  endpoints?: OnPremEndpoint[];
  /** Self-hosted / private LLM base URL for air-gapped mode. */
  llmBaseUrl?: string;
  /** Pin container image tags for a reproducible, offline bundle. */
  imageTag?: string;
}
export interface DeployPlan {
  mode: DeployMode;
  artifacts: DeployArtifact[];
  residency: ResidencyReport;
  checklist: string[];
}

function composeYaml(airgapped: boolean, tag: string, llmBaseUrl: string): string {
  return `# IntelliQE — self-hosted deployment (generated)
# docker compose up -d
version: "3.9"
services:
  db:
    image: mcr.microsoft.com/mssql/server:2022-latest
    environment:
      ACCEPT_EULA: "Y"
      MSSQL_SA_PASSWORD: "\${DB_PASSWORD:?set a strong SA password}"
    volumes: [ "intelliqe-db:/var/opt/mssql" ]
    ports: [ "1433:1433" ]
  backend:
    image: intelliqe/backend:${tag}
    depends_on: [ db ]
    env_file: [ .env.onprem ]
    ports: [ "3001:3001" ]
    restart: unless-stopped
  worker:
    image: intelliqe/backend:${tag}
    command: [ "node", "dist/worker/index.js" ]
    depends_on: [ backend ]
    env_file: [ .env.onprem ]
    restart: unless-stopped
  frontend:
    image: intelliqe/frontend:${tag}
    depends_on: [ backend ]
    ports: [ "8080:80" ]
    restart: unless-stopped
volumes:
  intelliqe-db:
${airgapped ? `
# Air-gapped: no service may reach the public internet. Pull every image into
# your private registry first, then retag to that registry before deploying.
# The only outbound call the platform makes is to the LLM at:
#   ${llmBaseUrl || 'http://your-private-llm:8000/v1'}
# which must live inside this network.
networks:
  default:
    internal: true
` : ''}`;
}

function envTemplate(airgapped: boolean, llmBaseUrl: string): string {
  return `# IntelliQE backend env — self-hosted (generated). Fill the secrets, keep out of git.
NODE_ENV=production
PORT=3001
DB_HOST=db
DB_PORT=1433
DB_NAME=JBSTestOpsAI
DB_USER=sa
DB_PASSWORD=change-me
DB_BOOTSTRAP=true
WORKER_SECRET=change-me-long-random
BACKEND_URL=http://backend:3001
# ── LLM provider ──
${airgapped
  ? `# Air-gapped: point at a self-hosted, OpenAI-compatible model inside the network.
LLM_PROVIDER=custom
LLM_BASE_URL=${llmBaseUrl || 'http://your-private-llm:8000/v1'}
LLM_API_KEY=local
# No public Anthropic/OpenAI/Gemini calls are made in this mode.`
  : `ANTHROPIC_API_KEY=sk-ant-...`}
# ── Egress / telemetry ──
INTELLIQE_TELEMETRY=off
${airgapped ? 'INTELLIQE_EGRESS=deny      # block all outbound except LLM_BASE_URL' : 'INTELLIQE_EGRESS=allow'}
`;
}

function helmValues(tag: string, airgapped: boolean, regions: string[]): string {
  return `# IntelliQE Helm values (generated) — helm install intelliqe ./chart -f values.onprem.yaml
image:
  repository: your-registry.internal/intelliqe
  tag: "${tag}"
  pullPolicy: IfNotPresent
dataResidency:
  allowedRegions: [${regions.map((r) => `"${r}"`).join(', ') || '"onprem"'}]
  pinNodeSelector: true        # schedule only onto nodes labelled with an allowed region
egress:
  mode: ${airgapped ? '"deny"' : '"allow"'}
  networkPolicy: ${airgapped}  # NetworkPolicy denying all egress except the LLM service
llm:
  mode: ${airgapped ? '"self-hosted"' : '"api"'}
  baseUrl: ${airgapped ? '"http://intelliqe-llm:8000/v1"' : '""'}
persistence:
  enabled: true
  storageClass: ""             # pin to a storageClass in the allowed region
`;
}

function residencyPolicyJson(report: ResidencyReport): string {
  return JSON.stringify({
    version: 1,
    generatedBy: 'IntelliQE',
    mode: report.mode,
    allowedRegions: report.allowedRegions,
    enforcement: report.mode === 'airgapped' ? 'deny-egress' : 'warn-on-disallowed',
    hosts: report.findings.map((f) => ({ host: f.host, region: f.region, status: f.status })),
  }, null, 2);
}

export function planDeployment(input: DeployPlanInput): DeployPlan {
  const mode: DeployMode = (['docker', 'kubernetes', 'airgapped'] as const).includes(input.mode as DeployMode) ? input.mode as DeployMode : 'docker';
  const tag = String(input.imageTag || 'latest').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'latest';
  const llmBaseUrl = String(input.llmBaseUrl || '').trim().slice(0, 300);
  const airgapped = mode === 'airgapped';
  const allowedRegions = (input.allowedRegions || []).filter((r) => REGIONS.some((x) => x.id === r));
  const residency = assessResidency(input.endpoints || [], airgapped ? [...new Set([...allowedRegions, 'onprem'])] : allowedRegions, mode);

  const artifacts: DeployArtifact[] = [];
  if (mode === 'kubernetes') {
    artifacts.push({ path: 'values.onprem.yaml', language: 'yaml', content: helmValues(tag, airgapped, allowedRegions) });
    artifacts.push({ path: '.env.onprem', language: 'ini', content: envTemplate(false, llmBaseUrl) });
  } else {
    artifacts.push({ path: 'docker-compose.onprem.yml', language: 'yaml', content: composeYaml(airgapped, tag, llmBaseUrl) });
    artifacts.push({ path: '.env.onprem', language: 'ini', content: envTemplate(airgapped, llmBaseUrl) });
  }
  artifacts.push({ path: 'data-residency.policy.json', language: 'json', content: residencyPolicyJson(residency) });

  const checklist: string[] = [
    'Run the schema bootstrap once (DB_BOOTSTRAP=true), then set it back to false.',
    'Rotate WORKER_SECRET and the DB password to long random values before go-live.',
  ];
  if (airgapped) {
    checklist.unshift('Mirror every container image into your private registry and retag before deploying.');
    checklist.push('Stand up the self-hosted LLM inside the network and set LLM_BASE_URL to it.');
    checklist.push('Apply a NetworkPolicy / firewall that denies all egress except the LLM service.');
  }
  if (residency.summary.disallowed > 0) checklist.push(`Resolve ${residency.summary.disallowed} host(s) that sit outside the allowed regions.`);
  if (residency.summary.egress > 0) checklist.push(`${residency.summary.egress} external host(s) are unreachable air-gapped — mirror or exclude them.`);
  if (residency.summary.unknown > 0) checklist.push(`Confirm the region of ${residency.summary.unknown} host(s) that could not be inferred.`);

  return { mode, artifacts, residency, checklist };
}
