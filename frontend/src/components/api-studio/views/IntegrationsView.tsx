/**
 * IntegrationsView — the testing-tools catalogue.
 *
 * A single place that shows the QA tools IntelliQE works with, across the whole
 * testing stack: test management, API testing, automation frameworks,
 * performance, the device clouds and CI/CD. It is a directory, not a connection
 * screen — the requirement sources that are already wired (JIRA, Azure DevOps,
 * Confluence, SharePoint) are set up under System Configuration → Integrations,
 * so they are not repeated here.
 */
import { useEffect, useState } from 'react';
import {
  ClipboardList, Webhook, Bot, Gauge, MonitorSmartphone, GitBranch, ExternalLink, Plug,
} from 'lucide-react';
import { CARD, TILE, MUTED_CHIP, CHIP_3D } from '../format';
import { listTmConnectors, listCiConnectors, listApiTestConnectors, type TmConnector, type TmVendor, type CiConnector, type CiVendor, type ApiTestConnector, type ApiTestVendor } from '@/services/api';
import TmConnectors from '../TmConnectors';
import CiCdConnectors from '../CiCdConnectors';
import ApiTestConnectors from '../ApiTestConnectors';

interface Tool {
  name: string;
  blurb: string;
  /** simpleicons.org slug — rendered in the tool's brand colour, with a
   *  graceful fall back to the category icon when the slug has no logo. */
  slug?: string;
}
interface Category {
  key: string;
  title: string;
  icon: React.ElementType;
  tools: Tool[];
}

/** The catalogue, grouped the way a QA team thinks about its tool-chain. */
const CATEGORIES: Category[] = [
  {
    key: 'test-management', title: 'Test Management', icon: ClipboardList,
    tools: [
      { name: 'TestRail', blurb: 'Test cases, suites & runs' },
      { name: 'Zephyr Scale', blurb: 'Test cases & test cycles' },
      { name: 'Xray', blurb: 'Tests & executions in Jira' },
      { name: 'qTest', blurb: 'Test cases & requirements' },
      { name: 'PractiTest', blurb: 'End-to-end test management' },
      { name: 'Testmo', blurb: 'Test cases & automation runs' },
    ],
  },
  {
    key: 'api-testing', title: 'API Testing', icon: Webhook,
    tools: [
      { name: 'Postman', blurb: 'Collections & workspaces', slug: 'postman' },
      { name: 'SoapUI / ReadyAPI', blurb: 'REST & SOAP functional tests' },
      { name: 'Insomnia', blurb: 'API requests & collections', slug: 'insomnia' },
      { name: 'Bruno', blurb: 'Git-native API collections', slug: 'bruno' },
      { name: 'Hoppscotch', blurb: 'Open-source API client', slug: 'hoppscotch' },
      { name: 'Karate', blurb: 'BDD-style API test suites' },
      { name: 'REST Assured', blurb: 'Java REST test framework' },
      { name: 'Pact', blurb: 'Consumer-driven contract tests' },
    ],
  },
  {
    key: 'automation', title: 'Test Automation', icon: Bot,
    tools: [
      { name: 'Selenium', blurb: 'Browser automation grid', slug: 'selenium' },
      { name: 'Playwright', blurb: 'Cross-browser end-to-end', slug: 'playwright' },
      { name: 'Cypress', blurb: 'Front-end E2E testing', slug: 'cypress' },
      { name: 'Katalon', blurb: 'Low-code test automation' },
      { name: 'Appium', blurb: 'Mobile app automation', slug: 'appium' },
      { name: 'Robot Framework', blurb: 'Keyword-driven automation', slug: 'robotframework' },
      { name: 'WebdriverIO', blurb: 'Next-gen WebDriver tests', slug: 'webdriverio' },
      { name: 'TestCafe', blurb: 'No-WebDriver E2E tests', slug: 'testcafe' },
    ],
  },
  {
    key: 'performance', title: 'Performance & Load', icon: Gauge,
    tools: [
      { name: 'Apache JMeter', blurb: 'Load & performance tests', slug: 'apachejmeter' },
      { name: 'k6', blurb: 'Developer-centric load tests', slug: 'k6' },
      { name: 'Gatling', blurb: 'High-throughput load tests', slug: 'gatling' },
      { name: 'Locust', blurb: 'Python-scripted load tests' },
      { name: 'BlazeMeter', blurb: 'Continuous performance cloud' },
      { name: 'LoadRunner', blurb: 'Enterprise load testing' },
    ],
  },
  {
    key: 'device-cloud', title: 'Cross-Browser & Device Cloud', icon: MonitorSmartphone,
    tools: [
      { name: 'BrowserStack', blurb: 'Real browsers & devices', slug: 'browserstack' },
      { name: 'Sauce Labs', blurb: 'Cross-browser test cloud', slug: 'saucelabs' },
      { name: 'LambdaTest', blurb: 'Scalable browser grid' },
      { name: 'Perfecto', blurb: 'Web & mobile device cloud' },
    ],
  },
  {
    key: 'ci-cd', title: 'CI/CD Pipelines', icon: GitBranch,
    tools: [
      { name: 'Jenkins', blurb: 'Pipelines & scheduled runs', slug: 'jenkins' },
      { name: 'GitHub Actions', blurb: 'Workflow-triggered tests', slug: 'github' },
      { name: 'GitLab CI', blurb: 'Pipeline-driven testing', slug: 'gitlab' },
      { name: 'Azure Pipelines', blurb: 'Build & release automation', slug: 'azuredevops' },
      { name: 'CircleCI', blurb: 'Cloud CI test runs', slug: 'circleci' },
    ],
  },
];

