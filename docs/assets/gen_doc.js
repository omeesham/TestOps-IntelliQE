const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  Header, Footer, AlignmentType, PageOrientation, LevelFormat, HeadingLevel,
  BorderStyle, WidthType, ShadingType, VerticalAlign, PageNumber, PageBreak,
  TableOfContents, TabStopType, TabStopPosition,
} = require("docx");

const NAVY = "1F4E79", BLUE = "2E75B6", LIGHT = "D6E4F0", GREY = "55636E", ROW = "F2F6FB";
const border = (c = "CCCCCC") => ({ style: BorderStyle.SINGLE, size: 1, color: c });
const allB = (c) => ({ top: border(c), bottom: border(c), left: border(c), right: border(c) });
const M = { top: 90, bottom: 90, left: 130, right: 130 };

function hcell(text, w, fill = NAVY) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders: allB("FFFFFF"), margins: M,
    shading: { fill, type: ShadingType.CLEAR }, verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: "FFFFFF", size: 19 })] })],
  });
}
function cell(runs, w, fill) {
  const kids = Array.isArray(runs) ? runs : [new TextRun({ text: String(runs), size: 19 })];
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders: allB(), margins: M,
    shading: fill ? { fill, type: ShadingType.CLEAR } : undefined, verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: kids })],
  });
}
function table(widths, headers, rows, headFill = NAVY) {
  const total = widths.reduce((a, b) => a + b, 0);
  const trs = [new TableRow({ tableHeader: true, children: headers.map((h, i) => hcell(h, widths[i], headFill)) })];
  rows.forEach((r, ri) => {
    trs.push(new TableRow({
      children: r.map((c, i) => cell(c, widths[i], ri % 2 ? ROW : "FFFFFF")),
    }));
  });
  return new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: widths, rows: trs });
}
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const P = (runs, opts = {}) => new Paragraph({ spacing: { after: 120 }, ...opts,
  children: Array.isArray(runs) ? runs : [new TextRun({ text: runs, size: 22 })] });
const bullet = (runs) => new Paragraph({ numbering: { reference: "b", level: 0 }, spacing: { after: 60 },
  children: Array.isArray(runs) ? runs : [new TextRun({ text: runs, size: 22 })] });
const b = (t) => new TextRun({ text: t, bold: true, size: 22 });
const r = (t) => new TextRun({ text: t, size: 22 });
const SP = (h = 80) => new Paragraph({ spacing: { after: h }, children: [] });

const img = fs.readFileSync("C:/Dev/JBSIntelliQE/docs/assets/er-diagram.png");

const styles = {
  default: { document: { run: { font: "Arial", size: 22, color: "222222" } } },
  paragraphStyles: [
    { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
      run: { size: 30, bold: true, color: NAVY, font: "Arial" },
      paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 0,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BLUE, space: 4 } } } },
    { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
      run: { size: 24, bold: true, color: BLUE, font: "Arial" },
      paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 } },
  ],
};

const numbering = { config: [
  { reference: "b", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 460, hanging: 260 } } } }] },
] };

const footer = new Footer({ children: [new Paragraph({
  tabStops: [{ type: TabStopType.RIGHT, position: 9360 }],
  children: [
    new TextRun({ text: "JBSIntelliQE — Architecture & Data Model Overview  |  Confidential", size: 16, color: GREY }),
    new TextRun({ text: "\tPage ", size: 16, color: GREY }),
    new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GREY }),
  ],
})] });

// ---------- COVER ----------
const cover = [
  SP(2200),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [new TextRun({ text: "JADE BUSINESS SOLUTIONS", bold: true, size: 26, color: BLUE, characterSpacing: 60 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
    children: [new TextRun({ text: "JBSIntelliQE", bold: true, size: 76, color: NAVY })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 },
    children: [new TextRun({ text: "Platform Architecture & Data Model", bold: true, size: 40, color: "333333" })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [new TextRun({ text: "A Leadership Overview", italics: true, size: 26, color: GREY })] }),
  SP(400),
  new Paragraph({ alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "AI-Powered QA Automation Platform", size: 22, color: GREY })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40 },
    children: [new TextRun({ text: "Prepared June 2026  ·  Confidential", size: 20, color: GREY })] }),
  new Paragraph({ children: [new PageBreak()] }),
];

// ---------- TOC ----------
const toc = [
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Contents")] }),
  new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
  new Paragraph({ children: [new PageBreak()] }),
];

