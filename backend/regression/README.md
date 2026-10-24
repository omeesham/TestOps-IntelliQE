# Regression suite

Proves that functionality users already rely on still works after a change.
Run it before merging into `integration` or a `poc/**` branch.

| Layer | File | Checks |
| --- | --- | --- |
| API | `api.regression.spec.ts` | Every read endpoint keeps its status and response shape (field names and types) against `approved/api-shapes.json`. New fields are fine; missing fields, changed types or statuses fail. |
| UI | `ui.regression.spec.ts` | Sign-in; Chat from pasted text and from an uploaded document to a saved suite; scripts → run → heal → report; Generated Test Cases edit, add, delete and CSV export; Automation Scripts; Reports; User Management; Feature Toggles; every System Configuration section. Any browser error or 5xx API response fails the journey. |

AI steps are answered by `fake-ai.mjs`, a local stand-in for the Anthropic API, so runs are fast,
free and repeatable. The generated scripts test a page they build themselves, and one of them
fails until it is healed. Jira, Confluence, SharePoint, TestRail and Git need real accounts and
are not covered.

## Run

1. Start the fake AI: `npm run regression:fake-ai` (port 4599).
2. Start the backend in development mode with:
   `ANTHROPIC_API_KEY=regression ANTHROPIC_BASE_URL=http://localhost:4599`, plus `DEV_ADMIN_PASSWORD`.
3. Start the frontend.
4. Run:
   ```bash
   REG_BASE_URL=http://localhost:5173 REG_API_URL=http://localhost:3001 \
   REG_USER=jbsadmin REG_PASSWORD=<DEV_ADMIN_PASSWORD> npm run regression
   ```
   The HTML report is written to `regression/regression-report`.

## Differences and known issues

- **Deliberate changes:** list a changed endpoint, with its reason, in `expected-differences.ts`
  (`API_DIFFERENCES`). It is then reported, not failed.
- **Existing bugs:** product bugs that were already there are listed in `KNOWN_ISSUES` until
  they are fixed.
- **New approved results:** record them only from a known-good build with `REG_RECORD=1`,
  and review the diff of `approved/api-shapes.json` in the PR.
