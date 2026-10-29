/**
 * ApiToolsLauncher — the API-testing tool catalogue.
 *
 * Every opt-in quality tool that used to hide in the Endpoints "Tools" dropdown
 * now lives here as a first-class, searchable gallery grouped by what it does.
 * The launcher owns each tool's open-state and renders its modal; a card click
 * opens the tool. Tools run against the current selection (or the whole
 * catalogue when nothing is selected) — exactly as the dropdown did, so no run
 * behaviour changes, only where you reach the tools from.
 */
import { useEffect, useMemo, useState, type ElementType } from 'react';
import {
  Search, Layers, BrainCircuit, FileText, Image as ImageIcon, ListFilter, GitCompareArrows, HeartPulse,
  Bug, Activity, Antenna, Radar, Sparkles, Webhook, Wand2, Workflow, MessageSquare, Bot, Database,
  Network, Globe2, MessagesSquare, Chrome, Cpu, Server, ShieldCheck, GitPullRequestArrow, ShieldAlert,
  BadgeCheck, Gauge, ScrollText, Target, GitCompare, Table2, Radio, ServerCog, Clock, Boxes, Handshake,
  Zap, Spline, Rss, Microscope, Cloud, Lock, ClipboardCheck, KeyRound, GitMerge, FolderGit2, Combine,
  GitBranchPlus, Rocket, ListChecks, MonitorSmartphone, ClipboardList, Waypoints, Share2, Stamp,
  FileCheck2, HardDrive, Wallet, Scale, FileCode2, Gavel, FileSearch, GitFork, Fingerprint, FlaskConical,
} from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import { useAuth } from '@/contexts/AuthContext';
import { getApiToolToggles, updateApiToolToggles, importApiFiles } from '@/services/api';
import { CARD, FIELD } from './format';
import { EmptyState } from './primitives';

import ContractCheck from './ContractCheck';
import LoadTest from './LoadTest';
import LoadProfile from './LoadProfile';
import SecurityScan from './SecurityScan';
import OwaspCompliance from './OwaspCompliance';
import FuzzTest from './FuzzTest';
import GovernanceCheck from './GovernanceCheck';
import Coverage from './Coverage';
import BaselineDiff from './BaselineDiff';
import DataDriven from './DataDriven';
import RunAutomation from './RunAutomation';
import NlAuthor from './NlAuthor';
import ContractDrift from './ContractDrift';
import AsyncProbe from './AsyncProbe';
import TrafficCapture from './TrafficCapture';
import MockServer from './MockServer';
import CoverageGaps from './CoverageGaps';
import SemanticAssert from './SemanticAssert';
import CallbackVerify from './CallbackVerify';
import FlowBuilder from './FlowBuilder';
import ChatToTest from './ChatToTest';
import AutoMaintenance from './AutoMaintenance';
import SyntheticData from './SyntheticData';
import LlmProviders from './LlmProviders';
import McpServer from './McpServer';
import EventGrpc from './EventGrpc';
import GeoLoad from './GeoLoad';
import Collaboration from './Collaboration';
import ExtensionRecorder from './ExtensionRecorder';
import VirtualService from './VirtualService';
import PactBroker from './PactBroker';
import ChaosTest from './ChaosTest';
import OAuthSecrets from './OAuthSecrets';
import DbValidate from './DbValidate';
import AsyncApiContract from './AsyncApiContract';
import TraceCorrelation from './TraceCorrelation';
import TestIntel from './TestIntel';
import CloudLoad from './CloudLoad';
import AccessControl from './AccessControl';
import RemediationPr from './RemediationPr';
import CompliancePacks from './CompliancePacks';
import GitSync from './GitSync';
import AuthzScan from './AuthzScan';
import SpecDiff from './SpecDiff';
import ReplayTest from './ReplayTest';
import LlmTesting from './LlmTesting';
import SmartGeneration from './SmartGeneration';
import CoverageGuided from './CoverageGuided';
import MutationLive from './MutationLive';
import AuthzDeep from './AuthzDeep';
import Autopilot from './Autopilot';
import DataCorrectness from './DataCorrectness';
import ModelGen from './ModelGen';
import UnifiedCanvas from './UnifiedCanvas';
import StepGroups from './StepGroups';
import DistributedLoad from './DistributedLoad';
import FixWorkflow from './FixWorkflow';
import FinOpsMetering from './FinOpsMetering';
import OnPremDeploy from './OnPremDeploy';
import AiCompliance from './AiCompliance';
import FullCodeExport from './FullCodeExport';
import GovernanceLint from './GovernanceLint';
import SpecAudit from './SpecAudit';
import SeqFuzz from './SeqFuzz';
import DataClassify from './DataClassify';
import LlmEval from './LlmEval';
import ProxyServer from './ProxyServer';
import StatusPages from './StatusPages';
import AiCoworker from './AiCoworker';
import StoryGen from './StoryGen';
import Multimodal from './Multimodal';
import SuiteOptimizer from './SuiteOptimizer';
import ImpactAnalysis from './ImpactAnalysis';
import SemanticHeal from './SemanticHeal';
import BugReport from './BugReport';
import Monitoring from './Monitoring';
import DataProfiles from './DataProfiles';
import HybridTest from './HybridTest';
import ReleaseGate from './ReleaseGate';
import CiPipeline from './CiPipeline';
import ExecQueue from './ExecQueue';
import CloudLab from './CloudLab';
import TestManagement from './TestManagement';
import Traceability from './Traceability';
import TmConnectors from './TmConnectors';
import AuditLog from './AuditLog';
import Approvals from './Approvals';
import EvidenceExport from './EvidenceExport';

import IntegrationTestsView from './views/IntegrationTestsView';

import type { Catalog } from './hooks/useCatalog';
import type { ApiEnvironment, CatalogEndpoint, NavView, Scenario, StrategyLayerId } from './types';

