const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.3" x 7.5"
pres.author = "JBSIntelliQE Analysis";
pres.title = "JBSIntelliQE — Codebase Feature Analysis";

const slide = pres.addSlide();
slide.background = { color: "0F172A" }; // Dark slate

// --- Colors ---
const C = {
  bg: "0F172A",
  title: "F8FAFC",
  subtitle: "94A3B8",
  headerBg: "1E293B",
  rowBg1: "1E293B",
  rowBg2: "162032",
  green: "10B981",
  greenBg: "064E3B",
  amber: "F59E0B",
  amberBg: "78350F",
  red: "94A3B8",
  redBg: "334155",
  catText: "E2E8F0",
  cellText: "CBD5E1",
  border: "334155",
  accent: "6366F1",
};

// --- Title ---
slide.addText("JBSIntelliQE — Codebase Feature Analysis", {
  x: 0.4, y: 0.15, w: 10, h: 0.45,
  fontSize: 18, fontFace: "Calibri", color: C.title, bold: true, margin: 0,
});
slide.addText("Comprehensive E2E Testing & Feature Coverage Matrix", {
  x: 0.4, y: 0.52, w: 8, h: 0.3,
  fontSize: 9, fontFace: "Calibri", color: C.subtitle, margin: 0,
});

// Legend chips
const legendY = 0.2;
const chipH = 0.25;
const chipW = 1.6;
// Green chip
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 10.2, y: legendY, w: chipW, h: chipH,
  fill: { color: C.greenBg }, rectRadius: 0.05,
});
slide.addText("Implemented", {
  x: 10.2, y: legendY, w: chipW, h: chipH,
  fontSize: 8, fontFace: "Calibri", color: C.green, bold: true, align: "center", valign: "middle", margin: 0,
});
// Amber chip
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 10.2, y: legendY + 0.3, w: chipW, h: chipH,
  fill: { color: C.amberBg }, rectRadius: 0.05,
});
slide.addText("Can Implement", {
  x: 10.2, y: legendY + 0.3, w: chipW, h: chipH,
  fontSize: 8, fontFace: "Calibri", color: C.amber, bold: true, align: "center", valign: "middle", margin: 0,
});
// Grey chip
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 11.9, y: legendY, w: chipW, h: chipH,
  fill: { color: C.redBg }, rectRadius: 0.05,
});
slide.addText("Cannot Implement", {
  x: 11.9, y: legendY, w: chipW, h: chipH,
  fontSize: 8, fontFace: "Calibri", color: C.red, bold: true, align: "center", valign: "middle", margin: 0,
});

// --- Table Data ---
const data = [
  {
    cat: "1. Core User Flows",
    impl: "Login/Logout, Signup (roles), Protected routes, Session auth, Form submissions, Profile display",
    can: "Password reset, Global search, Profile edit, Password change",
    cannot: "Checkout/payment (N/A — QA platform)",
  },
  {
    cat: "2. UI & Frontend",
    impl: "Responsive layouts (Tailwind), Buttons/links/dropdowns, Form validations, Loading states, Toast notifications, Animations",
    can: "Full accessibility audit (ARIA), Dark mode, Breadcrumb navigation",
    cannot: "N/A",
  },
  {
    cat: "3. Backend Integration",
    impl: "22+ API route files, Axios Bearer token, Error handling (try-catch), Session handling, Tenant-scoped isolation",
    can: "API caching, Request logging, API versioning, Rate limiting",
    cannot: "N/A",
  },
  {
    cat: "4. Database Validation",
    impl: "30+ PostgreSQL tables, Validation rules engine, Parameterized queries, Tenant isolation, Connection pooling, Azure SQL",
    can: "Migration framework (Knex/Prisma), FK constraints, Auto backup, Dedup at DB level",
    cannot: "N/A",
  },
  {
    cat: "5. Auth & Authorization",
    impl: "Role-based access (3 roles), Login/signup + tenants, Auth middleware, Platform admin override, Worker auth",
    can: "JWT with expiry, bcrypt hashing, Granular RBAC, OAuth2/SSO, MFA, Account lockout",
    cannot: "N/A",
  },
  {
    cat: "6. Third-Party Integrations",
    impl: "JIRA, Azure Blob, Gmail SMTP, Teams webhooks, Claude AI, Playwright",
    can: "Stripe payments, OAuth logins, Slack, PagerDuty, Confluence, SMS (Twilio)",
    cannot: "N/A",
  },
  {
    cat: "7. Error Handling",
    impl: "Try-catch all routes, User-friendly messages, Network error handling, PII masking, Credential redaction",
    can: "React error boundary, Centralized middleware, Empty states, Retry/backoff, Circuit breaker",
    cannot: "N/A",
  },
  {
    cat: "8. Performance",
    impl: "DB connection pooling, Config caching, Vite HMR, Code splitting, Memoization, Skeleton loaders",
    can: "Redis caching, gzip compression, Query optimization, CDN, Lazy loading, Load testing (k6)",
    cannot: "N/A",
  },
  {
    cat: "9. Security",
    impl: "Parameterized SQL, Client-side encryption, PII masking, Credential redaction, Tenant isolation, CORS, Auth middleware",
    can: "AES-256 (replace XOR), Helmet.js, HTTPS, Rate limiting, XSS prevention, CSP, Secrets vault",
    cannot: "N/A",
  },
  {
    cat: "10. Cross-Browser & Device",
    impl: "Tailwind breakpoints (sm/md/lg/xl), Mobile-first grids, TTS voice fallbacks, ES2022 target, Responsive header",
    can: "Playwright multi-browser tests, Device matrix, PWA, Touch gestures",
    cannot: "N/A",
  },
  {
    cat: "11. Notifications & Async",
    impl: "Email alerts (SMTP), Teams webhooks, SSE real-time updates, Toast system, Background worker, Event broadcasting",
    can: "Slack, SMS (Twilio), Push notifications, Webhook retry, User preferences, Notification inbox",
    cannot: "N/A",
  },
  {
    cat: "12. Logging & Monitoring",
    impl: "Console logging, Context tags, Health endpoint, Cost/token tracking",
    can: "Structured logging (Winston), Sentry, APM (DataDog), Morgan, Alert thresholds, Audit trail",
    cannot: "N/A",
  },
];

