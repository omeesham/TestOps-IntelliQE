# Feature: Azure Deployment Baseline

> **GitHub branch:** `feature-azure-baseline`
> **Folder convention:** This folder's name mirrors the branch name exactly. Every file inside is named `feature-azure-baseline-NNN-{descriptor}.md`. See [docs/CONVENTIONS.md](../CONVENTIONS.md).
> **Status:** Architecture documented. Implementation not started.
> **Owner:** TBD

## What this feature delivers

The foundational Azure landing zone and deployment architecture for JBSIntelliQE. Establishes the cloud baseline that every subsequent feature builds on:

- Multi-subscription tenancy (dev / staging / prod) under a single Entra ID tenant
- HIPAA-compliant managed-PaaS architecture (BAA-covered services only)
- Selected runtime topology: unified frontend+backend Container App + separate event-driven worker + managed PostgreSQL
- Hub-spoke VNet with private endpoints for all data services
- Identity (Entra External ID for users, Managed Identity for workloads), secrets (Key Vault), edge (Front Door + WAF), queue (Service Bus), observability (App Insights + Log Analytics), CI/CD (GitHub Actions + OIDC), IaC (Bicep)

## Documents in this folder

| # | File | Purpose |
|---|---|---|
| 001 | `feature-azure-baseline-001-overview.md` (this file) | Feature entry point. Read this first. |
| 002 | [feature-azure-baseline-002-plans-considered.md](feature-azure-baseline-002-plans-considered.md) | All three Azure plans we evaluated (Managed PaaS Starter, Container Apps Unified, AKS Enterprise) with options-considered-and-rejected, cross-cutting design decisions (identity, secrets, HIPAA, networking, observability, CI/CD, IaC, DR), decision matrix, and migration triggers between plans. The baseline reference. |
| 003 | [feature-azure-baseline-003-selected-architecture.md](feature-azure-baseline-003-selected-architecture.md) | The architecture we are building: Plan B with the unified frontend+backend container customization. Component-by-component decisions, code/repo changes required, SSE multi-replica design note, 9-week phased implementation plan, HIPAA checklist, risks, and open questions. |

## How to read this folder

1. **First time?** Start with [feature-azure-baseline-002-plans-considered.md §1 Executive Summary](feature-azure-baseline-002-plans-considered.md#1-executive-summary) for the three-plan comparison, then jump to [feature-azure-baseline-003-selected-architecture.md §1](feature-azure-baseline-003-selected-architecture.md#1-the-decision-in-one-page) for the chosen path.
2. **Implementing something?** Go straight to [feature-azure-baseline-003-selected-architecture.md §5 Code & Repository Changes Required](feature-azure-baseline-003-selected-architecture.md#5-code--repository-changes-required) and §8 (phase plan).
3. **HIPAA / audit review?** Read [feature-azure-baseline-002-plans-considered.md §3.2](feature-azure-baseline-002-plans-considered.md#32-hipaa--baa-posture) (posture) then [feature-azure-baseline-003-selected-architecture.md §9](feature-azure-baseline-003-selected-architecture.md#9-hipaa-compliance-checklist) (checklist).
4. **Questioning a design decision?** Both documents preserve the options we considered and rejected — search for "Verdict" or "Rejected" to find the rationale.

## Future artifacts that belong in this folder

When the feature progresses, the following artifacts should also live here. **Continue the `NNN` sequence**; do not restart numbering, do not skip numbers. The next available number is **004**.

- `feature-azure-baseline-004-iac-skeleton.md` — Bicep modules + per-env stacks layout (or link to `/infra/` and document the layout)
- `feature-azure-baseline-005-runbook.md` — operator runbook (deploy, rollback, scale, DR drill)
- `feature-azure-baseline-006-test-plan.md` — load test, penetration test, DR drill plans
- `feature-azure-baseline-007-cutover.md` — production cutover sequence and rollback criteria
- `feature-azure-baseline-008-adr-{slug}.md`, `-009-adr-{slug}.md`, ... — Architecture Decision Records for decisions that override or extend earlier docs

If a decision is purely about this feature, capture it here. If a decision is cross-cutting (affects other features), capture it in the appropriate feature folder and link from here.

## Out of scope for this feature

These belong in their own feature folders, not here:

- Per-tenant onboarding workflow
- Customer-facing changes (UI, product features)
- Anything specific to a single Azure service that the baseline doesn't cover (e.g., adding Azure Search would be its own feature)
- Cost optimization passes (separate feature once we have real production cost data)
