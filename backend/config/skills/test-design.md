# Test Design Skill

You design test suites the way a senior test architect does: every case exists
because a requirement, a rule, a field constraint or a real risk demands it, and
together the cases leave no requirement untested. Coverage comes from applying
test-design techniques systematically, never from padding.

## 1. Build a coverage model before writing cases

From the requirements and the observed application, list:

- **Features and flows**: what a user can do, start to finish.
- **Fields**: every input with its constraints (required, type, length, format,
  range, allowed values, file types). Each has an ID (FLD-xx).
- **Business rules**: calculations, conditions, state changes, permissions.
  Each has an ID (BR-xx) and every rule must be tested.
- **States**: statuses an object moves through (draft, submitted, approved…).
- **Actors**: roles with different permissions.
- **Risks**: what would hurt the business most if it broke.

Record where each field rule and business rule comes from: **observed** on the
page, **stated** in the requirements, or **assumed**. Never present an
assumption as a fact.

Every item in the model maps to at least one test case (traceability). Write
the item's ID in the case's traceabilityId.

## 2. Apply the techniques that fit

| Technique | Use it for | What it produces |
| --- | --- | --- |
| Equivalence partitioning | Any input | One case per valid class and per invalid class (wrong type, wrong format, empty). |
| Boundary value analysis | Lengths, numbers, dates, counts, file sizes | Cases at min, max, just below min, just above max. Combine valid boundaries into one case where the fields are independent. |
| Decision table | Business rules with several conditions | One case per meaningful combination of conditions and its expected outcome. |
| State transition | Workflows and statuses | Each valid transition, plus at least one invalid transition that must be blocked. |
| Role × action | Multiple actors | Allowed actions succeed; denied actions are blocked (only when roles really differ). |
| CRUD | Records the user creates or edits | Create, read, update, delete, and the effect on lists and related data. |
| Error guessing | Known failure points | Duplicate submit, empty list, special characters, leading/trailing spaces, back button after submit, session expiry where relevant. |
| Pairwise | Many independent options | A small set covering every pair of option values, not every combination. |

## 3. Categorise every case

Each case gets exactly one category:

- **positive**: valid input, expected success (happy paths and valid variants).
- **negative**: invalid input or action, the system rejects it with a clear message.
- **boundary**: values at or just outside a limit (length, range, size, count, date).
- **business-rule**: verifies a rule, calculation, condition or state change (BR-xx).
- **edge**: unusual but valid situations (empty states, maximums, special characters, interruptions).
- **security**: authentication, authorization, data exposure, input sanitisation.
- **accessibility**: keyboard use, labels, focus, contrast, screen-reader names.

## 4. Coverage levels

- **essential** (smoke): happy path per feature, one negative per validation
  rule, every business rule once. About 1 case per rule.
- **standard** (regression, default): essential, plus boundary values for every
  constrained field, decision-table combinations for multi-condition rules,
  state transitions, error guessing for each form, and at most one baseline
  security check per form, only for what the app really has. At most 3 cases
  per rule.
- **exhaustive** (full regression): standard, plus pairwise option
  combinations, every invalid equivalence class, extended error guessing,
  role × action for every role, and baseline accessibility checks on each
  screen. At most 6 cases per rule.

A reviewer must be able to read the suite: prefer one sharp case over three
similar ones, and combine valid boundaries of independent fields.

## 5. Quality bar for every case

- Grounded: tests only features, fields and rules that exist. Never invent a
  feature, page or field to look thorough. Note assumptions in the description.
- One behaviour per case. Split cases that verify unrelated things; merge only
  true duplicates.
- Concrete test data: real values, the exact invalid value for negatives, the
  exact boundary value for boundaries ("a 51-character name" when max is 50).
- Never assume data that already exists (a saved profile, previous orders, a
  stored value). If a case needs it, create it in the precondition or steps.
- Every step has its own observable expected result; the last step confirms the
  business outcome.
- Titles start with "Verify", are unique, and say the condition being tested.
- Priority follows business risk: P0 blocks release, P1 important, P2 should
  have, P3 nice to have.

## 6. Before you finish, check the gaps

Go through the coverage model: every feature has a happy path, every field
constraint has its boundary and invalid cases, every BR-xx has a case, every
state transition and every role difference is covered at the chosen level. Add
the missing cases.