/**
 * Tools whose live two-way connector already exists (api-tm-connectors.service).
 * A card for one of these opens the real connect → test → export/import flow,
 * with the vendor preselected — the rest of the catalogue stays a directory.
 */
const LIVE_VENDOR: Record<string, TmVendor> = {
  TestRail: 'testrail', Xray: 'xray', 'Zephyr Scale': 'zephyr', qTest: 'qtest',
};

/** CI/CD tools whose live connector exists (api-cicd-connectors.service). */
const LIVE_CI_VENDOR: Record<string, CiVendor> = {
  Jenkins: 'jenkins', 'GitHub Actions': 'github', 'GitLab CI': 'gitlab', 'Azure Pipelines': 'azuredevops', CircleCI: 'circleci',
};

/** API-testing tools whose live connector exists (api-apitest-connectors.service). */
const LIVE_AT_VENDOR: Record<string, ApiTestVendor> = {
  Postman: 'postman', 'SoapUI / ReadyAPI': 'soapui', Insomnia: 'insomnia', Bruno: 'bruno',
  Hoppscotch: 'hoppscotch', Karate: 'karate', 'REST Assured': 'restassured', Pact: 'pact',
};

/** A tool's brand logo, falling back to its category icon if the logo 404s. */
function ToolLogo({ slug, Icon }: { slug?: string; Icon: React.ElementType }) {
  const [failed, setFailed] = useState(false);
  if (slug && !failed) {
    return <img src={`https://cdn.simpleicons.org/${slug}`} alt="" className="w-4 h-4" onError={() => setFailed(true)} />;
  }
  return <Icon className="w-4 h-4 text-[#7C3AED]" />;
}

