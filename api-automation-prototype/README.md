# API Automation — Prototype

A simplified-rebuild of the JBSIntelliQE API automation **core**, built to the
spec in [`../API-AUTOMATION-PROTOTYPE-BLUEPRINT.md`](../API-AUTOMATION-PROTOTYPE-BLUEPRINT.md).

**The one idea it proves:** the LLM designs test *intent* as **typed JSON**
(a closed `ApiCheck` set); deterministic code renders and runs it. The model
never writes a line of code.

```
ApiSpec ─▶ generator (1 LLM call) ─▶ NormalizedCase[]  ─▶ renderer ─▶ executor ─▶ RunResult[]
         (typed JSON out)          (model output = data)           (live HTTP, typed checks)
```

## Layout

| File | Role |
|---|---|
| `src/types.ts` | The 4 types (copied from production `state.ts`) |
| `src/llm.ts` | One Anthropic Messages API call (`claude-opus-5-5`) |
| `src/generator.ts` | Prompt → defensive JSON parse → normalize |
| `src/renderer.ts` | `NormalizedCase` → `ExecutableCase` (the swap seam for real Playwright rendering) |
| `src/executor.ts` | Live HTTP + the typed-check engine (ported from the flow runner) |
| `src/flow.ts` | **M4** — multi-step journeys: `extract` → `{{var}}` `substitute` |
| `src/seed.ts` | Deterministic **offline** generator (stand-in when no API key) |
| `src/server.ts` | 4 endpoints (generate / run / flow / cURL import) |
| `src/demo.ts` | CLI proof — single-endpoint suites against live public APIs |
| `src/flow-demo.ts` | CLI proof — a live create → read → delete → confirm-404 journey |
| `web/index.html` | Define form + Report table + the M4 flow panel |

## Run

```bash
npm install
```

Prove the deterministic half live against real public APIs (no key needed):

```bash
npm run demo
```

Prove the M4 stateful journey live (create → read → delete → confirm 404, with `{{var}}` chaining):

```bash
npm run flow
```

Typecheck:

```bash
npm run typecheck
```

Start the app:

```bash
npm start
```

Then open http://localhost:4100 — define an endpoint, design a suite, run it.

## AI generation

Set `ANTHROPIC_API_KEY` (copy `.env.example` → `.env`) to enable the real model
call in the generator. **Without a key, `/api/generate` falls back to a labelled
deterministic heuristic** so the full loop still runs — but that is *not* the AI
half of the invariant, just a stand-in so the UI is demonstrable offline.

## Scope

This is the irreducible core only. Deliberately omitted (see the blueprint):
multi-tenancy, auth/DB/worker, Playwright spec-file rendering, self-healing, and
the ~110 other `api-*` services in the production platform. Nothing here has to
be thrown away to grow into them — the 4 types match production.
