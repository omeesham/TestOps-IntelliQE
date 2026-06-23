# Implementation Plan: Enhanced Test Case Generation & Management

## Overview
Redesign the ChatPage flow from `content-select` → results into a multi-step professional workflow:
1. **Column Selection** → 2. **Test Case Generation (only)** → 3. **Review/Edit/Delete with Pagination** → 4. **Save to DB** → 5. **Export** → 6. **Proceed to Script Generation**

---

## New Flow Steps (replacing old `generating` + `results`)

| New Step | What Happens |
|----------|-------------|
| `column-select` | Multi-select checkboxes for desired TC columns (TC#, Title, Steps, Expected Result, Priority, Type, Preconditions, etc.) |
| `generating` | **Only** the Test Case Generator agent runs (no full 7-agent pipeline) |
| `results` | Paginated table with checkboxes, inline edit, delete, Save button |
| `saved` | After Save → Export options (JIRA/TestRail/Excel CSV) + "Proceed to Script Generation" button |
| `script-generating` | Script Writer agent works on saved TCs (real pipeline for automation scripts) |

---

## Files Changed

### 1. Frontend: `ChatPage.tsx` — Major Changes

**A. New state variables:**
- `selectedColumns: string[]` — which columns user wants (default all standard)
- `tcPage: number` — current pagination page
- `tcPageSize: number` — rows per page (10/25/50)
- `selectedTcIds: Set<string>` — checked TC rows
- `editingTcId: string | null` — TC currently being edited inline
- `editDraft: any` — temp edit state for the row being edited
- `isSaving: boolean` — save loading state
- `savedTestRunId: string | null` — ID returned after save to DB
- `isExporting: boolean` — export loading state

**B. New Step: `column-select`**
- Shows after story selection (before generation starts)
- Checkboxes for: TC Number, Test Case Title, Test Steps, Expected Result, Priority, Type, Feature, Status, Preconditions, Postconditions
- Some checked by default (TC#, Title, Steps, Expected, Priority, Type)
- "Generate Test Cases" button at bottom

**C. Modified `handleStorySelect`**
- Instead of jumping to `generating`, go to `column-select` first
- Save requirements in state for later use when user clicks generate

**D. Modified `runGeneration`**
- Remove the full 7-agent pipeline animation
- Show only "Test Case Generator" agent as a single step
- Call `generateTests()` backend as before
- Map results, then go to `results` step

**E. Redesigned `results` panel**
- **Header bar**: "Generated Test Cases (N)" + pagination controls (page size dropdown + page nav)
- **Select All checkbox** in header + individual row checkboxes
- **Table rows**: Only show columns the user selected
- Each row has: checkbox | columns... | Edit (pencil icon) | Delete (trash icon)
- **Edit mode**: Clicking edit turns that row into input fields; Save/Cancel buttons appear
- **Delete**: Removes TC from local state (with confirmation)
- **Bottom bar**: "Save Test Cases" button (disabled until at least 1 TC exists)
- Summary stats moved to a compact bar above the table

**F. New `saved` panel**
- Shows after Save succeeds: "✓ N test cases saved successfully"
- **Export section**: Format dropdown (JIRA XML, TestRail CSV, Excel XLSX, CSV) + "Export" button
- Each format generates appropriate file and triggers browser download
- **Proceed button**: "Generate Automation Scripts →" to start script generation

**G. New `script-generating` panel**
- Shows the Script Writer agent + Execution Engine animation
- Calls a new or existing backend endpoint for script generation
- On completion, shows summary of generated scripts

### 2. Backend: New `test-cases.routes.ts`

**New API endpoints:**
- `POST /api/test-cases/save` — Saves test cases to DB, returns `testRunId`
  - Body: `{ username, storyKey?, storyTitle?, testCases: [...], columns: [...] }`
  - Creates a `test_runs` record + `test_cases` records
- `GET /api/test-cases/:testRunId` — Fetch saved test cases for a run
- `GET /api/test-cases/:testRunId/export?format=csv|jira|testrail|excel` — Returns downloadable file

### 3. Backend: `db.ts` — New Tables

```sql
CREATE TABLE test_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username    VARCHAR(100) NOT NULL,
  story_key   VARCHAR(50),
  story_title VARCHAR(500),
  columns     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE test_cases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id  UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  tc_number    VARCHAR(20) NOT NULL,
  title        VARCHAR(1000) NOT NULL,
  steps        JSONB NOT NULL,
  expected     TEXT,
  priority     VARCHAR(10),
  type         VARCHAR(50),
  feature      VARCHAR(200),
  precondition TEXT,
  status       VARCHAR(50) DEFAULT 'generated',
  sort_order   INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4. Frontend: `api.ts` — New Functions
- `saveTestCases(payload)` → POST /api/test-cases/save
- `exportTestCases(testRunId, format)` → GET /api/test-cases/:id/export?format=...

### 5. Export Format Standards
- **CSV**: Standard columns with headers, comma-separated, UTF-8 BOM
- **Excel**: Same as CSV but .xlsx format (using a simple CSV download with .csv extension for now, real xlsx if we add a library)
- **JIRA**: XML format compatible with JIRA Test Management import
- **TestRail**: CSV format matching TestRail's import template (Title, Steps, Expected, Priority, Type)

---

## Security Considerations
- All API calls go through existing Vite proxy (no CORS exposure)
- No sensitive data in test cases (requirements text only)
- Export files generated server-side, streamed to client
- Existing encryption layer untouched
- DB queries use parameterized statements (no SQL injection)

---

## Execution Order
1. Add DB tables to `db.ts`
2. Create `test-cases.routes.ts` + register in `index.ts`
3. Add new API functions in `api.ts`
4. Rewrite ChatPage.tsx flow: column-select → generate → results → saved → script-gen