interface Props {
  catalog: Catalog;
  /** The current run's designed scenarios — read-only, for coverage-type tools. */
  scenarios?: Scenario[];
  /** Pre-fills the gallery search — lets a caller (e.g. an Overview feature chip)
      deep-link straight to a capability's tools. */
  initialSearch?: string;
  /** Lets a tool hand the user back to another tab (e.g. "Open the catalogue"). */
  onNavigate?: (view: NavView) => void;
  /** The environment a run would target — tools that gate on it need to know. */
  environment?: ApiEnvironment | null;
}

interface ToolDef { icon: ElementType; label: string; desc: string; open: () => void }
/** Each group carries its own vivid hue so the catalogue reads as colourful
    while staying on the violet brand — decorative, not an outcome colour. */
interface ToolGroup { title: string; blurb: string; accent: string; items: ToolDef[] }

/** Stable per-tool key derived from its label (persistence id for toggles). */
const toolKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Compact on/off switch — same visual language as the Feature Toggles page. */
function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onChange(); }}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-[#7C3AED] focus:ring-offset-1 ${
        checked ? 'bg-gradient-to-r from-[#7C3AED] to-[#6366F1]' : 'bg-gray-300'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

/**
 * Group order, rebuilt from the 2026 competitor + gap analysis
 * (docs/api-automation-competitor-gap-analysis.md). Lead with where we beat the
 * field — AI/agentic authoring, security depth, LLM/MCP testing and coverage
 * intelligence — and close with the execution/CI lifecycle that every rival
 * already ships (table stakes). The group definitions are unchanged; only the
 * display order is.
 */
const GROUP_ORDER: string[] = [
  'Generate & author',
  'Security & authorization',
  'Protocols, data & AI',
  'Coverage & intelligence',
  'Contracts & virtualization',
  'Performance & resilience',
  'Governance & compliance',
  'Execution, CI & lifecycle',
];

/**
 * "Edge" tools — the capabilities the gap analysis flags as competitive
 * white-space: few or no rivals cover them, or only standalone point tools do
 * while we offer them inside one platform. Marked with an EDGE badge so the
 * gallery reads the way the market analysis ranks us.
 */
const DIFFERENTIATORS = new Set<string>([
  // Agentic / autonomous loop
  'AI coworker (Atto)', 'Autopilot (autonomous loop)', 'Autonomous maintenance',
  'Semantic self-healing', 'Failure → fix workflow',
  // Deep authorization inside a functional QA platform
  'Authorization (BOLA/BFLA)', 'Deep authorization & data exposure', 'Assertion strength (mutation)',
  // AI/LLM & MCP testing + security combined
  'AI / LLM & MCP testing', 'LLM eval harness', 'MCP server', 'LLM providers',
  // Contracts/replay/virtualization edges
  'Breaking-change gate', 'Record & replay', 'Service virtualization',
  // Governance-as-code + regulatory packs
  'API governance', 'Compliance packs', 'AI-era compliance',
  // No-lock-in / data residency
  'On-prem / air-gapped', 'Full-code & Monitoring-as-Code',
  // Cross-layer + shift-right
  'Unified cross-layer test', 'API + UI hybrid test', 'Monitoring', 'Public status page',
]);

export default function ApiToolsLauncher({ catalog, scenarios = [], initialSearch = '', onNavigate, environment }: Props) {
  const { endpoints, selected } = catalog;
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [q, setQ] = useState(initialSearch);

  // ── Tool availability toggles (per-tenant; a key absent ⇒ enabled) ──
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set());
  const [savingToggles, setSavingToggles] = useState(false);

  const selectedCount = selected.size;
  /** The endpoints a tool runs against: the selection, or everything. */
  const ep: CatalogEndpoint[] = selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints;

  // ── Open-state, one per tool (unchanged from the former dropdown) ──
  const [contractOpen, setContractOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [loadProfileOpen, setLoadProfileOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [owaspOpen, setOwaspOpen] = useState(false);
  const [fuzzOpen, setFuzzOpen] = useState(false);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [authzOpen, setAuthzOpen] = useState(false);
  const [specDiffOpen, setSpecDiffOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [llmTestingOpen, setLlmTestingOpen] = useState(false);
  const [smartGenOpen, setSmartGenOpen] = useState(false);
  const [covGuideOpen, setCovGuideOpen] = useState(false);
  const [mutationLiveOpen, setMutationLiveOpen] = useState(false);
  const [authzDeepOpen, setAuthzDeepOpen] = useState(false);
  const [autopilotOpen, setAutopilotOpen] = useState(false);
  const [dataCorrectnessOpen, setDataCorrectnessOpen] = useState(false);
  const [modelGenOpen, setModelGenOpen] = useState(false);
  const [unifiedOpen, setUnifiedOpen] = useState(false);
  const [stepGroupsOpen, setStepGroupsOpen] = useState(false);
  const [distLoadOpen, setDistLoadOpen] = useState(false);
  const [fixWorkflowOpen, setFixWorkflowOpen] = useState(false);
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
  const [integrationOpen, setIntegrationOpen] = useState(false);
  const [chatTestOpen, setChatTestOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [synthOpen, setSynthOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [geoOpen, setGeoOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [extensionOpen, setExtensionOpen] = useState(false);
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
  const [finopsOpen, setFinopsOpen] = useState(false);
  const [onPremOpen, setOnPremOpen] = useState(false);
  const [aiComplianceOpen, setAiComplianceOpen] = useState(false);
  const [fullCodeOpen, setFullCodeOpen] = useState(false);
  const [govLintOpen, setGovLintOpen] = useState(false);
  const [specAuditOpen, setSpecAuditOpen] = useState(false);
  const [seqFuzzOpen, setSeqFuzzOpen] = useState(false);
  const [dataClassifyOpen, setDataClassifyOpen] = useState(false);
  const [llmEvalOpen, setLlmEvalOpen] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [statusPagesOpen, setStatusPagesOpen] = useState(false);
  const [coworkerOpen, setCoworkerOpen] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  const [multimodalOpen, setMultimodalOpen] = useState(false);
  const [optimizerOpen, setOptimizerOpen] = useState(false);
  const [impactOpen, setImpactOpen] = useState(false);
  const [healOpen, setHealOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [hybridOpen, setHybridOpen] = useState(false);
  const [releaseGateOpen, setReleaseGateOpen] = useState(false);
  const [ciOpen, setCiOpen] = useState(false);
  const [execQueueOpen, setExecQueueOpen] = useState(false);
  const [cloudLabOpen, setCloudLabOpen] = useState(false);
  const [tmOpen, setTmOpen] = useState(false);
  const [traceMatrixOpen, setTraceMatrixOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  // ── The catalogue, grouped by what the tool is for ──
  const GROUPS: ToolGroup[] = useMemo(() => [
    {
      title: 'Generate & author',
      accent: '#7C3AED',
      blurb: 'Design and generate tests — from prose, specs, models or the live API.',
      items: [
        { icon: BrainCircuit, label: 'AI coworker (Atto)', desc: 'Chat + autonomy across the lifecycle', open: () => setCoworkerOpen(true) },
        { icon: Bot, label: 'Autopilot (autonomous loop)', desc: 'Discover → generate → run → heal → reviewed PR', open: () => setAutopilotOpen(true) },
        { icon: FileText, label: 'Story-driven generation', desc: 'Jira story / PRD → a reviewed test plan', open: () => setStoryOpen(true) },
        { icon: ImageIcon, label: 'Multimodal inputs', desc: 'Screenshot / Figma / recording → a plan', open: () => setMultimodalOpen(true) },
        { icon: Wand2, label: 'Author in plain English', desc: 'Describe tests → a run strategy', open: () => setNlOpen(true) },
        { icon: MessageSquare, label: 'Chat-to-test', desc: 'Refine a test in plain English', open: () => setChatTestOpen(true) },
        { icon: Target, label: 'Coverage-guided generation', desc: 'Probe branches → generate toward the gaps', open: () => setCovGuideOpen(true) },
        { icon: Boxes, label: 'Stateful / white-box generation', desc: 'Producer→consumer CRUD sequences', open: () => setSmartGenOpen(true) },
        { icon: Workflow, label: 'Model-based generation', desc: 'Learn the state machine → long business sequences', open: () => setModelGenOpen(true) },
        { icon: Database, label: 'Synthetic data factory', desc: 'Realistic, seeded test data', open: () => setSynthOpen(true) },
        { icon: Workflow, label: 'Flow builder', desc: 'Assemble a multi-step journey', open: () => setFlowOpen(true) },
        { icon: Workflow, label: 'Integration tests', desc: 'Runnable journeys — chain real values, assert each step', open: () => setIntegrationOpen(true) },
        { icon: Layers, label: 'Step groups library', desc: 'Reusable login / token / teardown sequences', open: () => setStepGroupsOpen(true) },
        { icon: Combine, label: 'Unified cross-layer test', desc: 'One test: API + DB + UI steps, shared vars', open: () => setUnifiedOpen(true) },
        { icon: Bot, label: 'Autonomous maintenance', desc: 'Drift + gaps → a changeset', open: () => setMaintenanceOpen(true) },
      ],
    },
    {
      title: 'Security & authorization',
      accent: '#F43F5E',
      blurb: 'Find vulnerabilities, weak auth and sensitive-data exposure.',
      items: [
        { icon: ShieldAlert, label: 'Security scan', desc: 'Broken auth, injection, headers, CORS', open: () => setSecurityOpen(true) },
        { icon: BadgeCheck, label: 'OWASP API Top-10', desc: 'Compliance posture across the 2023 categories', open: () => setOwaspOpen(true) },
        { icon: Bug, label: 'Fuzz / property test', desc: 'Boundary & malformed inputs → crashes, leaks', open: () => setFuzzOpen(true) },
        { icon: GitFork, label: 'Sequence fuzzing', desc: 'Stateful CRUD-chain fuzzing', open: () => setSeqFuzzOpen(true) },
        { icon: Lock, label: 'Authorization (BOLA/BFLA)', desc: 'Multi-role cross-user & privileged access', open: () => setAuthzOpen(true) },
        { icon: ShieldAlert, label: 'Deep authorization & data exposure', desc: 'Multi-role excessive-data, mass-assignment, more', open: () => setAuthzDeepOpen(true) },
        { icon: Microscope, label: 'Assertion strength (mutation)', desc: 'Grade assertions against a live response', open: () => setMutationLiveOpen(true) },
        { icon: Sparkles, label: 'Semantic assertion', desc: 'Judge AI responses by intent', open: () => setSemanticOpen(true) },
        { icon: Fingerprint, label: 'Data classification', desc: 'PII/secrets + shadow APIs', open: () => setDataClassifyOpen(true) },
        { icon: FileSearch, label: 'OpenAPI security audit', desc: '42Crunch-style spec scoring', open: () => setSpecAuditOpen(true) },
        { icon: KeyRound, label: 'OAuth & secrets', desc: 'OAuth2 tokens · Vault/AWS/Azure/GCP secrets', open: () => setOauthOpen(true) },
        { icon: Lock, label: 'Access control', desc: 'RBAC · SSO (OIDC) · SCIM provisioning', open: () => setAccessOpen(true) },
      ],
    },
    {
      title: 'Performance & resilience',
      accent: '#F59E0B',
      blurb: 'Latency, throughput, SLA gates and fault tolerance.',
      items: [
        { icon: Gauge, label: 'Load test', desc: 'Latency, throughput, status mix', open: () => setLoadOpen(true) },
        { icon: Activity, label: 'Load profile & SLA', desc: 'Ramp-up stages, p95/error gate', open: () => setLoadProfileOpen(true) },
        { icon: Globe2, label: 'Geo / distributed load', desc: 'Multi-region load + SLA gate', open: () => setGeoOpen(true) },
        { icon: Cloud, label: 'Distributed cloud load', desc: 'Fan out to remote agents + SLA gate', open: () => setCloudLoadOpen(true) },
        { icon: Cloud, label: 'Distributed load ramp', desc: 'Staged high-RPS across registered agents', open: () => setDistLoadOpen(true) },
        { icon: Zap, label: 'Chaos / resilience', desc: 'Fault injection → graceful-degradation grade', open: () => setChaosOpen(true) },
      ],
    },
    {
      title: 'Contracts & virtualization',
      accent: '#10B981',
      blurb: 'Validate contracts, catch drift, replay and stub dependencies.',
      items: [
        { icon: ShieldCheck, label: 'Contract validation', desc: 'Live-check status, JSON & schema', open: () => setContractOpen(true) },
        { icon: GitPullRequestArrow, label: 'Contract drift', desc: 'Adopt live changes into the catalogue', open: () => setDriftOpen(true) },
        { icon: GitCompare, label: 'Regression baselines', desc: 'Snapshot responses & diff for drift', open: () => setBaselineOpen(true) },
        { icon: GitCompareArrows, label: 'Breaking-change gate', desc: 'Diff two OpenAPI specs → go / no-go', open: () => setSpecDiffOpen(true) },
        { icon: Radio, label: 'Record & replay', desc: 'Deterministic, zero-cost regression replay', open: () => setReplayOpen(true) },
        { icon: Handshake, label: 'Pact broker', desc: 'Consumer-driven contracts & verification', open: () => setPactOpen(true) },
        { icon: Rss, label: 'AsyncAPI contracts', desc: 'Event channels & message validation', open: () => setAsyncApiOpen(true) },
        { icon: Boxes, label: 'Service virtualization', desc: 'Stateful, fault-injecting virtual deps', open: () => setVirtualOpen(true) },
        { icon: ServerCog, label: 'Hosted mock server', desc: 'Publish endpoints as a live stub URL', open: () => setMockOpen(true) },
        { icon: Network, label: 'Contract proxy', desc: 'Validate live traffic · simulate deps', open: () => setProxyOpen(true) },
      ],
    },
    {
      title: 'Coverage & intelligence',
      accent: '#0EA5E9',
      blurb: 'See what is tested, what is flaky, and what a change touches.',
      items: [
        { icon: Target, label: 'Test coverage', desc: 'Which endpoints are tested', open: () => setCoverageOpen(true) },
        { icon: Radar, label: 'Traffic coverage gaps', desc: 'Untested endpoints from real traffic', open: () => setGapsOpen(true) },
        { icon: Microscope, label: 'Test intelligence', desc: 'Flaky detection, quarantine, change impact', open: () => setTestIntelOpen(true) },
        { icon: GitCompareArrows, label: 'Change impact', desc: 'History- & flow-aware test selection', open: () => setImpactOpen(true) },
        { icon: ListFilter, label: 'Suite optimizer', desc: 'Risk priority + redundancy pruning', open: () => setOptimizerOpen(true) },
        { icon: HeartPulse, label: 'Semantic self-healing', desc: 'Intent-aware fixes for failing tests', open: () => setHealOpen(true) },
        { icon: GitMerge, label: 'Data-correctness verify', desc: 'Assert a write propagated across services/DBs', open: () => setDataCorrectnessOpen(true) },
      ],
    },
    {
      title: 'Protocols, data & AI',
      accent: '#6366F1',
      blurb: 'Streaming, events, databases, and testing AI/LLM systems.',
      items: [
        { icon: Radio, label: 'Async & streaming', desc: 'Test WebSocket and SSE endpoints', open: () => setAsyncOpen(true) },
        { icon: Network, label: 'Events & gRPC', desc: 'Kafka topics and gRPC services', open: () => setEventsOpen(true) },
        { icon: Webhook, label: 'Callback verification', desc: 'Capture & assert async webhooks', open: () => setCallbackOpen(true) },
        { icon: Table2, label: 'Data-driven testing', desc: 'Run one endpoint over a data table', open: () => setDataDrivenOpen(true) },
        { icon: Database, label: 'Test data profiles', desc: 'Named datasets → run a flow per row', open: () => setProfilesOpen(true) },
        { icon: Database, label: 'Database validation', desc: 'Read-only SELECT assertions', open: () => setDbValidateOpen(true) },
        { icon: Antenna, label: 'Traffic capture', desc: 'Record real API calls → endpoints', open: () => setCaptureOpen(true) },
        { icon: Chrome, label: 'Browser recorder', desc: 'Record traffic from DevTools', open: () => setExtensionOpen(true) },
        { icon: Spline, label: 'Trace correlation', desc: 'Assert spans in Jaeger / Zipkin / Tempo', open: () => setTraceOpen(true) },
        { icon: Cpu, label: 'LLM providers', desc: 'OpenAI, Azure, Gemini or compatible', open: () => setProvidersOpen(true) },
        { icon: Server, label: 'MCP server', desc: 'Expose IntelliQE tools to AI agents', open: () => setMcpOpen(true) },
        { icon: Sparkles, label: 'AI / LLM & MCP testing', desc: 'Quality eval · LLM Top-10 · MCP security', open: () => setLlmTestingOpen(true) },
        { icon: FlaskConical, label: 'LLM eval harness', desc: 'Promptfoo-style scoring · LLM judge', open: () => setLlmEvalOpen(true) },
      ],
    },
    {
      title: 'Governance & compliance',
      accent: '#D946EF',
      blurb: 'API design rules, regulatory posture and cost governance.',
      items: [
        { icon: Gavel, label: 'API governance', desc: 'Spectral-style rulesets · CI gate', open: () => setGovLintOpen(true) },
        { icon: ScrollText, label: 'Governance lint', desc: 'API design smells', open: () => setGovernanceOpen(true) },
        { icon: ClipboardCheck, label: 'Compliance packs', desc: 'PCI · HIPAA · GDPR · PSD2 posture', open: () => setComplianceOpen(true) },
        { icon: Scale, label: 'AI-era compliance', desc: 'EU AI Act · DORA posture', open: () => setAiComplianceOpen(true) },
        { icon: Wallet, label: 'AI cost / FinOps', desc: 'Estimate & cap token spend per run', open: () => setFinopsOpen(true) },
        { icon: HardDrive, label: 'On-prem / air-gapped', desc: 'Self-host + data-residency policy', open: () => setOnPremOpen(true) },
        { icon: FileCode2, label: 'Full-code & Monitoring-as-Code', desc: 'Owned code · local-first · no lock-in', open: () => setFullCodeOpen(true) },
      ],
    },
    {
      title: 'Execution, CI & lifecycle',
      accent: '#EC4899',
      blurb: 'Schedule, gate, report and manage tests across the delivery flow.',
      items: [
        { icon: Clock, label: 'Schedules & webhooks', desc: 'Recurring runs and Slack/Teams alerts', open: () => setAutomationOpen(true) },
        { icon: Rocket, label: 'CI / GitHub Action', desc: 'Trigger & gate runs from your pipeline', open: () => setCiOpen(true) },
        { icon: GitBranchPlus, label: 'Release gate', desc: 'Score a run → go / no-go to deploy', open: () => setReleaseGateOpen(true) },
        { icon: ListChecks, label: 'Parallel run queue', desc: 'Queue runs across concurrency slots', open: () => setExecQueueOpen(true) },
        { icon: MonitorSmartphone, label: 'Cloud browser lab', desc: 'Run UI checks on hosted browsers · matrix', open: () => setCloudLabOpen(true) },
        { icon: Combine, label: 'API + UI hybrid test', desc: 'Seed via API → verify in UI → cleanup', open: () => setHybridOpen(true) },
        { icon: Activity, label: 'Monitoring', desc: 'Always-on health / drift / coverage watcher', open: () => setMonitorOpen(true) },
        { icon: Gauge, label: 'Public status page', desc: 'Shareable uptime + SLO', open: () => setStatusPagesOpen(true) },
        { icon: HeartPulse, label: 'Failure → fix workflow', desc: 'Cluster → heal → PR, one guided flow', open: () => setFixWorkflowOpen(true) },
        { icon: Bug, label: 'Bug report', desc: 'Tracker-ready report from a failure', open: () => setBugReportOpen(true) },
        { icon: GitMerge, label: 'Remediation PR', desc: 'Open a GitHub/GitLab PR with a changeset', open: () => setRemediationOpen(true) },
        { icon: FolderGit2, label: 'Git-synced tests', desc: 'Push / pull the catalogue as test-as-code', open: () => setGitSyncOpen(true) },
        { icon: FileCheck2, label: 'Evidence export', desc: 'Compliance evidence → PDF', open: () => setEvidenceOpen(true) },
        { icon: ScrollText, label: 'Audit log', desc: 'Filter & export recorded actions', open: () => setAuditOpen(true) },
        { icon: Waypoints, label: 'Traceability matrix', desc: 'Requirement → case → defect', open: () => setTraceMatrixOpen(true) },
        { icon: ClipboardList, label: 'Test management', desc: 'Suites · plans · cycles · assignments', open: () => setTmOpen(true) },
        { icon: Share2, label: 'TM connectors', desc: 'TestRail · Xray · Zephyr · qTest export', open: () => setConnectorsOpen(true) },
        { icon: Stamp, label: 'Approvals', desc: 'Multi-stage release gating', open: () => setApprovalsOpen(true) },
        { icon: MessagesSquare, label: 'Collaboration', desc: 'Comments & version history', open: () => setCollabOpen(true) },
      ],
    },
  ], []);

  const totalTools = useMemo(() => GROUPS.reduce((n, g) => n + g.items.length, 0), [GROUPS]);
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => GROUPS
    .map((g) => ({ ...g, items: needle ? g.items.filter((t) => t.label.toLowerCase().includes(needle) || t.desc.toLowerCase().includes(needle)) : g.items }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => GROUP_ORDER.indexOf(a.title) - GROUP_ORDER.indexOf(b.title)), [GROUPS, needle]);
  const shownCount = filtered.reduce((n, g) => n + g.items.length, 0);

  // ── Toggle state: keys, counts, load, and persistence ──
  const allKeys = useMemo(() => GROUPS.flatMap((g) => g.items.map((t) => toolKey(t.label))), [GROUPS]);
  const enabledCount = allKeys.length - disabledTools.size;
  const allOn = disabledTools.size === 0;
  const isOn = (key: string) => !disabledTools.has(key);

  useEffect(() => {
    let alive = true;
    getApiToolToggles()
      .then((d) => {
        if (!alive) return;
        const off = new Set(Object.entries(d.tools || {}).filter(([, v]) => v === false).map(([k]) => k));
        setDisabledTools(off);
      })
      .catch(() => { /* default: everything enabled */ });
    return () => { alive = false; };
  }, []);

  /** Persist a new disabled-set to the tenant; optimistic, reverts on failure. */
  const persist = async (next: Set<string>) => {
    const prev = disabledTools;
    setDisabledTools(next);
    setSavingToggles(true);
    try {
      const map: Record<string, boolean> = {};
      for (const k of allKeys) map[k] = !next.has(k);
      await updateApiToolToggles(map);
    } catch (err: any) {
      setDisabledTools(prev); // revert
      toast.error('Could not save', err?.response?.data?.error || 'Please try again.');
    } finally {
      setSavingToggles(false);
    }
  };

  const toggleOne = (key: string) => {
    if (!isAdmin) return;
    const next = new Set(disabledTools);
    next.has(key) ? next.delete(key) : next.add(key);
    void persist(next);
  };

  const setAll = (value: boolean) => {
    if (!isAdmin) return;
    void persist(value ? new Set() : new Set(allKeys));
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1280px] mx-auto px-6 py-5">
        {/* Toolbar: what tools run against + search */}
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <p className="text-[12px] text-gray-500">
            {totalTools} tools · run against{' '}
            <span className="font-semibold text-gray-700">{selectedCount > 0 ? `${selectedCount} selected endpoint${selectedCount === 1 ? '' : 's'}` : endpoints.length ? 'all endpoints' : 'the catalogue'}</span>
          </p>
          <div className="relative ml-auto">
            <Search className="w-3.5 h-3.5 text-gray-300 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools…" className={`${FIELD} w-64 pl-8 py-1.5`} />
          </div>
        </div>

        {/* Universal master toggle — turn every tool on or off in one click */}
        <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-[#E9E5FF] bg-white px-4 py-3 shadow-sm">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-lg flex items-center justify-center bg-[#F5F3FF] border border-[#DDD6FE] flex-shrink-0">
              <Boxes className="w-4 h-4 text-[#7C3AED]" />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-gray-800">All tools</div>
              <div className="text-[11px] text-gray-500 mt-0.5">
                {enabledCount} of {allKeys.length} enabled
                {savingToggles && <span className="ml-1.5 text-[#7C3AED]">· saving…</span>}
                {!isAdmin && <span className="ml-1.5 text-gray-400">· admin only</span>}
              </div>
            </div>
          </div>
          <Switch checked={allOn} disabled={!isAdmin || savingToggles} onChange={() => setAll(!allOn)} label="Enable or disable all tools" />
        </div>

        {shownCount === 0 ? (
          <EmptyState icon={Search} title="No tools match" hint="Try another word — or clear the search to see every tool." />
        ) : (
          <div className="space-y-6">
            {filtered.map((g) => (
              <section key={g.title}>
                <div className="flex items-center gap-2 mb-2.5">
                  <span className="w-1.5 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: g.accent }} />
                  <h3 className="text-[12px] font-bold text-gray-800 tracking-tight">{g.title}</h3>
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full border text-[10px] font-semibold tabular-nums" style={{ color: g.accent, backgroundColor: `${g.accent}14`, borderColor: `${g.accent}33` }}>{g.items.length}</span>
                  {!needle && <p className="text-[11px] text-gray-400 truncate">{g.blurb}</p>}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
                  {g.items.map((t) => {
                    const key = toolKey(t.label);
                    const on = isOn(key);
                    return (
                      <div key={t.label} className="relative">
                        <button
                          type="button"
                          onClick={() => { if (on) t.open(); }}
                          disabled={!on}
                          aria-disabled={!on}
                          className={`group w-full flex items-start gap-3 p-3.5 pr-12 text-left rounded-xl border transition-all duration-200 ${
                            on
                              ? 'border-[#EFECFA] bg-white hover:border-[#C7BAF5] hover:shadow-lg hover:shadow-purple-500/10 hover:-translate-y-0.5 cursor-pointer'
                              : 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
                          }`}
                        >
                          <span
                            className={`w-9 h-9 rounded-lg flex items-center justify-center border flex-shrink-0 transition-all group-hover:scale-105 ${on ? '' : 'bg-gray-100 border-gray-200'}`}
                            style={on ? { backgroundColor: `${g.accent}1A`, borderColor: `${g.accent}40` } : undefined}
                          >
                            <t.icon className={`w-4 h-4 ${on ? '' : 'text-gray-400'}`} style={on ? { color: g.accent } : undefined} />
                          </span>
                          <span className="min-w-0">
                            <span className={`flex items-center gap-1.5 text-[13px] font-semibold transition-colors ${on ? 'text-gray-800 group-hover:text-[#7C3AED]' : 'text-gray-500'}`}>
                              <span className="truncate">{t.label}</span>
                              {DIFFERENTIATORS.has(t.label) && (
                                <span title="Competitive white-space — few or no rivals cover this" className="inline-flex items-center px-1 py-px rounded text-[8px] font-bold tracking-wide leading-none flex-shrink-0 text-[#B45309] bg-[#FEF3C7] border border-[#FDE68A]">EDGE</span>
                              )}
                            </span>
                            <span className="block text-[11px] text-gray-500 leading-snug mt-0.5">{t.desc}</span>
                          </span>
                        </button>
                        <div className="absolute top-2.5 right-2.5" title={isAdmin ? (on ? 'Disable this tool' : 'Enable this tool') : 'Admin only'}>
                          <Switch checked={on} disabled={!isAdmin || savingToggles} onChange={() => toggleOne(key)} label={`${on ? 'Disable' : 'Enable'} ${t.label}`} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ── Tool modals (one renders at a time) ── */}
      {contractOpen && <ContractCheck endpoints={ep} onClose={() => setContractOpen(false)} />}
      {securityOpen && <SecurityScan endpoints={ep} onClose={() => setSecurityOpen(false)} />}
      {owaspOpen && <OwaspCompliance endpoints={ep} onClose={() => setOwaspOpen(false)} />}
      {fuzzOpen && <FuzzTest endpoints={ep} onClose={() => setFuzzOpen(false)} />}
      {loadOpen && <LoadTest endpoints={ep} onClose={() => setLoadOpen(false)} />}
      {loadProfileOpen && <LoadProfile endpoints={ep} onClose={() => setLoadProfileOpen(false)} />}
      {governanceOpen && <GovernanceCheck endpoints={ep} onClose={() => setGovernanceOpen(false)} />}
      {coverageOpen && <Coverage endpoints={ep} scenarios={scenarios} onClose={() => setCoverageOpen(false)} />}
      {baselineOpen && <BaselineDiff endpoints={ep} onClose={() => setBaselineOpen(false)} />}
      {authzOpen && <AuthzScan endpoints={ep} onClose={() => setAuthzOpen(false)} />}
      {specDiffOpen && <SpecDiff onClose={() => setSpecDiffOpen(false)} />}
      {replayOpen && <ReplayTest endpoints={ep} onClose={() => setReplayOpen(false)} />}
      {llmTestingOpen && <LlmTesting endpoints={ep} onClose={() => setLlmTestingOpen(false)} />}
      {autopilotOpen && <Autopilot endpoints={ep} onClose={() => setAutopilotOpen(false)} />}
      {covGuideOpen && <CoverageGuided endpoints={ep} onClose={() => setCovGuideOpen(false)} />}
      {smartGenOpen && <SmartGeneration endpoints={ep} onClose={() => setSmartGenOpen(false)} />}
      {mutationLiveOpen && <MutationLive endpoints={ep} onClose={() => setMutationLiveOpen(false)} />}
      {authzDeepOpen && <AuthzDeep endpoints={ep} onClose={() => setAuthzDeepOpen(false)} />}
      {unifiedOpen && <UnifiedCanvas endpoints={ep} onClose={() => setUnifiedOpen(false)} />}
      {dataCorrectnessOpen && <DataCorrectness endpoints={ep} onClose={() => setDataCorrectnessOpen(false)} />}
      {modelGenOpen && <ModelGen endpoints={ep} onClose={() => setModelGenOpen(false)} />}
      {stepGroupsOpen && <StepGroups endpoints={ep} onClose={() => setStepGroupsOpen(false)} />}
      {distLoadOpen && <DistributedLoad endpoints={ep} onClose={() => setDistLoadOpen(false)} />}
      {fixWorkflowOpen && <FixWorkflow endpoints={ep} onClose={() => setFixWorkflowOpen(false)} />}
      {dataDrivenOpen && <DataDriven endpoints={ep} onClose={() => setDataDrivenOpen(false)} />}
      {automationOpen && <RunAutomation endpoints={ep} onClose={() => setAutomationOpen(false)} />}
      {integrationOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={() => setIntegrationOpen(false)}>
          <div className={`${CARD} w-full max-w-5xl h-[88vh] overflow-hidden`} onClick={(e) => e.stopPropagation()}>
            <IntegrationTestsView
              endpoints={ep}
              onOpenCatalogue={() => { setIntegrationOpen(false); onNavigate?.('endpoints'); }}
              onClose={() => setIntegrationOpen(false)}
            />
          </div>
        </div>
      )}
      {nlOpen && (
        <NlAuthor
          endpoints={ep}
          onApply={(brief) => { catalog.setStrategy({ coverage: brief.coverage, layers: brief.layers as StrategyLayerId[], requirements: brief.requirements }); toast.success('Strategy updated', `${brief.coverage} coverage · ${brief.layers.length} layer${brief.layers.length === 1 ? '' : 's'} · brief applied`); }}
          onClose={() => setNlOpen(false)}
        />
      )}
      {driftOpen && (
        <ContractDrift
          endpoints={ep}
          onAdopt={(id, patch) => { catalog.updateEndpoint(id, patch); toast.success('Catalogue updated', 'Adopted the live contract for this endpoint.'); }}
          onClose={() => setDriftOpen(false)}
        />
      )}
      {asyncOpen && <AsyncProbe initialUrl={(ep[0] || endpoints[0])?.url || ''} onClose={() => setAsyncOpen(false)} />}
      {captureOpen && <TrafficCapture catalog={catalog} onClose={() => setCaptureOpen(false)} />}
      {mockOpen && <MockServer endpoints={ep} onClose={() => setMockOpen(false)} />}
      {gapsOpen && <CoverageGaps catalog={catalog} onClose={() => setGapsOpen(false)} />}
      {semanticOpen && <SemanticAssert endpoints={ep} onClose={() => setSemanticOpen(false)} />}
      {callbackOpen && <CallbackVerify onClose={() => setCallbackOpen(false)} />}
      {flowOpen && <FlowBuilder catalog={catalog} onClose={() => setFlowOpen(false)} />}
      {chatTestOpen && <ChatToTest endpoints={ep} onClose={() => setChatTestOpen(false)} />}
      {maintenanceOpen && <AutoMaintenance catalog={catalog} onClose={() => setMaintenanceOpen(false)} />}
      {synthOpen && <SyntheticData endpoints={ep} onClose={() => setSynthOpen(false)} />}
      {eventsOpen && <EventGrpc onClose={() => setEventsOpen(false)} />}
      {geoOpen && <GeoLoad endpoints={ep} onClose={() => setGeoOpen(false)} />}
      {collabOpen && <Collaboration endpoints={ep} onClose={() => setCollabOpen(false)} />}
      {extensionOpen && <ExtensionRecorder onClose={() => setExtensionOpen(false)} />}
      {providersOpen && <LlmProviders onClose={() => setProvidersOpen(false)} />}
      {mcpOpen && <McpServer onClose={() => setMcpOpen(false)} />}
      {virtualOpen && <VirtualService onClose={() => setVirtualOpen(false)} />}
      {pactOpen && <PactBroker onClose={() => setPactOpen(false)} />}
      {chaosOpen && <ChaosTest endpoints={ep} onClose={() => setChaosOpen(false)} />}
      {traceOpen && <TraceCorrelation endpoints={ep} onClose={() => setTraceOpen(false)} />}
      {asyncApiOpen && <AsyncApiContract onClose={() => setAsyncApiOpen(false)} />}
      {testIntelOpen && <TestIntel endpoints={ep} onClose={() => setTestIntelOpen(false)} />}
      {cloudLoadOpen && <CloudLoad endpoints={ep} onClose={() => setCloudLoadOpen(false)} />}
      {dbValidateOpen && <DbValidate onClose={() => setDbValidateOpen(false)} />}
      {complianceOpen && <CompliancePacks endpoints={ep} onClose={() => setComplianceOpen(false)} />}
      {oauthOpen && <OAuthSecrets onClose={() => setOauthOpen(false)} />}
      {accessOpen && <AccessControl onClose={() => setAccessOpen(false)} />}
      {remediationOpen && <RemediationPr onClose={() => setRemediationOpen(false)} />}
      {gitSyncOpen && <GitSync endpoints={ep} onClose={() => setGitSyncOpen(false)} />}
      {onPremOpen && <OnPremDeploy endpoints={ep} onClose={() => setOnPremOpen(false)} />}
      {finopsOpen && <FinOpsMetering endpoints={ep} onClose={() => setFinopsOpen(false)} />}
      {aiComplianceOpen && <AiCompliance endpoints={ep} onClose={() => setAiComplianceOpen(false)} />}
      {fullCodeOpen && <FullCodeExport endpoints={ep} onClose={() => setFullCodeOpen(false)} />}
      {govLintOpen && <GovernanceLint endpoints={ep} onClose={() => setGovLintOpen(false)} />}
      {specAuditOpen && <SpecAudit endpoints={ep} onClose={() => setSpecAuditOpen(false)} />}
      {seqFuzzOpen && <SeqFuzz endpoints={ep} onClose={() => setSeqFuzzOpen(false)} />}
      {dataClassifyOpen && <DataClassify endpoints={ep} onClose={() => setDataClassifyOpen(false)} />}
      {llmEvalOpen && <LlmEval onClose={() => setLlmEvalOpen(false)} />}
      {proxyOpen && <ProxyServer endpoints={ep} onClose={() => setProxyOpen(false)} />}
      {statusPagesOpen && <StatusPages endpoints={ep} onClose={() => setStatusPagesOpen(false)} />}
      {coworkerOpen && <AiCoworker endpoints={ep} onClose={() => setCoworkerOpen(false)} />}
      {storyOpen && (
        <StoryGen
          endpoints={ep}
          environment={environment}
          onMineEndpoints={async (file) => {
            // Reuse the existing AI file-import so a BRD/FRD dropped into the
            // story agent also yields runnable endpoints in the catalogue.
            const res = await importApiFiles([file], 'auto');
            const { added, duplicates, total } = catalog.addEndpoints(res.endpoints || [], {
              method: 'file', name: file.name, format: res.format || 'document', parser: res.parser || 'llm', profile: res.profile,
            });
            return { added, duplicates, total };
          }}
          onApply={(brief, approvedUrls) => {
            catalog.setStrategy({ coverage: brief.coverage, layers: brief.layers as StrategyLayerId[], requirements: brief.requirements });
            // A rejected requirement must not be planned, so the run is narrowed
            // to the endpoints that cleared review — not just its brief text.
            const approvedIds = catalog.endpoints.filter((e) => approvedUrls.includes(e.url)).map((e) => e.id);
            if (approvedIds.length) { catalog.clearSelection(); catalog.selectMany(approvedIds, true); }
            toast.success('Strategy updated', `${brief.coverage} coverage · ${brief.layers.length} layer${brief.layers.length === 1 ? '' : 's'} · ${approvedIds.length} approved endpoint${approvedIds.length === 1 ? '' : 's'}`);
          }}
          onClose={() => setStoryOpen(false)}
        />
      )}
      {multimodalOpen && (
        <Multimodal
          endpoints={ep}
          onApply={(brief) => { catalog.setStrategy({ coverage: brief.coverage, layers: brief.layers as StrategyLayerId[], requirements: brief.requirements }); toast.success('Strategy updated', `${brief.coverage} coverage · ${brief.layers.length} layer${brief.layers.length === 1 ? '' : 's'} · artifacts applied`); }}
          onClose={() => setMultimodalOpen(false)}
        />
      )}
      {optimizerOpen && <SuiteOptimizer endpoints={ep} onClose={() => setOptimizerOpen(false)} />}
      {impactOpen && <ImpactAnalysis endpoints={ep} onClose={() => setImpactOpen(false)} />}
      {healOpen && <SemanticHeal endpoints={ep} onClose={() => setHealOpen(false)} />}
      {bugReportOpen && <BugReport endpoints={ep} onClose={() => setBugReportOpen(false)} />}
      {monitorOpen && <Monitoring endpoints={ep} onClose={() => setMonitorOpen(false)} />}
      {profilesOpen && <DataProfiles onClose={() => setProfilesOpen(false)} />}
      {hybridOpen && <HybridTest endpoints={ep} onClose={() => setHybridOpen(false)} />}
      {releaseGateOpen && <ReleaseGate onClose={() => setReleaseGateOpen(false)} />}
      {ciOpen && <CiPipeline endpoints={ep} onClose={() => setCiOpen(false)} />}
      {execQueueOpen && <ExecQueue endpoints={ep} onClose={() => setExecQueueOpen(false)} />}
      {cloudLabOpen && <CloudLab onClose={() => setCloudLabOpen(false)} />}
      {tmOpen && <TestManagement endpoints={ep} onClose={() => setTmOpen(false)} />}
      {traceMatrixOpen && <Traceability endpoints={ep} onClose={() => setTraceMatrixOpen(false)} />}
      {connectorsOpen && <TmConnectors onClose={() => setConnectorsOpen(false)} />}
      {approvalsOpen && <Approvals onClose={() => setApprovalsOpen(false)} />}
      {auditOpen && <AuditLog onClose={() => setAuditOpen(false)} />}
      {evidenceOpen && <EvidenceExport onClose={() => setEvidenceOpen(false)} />}
    </div>
  );
}
