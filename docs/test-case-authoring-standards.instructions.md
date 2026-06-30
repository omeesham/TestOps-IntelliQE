---
applyTo: "**/specs/**,**/*.plan.md,**/test-plan.md"
description: "Test-case authoring standard for the Playwright Planner agent. The Planner MUST read and follow this file before writing any test plan. Output is aligned to the TestRail 'Test Case (Steps)' export schema, with added Module / Sub-Module / Test Data columns."
---

# Test Case Authoring Standard — Planner Startup Instructions

> **Read this first.** Before the Planner explores the app or writes a single
> scenario, it loads this file and treats every rule below as mandatory.
> **Goal:** clean, executive-readable test cases that import straight into
> **TestRail** (matching our existing export schema) and **TestLink**, with
> **Module / Sub-Module** clearly stated and **Test Data** (including any data the
> Planner simulates or creates) captured in its own column for easy reference.

---

## 1. What "good" looks like (the one-line rule)

Every test case must answer four questions clearly:

1. **Where** does it live? → **Module** and **Sub-Module** (the feature area).
2. **What** are we testing? → a clean **Title** + a one-line **Title Description**.
3. **How** do we test it? → numbered **Steps**, each with a plain-English action.
4. **How do we know it passed?** → an **Expected Result** for **every single step**.

Plus: **What data did we use?** → every input/account/record (real or simulated)
goes in the **Test Data** column.

If any of those is missing or vague, the case is not done.

---

## 2. Module & Sub-Module rules (NEW — required)

Every test case must state both, even if the sub-module is the same as the module.

- **Module** = the top-level feature area. *Example:* `Product Groups`
- **Sub-Module** = the specific screen / capability inside it. *Example:* `Edit Product Group`
- If there is genuinely no sub-module, write the module name again or `General`.
- These two together form the **TestRail `Section Hierarchy`** using ` > `:
  - `Module > Sub-Module` → e.g. `Product Groups > Edit Product Group`
- They also become the **TestLink suite > sub-suite** path.
- Keep Module/Sub-Module names **consistent across all cases** so grouping works
  in both tools — do not invent a new spelling per case.

---

## 3. Title rules

- The **Title** is short, plain, and self-explanatory — readable by a manager who
  has never seen the app. (Match the style already in our suite, e.g.
  `Successful Save with Valid Data`, `Verify Validation Rules Applied During Edit`.)
- Recommended pattern: **`Verify <behaviour> when <condition>`** or a short
  outcome phrase. Avoid `TC_01`, `Test the thing`, selector names, or ticket IDs
  in the title.
- Keep it under ~80 characters.

### Title Description (mandatory, one line)
A single sentence stating the business intent and scope.
> *Example:* "Confirms an authorized user can edit a product group's Name,
> Description and Service Type and persist the change."

---

## 4. Step rules

Each case is a numbered list of steps. **One action per step.** For **every** step
there is a matching **Expected Result** — never skip it, even for setup steps.

| Field | Rule |
|-------|------|
| **Step #** | Sequential integer starting at 1. |
| **Step Description** | One clear action, imperative. "Click the 'Save' button." |
| **Expected Result** | The observable outcome of *that* step. "A success message confirming the update is displayed." |

Rules:
- **One step per row** — each step and its matching Expected Result occupy a
  single row; the next step goes on the next row. Never bundle multiple steps,
  or multiple expected results, into one cell.
