/**
 * EndpointsView — the catalogue.
 *
 * Left: every endpoint the imports produced, grouped by resource, filterable,
 * selectable, editable. Right: what the platform understood about them and
 * the strategy that will steer generation. The one call to action is
 * "Design scenarios", which starts the run for the selected endpoints.
 */
import { useMemo, useState } from 'react';
import { Search, Trash2, Pencil, Layers, Plus, Download, ChevronDown, ChevronRight, Globe, ShieldCheck, Gauge, ShieldAlert, ScrollText, Target, Wrench, GitCompare, Table2, Clock, Wand2, GitPullRequestArrow, Radio, BadgeCheck, Bug, Antenna, Activity, ServerCog, Radar, Sparkles, Webhook, Workflow, MessageSquare, Bot, Database, Cpu, Server, Network, Globe2, MessagesSquare, Chrome, Boxes, Handshake, Zap, KeyRound, Rss, Spline, Microscope, Cloud, Lock, GitMerge, ClipboardCheck, FolderGit2, BrainCircuit, FileText, ListFilter, GitCompareArrows, HeartPulse, Image as ImageIcon, Combine, GitBranchPlus, Rocket, ListChecks, MonitorSmartphone, ClipboardList, Waypoints, Share2, Stamp, FileCheck2 } from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import { MethodBadge, StatusCode, EmptyState } from '../primitives';
import { PRIMARY_BTN, SECONDARY_BTN, INPUT, FIELD, CARD, BRAND_CHIP, MUTED_CHIP, STRIP, THEAD, IMPORT_METHOD_LABELS, pathOf, hostOf } from '../format';
import EndpointEditor from '../EndpointEditor';
import ContractCheck from '../ContractCheck';
import LoadTest from '../LoadTest';
import LoadProfile from '../LoadProfile';
import SecurityScan from '../SecurityScan';
import OwaspCompliance from '../OwaspCompliance';
import FuzzTest from '../FuzzTest';
import GovernanceCheck from '../GovernanceCheck';
import Coverage from '../Coverage';
import BaselineDiff from '../BaselineDiff';
import DataDriven from '../DataDriven';
import RunAutomation from '../RunAutomation';
import NlAuthor from '../NlAuthor';
import ContractDrift from '../ContractDrift';
import AsyncProbe from '../AsyncProbe';
import TrafficCapture from '../TrafficCapture';
import MockServer from '../MockServer';
import CoverageGaps from '../CoverageGaps';
import SemanticAssert from '../SemanticAssert';
import CallbackVerify from '../CallbackVerify';
import FlowBuilder from '../FlowBuilder';
import ChatToTest from '../ChatToTest';
import AutoMaintenance from '../AutoMaintenance';
import SyntheticData from '../SyntheticData';
import LlmProviders from '../LlmProviders';
import McpServer from '../McpServer';
import EventGrpc from '../EventGrpc';
import GeoLoad from '../GeoLoad';
import Collaboration from '../Collaboration';
import ExtensionRecorder from '../ExtensionRecorder';
import VirtualService from '../VirtualService';
import PactBroker from '../PactBroker';
import ChaosTest from '../ChaosTest';
import OAuthSecrets from '../OAuthSecrets';
import DbValidate from '../DbValidate';
import AsyncApiContract from '../AsyncApiContract';
import TraceCorrelation from '../TraceCorrelation';
import TestIntel from '../TestIntel';
import CloudLoad from '../CloudLoad';
import AccessControl from '../AccessControl';
import RemediationPr from '../RemediationPr';
import CompliancePacks from '../CompliancePacks';
import GitSync from '../GitSync';
// ─── Atto coworker lifecycle tools (all additive, opt-in) ───
import AiCoworker from '../AiCoworker';
import StoryGen from '../StoryGen';
import Multimodal from '../Multimodal';
import SuiteOptimizer from '../SuiteOptimizer';
import ImpactAnalysis from '../ImpactAnalysis';
import SemanticHeal from '../SemanticHeal';
import BugReport from '../BugReport';
import Monitoring from '../Monitoring';
import DataProfiles from '../DataProfiles';
// ─── Execution/CI batch (all additive, opt-in) ───
import HybridTest from '../HybridTest';
import ReleaseGate from '../ReleaseGate';
import CiPipeline from '../CiPipeline';
import ExecQueue from '../ExecQueue';
import CloudLab from '../CloudLab';
import TestManagement from '../TestManagement';
import Traceability from '../Traceability';
import TmConnectors from '../TmConnectors';
import AuditLog from '../AuditLog';
import Approvals from '../Approvals';
import EvidenceExport from '../EvidenceExport';
import { toConnectorManifest, toOpenApi, toMockServer, toPactContract, downloadText } from '../generators';
import InsightsPanel from './InsightsPanel';
import StrategyBar from './StrategyBar';
import type { Catalog } from '../hooks/useCatalog';
import type { CatalogEndpoint, Scenario, StrategyLayerId } from '../types';

