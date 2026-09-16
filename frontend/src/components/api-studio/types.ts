/**
 * API Studio — shared types.
 *
 * The studio drives one linear run: design scenarios → render specs → execute →
 * heal → report. Everything below describes a step of that run or one of its
 * artifacts; nothing here is chat- or wizard-shaped.
 */

/** Where the run currently is. `review` is the gate the user must pass through. */
export type Phase =
  | 'idle'        // nothing run yet — the request panel is the whole story
  | 'generating'  // designing scenarios
  | 'review'      // GATE: scenarios are on screen, waiting for the user to continue
  | 'automating'  // rendering the Playwright request specs + saving the run
  | 'executing'   // running the suite
  | 'healing'     // repairing failing specs and re-running
  | 'report'      // finished — the report is on screen
  | 'failed';     // the run stopped on an error; the message is in `error`

export type StageKey = 'scenarios' | 'automate' | 'execute' | 'heal' | 'report';
export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface Stage {
  key: StageKey;
  label: string;
  /** One-line description of what this stage does, shown before it runs. */
  hint: string;
  status: StageStatus;
  /** Live detail — what it is doing now, or what it produced. */
  detail: string;
  startedAt?: number;
  durationMs?: number;
}

export interface HeaderPair { key: string; value: string }

/**
 * One row of the query-param editor. `enabled` is the Bruno/Postman checkbox: a
 * disabled row stays in the table for easy re-use but is left out of the URL.
 * The URL string itself is always the source of truth — these rows are a
 * structured view over its query string that writes back to it.
 */
export interface QueryParamRow { key: string; value: string; enabled: boolean }

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey';

/** The HTTP-level detail the generator attaches to each designed scenario. */
export interface ApiCaseMeta {
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  queryParams: string;
  requestBody?: string;
  expectedStatus: string;
}

/** One designed scenario, as it comes back from the generator. */
export interface Scenario {
  id: string;
  title: string;
  description?: string;
  feature?: string;
  /** positive | negative | security | data | edge | api — drives the category chip. */
  type: string;
  priority: string;
  severity?: string;
  tags?: string[];
  /** Human-readable assertion list, one per rendered `expect(...)`. */
  steps: string[];
  expectedResult?: string;
  precondition?: string;
  api?: ApiCaseMeta;
  /** Everything else the backend sent, carried through to save/execute intact. */
  raw: any;
}

/**
 * A generated service object — the API half of the Page Object Model. One class
 * per feature, owning the URL, headers and payload of that feature's requests;
 * specs call its methods and assert on the response. Carried alongside the
 * specs through execution, healing and the push to the repo, because a spec
 * that arrives without its service object cannot even be imported.
 */
export interface ServiceObject {
  /** Repo-relative path, e.g. `src/api/users/users.api.ts`. */
  path: string;
  className: string;
  module: string;
  methods: string[];
  code: string;
}

/** A rendered Playwright request spec. */
export interface Spec {
  testCaseId: string;
  fileName: string;
  code: string;
  path?: string;
}

export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'not_run';

/** One row of the execution table. */
export interface RunRow {
  testCaseId: string;
  name: string;
  status: RunStatus;
  duration: string;
  error?: string;
  /** Set once healing has touched this case. */
  healed?: boolean;
  /** What the healer did — or why it deliberately did nothing. */
  healNote?: string;
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

export interface LogLine {
  id: number;
  at: number;
  stage: StageKey | 'run';
  level: LogLevel;
  text: string;
}

/**
 * Progress of the "push to repo" action. The finished shape carries the URL the
 * push produced — a PR/MR when the connected repo publishes through one, or the
 * branch itself when it commits directly — so the button can link straight to it
 * instead of telling the user to go and find it.
 */
export type PushState =
  | { status: 'idle' }
  | { status: 'pushing' }
  | { status: 'done'; url: string; branch: string; mode: 'pr' | 'direct'; fileCount: number; repo: string }
  | { status: 'error'; error: string };

export interface RunReport {
  total: number;
  passed: number;
  failed: number;
  notRun: number;
  healed: number;
  passRate: number;
  durationMs: number;
  /** Allure report for this run, when one was published. */
  reportUrl?: string;
}
