/**
 * testCaseStandard
 * ────────────────
 * Single source of truth for the "leadership-level" test-case authoring bar
 * that the Planner and Generator agents must follow. It is a distilled,
 * prompt-ready version of the full standard committed at:
 *   docs/test-case-authoring-standards.instructions.md
 *
 * Keep the doc and this constant in sync. The doc is the human reference;
 * this constant is what actually gets injected into the LLM prompts so the
 * generated cases import cleanly into TestRail / TestLink and read well to a
 * non-technical reviewer.
 */

/** TestRail-style priority labels mapped to our internal P0–P3 enum. */
export const PRIORITY_LABEL: Record<'P0' | 'P1' | 'P2' | 'P3', string> = {
  P0: 'Critical',
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};

/** Build the TestRail `Section Hierarchy` value from module + sub-module. */
export function sectionHierarchy(module?: string, submodule?: string): string {
  const m = (module || '').trim() || 'General';
  const s = (submodule || '').trim() || m;
  return m === s ? m : `${m} > ${s}`;
}

/**
 * The authoring standard, phrased as mandatory rules for the agent. Injected
 * verbatim into the planner and generator prompts.
 */
export const TEST_CASE_STANDARD = `═══════════════════════════════════════════════════════════════
TEST-CASE AUTHORING STANDARD (MANDATORY — leadership-readable, TestRail/TestLink-ready)
═══════════════════════════════════════════════════════════════
Every test case must answer four questions clearly, plus its data:
  • WHERE does it live?  → Module AND Sub-Module (the feature area / screen).
  • WHAT are we testing? → a clean Title + a one-line Title Description.
  • HOW do we test it?   → numbered Steps, one atomic action each.
  • HOW do we know it passed? → an Expected Result for EVERY single step.
  • WHAT data did we use? → every input/account/record in the Test Data field.
If any of those is missing or vague, the case is NOT done.

MODULE & SUB-MODULE (required on every case):
  • Module = top-level feature area (e.g. "Product Groups").
  • Sub-Module = the specific screen/capability (e.g. "Edit Product Group").
  • If there is genuinely no sub-module, repeat the module name or use "General".
  • Use CONSISTENT module/sub-module names across ALL cases so grouping works —
    never invent a new spelling per case. Section Hierarchy = "Module > Sub-Module".

TITLE (executive-readable):
  • Short, plain, self-explanatory to a manager who has never seen the app.
  • Pattern: "Verify <behaviour> when <condition>" OR a short outcome phrase
    (e.g. "Successful Save with Valid Data"). Under ~80 characters. Unique.
  • Never use TC_01, raw selectors, code, or bare ticket IDs as the title.

TITLE DESCRIPTION (one line, mandatory): a single sentence stating the business
  intent and scope — e.g. "Confirms an authorized user can edit a product group's
  Name, Description and Service Type and persist the change." Do not restate the title.

STEPS (one action per step; every step has its own Expected Result):
  • Step action = one clear imperative ("Click the 'Save' button"). Atomic — if a
    step says "and" doing two things, split it. Reference UI by visible label/role.
  • Expected Result = the OBSERVABLE outcome of THAT step ("A success message
    confirming the update is displayed"). Never blank, even for setup steps.
  • The LAST step's Expected Result confirms the overall business outcome.
  • Plain language only — NO selectors / NO code (that is the Generator's job).
  • Definite wording: say "is displayed", never "should probably" / "may".

TEST DATA (separate, captured for reproducibility):
  • List every value the case relies on as "key = value" lines.
  • Tag invented values "(created by Planner)" and mocked values "(simulated)".
  • Use CONCRETE realistic values (e.g. "alice@example.com", "ORDER-2024-0042"),
    never placeholders like "<email>" — EXCEPT secrets, which use a placeholder
    such as "<valid_password>". If the case needs no data, write "None".

DEFENSIBLE COVERAGE (per flow): at least one happy path, at least one
  negative/validation path, and the relevant boundary/edge cases — including
  API-failure simulations (e.g. forced HTTP 500, invalid token) where applicable.

PRIORITY maps to TestRail labels: P0=Critical, P1=High, P2=Medium, P3=Low.
TEMPLATE is always "Test Case (Steps)". AUTOMATION TYPE is "Automated" for
  UI/API cases the Generator will script, "Manual" otherwise.
═══════════════════════════════════════════════════════════════`;
