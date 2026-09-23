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
import { useState } from 'react';
import {
  Blocks, ClipboardList, Webhook, Bot, Gauge, MonitorSmartphone, GitBranch, ExternalLink,
} from 'lucide-react';
import { CARD, TILE, TILE_ACTIVE, MUTED_CHIP, CHIP_3D } from '../format';

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

/** A tool's brand logo, falling back to its category icon if the logo 404s. */
function ToolLogo({ slug, Icon }: { slug?: string; Icon: React.ElementType }) {
  const [failed, setFailed] = useState(false);
  if (slug && !failed) {
    return <img src={`https://cdn.simpleicons.org/${slug}`} alt="" className="w-4 h-4" onError={() => setFailed(true)} />;
  }
  return <Icon className="w-4 h-4 text-[#7C3AED]" />;
}

export default function IntegrationsView() {
  const total = CATEGORIES.reduce((n, c) => n + c.tools.length, 0);
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-6 py-5 space-y-5">
        {/* Intro */}
        <div className={`${CARD} relative overflow-hidden p-4`}>
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#8B5CF6] to-[#6366F1] shadow-[0_2px_6px_rgba(124,58,237,0.45)]" />
          <div className="flex items-start gap-3">
            <span className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${TILE_ACTIVE} shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_3px_0_0_#4338CA,0_10px_20px_-8px_rgba(124,58,237,0.6)]`}>
              <Blocks className="w-5 h-5 text-white" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold text-gray-900">Testing tools</h2>
              <p className="mt-1 text-[12px] text-gray-500 leading-relaxed">
                The QA tool-chain IntelliQE works with — {total} tools across test management, API testing, automation, performance, the device clouds and CI/CD. More integrations arrive regularly.
              </p>
            </div>
          </div>
        </div>

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
                {cat.tools.map((tool) => (
                  <div key={tool.name} className={`${CARD} p-3`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${TILE}`}>
                        <ToolLogo slug={tool.slug} Icon={cat.icon} />
                      </span>
                      <span className="text-[12.5px] font-semibold text-gray-800 leading-tight min-w-0 truncate">{tool.name}</span>
                      <span className={`ml-auto inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-semibold flex-shrink-0 ${MUTED_CHIP} ${CHIP_3D}`}>Soon</span>
                    </div>
                    <p className="mt-1.5 text-[10.5px] text-gray-500 truncate">{tool.blurb}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {/* Where the wired requirement sources live */}
        <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <ExternalLink className="w-3 h-3" />
          JIRA, Azure DevOps, Confluence and SharePoint are connected under System Configuration → Integrations.
        </p>
      </div>
    </div>
  );
}
