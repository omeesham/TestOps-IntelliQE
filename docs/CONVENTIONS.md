# Documentation Conventions

> **Authoritative.** Every contributor adding documentation to this repository must follow these rules.
> **Last updated:** 2026-05-27

## 1. Documents are organized by feature, not by document type

Every meaningful piece of work — an architecture, a deployment, a major refactor, a new integration — gets its own folder inside `docs/`. All artifacts related to that work (architecture, deployment plan, runbook, ADRs, diagrams, test plans, cutover notes) live inside that folder.

**Do not** create top-level docs like `docs/ARCHITECTURE.md` or `docs/DEPLOYMENT.md` that mix multiple features. Such a file becomes a graveyard of stale sections within a quarter.

## 2. Folder name = GitHub branch name (exact match)

The subfolder name under `docs/` must be **byte-identical** to the GitHub feature branch name that delivers the work.

| GitHub branch | Docs folder |
|---|---|
| `feature-azure-baseline` | `docs/feature-azure-baseline/` |
| `feature-{descriptor}` | `docs/feature-{descriptor}/` |

**Why:** Anyone reviewing a PR can find the design docs by looking at the branch name. Anyone reading the docs can find the code by checking out the branch.

**Branch naming rules** (existing repo convention — keep using it):
- Lowercase, hyphen-separated, ASCII only
- Prefix: `feature-` for new features, `fix-` for bug-fix work big enough to warrant docs, `chore-` for infrastructure refactors that don't change product behavior
- Short slug describing the scope (e.g. `feature-azure-baseline`, not `feature-omeesha-new-stuff-for-azure-and-some-other-things`)

## 3. File naming inside a feature folder

**Every file inside a feature folder must follow this exact pattern, no exceptions:**

```
{feature-branch-name}-{NNN}-{descriptor}.{ext}
```

Where:
- `{feature-branch-name}` = the parent folder's name, repeated as a prefix on every file.
- `{NNN}` = three-digit zero-padded sequential number, starting at `001`. Numbers are assigned in the order documents are created and never re-used, even if a document is deleted.
- `{descriptor}` = lowercase hyphen-separated short slug (3–6 words) describing the document's content.
- `{ext}` = file extension (`md` for documents, `drawio`/`png`/`svg` for diagrams, etc.).

### Examples (from `feature-azure-baseline/`)

```
feature-azure-baseline-001-overview.md
feature-azure-baseline-002-plans-considered.md
feature-azure-baseline-003-selected-architecture.md
feature-azure-baseline-004-iac-skeleton.md           ← future
feature-azure-baseline-005-runbook.md                ← future
feature-azure-baseline-008-adr-replace-xor-crypto.md ← future ADR
```

### Rules and rationale

| Rule | Why |
|---|---|
| **No bare `README.md`** inside feature folders. The first document (`-001-overview.md` or similar) serves as the entry point. | One consistent rule; file listings sort cleanly by the `NNN` number. |
| **Three-digit number, always.** `007`, never `7`. | File-manager and `ls` sort lexicographically; padding keeps order correct past 9 and past 99. |
| **Numbers are monotonically increasing**, even across document types (overview, ADR, runbook all share one sequence). | Anyone can answer "what came next?" by looking at one column. Prevents ADR vs guide vs runbook collisions. |
| **Numbers are never re-used.** Deleting a document leaves a gap; the next document still takes the next available number. | Git history + audit trail remain unambiguous. A reference to `feature-X-014-foo.md` always meant the same document. |
| **Descriptor is short and content-driven.** `selected-architecture`, not `the-architecture-we-eventually-selected-after-much-debate`. | Folder listings stay scannable. |
| **No spaces, no uppercase, no underscores.** Hyphens only. | One consistent token style across folder, branch, and filenames. |
| **Sub-folders inside a feature folder are discouraged.** If you need to group, use the descriptor (e.g., `-008-adr-replace-xor.md`, `-009-adr-entra-external-id.md`). | Keeps the natural `ls` view a complete table of contents. |
| **The first document (NNN=001) is always the overview** — feature scope, document index, reading guide. | Reader always knows where to start. |

## 4. Standard documents inside a feature folder

Every feature folder should have at minimum:

- **`-001-overview.md`** — Mandatory entry point. Summarizes the feature, lists every document in the folder with purpose, gives a role-based reading order (implementer / reviewer / auditor), lists out-of-scope items, and notes the next available `NNN`.

Optional, add as the feature matures (each as its own numbered file):

- A plans-considered or design-options doc (early in the sequence)
- A selected-architecture or implementation doc
- A runbook (operator procedures: deploy, rollback, scale, DR)
- A test plan (load, security, DR drill)
- A cutover plan (production rollout sequence)
- Architecture Decision Records — one ADR per substantive decision (`-NNN-adr-{slug}.md`)
- Diagram source files (`-NNN-diagram-{slug}.drawio` and exported `.png`/`.svg` siblings)

## 5. Cross-feature concerns

If a decision genuinely affects multiple features (organization-wide HIPAA posture, the auth scheme, the IaC tooling choice), document it in the **first feature folder where the decision is made**, then link to it from subsequent features. Do **not** copy-paste.

If a decision becomes truly cross-cutting later, promote it to `docs/` root only after at least two features have referenced it. Premature promotion creates the graveyard problem in §1.

## 6. What belongs in `docs/` root (not a feature folder)

Only these:

- **`CONVENTIONS.md`** — this file
- **`README.md`** — index of all feature folders (one-line description + link each)
- Auto-generated cross-feature glossaries or indices (not yet present)

That's it. Anything else goes in a feature folder.

## 7. Maintaining the index

When you create a new feature folder, also add a one-line entry to `docs/README.md` linking to it. When a feature is fully delivered and stable, mark the folder's overview (`-001-overview.md`) with `Status: Delivered` (don't delete — historical context matters for audits).

## 8. Decision documents preserve rejected options

In any design or architecture document, when a choice is made between multiple options:

- List every option seriously considered (typically 2–5)
- For each: pros, cons, and verdict (Selected / Rejected with one-line reason)
- Include why the rejected options were rejected, not just why the selected one was chosen

This is non-negotiable for HIPAA-scope work where auditors expect to see the decision trail. It is also extremely helpful six months later when the team has forgotten the original tradeoffs.

## 9. Pre-existing folders (one-time grandfathering)

The following files predate this convention and are exempt from §2 / §3 until they are refactored:

- `docs/architecture-diagram.md`
- `docs/component-diagram.md`
- `docs/infrastructure-diagram.md`
- `docs/TECHNICAL_SPEC.md`
- `docs/DATABASE_SCHEMA.md`
- `docs/DATABASE_SETUP_PROMPT.md`

These should be reviewed and either (a) folded into the appropriate feature folder following §3 naming, or (b) confirmed as cross-cutting and left at the root, on a case-by-case basis. New work must not extend these files; create a feature folder instead.
