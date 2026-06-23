# Allure Report Integration in Reports Page

## Context

The user wants the actual Allure HTML report to appear under the Reports menu. Currently, the Reports page (`/reports`) shows a custom dashboard with KPI cards and recharts visualizations. The goal is to add a tabbed layout where the existing dashboard becomes one tab, and a new "Allure Report" tab embeds a full interactive Allure HTML report generated from the app's test execution data.

## Approach

1. Convert test case data from the database into Allure result JSON files
2. Use `allure-commandline` npm package to generate the static HTML report
3. Serve the generated HTML from the Express backend
4. Embed in an iframe on a new tab within the Reports page

**Prerequisite**: `allure-commandline` requires Java 8+ on the system. The service includes a check and informative error if Java is unavailable.

## Files to Create

### 1. `backend/src/services/allure-report.service.ts` (NEW)
- `generateAllureResults(tenantId, runId?)` - Queries `test_cases` + `test_runs`, converts each to Allure result JSON, writes to temp dir
  - Maps status: passed->passed, failed->failed, generated->skipped
  - Maps priority to severity: P0->blocker, P1->critical, P2->normal, P3->minor
  - Converts `steps` JSONB to Allure step format
  - Labels: suite (story_key), severity, feature (type)
- `generateAllureHtml(resultsDir, outputDir)` - Runs `allure generate --clean` via child_process
- `getOrGenerateReport(tenantId, runId?)` - Orchestrates the above, outputs to `backend/allure-reports/{tenantId}/{runId|latest}/`

### 2. `backend/src/routes/allure.routes.ts` (NEW)
- `POST /api/allure/generate` - Triggers report generation (body: `{ runId? }`)
- `GET /api/allure/status` - Returns `{ exists, generatedAt?, reportUrl? }`
- `GET /api/allure/report/:tenantId/:scope/*` - Serves static Allure HTML files via `res.sendFile()` with directory traversal protection

## Files to Modify

### 3. `backend/package.json`
- Add `"allure-commandline": "^2.30.0"` to dependencies

### 4. `backend/src/index.ts` (~line 24 + ~line 167)
- Import and register: `app.use('/api/allure', authMiddleware, allureRoutes)`

### 5. `frontend/src/services/api.ts` (~line 46)
- Add `generateAllureReport(runId?)` and `getAllureReportStatus(runId?)`

### 6. `frontend/src/pages/ReportsPage.tsx` (major rewrite)
- Add tab bar at top: **Dashboard** | **Allure Report**
- Dashboard tab = existing content (KPI cards, charts, table)
- Allure Report tab:
  - Run selector dropdown (from recentRuns data)
  - "Generate Report" button with loading state
  - Last generated timestamp
  - Full-height iframe loading the Allure HTML
  - Empty state when no report exists yet
- Style tabs using existing design system (#7C3AED purple theme)

## Implementation Order

1. `npm install allure-commandline` in backend
2. Create `allure-report.service.ts`
3. Create `allure.routes.ts`
4. Register routes in `index.ts`
5. Add API functions in `api.ts`
6. Update `ReportsPage.tsx` with tabs + iframe
7. Add `allure-reports/` to `.gitignore`

## Verification

1. Start backend server, ensure no import errors
2. Start frontend dev server
3. Navigate to Reports page -> verify Dashboard tab shows existing charts
4. Switch to Allure Report tab -> click Generate Report
5. Verify Allure HTML loads in iframe with test data from the database
6. Verify run-specific report generation works from dropdown