export default function IntegrationsView() {
  const [connectors, setConnectors] = useState<TmConnector[]>([]);
  const [connectVendor, setConnectVendor] = useState<TmVendor | null>(null);
  const [ciConnectors, setCiConnectors] = useState<CiConnector[]>([]);
  const [connectCiVendor, setConnectCiVendor] = useState<CiVendor | null>(null);
  const [atConnectors, setAtConnectors] = useState<ApiTestConnector[]>([]);
  const [connectAtVendor, setConnectAtVendor] = useState<ApiTestVendor | null>(null);

  /** The live status behind the TestRail/Xray/Zephyr/qTest cards — a convenience,
      so a failure just leaves them showing "Live" rather than "Connected". */
  const loadConnectors = () => { listTmConnectors().then(setConnectors).catch(() => { /* status is best-effort */ }); };
  const loadCiConnectors = () => { listCiConnectors().then(setCiConnectors).catch(() => { /* status is best-effort */ }); };
  const loadAtConnectors = () => { listApiTestConnectors().then(setAtConnectors).catch(() => { /* status is best-effort */ }); };
  useEffect(() => { loadConnectors(); loadCiConnectors(); loadAtConnectors(); }, []);

  return (
    <div className="max-w-[1180px] space-y-5">
        {/* Catalogue */}
        {CATEGORIES.map((cat) => {
          const CatIcon = cat.icon;
          return (
            <div key={cat.key}>
              <div className="flex items-center gap-2 mb-2.5">
                <span className={`w-6 h-6 rounded-md flex items-center justify-center ${TILE}`}><CatIcon className="w-3.5 h-3.5 text-[#7C3AED]" /></span>
                <h3 className="text-[12px] font-semibold text-gray-700 uppercase tracking-wide">{cat.title}</h3>
                <span className="text-[11px] text-gray-400 tabular-nums">{cat.tools.length}</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
                {cat.tools.map((tool) => {
                  const vendor = LIVE_VENDOR[tool.name];
                  const ciVendor = LIVE_CI_VENDOR[tool.name];
                  const atVendor = LIVE_AT_VENDOR[tool.name];
                  const isLive = !!vendor || !!ciVendor || !!atVendor;
                  const connected = vendor
                    ? connectors.some((c) => c.vendor === vendor && c.enabled)
                    : ciVendor
                      ? ciConnectors.some((c) => c.vendor === ciVendor && c.enabled)
                      : atVendor
                        ? atConnectors.some((c) => c.vendor === atVendor && c.enabled)
                        : false;
                  const onConnect = () => { if (vendor) setConnectVendor(vendor); else if (ciVendor) setConnectCiVendor(ciVendor); else if (atVendor) setConnectAtVendor(atVendor); };
                  return (
                  <div key={tool.name} className={`${CARD} p-3 flex flex-col ${isLive ? 'border-[#E4DDF8]' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${TILE}`}>
                        <ToolLogo slug={tool.slug} Icon={cat.icon} />
                      </span>
                      <span className="text-[12.5px] font-semibold text-gray-800 leading-tight min-w-0 truncate">{tool.name}</span>
                      {isLive ? (
                        connected ? (
                          <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold flex-shrink-0 text-[#15803D] bg-[#DCFCE7] border-[#BBF7D0]"><span className="w-1.5 h-1.5 rounded-full bg-[#22C55E]" />Connected</span>
                        ) : (
                          <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold flex-shrink-0 text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]"><span className="w-1.5 h-1.5 rounded-full bg-[#A78BFA]" />Live</span>
                        )
                      ) : (
                        <span className={`ml-auto inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-semibold flex-shrink-0 ${MUTED_CHIP} ${CHIP_3D}`}>Soon</span>
                      )}
                    </div>
                    <p className="mt-1.5 text-[10.5px] text-gray-500 truncate">{tool.blurb}</p>
                    {isLive && (
                      <button
                        type="button"
                        onClick={onConnect}
                        className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white text-[11px] font-semibold shadow-sm hover:shadow hover:-translate-y-px transition-all active:translate-y-0 focus:outline-none focus:ring-2 focus:ring-[#A5B4FC]"
                      >
                        <Plug className="w-3.5 h-3.5" />{connected ? 'Manage connection' : 'Connect'}
                      </button>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Where the wired requirement sources live */}
        <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <ExternalLink className="w-3 h-3" />
          JIRA, Azure DevOps, Confluence and SharePoint are wired up under the Code Repositories and Requirement Sources tabs.
        </p>

        {connectVendor && <TmConnectors initialVendor={connectVendor} onClose={() => { setConnectVendor(null); loadConnectors(); }} />}
        {connectCiVendor && <CiCdConnectors initialVendor={connectCiVendor} onClose={() => { setConnectCiVendor(null); loadCiConnectors(); }} />}
        {connectAtVendor && <ApiTestConnectors initialVendor={connectAtVendor} onClose={() => { setConnectAtVendor(null); loadAtConnectors(); }} />}
    </div>
  );
}