// ---------- BODY ----------
const body = [
  H1("1.  Executive Summary"),
  P([b("JBSIntelliQE"), r(" is Jade Business Solutions’ AI-powered quality-assurance platform. It uses a team of Claude AI agents to automatically read software requirements, design test cases, write automated test scripts, run them, and even repair tests when they break — work that traditionally requires a team of manual QA engineers.")]),
  P([r("The platform is "), b("multi-tenant"), r(": a single deployment serves many customer organizations, with each customer’s data fully isolated from every other. This document explains, in plain terms, the building blocks of the platform and the database that underpins it, and includes a one-page visual map (Entity-Relationship diagram) of how the data fits together.")]),
  new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [3120, 3120, 3120],
    rows: [ new TableRow({ children: [
      statCell("3", "Runtime services\n(API, Worker, Web app)"),
      statCell("22", "Database tables\nin 7 groups"),
      statCell("6", "Specialised AI agents\nin the pipeline"),
    ] }) ] }),

  H1("2.  What the Platform Does"),
  P("In everyday language, the platform turns a written requirement into working, self-maintaining automated tests:"),
  bullet([b("Understands the application "), r("— an AI agent explores the live web app to learn how each page works.")]),
  bullet([b("Plans the testing "), r("— it designs a comprehensive set of test cases covering the feature.")]),
  bullet([b("Writes the automation "), r("— it generates ready-to-run Playwright test scripts.")]),
  bullet([b("Runs and reports "), r("— it executes the tests and produces reports and email notifications.")]),
  bullet([b("Heals itself "), r("— when a test fails because the app changed, an agent diagnoses and fixes it.")]),
  bullet([b("Keeps an audit trail "), r("— every action is logged for compliance and traceability.")]),

  H1("3.  How the System Is Built"),
  P("The platform is organised into three cooperating services that share one database:"),
  table([2400, 4160, 2800],
    ["Service", "What it does", "Technology"],
    [
      [[b("Web App (Frontend)")], "What users see and click — the chat wizard, dashboards, reports, and configuration screens.", "React + Vite"],
      [[b("API (Backend)")], "The brain of the system — handles logins, business rules, data, and coordinates the AI pipeline.", "Node.js + Express"],
      [[b("Worker(s)")], "Background engine(s) that run the heavy AI work by calling the Claude API, so the app stays responsive.", "Node.js + Claude SDK"],
    ]),
  SP(60),
  P([r("Information flows in one direction and back: the "), b("Web App"), r(" talks to the "), b("API"), r(", which stores everything in "), b("PostgreSQL"), r(" and hands AI jobs to the "), b("Worker"), r(". Progress streams back to the user’s screen live as each stage completes.")]),

  H2("3.1  Component Inventory"),
  P("The API is itself made of clearly separated parts. Leadership-level summary:"),
  table([2550, 6810],
    ["Building block", "Responsibility"],
    [
      [[b("AI Agents")], "The six specialists: Requirements, Planner, Generator, Script-writer, Execution, and Healer — each a Claude agent with its own job."],
      [[b("Orchestrator")], "The conductor — decides which agent runs next, enforces budget caps and quality gates, prevents runaway loops."],
      [[b("Worker queue")], "A to-do list of AI jobs; workers pick up tasks, do them, and report back."],
      [[b("API Routes (22)")], "The doors into the system — chat, test cases, reports, integrations (Jira, Git, Confluence, SharePoint), user management, and more."],
      [[b("Services")], "Reusable helpers — test execution, email, reporting, integrations, real-time progress streaming."],
      [[b("Security layer")], "Login checks, role permissions, credential encryption, and the audit log."],
    ]),

  H1("4.  The Data Model at a Glance"),
  P("The diagram on the next page is a visual map of the database. Each box is a table; the colour shows which group it belongs to; the connecting lines show how records relate (one record links to many). It is intended to be read top-to-bottom, left-to-right."),
  new Paragraph({ children: [new PageBreak()] }),
];

function statCell(num, label) {
  const lines = label.split("\n");
  return new TableCell({ width: { size: 3120, type: WidthType.DXA }, borders: allB("FFFFFF"), margins: { top: 160, bottom: 160, left: 120, right: 120 },
    shading: { fill: LIGHT, type: ShadingType.CLEAR }, verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: num, bold: true, size: 56, color: NAVY })] }),
      ...lines.map((l) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: l, size: 18, color: "333333" })] })),
    ] });
}