/**
 * The right-hand "Intelligence & strategy" panels are hidden for API automation
 * for now. None of these hides disturbs the run:
 *  - SHOW_STRATEGY_BAR — useCatalog seeds `strategy` with DEFAULT_STRATEGY
 *    (standard coverage, all layers), which still steers every run.
 *  - SHOW_INSIGHTS_PANEL — the pattern analysis (`profile`) is still computed
 *    automatically in useCatalog and still passed into generation; only its
 *    on-screen display (and the optional "Deep analysis" button) is hidden.
 *  - SHOW_IMPORTS — the import log (`catalog.imports`) is still tracked; only
 *    the "Imports this session" card is hidden.
 * The whole aside is skipped when all three are off, so the endpoints table
 * takes the full width. Flip any flag to `true` to restore that panel.
 */
const SHOW_STRATEGY_BAR = false;
const SHOW_INSIGHTS_PANEL = false;
const SHOW_IMPORTS = false;
const SHOW_ASIDE = SHOW_STRATEGY_BAR || SHOW_INSIGHTS_PANEL || SHOW_IMPORTS;

interface Props {
  catalog: Catalog;
  running: boolean;
  onDesign: () => void;
  onImport: () => void;
  /** The current run's designed scenarios — read-only, for coverage. */
  scenarios?: Scenario[];
}

