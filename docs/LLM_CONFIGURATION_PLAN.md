# IntelliQE — LLM Connectivity & Configuration: Proposal

**Status:** Draft for review — no code changed yet.
**Prepared for:** Executive / product review before implementation sign-off.
**Date:** 2026-06-15.

---

## 1. Executive summary

IntelliQE's AI test-generation does not currently work in the deployed product. Every
request — whether the user uploads a BRD/FRD, pastes requirements, or asks IntelliQE to
explore a live app — fails the same way. The root cause is narrow and well understood:
the server tries to drive AI through a **command-line tool that isn't present in the
cloud image**, and there is **no screen for a customer to connect their own AI account.**

This proposal does two things:

1. **Restores AI generation** by switching to the standard cloud API (the modern,
   supported integration path that needs no command-line tool).
2. **Turns "AI connectivity" into a first-class, self-serve feature** appropriate for
   enterprise customers: a **System Configuration** screen where an administrator
   connects their cloud LLM (two authentication options), the product **auto-selects a
   cost-effective model** while always showing the **latest available models** in a
   dropdown, and any connectivity problem produces **one clear message** —
   *"AI is not connected — please configure it in System Configuration"* — instead of
   leaking confusing internal pipeline details.

The work is staged so value lands early (AI working again in Phase 0) and the
enterprise-grade experience follows in controlled increments.

---

## 2. The problem, in business terms

| What the customer experiences | What is actually happening |
|---|---|
| "Pipeline returned no test cases" on every attempt | The server calls a Claude **CLI binary** that isn't installed in the cloud container → hard error before any test case is produced |
| The progress panel shows "Requirement Analysis ✓" then stalls | That panel is **cosmetic**; the backend actually fails on the very first AI call. The UI implies progress that didn't happen |
| No way to plug in our own AI account | The product has **no UI** to enter LLM credentials. A backend slot exists but is unreachable, so no key is ever set |
| When it fails, the message blames "requirements"/"Jira" | Errors surface the **internal stage** rather than the real cause (no AI connection), eroding trust |

**Net effect:** the headline capability of the product is non-functional in production,
and even a knowledgeable admin has no way to fix it themselves.

---

## 3. Guiding principles (from stakeholder direction)

1. **Cost-effective & token-friendly first.** Minimize tokens per run; make expensive
   behaviors opt-in; surface each model's relative cost so the admin chooses
   economically.
2. **The admin explicitly selects the model — the system never auto-selects.** The
   chosen model is shown in a dropdown and saved per customer. Selecting a model is a
   required step when connecting the LLM.
3. **Always current.** The model dropdown reflects the **latest models** the connected
   account can use — fetched live, never a stale hardcoded list.
4. **Two ways to connect.** Support both **API key** and **username/password**
   (gateway) authentication.
5. **Fail clearly, in one line.** Connectivity/config failures say *"LLM not connected —
   configure System Configuration first"* — never an internal stage/path.
6. **Do no harm.** Existing behavior and data are preserved; local development keeps
   working.

---

## 4. Proposed solution

### 4.1 Restore AI generation (the core fix)

Replace the command-line dependency with a direct call to the cloud **Messages API**
over HTTPS — the same mechanism the product's background worker already uses
successfully. The command-line path is **kept only as an optional local-developer
fallback**, so nothing that works today regresses.

*Outcome:* once an LLM is connected (next section), all three input methods
(Upload BRD/FRD, Copy-Paste, Explore App) generate test cases.

### 4.2 Connect a cloud LLM — new System Configuration screen

A new **"AI / LLM Connection"** card in **System Configuration** (admin-only), with:

**Two authentication options (recommended vs. alternative):**

| Option | When to use | What the admin enters |
|---|---|---|
| **API Key** *(recommended — simplest, direct)* | Connecting directly to the AI provider | A single secret key |
| **Username & Password** *(alternative — enterprise gateway)* | Organizations that route AI through a corporate proxy/gateway that uses login auth | Username, password, and the gateway URL |

Both are stored **encrypted at rest** and shown **masked** after saving (e.g.
`sk-…ab`). The choice is a simple toggle; the form adapts to the selected option.

**"Test Connection" button:** validates the credentials immediately and reports
*Connected ✅ / Not configured ⚠️ / Authentication failed ❌* — so the admin gets instant
confirmation rather than discovering problems mid-run.

### 4.3 Always-current model list + cost-effective default

- The screen shows a **model dropdown populated live** by querying the provider's
  **Models API** with the saved credentials. It therefore always lists the newest
  models the account can access — no code change needed when the provider ships a new
  model.
- **The admin explicitly chooses a model** from that dropdown — the system does **not**
  auto-select one. To help them choose economically, each option can display a
  cost/tier hint (e.g. "fast/low-cost" vs "high-capability").
- **Choosing a model is required to complete the connection.** If no model is selected,
  generation is treated as "not configured" and shows the same clear message
  (Section 4.5) rather than silently guessing a model.
- The chosen model is saved per customer and used for all generation.

### 4.4 Token & cost discipline

