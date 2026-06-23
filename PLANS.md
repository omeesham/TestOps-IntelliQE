# JBS IntelliQE — Implementation Status

All three previously-deferred items have been implemented. This file
now serves as the historical record of what was delivered for each
work package, so future contributors can find the entry points without
re-reading the commit history.

---

## Item #2 — Real Git Publish (PR creation) ✅ DELIVERED

### What was delivered
A working `POST /api/git/publish` route that opens a real pull/merge
request on the user's connected GitHub, GitLab, or Bitbucket
integration. The fake `setTimeout` + "Pull request created
successfully" lie has been removed from `handlePublishToGit`.

### File map
| Layer | File | Purpose |
|---|---|---|
| Provider interface | `backend/src/services/git/git.types.ts` | `GitProvider`, `GitFile`, `GitProviderConfig`, `PublishResult`, `parseRepoUrl()` |
| GitHub provider | `backend/src/services/git/github.provider.ts` | Octokit-based branch + commit + PR |
| GitLab provider | `backend/src/services/git/gitlab.provider.ts` | Gitbeaker-based branch + atomic commit + MR |
| Bitbucket provider | `backend/src/services/git/bitbucket.provider.ts` | Native `fetch` + Basic auth + `/src` commit + PR |
| HTTP route | `backend/src/routes/git.routes.ts` | Resolves config_data, auto-picks provider from URL host, calls provider, returns PublishResult |
| Frontend client | `frontend/src/services/api.ts` → `publishToGit()` | POST helper |
| Frontend wiring | `frontend/src/pages/ChatPage.tsx` → `handlePublishToGit` | Calls real API, renders PR URL on success |

### Behaviour
- The provider is **auto-detected from the repo URL host**. The user
  doesn't pick GitHub vs GitLab manually — whatever they pasted as
  `repo_url` in the integration determines which provider runs.
- Branch name defaults to `intelliqe/tests-<iso-timestamp>` so two
  publishes from the same run never collide.
- Files are placed under `tests/` (overridable via `directory` param).
- PR body auto-includes file list + test-run id + review checklist.
- Credentials decrypted from `client_configurations.config_data` via
  the existing `decryptConfigData` helper.
- All error paths return 4xx with a clear message — no silent fallback.

### Dependencies added
```
@octokit/rest      ^22.0.1
@gitbeaker/rest    ^43.8.0
```
Bitbucket uses native `fetch` (Node 20+) so no SDK was added.

### Provider permission requirements
- **GitHub**: PAT with `repo` scope (or fine-grained: contents read+write, pull-requests write).
- **GitLab**: PAT with `api` scope (or `write_repository`).
- **Bitbucket**: App password with `Repositories: Write` + `Pull requests: Write`.

---

## Item #8 — Confluence + SharePoint Requirement Fetchers ✅ DELIVERED

### What was delivered
Full end-to-end integration for both providers mirroring the existing
Jira pattern. The "not yet integrated" toast in the wizard has been
removed. Both sources now populate `pendingRequirements` with real
content the test-generation pipeline consumes verbatim.

### File map
| Layer | File | Purpose |
|---|---|---|
| Confluence service | `backend/src/services/confluence.service.ts` | Cloud REST v2 client, Basic auth, list + getPage with storage-format → plain text conversion |
| Confluence routes | `backend/src/routes/confluence.routes.ts` | `GET /api/confluence/status`, `/pages?spaceKey=`, `/page/:id` |
| SharePoint service | `backend/src/services/sharepoint.service.ts` | `ClientSecretCredential` + Microsoft Graph SDK, list + getDocument with reuse of `document-parser.service.ts` for PDF/DOCX extraction |
| SharePoint routes | `backend/src/routes/sharepoint.routes.ts` | `GET /api/sharepoint/status`, `/documents`, `/document/:id` |
| Catalog update | `frontend/src/components/system-config/integrationCatalog.ts` | SharePoint integration now requires `tenantId` (Azure AD), alongside `clientId` + `clientSecret` |
| Frontend client | `frontend/src/services/api.ts` | `getConfluencePages`, `getConfluencePage`, `getSharePointDocuments`, `getSharePointDocument` |
| Frontend wiring | `frontend/src/pages/ChatPage.tsx` | `pickSource` branches per provider; `handleStorySelect` calls the right detail endpoint per `source` |

### Behaviour
- **Confluence**: lists up to 50 recently-modified pages; optional
  `?spaceKey=` filter. Storage-format HTML is converted to readable
  plain text including `ac:structured-macro` code-block unwrapping.
- **SharePoint**: lists up to 50 most-recent files in the site's
  default Document library; PDFs and DOCXs are downloaded server-side
  and extracted using the SAME parser the document-upload route uses,
  so quality is consistent across paths.

### Dependencies added
```
@azure/identity                       ^4.13.1
@microsoft/microsoft-graph-client     ^3.0.7
isomorphic-fetch                      ^3.0.0   (required peer for Graph SDK)
```

### Required Microsoft Graph permissions (Application, admin-consent)
- `Sites.Read.All` — for site + drive metadata
- `Files.Read.All` — for downloading file contents

### Confluence credentials
Same as Jira — email + API token from `https://id.atlassian.com/manage-profile/security/api-tokens`.

---

## Item #9 — Per-Test Execution Details ✅ DELIVERED (in earlier sweep)

Closed as part of items #3 + #4. Recap:
- `backend/src/agents/executionAgent.ts` captures `durationMs` per spec
  from Playwright's JSON reporter and emits `executionResults.details[]`.
- `backend/src/routes/execute.routes.ts` surfaces `executionDetails` at
  the top level of the response.
- `frontend/src/pages/ChatPage.tsx` reads these real per-test outcomes
  directly — no fabricated durations, no index-based fake pass/fail.

---

## Verification (post-implementation)

```
backend:  npm run build                → exit 0
frontend: npx tsc --noEmit             → exit 0
grep sweep for simulat|mocked|FIXME|HACK only returns legitimate hits
  ('fixme' FSM status — a real terminal state for pipeline runs).
```

No remaining mocks, simulations, or stub responses in source.

---

## How to wire a new credential set

The four integrations now live in `client_configurations` with the
following config_data shapes (sensitive fields auto-encrypted at rest):

| integration_id | Required fields |
|---|---|
| `jira` | `jira_url`, `email`, `api_token` |
| `confluence` | `url`, `email`, `api_token` |
| `sharepoint` | `siteUrl`, `tenantId`, `clientId`, `clientSecret` |
| `github` / `gitlab` / `bitbucket` | `repo_url`, `branch`, `access_token` (+ `username` for Bitbucket app password) |

Connect each in System Configuration → Integrations.