export default function EndpointsView({ catalog, running, onDesign, onImport, scenarios = [] }: Props) {
  const { endpoints, selected, profile } = catalog;
  const toast = useToast();
  const [q, setQ] = useState('');
  const [methodFilter, setMethodFilter] = useState('all');
  const [resourceFocus, setResourceFocus] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<CatalogEndpoint | null>(null);
  const [contractOpen, setContractOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [loadProfileOpen, setLoadProfileOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [owaspOpen, setOwaspOpen] = useState(false);
  const [fuzzOpen, setFuzzOpen] = useState(false);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [dataDrivenOpen, setDataDrivenOpen] = useState(false);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [nlOpen, setNlOpen] = useState(false);
  const [driftOpen, setDriftOpen] = useState(false);
  const [asyncOpen, setAsyncOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [mockOpen, setMockOpen] = useState(false);
  const [gapsOpen, setGapsOpen] = useState(false);
  const [semanticOpen, setSemanticOpen] = useState(false);
  const [callbackOpen, setCallbackOpen] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  const [chatTestOpen, setChatTestOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [synthOpen, setSynthOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [geoOpen, setGeoOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Enterprise batch (Tier 1–3) — each opens one additive, opt-in modal.
  const [virtualOpen, setVirtualOpen] = useState(false);
  const [pactOpen, setPactOpen] = useState(false);
  const [chaosOpen, setChaosOpen] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [dbValidateOpen, setDbValidateOpen] = useState(false);
  const [asyncApiOpen, setAsyncApiOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [testIntelOpen, setTestIntelOpen] = useState(false);
  const [cloudLoadOpen, setCloudLoadOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [remediationOpen, setRemediationOpen] = useState(false);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [gitSyncOpen, setGitSyncOpen] = useState(false);
  // Atto coworker lifecycle tools.
  const [coworkerOpen, setCoworkerOpen] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  const [multimodalOpen, setMultimodalOpen] = useState(false);
  const [optimizerOpen, setOptimizerOpen] = useState(false);
  const [impactOpen, setImpactOpen] = useState(false);
  const [healOpen, setHealOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  // Execution/CI batch.
  const [hybridOpen, setHybridOpen] = useState(false);
  const [releaseGateOpen, setReleaseGateOpen] = useState(false);
  const [ciOpen, setCiOpen] = useState(false);
  const [execQueueOpen, setExecQueueOpen] = useState(false);
  const [cloudLabOpen, setCloudLabOpen] = useState(false);
  // Enterprise test-management & governance batch.
  const [tmOpen, setTmOpen] = useState(false);
  const [traceMatrixOpen, setTraceMatrixOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const methods = useMemo(() => [...new Set(endpoints.map((e) => e.method))].sort(), [endpoints]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return endpoints.filter((e) => {
      if (methodFilter !== 'all' && e.method !== methodFilter) return false;
      if (resourceFocus && (e.resource || '') !== resourceFocus) return false;
      if (!needle) return true;
      return e.url.toLowerCase().includes(needle) || e.title.toLowerCase().includes(needle) || (e.resource || '').toLowerCase().includes(needle) || (e.tags || []).some((t) => t.toLowerCase().includes(needle));
    });
  }, [endpoints, q, methodFilter, resourceFocus]);

  /** Group by host → resource so a 300-endpoint catalogue still reads. */
  const groups = useMemo(() => {
    const map = new Map<string, CatalogEndpoint[]>();
    for (const e of visible) {
      const key = `${hostOf(e.url)} · ${e.resource || 'other'}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const allVisibleSelected = visible.length > 0 && visible.every((e) => selected.has(e.id));
  const selectedCount = selected.size;

  /** Generate a portable artifact from the selected endpoints (or all). */
  const exportAs = (kind: 'connector' | 'openapi' | 'mock' | 'pact') => {
    const list = selected.size > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints;
    setExportOpen(false);
    if (kind === 'connector') downloadText('api-connector.json', toConnectorManifest(list));
    else if (kind === 'openapi') downloadText('openapi.json', toOpenApi(list));
    else if (kind === 'mock') downloadText('mock-server.mjs', toMockServer(list), 'text/javascript');
    else if (kind === 'pact') downloadText('pact-contract.json', toPactContract(list));
  };

  if (endpoints.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <EmptyState icon={Layers} title="The catalogue is empty" />
        <div className="flex justify-center items-center gap-2 -mt-10 pb-10">
          <button type="button" onClick={onImport} className={PRIMARY_BTN}><Plus className="w-3.5 h-3.5" />Import APIs</button>
          <button type="button" onClick={() => setCaptureOpen(true)} className={SECONDARY_BTN} title="Record real API traffic and turn it into endpoints"><Antenna className="w-3.5 h-3.5" />Capture traffic</button>
        </div>
        {captureOpen && <TrafficCapture catalog={catalog} onClose={() => setCaptureOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      {/* ── Table ── */}
      <div className="@container flex-1 min-w-0 flex flex-col min-h-0">
        {/* The filters shrink, the actions never do, and nothing leaves the column.
            Sizes come from @container queries because the constraint is this
            column’s width — the nav rail and the insights panel take their cut
            first, so a viewport breakpoint would report room that is not here. */}
        <div className={`relative z-10 flex items-center gap-2 px-4 h-11 min-w-0 overflow-hidden border-b border-gray-100 flex-shrink-0 ${STRIP}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer select-none flex-shrink-0">
              <input type="checkbox" checked={allVisibleSelected} onChange={() => catalog.selectMany(visible.map((e) => e.id), !allVisibleSelected)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC] focus:ring-offset-0" />
              <span className="font-medium tabular-nums whitespace-nowrap">{selectedCount}/{endpoints.length}<span className="hidden @[560px]:inline"> selected</span></span>
            </label>
            <div className="relative min-w-0 flex-1 max-w-[260px] hidden @[420px]:block">
              <Search className="w-3.5 h-3.5 text-gray-300 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" title="Filter by path, name or tag" className={`${INPUT} pl-7 py-1`} />
            </div>
            <select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)} className={`${FIELD} w-auto py-1 flex-shrink-0 hidden @[680px]:block`}>
              <option value="all">All methods</option>
              {methods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {resourceFocus && (
              <button type="button" onClick={() => setResourceFocus(null)} title="Clear the resource filter" className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] min-w-0 max-w-[140px] flex-shrink ${BRAND_CHIP}`}><span className="truncate">{resourceFocus}</span> ×</button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {selectedCount > 0 && (
              <button type="button" onClick={() => catalog.removeEndpoints([...selected])} disabled={running} className={SECONDARY_BTN} title="Remove the selected endpoints from the catalogue"><Trash2 className="w-3.5 h-3.5" /><span className="hidden @[1000px]:inline">Remove</span></button>
            )}
            <div className="relative">
              <button type="button" onClick={() => setToolsOpen((o) => !o)} className={SECONDARY_BTN} title="Quality tools — validate, scan, load-test, lint, coverage"><Wrench className="w-3.5 h-3.5" /><span className="hidden @[1000px]:inline">Tools</span><ChevronDown className="w-3 h-3" /></button>
              {toolsOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setToolsOpen(false)} />
                  <div className="absolute right-0 mt-1 z-50 w-60 bg-white border border-[#E4E0F5] rounded-lg py-1 shadow-[0_14px_32px_-12px_rgba(76,29,149,0.5)]">
                    {([
                      { icon: BrainCircuit, label: 'AI coworker (Atto)', desc: 'Chat + autonomy across the lifecycle', open: () => setCoworkerOpen(true) },
                      { icon: FileText, label: 'Story-driven generation', desc: 'Jira story / PRD → a test plan', open: () => setStoryOpen(true) },
                      { icon: ImageIcon, label: 'Multimodal inputs', desc: 'Screenshot / Figma / recording → a plan', open: () => setMultimodalOpen(true) },
                      { icon: ListFilter, label: 'Suite optimizer', desc: 'Risk priority + redundancy pruning', open: () => setOptimizerOpen(true) },
                      { icon: GitCompareArrows, label: 'Change impact', desc: 'History- & flow-aware test selection', open: () => setImpactOpen(true) },
                      { icon: HeartPulse, label: 'Semantic self-healing', desc: 'Intent-aware fixes for failing tests', open: () => setHealOpen(true) },
                      { icon: Bug, label: 'Bug report', desc: 'Tracker-ready report from a failure', open: () => setBugReportOpen(true) },
                      { icon: Activity, label: 'Monitoring', desc: 'Always-on health / drift / coverage watcher', open: () => setMonitorOpen(true) },
                      { icon: Antenna, label: 'Traffic capture', desc: 'Record real API calls → endpoints', open: () => setCaptureOpen(true) },
                      { icon: Radar, label: 'Traffic coverage gaps', desc: 'Untested endpoints from real traffic', open: () => setGapsOpen(true) },
                      { icon: Sparkles, label: 'Semantic assertion', desc: 'Judge AI responses by intent', open: () => setSemanticOpen(true) },
                      { icon: Webhook, label: 'Callback verification', desc: 'Capture & assert async webhooks', open: () => setCallbackOpen(true) },
                      { icon: Wand2, label: 'Author in plain English', desc: 'Describe tests → a run strategy', open: () => setNlOpen(true) },
                      { icon: Workflow, label: 'Flow builder', desc: 'Assemble a multi-step journey', open: () => setFlowOpen(true) },
                      { icon: MessageSquare, label: 'Chat-to-test', desc: 'Refine a test in plain English', open: () => setChatTestOpen(true) },
                      { icon: Bot, label: 'Autonomous maintenance', desc: 'Drift + gaps → a changeset', open: () => setMaintenanceOpen(true) },
                      { icon: Database, label: 'Synthetic data factory', desc: 'Realistic, seeded test data', open: () => setSynthOpen(true) },
                      { icon: Network, label: 'Events & gRPC', desc: 'Kafka topics and gRPC services', open: () => setEventsOpen(true) },
                      { icon: Globe2, label: 'Geo / distributed load', desc: 'Multi-region load + SLA gate', open: () => setGeoOpen(true) },
                      { icon: MessagesSquare, label: 'Collaboration', desc: 'Comments & version history', open: () => setCollabOpen(true) },
                      { icon: Chrome, label: 'Browser recorder', desc: 'Record traffic from DevTools', open: () => setExtensionOpen(true) },
                      { icon: Cpu, label: 'LLM providers', desc: 'OpenAI, Azure, Gemini or compatible', open: () => setProvidersOpen(true) },
                      { icon: Server, label: 'MCP server', desc: 'Expose IntelliQE tools to AI agents', open: () => setMcpOpen(true) },
                      { icon: ShieldCheck, label: 'Contract validation', desc: 'Live-check status, JSON & schema', open: () => setContractOpen(true) },
                      { icon: GitPullRequestArrow, label: 'Contract drift', desc: 'Adopt live changes into the catalogue', open: () => setDriftOpen(true) },
                      { icon: ShieldAlert, label: 'Security scan', desc: 'Broken auth, injection, headers, CORS', open: () => setSecurityOpen(true) },
                      { icon: BadgeCheck, label: 'OWASP API Top-10', desc: 'Compliance posture across the 2023 categories', open: () => setOwaspOpen(true) },
                      { icon: Bug, label: 'Fuzz / property test', desc: 'Boundary & malformed inputs → crashes, leaks', open: () => setFuzzOpen(true) },
                      { icon: Gauge, label: 'Load test', desc: 'Latency, throughput, status mix', open: () => setLoadOpen(true) },
                      { icon: Activity, label: 'Load profile & SLA', desc: 'Ramp-up stages, p95/error gate', open: () => setLoadProfileOpen(true) },
                      { icon: ScrollText, label: 'Governance lint', desc: 'API design smells', open: () => setGovernanceOpen(true) },
                      { icon: Target, label: 'Test coverage', desc: 'Which endpoints are tested', open: () => setCoverageOpen(true) },
                      { icon: GitCompare, label: 'Regression baselines', desc: 'Snapshot responses & diff for drift', open: () => setBaselineOpen(true) },
                      { icon: Table2, label: 'Data-driven testing', desc: 'Run one endpoint over a data table', open: () => setDataDrivenOpen(true) },
                      { icon: Database, label: 'Test data profiles', desc: 'Named datasets (CSV/Excel/Sheets/DB) → run a flow per row', open: () => setProfilesOpen(true) },
                      { icon: Radio, label: 'Async & streaming', desc: 'Test WebSocket and SSE endpoints', open: () => setAsyncOpen(true) },
                      { icon: ServerCog, label: 'Hosted mock server', desc: 'Publish endpoints as a live stub URL', open: () => setMockOpen(true) },
                      { icon: Clock, label: 'Schedules & webhooks', desc: 'Recurring runs and Slack/Teams alerts', open: () => setAutomationOpen(true) },
                      { icon: Boxes, label: 'Service virtualization', desc: 'Stateful, fault-injecting virtual deps', open: () => setVirtualOpen(true) },
                      { icon: Handshake, label: 'Pact broker', desc: 'Consumer-driven contracts & verification', open: () => setPactOpen(true) },
                      { icon: Zap, label: 'Chaos / resilience', desc: 'Fault injection → graceful-degradation grade', open: () => setChaosOpen(true) },
                      { icon: Spline, label: 'Trace correlation', desc: 'Assert spans in Jaeger / Zipkin / Tempo', open: () => setTraceOpen(true) },
                      { icon: Rss, label: 'AsyncAPI contracts', desc: 'Event channels & message validation', open: () => setAsyncApiOpen(true) },
                      { icon: Microscope, label: 'Test intelligence', desc: 'Flaky detection, quarantine, change impact', open: () => setTestIntelOpen(true) },
                      { icon: Cloud, label: 'Distributed cloud load', desc: 'Fan out to remote agents + SLA gate', open: () => setCloudLoadOpen(true) },
                      { icon: Database, label: 'Database validation', desc: 'Read-only SELECT assertions', open: () => setDbValidateOpen(true) },
                      { icon: ClipboardCheck, label: 'Compliance packs', desc: 'PCI · HIPAA · GDPR · PSD2 posture', open: () => setComplianceOpen(true) },
                      { icon: KeyRound, label: 'OAuth & secrets', desc: 'OAuth2 tokens · Vault/AWS/Azure/GCP secrets', open: () => setOauthOpen(true) },
                      { icon: Lock, label: 'Access control', desc: 'RBAC · SSO (OIDC) · SCIM provisioning', open: () => setAccessOpen(true) },
                      { icon: GitMerge, label: 'Remediation PR', desc: 'Open a GitHub/GitLab PR with a changeset', open: () => setRemediationOpen(true) },
                      { icon: FolderGit2, label: 'Git-synced tests', desc: 'Push / pull the catalogue as test-as-code', open: () => setGitSyncOpen(true) },
                      { icon: Combine, label: 'API + UI hybrid test', desc: 'Seed via API → verify in UI → cleanup', open: () => setHybridOpen(true) },
                      { icon: GitBranchPlus, label: 'Release gate', desc: 'Score a run → go / no-go to deploy', open: () => setReleaseGateOpen(true) },
                      { icon: Rocket, label: 'CI / GitHub Action', desc: 'Trigger & gate runs from your pipeline', open: () => setCiOpen(true) },
                      { icon: ListChecks, label: 'Parallel run queue', desc: 'Queue runs across concurrency slots', open: () => setExecQueueOpen(true) },
                      { icon: MonitorSmartphone, label: 'Cloud browser lab', desc: 'Run UI checks on hosted browsers · matrix', open: () => setCloudLabOpen(true) },
                      { icon: ClipboardList, label: 'Test management', desc: 'Suites · plans · cycles · assignments', open: () => setTmOpen(true) },
                      { icon: Waypoints, label: 'Traceability matrix', desc: 'Requirement → case → defect', open: () => setTraceMatrixOpen(true) },
                      { icon: Share2, label: 'TM connectors', desc: 'TestRail · Xray · Zephyr · qTest export', open: () => setConnectorsOpen(true) },
                      { icon: Stamp, label: 'Approvals', desc: 'Multi-stage release gating', open: () => setApprovalsOpen(true) },
                      { icon: ScrollText, label: 'Audit log', desc: 'Filter & export recorded actions', open: () => setAuditOpen(true) },
                      { icon: FileCheck2, label: 'Evidence export', desc: 'Compliance evidence → PDF', open: () => setEvidenceOpen(true) },
                    ]).map((t) => (
                      <button key={t.label} type="button" onClick={() => { setToolsOpen(false); t.open(); }} className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[#F5F3FF] transition-colors">
                        <t.icon className="w-4 h-4 text-[#7C3AED] flex-shrink-0 mt-0.5" />
                        <span className="min-w-0">
                          <span className="block text-[12px] font-medium text-gray-800">{t.label}</span>
                          <span className="block text-[10.5px] text-gray-400">{t.desc}</span>
                        </span>
                      </button>
                    ))}
                    <div className="mx-2 my-1 border-t border-gray-100" />
                    <p className="px-3 py-1 text-[10px] text-gray-400">Runs on {selectedCount > 0 ? `${selectedCount} selected` : 'all'} endpoint{selectedCount === 1 ? '' : 's'}</p>
                  </div>
                </>
              )}
            </div>
            <div className="relative">
              <button type="button" onClick={() => setExportOpen((o) => !o)} className={SECONDARY_BTN} title="Export the catalogue as a portable artifact"><Download className="w-3.5 h-3.5" /><span className="hidden @[1000px]:inline">Export</span><ChevronDown className="w-3 h-3" /></button>
              {exportOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                  <div className="absolute right-0 mt-1 z-50 w-56 bg-white border border-[#E4E0F5] rounded-lg py-1 shadow-[0_14px_32px_-12px_rgba(76,29,149,0.5)]">
                    {([
                      { k: 'openapi' as const, label: 'OpenAPI 3 spec', desc: 'openapi.json' },
                      { k: 'connector' as const, label: 'Connector manifest', desc: 'round-trips into Import' },
                      { k: 'mock' as const, label: 'Mock server', desc: 'runnable, zero-dependency Node' },
                      { k: 'pact' as const, label: 'Pact contract', desc: 'consumer-driven contract (v2)' },
                    ]).map((it) => (
                      <button key={it.k} type="button" onClick={() => exportAs(it.k)} className="w-full flex flex-col items-start px-3 py-1.5 text-left hover:bg-[#F5F3FF] transition-colors">
                        <span className="text-[12px] font-medium text-gray-800">{it.label}</span>
                        <span className="text-[10.5px] text-gray-400">{it.desc}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button type="button" onClick={onImport} className={SECONDARY_BTN} title="Import more APIs"><Plus className="w-3.5 h-3.5" /><span className="hidden @[1000px]:inline">Import</span></button>
            <button type="button" onClick={onDesign} disabled={running || selectedCount === 0} title={`Testcase generation for ${selectedCount} selected endpoint${selectedCount === 1 ? '' : 's'}`} className={`${PRIMARY_BTN} whitespace-nowrap`}>
              {running ? 'Generating…' : <>Testcase generation ({selectedCount})</>}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto min-w-0 min-h-0 bg-white">
          {visible.length === 0 ? (
            <EmptyState icon={Search} title="No endpoints match" hint="Clear the filter or pick another resource." />
          ) : (
            <table className="w-full text-[12px]">
              <thead className={`sticky top-0 backdrop-blur text-[10.5px] uppercase tracking-wide text-gray-500 z-10 ${THEAD}`}>
                <tr>
                  <th className="w-8" />
                  <th className="text-left px-2 py-1.5 font-semibold w-[76px]">Method</th>
                  <th className="text-left px-2 py-1.5 font-semibold">Endpoint</th>
                  <th className="text-left px-2 py-1.5 font-semibold w-[90px]">Auth</th>
                  <th className="text-left px-2 py-1.5 font-semibold w-[70px]">Expect</th>
                  <th className="text-left px-2 py-1.5 font-semibold w-[110px] hidden @[900px]:table-cell">Source</th>
                  <th className="w-[64px]" />
                </tr>
              </thead>
              <tbody>
                {groups.map(([key, list]) => {
                  const isCollapsed = !!collapsed[key];
                  const groupSelected = list.every((e) => selected.has(e.id));
                  return (
                    <GroupRows key={key} label={key} list={list} collapsed={isCollapsed} groupSelected={groupSelected}
                      onToggleCollapse={() => setCollapsed((c) => ({ ...c, [key]: !isCollapsed }))}
                      onToggleGroup={() => catalog.selectMany(list.map((e) => e.id), !groupSelected)}
                      selected={selected} running={running}
                      onToggle={catalog.toggle} onEdit={setEditing} onRemove={(id) => catalog.removeEndpoints([id])}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Intelligence & strategy ── */}
      {SHOW_ASIDE && (
        <aside className="relative z-20 w-[340px] flex-shrink-0 border-l border-gray-100 bg-gray-50/60 overflow-y-auto min-h-0 p-3 space-y-3">
          {SHOW_STRATEGY_BAR && <StrategyBar strategy={catalog.strategy} profile={profile} onCoverage={(c) => catalog.setStrategy({ coverage: c })} onToggleLayer={catalog.toggleLayer} onAdopt={catalog.adoptRecommendation} />}
          {SHOW_INSIGHTS_PANEL && <InsightsPanel profile={profile} analyzing={catalog.analyzing} error={catalog.analysisError} endpoints={endpoints} onDeepAnalyze={() => void catalog.analyze(true)} onFocusResource={setResourceFocus} />}
          {SHOW_IMPORTS && catalog.imports.length > 0 && (
            <div className={`${CARD} p-3.5`}>
              <div className="flex items-center gap-2 mb-2"><Download className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Imports this session</h3></div>
              <ul className="space-y-1">
                {catalog.imports.slice(0, 8).map((im) => (
                  <li key={im.id} className="flex items-center gap-2 text-[11px]">
                    <span className={`inline-flex px-1.5 py-0.5 rounded border text-[9.5px] font-semibold ${MUTED_CHIP}`}>{IMPORT_METHOD_LABELS[im.method] || im.method}</span>
                    <span className="truncate text-gray-700 flex-1 min-w-0" title={im.name}>{im.name}</span>
                    <span className="font-mono text-gray-400 tabular-nums">{im.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      )}

      {editing && (
        <EndpointEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => { catalog.updateEndpoint(editing.id, patch); setEditing(null); }}
        />
      )}

      {contractOpen && (
        <ContractCheck
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setContractOpen(false)}
        />
      )}
      {securityOpen && (
        <SecurityScan
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setSecurityOpen(false)}
        />
      )}
      {owaspOpen && (
        <OwaspCompliance
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setOwaspOpen(false)}
        />
      )}
      {fuzzOpen && (
        <FuzzTest
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setFuzzOpen(false)}
        />
      )}
      {loadOpen && (
        <LoadTest
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setLoadOpen(false)}
        />
      )}
      {loadProfileOpen && (
        <LoadProfile
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setLoadProfileOpen(false)}
        />
      )}
      {governanceOpen && (
        <GovernanceCheck
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setGovernanceOpen(false)}
        />
      )}
      {coverageOpen && (
        <Coverage
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          scenarios={scenarios}
          onClose={() => setCoverageOpen(false)}
        />
      )}
      {baselineOpen && (
        <BaselineDiff
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setBaselineOpen(false)}
        />
      )}
      {dataDrivenOpen && (
        <DataDriven
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setDataDrivenOpen(false)}
        />
      )}
      {automationOpen && (
        <RunAutomation
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setAutomationOpen(false)}
        />
      )}
      {nlOpen && (
        <NlAuthor
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onApply={(brief) => {
            catalog.setStrategy({ coverage: brief.coverage, layers: brief.layers as StrategyLayerId[], requirements: brief.requirements });
            toast.success('Strategy updated', `${brief.coverage} coverage · ${brief.layers.length} layer${brief.layers.length === 1 ? '' : 's'} · brief applied`);
          }}
          onClose={() => setNlOpen(false)}
        />
      )}
      {driftOpen && (
        <ContractDrift
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onAdopt={(id, patch) => { catalog.updateEndpoint(id, patch); toast.success('Catalogue updated', 'Adopted the live contract for this endpoint.'); }}
          onClose={() => setDriftOpen(false)}
        />
      )}
      {asyncOpen && (
        <AsyncProbe
          initialUrl={(selectedCount > 0 ? endpoints.find((e) => selected.has(e.id)) : endpoints[0])?.url || ''}
          onClose={() => setAsyncOpen(false)}
        />
      )}
      {captureOpen && (
        <TrafficCapture
          catalog={catalog}
          onClose={() => setCaptureOpen(false)}
        />
      )}
      {mockOpen && (
        <MockServer
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setMockOpen(false)}
        />
      )}
      {gapsOpen && (
        <CoverageGaps catalog={catalog} onClose={() => setGapsOpen(false)} />
      )}
      {semanticOpen && (
        <SemanticAssert
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setSemanticOpen(false)}
        />
      )}
      {callbackOpen && (
        <CallbackVerify onClose={() => setCallbackOpen(false)} />
      )}
      {flowOpen && (
        <FlowBuilder catalog={catalog} onClose={() => setFlowOpen(false)} />
      )}
      {chatTestOpen && (
        <ChatToTest
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setChatTestOpen(false)}
        />
      )}
      {maintenanceOpen && (
        <AutoMaintenance catalog={catalog} onClose={() => setMaintenanceOpen(false)} />
      )}
      {synthOpen && (
        <SyntheticData
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setSynthOpen(false)}
        />
      )}
      {eventsOpen && (
        <EventGrpc onClose={() => setEventsOpen(false)} />
      )}
      {geoOpen && (
        <GeoLoad
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setGeoOpen(false)}
        />
      )}
      {collabOpen && (
        <Collaboration
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setCollabOpen(false)}
        />
      )}
      {extensionOpen && (
        <ExtensionRecorder onClose={() => setExtensionOpen(false)} />
      )}
      {providersOpen && (
        <LlmProviders onClose={() => setProvidersOpen(false)} />
      )}
      {mcpOpen && (
        <McpServer onClose={() => setMcpOpen(false)} />
      )}

      {/* ── Enterprise batch (Tier 1–3) ── */}
      {virtualOpen && (
        <VirtualService onClose={() => setVirtualOpen(false)} />
      )}
      {pactOpen && (
        <PactBroker onClose={() => setPactOpen(false)} />
      )}
      {chaosOpen && (
        <ChaosTest
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setChaosOpen(false)}
        />
      )}
      {traceOpen && (
        <TraceCorrelation
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setTraceOpen(false)}
        />
      )}
      {asyncApiOpen && (
        <AsyncApiContract onClose={() => setAsyncApiOpen(false)} />
      )}
      {testIntelOpen && (
        <TestIntel
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setTestIntelOpen(false)}
        />
      )}
      {cloudLoadOpen && (
        <CloudLoad
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setCloudLoadOpen(false)}
        />
      )}
      {dbValidateOpen && (
        <DbValidate onClose={() => setDbValidateOpen(false)} />
      )}
      {complianceOpen && (
        <CompliancePacks
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setComplianceOpen(false)}
        />
      )}
      {oauthOpen && (
        <OAuthSecrets onClose={() => setOauthOpen(false)} />
      )}
      {accessOpen && (
        <AccessControl onClose={() => setAccessOpen(false)} />
      )}
      {remediationOpen && (
        <RemediationPr onClose={() => setRemediationOpen(false)} />
      )}
      {gitSyncOpen && (
        <GitSync
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setGitSyncOpen(false)}
        />
      )}

      {/* ── Atto coworker lifecycle tools ── */}
      {coworkerOpen && (
        <AiCoworker
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setCoworkerOpen(false)}
        />
      )}
      {storyOpen && (
        <StoryGen
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onApply={(brief) => {
            catalog.setStrategy({ coverage: brief.coverage, layers: brief.layers as StrategyLayerId[], requirements: brief.requirements });
            toast.success('Strategy updated', `${brief.coverage} coverage · ${brief.layers.length} layer${brief.layers.length === 1 ? '' : 's'} · story applied`);
          }}
          onClose={() => setStoryOpen(false)}
        />
      )}
      {multimodalOpen && (
        <Multimodal
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onApply={(brief) => {
            catalog.setStrategy({ coverage: brief.coverage, layers: brief.layers as StrategyLayerId[], requirements: brief.requirements });
            toast.success('Strategy updated', `${brief.coverage} coverage · ${brief.layers.length} layer${brief.layers.length === 1 ? '' : 's'} · artifacts applied`);
          }}
          onClose={() => setMultimodalOpen(false)}
        />
      )}
      {optimizerOpen && (
        <SuiteOptimizer
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setOptimizerOpen(false)}
        />
      )}
      {impactOpen && (
        <ImpactAnalysis
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setImpactOpen(false)}
        />
      )}
      {healOpen && (
        <SemanticHeal
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setHealOpen(false)}
        />
      )}
      {bugReportOpen && (
        <BugReport
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setBugReportOpen(false)}
        />
      )}
      {monitorOpen && (
        <Monitoring
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setMonitorOpen(false)}
        />
      )}
      {profilesOpen && <DataProfiles onClose={() => setProfilesOpen(false)} />}

      {/* ── Execution/CI batch ── */}
      {hybridOpen && (
        <HybridTest
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setHybridOpen(false)}
        />
      )}
      {releaseGateOpen && (
        <ReleaseGate onClose={() => setReleaseGateOpen(false)} />
      )}
      {ciOpen && (
        <CiPipeline
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setCiOpen(false)}
        />
      )}
      {execQueueOpen && (
        <ExecQueue
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setExecQueueOpen(false)}
        />
      )}
      {cloudLabOpen && (
        <CloudLab onClose={() => setCloudLabOpen(false)} />
      )}

      {/* ── Enterprise test-management & governance ── */}
      {tmOpen && (
        <TestManagement
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setTmOpen(false)}
        />
      )}
      {traceMatrixOpen && (
        <Traceability
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setTraceMatrixOpen(false)}
        />
      )}
      {connectorsOpen && <TmConnectors onClose={() => setConnectorsOpen(false)} />}
      {approvalsOpen && <Approvals onClose={() => setApprovalsOpen(false)} />}
      {auditOpen && <AuditLog onClose={() => setAuditOpen(false)} />}
      {evidenceOpen && <EvidenceExport onClose={() => setEvidenceOpen(false)} />}
    </div>
  );
}

function GroupRows({ label, list, collapsed, groupSelected, onToggleCollapse, onToggleGroup, selected, running, onToggle, onEdit, onRemove }: {
  label: string; list: CatalogEndpoint[]; collapsed: boolean; groupSelected: boolean; onToggleCollapse: () => void; onToggleGroup: () => void;
  selected: Set<string>; running: boolean; onToggle: (id: string) => void; onEdit: (e: CatalogEndpoint) => void; onRemove: (id: string) => void;
}) {
  return (
    <>
      <tr className="bg-gray-50 border-y border-gray-100">
        <td className="px-2 py-1"><input type="checkbox" checked={groupSelected} onChange={onToggleGroup} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC] focus:ring-offset-0" /></td>
        <td colSpan={7} className="px-2 py-1">
          <button type="button" onClick={onToggleCollapse} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-700 hover:text-[#7C3AED]">
            {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <Globe className="w-3 h-3 text-gray-400" />{label}
            <span className="font-mono font-normal text-gray-400 tabular-nums">{list.length}</span>
          </button>
        </td>
      </tr>
      {!collapsed && list.map((e) => {
        const on = selected.has(e.id);
        return (
          <tr key={e.id} className={`border-b border-gray-50 hover:bg-[#FAFAFE] hover:shadow-[inset_3px_0_0_0_#C4B5FD] transition-[background,box-shadow] group ${on ? '' : 'opacity-60'}`}>
            <td className="px-2 py-1.5 align-top"><input type="checkbox" checked={on} onChange={() => onToggle(e.id)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC] focus:ring-offset-0" /></td>
            <td className="px-2 py-1.5 align-top"><MethodBadge method={e.method} /></td>
            <td className="px-2 py-1.5 align-top max-w-0 w-full">
              <div className="font-mono text-[11.5px] text-gray-800 truncate" title={e.url}>{pathOf(e.url)}</div>
              <div className="text-[10.5px] text-gray-500 truncate">
                {e.title}{e.deprecated && <span className="ml-1 text-amber-600">· deprecated</span>}{e.discovered && <span className="ml-1 text-[#7C3AED]">· discovered</span>}
                {e.style && e.style !== 'rest' && <span className="ml-1 uppercase text-gray-400">· {e.style}</span>}
              </div>
            </td>
            <td className="px-2 py-1.5 align-top text-[11px] text-gray-500">{e.auth.type === 'none' ? <span className="text-gray-300">—</span> : e.auth.type === 'apikey' ? `key · ${e.auth.headerName || 'X-API-Key'}` : e.auth.type}</td>
            <td className="px-2 py-1.5 align-top"><StatusCode code={e.expectedStatus || ''} /></td>
            <td className="px-2 py-1.5 align-top text-[10.5px] text-gray-500 truncate max-w-[110px] hidden @[900px]:table-cell" title={e.source?.name}>{e.source ? IMPORT_METHOD_LABELS[e.source.method] || e.source.method : ''}</td>
            <td className="px-2 py-1.5 align-top">
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button type="button" onClick={() => onEdit(e)} disabled={running} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                <button type="button" onClick={() => onRemove(e.id)} disabled={running} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}