// --- Build Table ---
const tableStartY = 0.9;
const tableX = 0.3;
const tableW = 12.7;
const colW = [2.0, 4.6, 4.0, 2.1];
const rowH = 0.48;
const fs = 7.5;
const headerFs = 8;

// Header row
const headerRow = [
  { text: "Category", options: { fill: { color: C.accent }, color: "FFFFFF", bold: true, fontSize: headerFs, fontFace: "Calibri", align: "center", valign: "middle" } },
  { text: "Currently Implemented", options: { fill: { color: "064E3B" }, color: C.green, bold: true, fontSize: headerFs, fontFace: "Calibri", align: "center", valign: "middle" } },
  { text: "Can Be Implemented", options: { fill: { color: "78350F" }, color: C.amber, bold: true, fontSize: headerFs, fontFace: "Calibri", align: "center", valign: "middle" } },
  { text: "Cannot Be Implemented", options: { fill: { color: "334155" }, color: C.red, bold: true, fontSize: headerFs, fontFace: "Calibri", align: "center", valign: "middle" } },
];

const tableRows = [headerRow];

data.forEach((row, i) => {
  const bg = i % 2 === 0 ? C.rowBg1 : C.rowBg2;
  tableRows.push([
    { text: row.cat, options: { fill: { color: bg }, color: C.catText, bold: true, fontSize: fs, fontFace: "Calibri", valign: "middle", margin: [2, 4, 2, 6] } },
    { text: row.impl, options: { fill: { color: bg }, color: C.cellText, fontSize: fs, fontFace: "Calibri", valign: "middle", margin: [2, 4, 2, 4] } },
    { text: row.can, options: { fill: { color: bg }, color: C.cellText, fontSize: fs, fontFace: "Calibri", valign: "middle", margin: [2, 4, 2, 4] } },
    { text: row.cannot, options: { fill: { color: bg }, color: row.cannot === "N/A" ? "64748B" : C.cellText, fontSize: fs, fontFace: "Calibri", valign: "middle", align: "center", margin: [2, 4, 2, 4] } },
  ]);
});

slide.addTable(tableRows, {
  x: tableX,
  y: tableStartY,
  w: tableW,
  colW: colW,
  rowH: [0.35, ...Array(12).fill(rowH)],
  border: { pt: 0.5, color: C.border },
  autoPage: false,
});

// --- Footer ---
slide.addText("JBSIntelliQE QA Automation Platform  |  React 19 + Express 5 + PostgreSQL + Claude AI  |  Analysis Date: March 2026", {
  x: 0.3, y: 7.1, w: 12.7, h: 0.3,
  fontSize: 7, fontFace: "Calibri", color: "475569", align: "center", margin: 0,
});

// Accent line at top
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 13.3, h: 0.04,
  fill: { color: C.accent },
});

pres.writeFile({ fileName: "C:\\temp\\JBSIntelliQE\\JBSIntelliQE-Codebase-Analysis.pptx" })
  .then(() => console.log("PPTX created successfully!"))
  .catch(err => console.error("Error:", err));