- Steps must be **atomic** — if a step says "and" doing two things, split it.
- Expected Results must be **observable** (something you can see/measure).
- The **last step's** Expected Result confirms the overall business outcome.
- Plain language only — **no selectors / no code** in the plan (that is the
  Generator's job).

---

## 5. Test Data rules (NEW — required, separate column)

The Planner records **every piece of data the case relies on** in a dedicated
**Test Data** field — kept separate from the steps so it is easy to find and reuse.

This includes:
- **Existing data** the case assumes (e.g. an existing product group, a user role).
- **Simulated / mocked data** (e.g. a forced HTTP 500, an invalid auth token, a
  blocked API endpoint).
- **Data the Planner itself generates/creates during exploration** — capture the
  exact values it used so the run is reproducible.

Format inside the Test Data field (one item per line, `key = value`):

```
user = role_with_edit_permission
product_group_name = QA_PG_Autogen_20260604   (created by Planner)
description = Auto-generated description for save test   (created by Planner)
service_type = Standard
subclass = SC-001
mock = API /product-groups/save -> 500 Server Error (simulated)
```

Rules:
- If a value was **invented by the Planner**, tag it `(created by Planner)`.
- If a value is **simulated/mocked**, tag it `(simulated)`.
- If the case needs no data, write `None`.
- Never put secrets/real credentials here — use a placeholder like `<valid_password>`.

---

## 6. Required structure for every test case

The Planner writes each case in the test plan using **exactly** this block. Field
names below map 1:1 to our TestRail export columns (see Section 7).

```markdown
### TC-<NNN>: <Clean Title>

- **Title Description:** <one-line business intent>
- **Module:** <top-level feature area>
- **Sub-Module:** <specific screen/capability>
- **Section Hierarchy:** <Module> > <Sub-Module>
- **Priority:** <Critical | High | Medium | Low>
- **Type:** <Functional | Regression | Smoke | Negative | E2E | Accessibility>
- **Automation Type:** <Manual | Automated>
- **Template:** Test Case (Steps)
- **Preconditions:** <state required before Step 1; "None" if not applicable>
- **Test Data:**
    user = ...
    <field> = <value>   (created by Planner | simulated, as applicable)
- **References:** <Jira/requirement ID; optional>

| Step # | Step Description | Expected Result |
|--------|------------------|-----------------|
| 1 | <action> | <observable outcome> |
| 2 | <action> | <observable outcome> |
```

### Worked example (quality bar — mirrors our existing suite)

```markdown
### TC-001: Successful Save with Valid Data

- **Title Description:** Confirms an authorized user can edit a product group's
  Name, Description and Service Type and persist the change.
- **Module:** Product Groups
- **Sub-Module:** Edit Product Group
- **Section Hierarchy:** Product Groups > Edit Product Group
- **Priority:** Critical
- **Type:** Functional
- **Automation Type:** Automated
- **Template:** Test Case (Steps)
- **Preconditions:** A user with edit permission is logged in; at least one
  product group exists.
- **Test Data:**
    user = role_with_edit_permission
    product_group_name = QA_PG_Autogen_20260604   (created by Planner)
    new_description = Updated by automated save test   (created by Planner)
    service_type = Standard
    subclass = SC-001
- **References:** JIRA-1042

| Step # | Step Description | Expected Result |
|--------|------------------|-----------------|
| 1 | Navigate to the Product Group Maintenance page and log in with valid credentials. | The page loads successfully, displaying the product group grid. |
| 2 | Locate and click the existing product group record in the grid. | The Edit Product Group form opens, pre-populated with current data. |
| 3 | Modify the 'Name' field with a new, valid value. | The 'Name' field shows the new value. |
| 4 | Modify the 'Description' field with a new, valid value. | The 'Description' field shows the new value. |
| 5 | Select a different 'Service Type' from the dropdown. | The selected 'Service Type' is updated. |
| 6 | Click the 'Save' button. | A success message confirming the update is displayed. |
| 7 | Refresh the grid. | The grid shows the updated Name, Description and Service Type. |
```

---

## 7. TestRail mapping — matches our export schema exactly

Our existing TestRail export uses these column headings (full list, in order):

```
ID, Title, AI Automated Test, AI Model, AI Type, Attachments, Automation Type,
Created By, Created On, Estimate, Expected Result, Forecast, Goals, Labels,
Mission, Preconditions, Priority, References, Section, Section Depth,
Section Description, Section Hierarchy, Steps, Steps (Additional Info),
Steps (Expected Result), Steps (References), Steps (Shared step ID),
Steps (Step), Suite, Suite ID, Template, Type, Updated By, Updated On, is_converted
```

**Field mapping (standard → TestRail column):**

| Standard field | TestRail column |
|----------------|-----------------|
| Clean Title | `Title` |
| Title Description | `Mission` (or first line of `Preconditions`) |
| Module + Sub-Module | `Section` (top level) + `Section Hierarchy` = `Module > Sub-Module` |
| Sub-Module depth | `Section Depth` (0 = module only, 1 = sub-module, …) |
| Preconditions | `Preconditions` |
| **Test Data (NEW)** | custom column `Test Data` *(add once in TestRail: Administration → Customizations → custom field, type Text)*. Until added, prefix it inside `Preconditions` as `Test Data: …`. |
| Priority | `Priority` |
| Type | `Type` |
| Automation Type | `Automation Type` |
| Template | `Template` = `Test Case (Steps)` |
| Step Description | `Steps (Step)` |
| Expected Result (per step) | `Steps (Expected Result)` |
| References | `References` (case) / `Steps (References)` (per step) |

**Import CSV — recommended header (existing columns + our two additions):**

```csv
Title,Section,Section Hierarchy,Section Depth,Module,Sub-Module,Test Data,Template,Type,Priority,Automation Type,Preconditions,Steps (Step),Steps (Expected Result),References
```

> `Module` and `Sub-Module` are added for human readability; `Section Hierarchy`
> (`Module > Sub-Module`) is what TestRail actually uses to build the tree, so
> always populate it. `Test Data` is a custom field — see mapping note above.

**Multi-row step format (same as the export):** the first row carries all
case-level columns; each following row leaves them blank and fills only
`Steps (Step)` and `Steps (Expected Result)` for steps 2..N.

---

## 8. TestLink mapping (XML import-ready)

| Standard field | TestLink element |
|----------------|------------------|
| Module > Sub-Module | test **suite > sub-suite** path |
| Clean Title | `testcase name=""` |
| Title Description | `<summary>` |
| Preconditions + Test Data | `<preconditions>` (append `Test Data:` block) |
| Priority (Low/Med/High) | `<importance>` (1/2/3) |
| Automation Type | `<execution_type>` (1=Manual, 2=Automated) |
| Step # | `<step_number>` |
| Step Description | `<actions>` |
| Expected Result | `<expectedresults>` |

```xml
<testcases>
  <testcase name="Successful Save with Valid Data">
    <summary>Confirms an authorized user can edit and persist a product group.</summary>
    <preconditions>User with edit permission logged in; a product group exists.
      Test Data: product_group_name=QA_PG_Autogen_20260604 (created by Planner);
      service_type=Standard; subclass=SC-001</preconditions>
    <importance>3</importance>
    <execution_type>2</execution_type>
    <steps>
      <step>
        <step_number>1</step_number>
        <actions>Navigate to the Product Group Maintenance page and log in.</actions>
        <expectedresults>The page loads, displaying the product group grid.</expectedresults>
        <execution_type>2</execution_type>
      </step>
      <!-- repeat <step> for each row -->
    </steps>
  </testcase>
</testcases>
```

---

## 9. Executive-level quality bar

- **Plain language** — no code/selectors in the plan; those go to the Generator.
- **Business value first** — the Title Description always frames *why* it matters.
- **Traceable** — every case has Module, Sub-Module, Priority, Type, and (where
  known) a requirement/Jira reference.
- **Reproducible** — Test Data column captures every input, including
  Planner-generated and simulated values.
- **Consistent IDs** — `TC-001`, `TC-002`, … stable across regenerations.
- **Defensible coverage** — per flow: a happy path, at least one negative/validation
  path, and relevant boundary/edge cases (e.g. API-failure simulations).
- **Definite wording** — Expected Results say "is displayed", never "should probably".

---

## 10. How the Planner uses this file (workflow)

1. **Load this standard at startup** — before exploring the app.
2. **Explore** the target flow(s) with the Playwright MCP browser tools.
3. **Record Test Data as you go** — every value you type, generate, or mock.
4. **Write the test plan** to `specs/test-plan.md` (or `*.plan.md`), each case
   using the Section 6 block.
5. **Self-check before finishing** — for each case confirm:
   - [ ] Clean Title + one-line Title Description
   - [ ] Module **and** Sub-Module set; Section Hierarchy = `Module > Sub-Module`
   - [ ] Priority, Type, Automation Type, Template set
   - [ ] Preconditions filled (or "None")
   - [ ] **Test Data** column filled, with `(created by Planner)` / `(simulated)` tags
   - [ ] Every step has a Step #, action, and Expected Result
   - [ ] Steps are atomic (no hidden "and")
   - [ ] Stable `TC-NNN` IDs
6. **Hand off** the plan to the Generator (which turns it into Playwright `.spec.ts`).

---

## 11. Configuration & setup

### Prerequisites
- **Playwright v1.56+** (`npx playwright --version`)
- **VS Code v1.105+** for the VS Code / Copilot loop
- An active LLM model in your AI tool (Copilot, Claude Code, or OpenCode)

### Generate the agents
Run from the project root:

```bash
# VS Code + Copilot
npx playwright init-agents --loop=vscode

# Claude Code
npx playwright init-agents --loop=claude

# OpenCode
npx playwright init-agents --loop=opencode
```

This creates the **planner / generator / healer** definitions, a `seed.spec.ts`,
and the Playwright **MCP** config (`.mcp.json` for Claude). Regenerate after every
Playwright upgrade.

### Wire this standard into the Planner

**Option A — VS Code / Copilot (recommended):**
```
.github/instructions/test-case-authoring-standards.instructions.md
```
The `applyTo` front matter auto-applies it on plan/spec files. Optionally add to
`.github/copilot-instructions.md`:
```markdown
When acting as the Planner, follow .github/instructions/test-case-authoring-standards.instructions.md for all test-case formatting, including Module, Sub-Module and Test Data columns.
```

**Option B — Claude Code:** reference it from `CLAUDE.md`:
```markdown
## Planner rules
Always follow ./docs/test-case-authoring-standards.instructions.md when generating test plans.
```

**Option C — any tool, per run:** start the Planner prompt with:
> "Follow `test-case-authoring-standards.instructions.md` for all formatting, then
> plan tests for `<flow>`."

### Suggested folder layout
```
repo/
├─ .github/
│  ├─ instructions/
│  │  └─ test-case-authoring-standards.instructions.md   ← this file
│  └─ copilot-instructions.md
├─ specs/
│  └─ test-plan.md            ← Planner output
├─ tests/
│  └─ *.spec.ts               ← Generator output
├─ seed.spec.ts
├─ playwright.config.ts
└─ .mcp.json                  ← Playwright MCP (Claude loop)
```

### Recommended `playwright.config.ts` (clean traces for the Healer + result sync)
```ts
export default defineConfig({
  testDir: './tests',
  retries: 1,
  use: {
    trace: 'on-first-retry',      // Healer reads traces to fix locators
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  reporter: [['html'], ['junit', { outputFile: 'results/junit.xml' }]],
});
```
The JUnit output feeds TestRail / TestLink result-sync integrations.

---

## 12. Definition of Done (per test plan)

A plan is complete only when **every** case passes the Section 10 checklist:
Module + Sub-Module set, Test Data captured (with simulated/Planner-created values
tagged), IDs sequential, titles executive-readable, and the file imports cleanly
into TestRail (Section 7 schema) and TestLink (Section 8) with no manual fixes.