// ---------- LANDSCAPE: ER DIAGRAM ----------
const erSection = {
  properties: { page: {
    size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE },
    margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
  footers: { default: footer },
  children: [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Entity-Relationship Diagram")] }),
    new Paragraph({ spacing: { after: 120 }, children: [new ImageRun({
      type: "png", data: img,
      transformation: { width: 1180, height: 787 },
      altText: { title: "JBSTestOpsAI ER Diagram", name: "ERDiagram", description: "Entity relationship diagram of the 22 tables grouped into 7 functional areas" },
    })] }),
  ],
};

// ---------- BODY PART 2 (portrait) ----------
const body2 = [
  H1("5.  Database Tables by Group"),
  P("The 22 tables are organised into seven groups by purpose. This grouping is what makes the schema easy to reason about and to reuse for new customers."),
  table([900, 2900, 700, 4860],
    ["Grp", "Group", "Tables", "What it stores"],
    [
      ["A", [b("Identity & Tenancy")], "2", "Customer organizations (tenants) and their users / roles."],
      ["B", [b("Integrations")], "1", "Per-customer connections to Jira, Git, Confluence, SharePoint, etc."],
      ["C", [b("Chat & Conversations")], "2", "The conversational wizard history between users and the assistant."],
      ["D", [b("Test Authoring & Execution")], "4", "Test runs, individual test cases, generated automation scripts, Jira links."],
      ["E", [b("Pipeline Orchestration")], "9", "The AI engine: runs, stage results, artifacts, the worker queue, page map, agent catalog."],
      ["F", [b("Test Data")], "3", "Reusable datasets and field values that drive data-aware tests."],
      ["G", [b("Audit")], "1", "An immutable log of who did what, for compliance."],
    ]),
  SP(60),
  P([b("The hub-and-spoke design: "), r("the "), b("tenants"), r(" table sits at the centre of the business data (everything is owned by a customer), and "), b("qa_pipeline_runs"), r(" is the hub of the AI engine (stages, artifacts, tasks and test data all trace back to a run). This is visible in the diagram as the two tables with the most connecting lines.")]),

  H1("6.  Security, Compliance & Multi-Tenancy"),
  bullet([b("Tenant isolation "), r("— every business record carries a tenant_id, so one customer can never see another’s data.")]),
  bullet([b("Encryption at rest "), r("— sensitive fields (API keys, passwords, integration credentials, Jira tokens) are encrypted in the database, shown with a lock icon in the diagram.")]),
  bullet([b("Role-based access "), r("— users are admins, QA engineers, or data analysts, each with appropriate permissions.")]),
  bullet([b("Full audit trail "), r("— the audit_log records every action with a per-request identifier, supporting HIPAA-style compliance reviews.")]),

  H1("7.  Reusing the Schema for a New Customer"),
  P([r("Because the schema is cleanly defined and self-contained, standing it up for a new customer is straightforward. A ready-to-run, customer-neutral "), b("database skeleton"), r(" has been prepared — it creates all 22 tables and their indexes, with no JBS-specific data or credentials.")]),
  table([3400, 5960],
    ["Deliverable", "Purpose"],
    [
      [[b("customer-skeleton.sql")], "One-shot script to create the entire schema in a customer’s own PostgreSQL database. Idempotent and safe to re-run."],
      [[b("DATABASE_SCHEMA.md")], "Plain-language documentation of every table and column, with sensitivity classification — for security and compliance reviewers."],
      [[b("backend/src/db.ts")], "The live source of truth in code; the SQL files are kept in lock-step with it."],
    ]),
  SP(60),
  P([b("To onboard a customer: "), r("(1) run the skeleton against an empty database; (2) insert the customer’s own organization and first admin user; (3) set a unique encryption key. No code changes are required.")]),
  SP(120),
  new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC", space: 6 } },
    spacing: { before: 200 }, children: [new TextRun({ text: "Source files: backend/db/seed/customer-skeleton.sql  ·  docs/DATABASE_SCHEMA.md  ·  backend/src/db.ts", italics: true, size: 18, color: GREY })] }),
];

const doc = new Document({
  styles, numbering,
  sections: [
    { properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      footers: { default: footer },
      children: [...cover, ...toc, ...body] },
    erSection,
    { properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      footers: { default: footer },
      children: body2 },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("C:/Dev/JBSIntelliQE/docs/JBSIntelliQE-Architecture-and-Data-Model.docx", buf);
  console.log("docx written", buf.length, "bytes");
});