- **Model choice is the biggest lever** — the dropdown shows each model's cost/tier so
  the admin can deliberately pick an economical one (the system does not decide for them).
- **Bounded output size** per call (sensible `max_tokens`), and prompt context trimmed.
- The current generator runs a **second "top-up" pass** that can roughly double token
  spend; this becomes **threshold-based/opt-in** so most runs use a single pass.
- **Per-run cost & token usage** surfaced to admins (the system already computes this),
  giving visibility and accountability.
- Optional **per-run token budget** guard to prevent runaway cost.

### 4.5 Clear, honest failure messaging

- A lightweight **pre-flight check** runs before the pipeline. If no LLM is connected,
  or the provider rejects the credentials, the user sees a **single message**:
  > **"AI is not connected. Please configure your LLM in System Configuration to
  > continue."** *(with a button that opens System Configuration)*
- Internal stage details (requirements / Jira / planning, etc.) are **logged for
  engineers** but **never shown** to the user when the real cause is connectivity/config.
- This converts today's confusing, trust-eroding errors into a clear next action.

---

## 5. What changes under the hood (for the technical reviewer)

| Area | Change | Risk |
|---|---|---|
| AI invocation | Agents call the Messages API (reusing the worker's proven client) instead of the CLI; CLI kept as local fallback | Low–Med — agents become async; the main pipeline already awaits them |
| Credentials store | Extend per-customer settings: auth mode, gateway URL, username/password (encrypted), selected model | Low — builds on the existing encrypted key slot |
| New endpoints | `Test connection`, `list models`, `get/set LLM connection` | Low — additive, admin-only, audited |
| Frontend | New System Configuration "AI / LLM Connection" card + connection status + model dropdown | Low — additive screen |
| Error handling | Pre-flight check + provider-error → friendly message mapping | Low — additive guard |

**Compatibility:** all changes are additive or behind the existing per-tenant settings;
no existing data is migrated destructively; local CLI workflows still function.

---

## 6. What we recommend (decisions for sign-off)

1. **Best way to connect:** **API key** — simplest, direct, fully supported, lowest
   operational overhead. *Recommended as the primary path.*
2. **Alternative:** **username/password via a corporate gateway URL** — for enterprises
   that mandate routing AI traffic through their own proxy. *Supported as a secondary
   option.*
3. **Model strategy:** the admin **explicitly selects** the model from a **live dropdown**
   of the latest available models (with cost/tier hints to guide an economical choice).
   The system does **not** auto-select, and there is no hardcoded model list.
4. **Key scope:** per-customer key entered in System Configuration, with an optional
   platform-wide fallback for shared/demo environments.

---

## 7. Delivery plan (phased)

| Phase | Goal | Outcome the reviewer can verify | Rough effort |
|---|---|---|---|
| **0 — Stop the bleeding** | AI generation works via API; friendly "not connected" message | Set one key → generation produces test cases; with no key, a clear one-line message | ~0.5–1 day |
| **1 — Self-serve connection** | System Configuration "AI / LLM Connection" card; both auth options; Test Connection; live model dropdown + cost-effective default | Admin connects an LLM end-to-end from the UI and sees "Connected" | ~2–3 days |
| **2 — Cost controls** | Economical default, single-pass default, per-run cost/token display, optional budget cap | Visible cost per run; reduced token usage vs. today | ~1–2 days |
| **3 — Enterprise hardening** | Audit trail, secret backed by Key Vault, multi-tenant validation, docs | Security review checklist passes | ~1–2 days |

Phases are independently shippable; Phase 0 restores the product immediately.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Making agents async introduces regressions | The main pipeline already awaits agents; changes are localized and covered by an end-to-end generation check before/after |
| A provider changes its model API, or the list can't be fetched | The model list is read at runtime; if the call fails the screen shows "couldn't load models — check the connection" and the admin re-selects once resolved (no silent default is substituted) |
| Credentials handling | Reuse the existing at-rest encryption + masking + audit logging; admin-only access; gateway option keeps traffic on-prem |
| Cost surprises | Economical default, single-pass default, per-run cost display, optional budget cap |

---

## 9. What we need from you to proceed

1. **Approve the approach** (Section 4) and the **phasing** (Section 7).
2. Confirm **key scope** (per-customer only, or per-customer + platform fallback).
3. Provide (or authorize obtaining) **one AI credential** to validate Phase 0 end-to-end
   in the deployed environment.

On approval we start with **Phase 0** (restores AI generation) and demo it before
proceeding to the self-serve UI.

---

### Appendix A — Confirmed root cause (evidence)

A live call to the deployed API returned:

```
POST /api/generate  →  HTTP 500   {"error":"Claude CLI not found"}
```

The server's AI runner (`backend/src/agents/claude-runner.ts`) shells out to a `claude`
command-line binary that is not installed in the cloud image. All AI agents
(requirements, planning, generation, scripting) depend on it, so generation fails before
producing output. A separate, working API-based client already exists in the background
worker (`backend/src/worker/sdk-executor.ts`) and is the basis for the fix.
