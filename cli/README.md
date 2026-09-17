# intelliqe-api — CLI for IntelliQE API Automation

Drive the whole API Automation pipeline from a terminal or a CI job, over the
RESTful public API (`/api/v1/public/api-automation`). No dependencies — Node 18+.

```bash
# one-off
node cli/intelliqe-api.mjs help

# or install the bin
cd cli && npm link      # → `intelliqe-api` on your PATH
```

## Authenticate

```bash
intelliqe-api login --url https://intelliqe.example.com --user jbsadmin
# token saved to ~/.intelliqe/config.json (0600)

# CI: no config file needed
export INTELLIQE_URL=https://intelliqe.example.com
export INTELLIQE_TOKEN=$(curl -s -X POST $INTELLIQE_URL/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"ci-bot","password":"…"}' | jq -r .token)
```

## Import anything

```bash
intelliqe-api import openapi.yaml                        # OpenAPI / Swagger (JSON or YAML)
intelliqe-api import orders.postman_collection.json      # Postman v2.x
intelliqe-api import api-docs.pdf                        # PDF / Word / Excel / Markdown — AI-read
intelliqe-api import --url https://api.acme.com/openapi.json
intelliqe-api import --url https://docs.acme.com/reference   # a docs page
intelliqe-api import --curl "curl -X POST https://api.acme.com/v1/login -d '{\"u\":\"a\"}'"
intelliqe-api import --graphql https://api.acme.com/graphql --bearer $TOKEN
intelliqe-api import --mcp https://mcp.acme.com/mcp
intelliqe-api import --connector connector.json          # custom connector manifest
```

Every import writes `endpoints.json` (override with `--out`) and prints the API
profile the platform derived — resources, CRUD chains, auth, pagination, flows,
risks and the recommended strategy.

## Understand, then run

```bash
intelliqe-api analyze endpoints.json
intelliqe-api run endpoints.json --env staging --wait
intelliqe-api run --spec openapi.yaml --coverage standard --layers smoke,contract,negative,flow --wait
intelliqe-api run endpoints.json --no-execute        # design + save scenarios only
```

`--wait` streams the phases (environment → analyze → design → save → execute →
heal → report) and exits **3** when the run has failures, so a pipeline step
fails honestly. Without `--wait`, poll with `intelliqe-api job <jobId> --wait`.

## Test information (RESTful)

```bash
intelliqe-api projects                 # what has been automated, grouped by API
intelliqe-api plans                    # saved scenario suites
intelliqe-api builds                   # executions with pass/fail stats
intelliqe-api build <buildId>          # every session (scenario) in a build
intelliqe-api session <buildId> TC-004 # one scenario's result
intelliqe-api envs                     # environments
intelliqe-api builds --json | jq '.data[0].stats'
```

## REST endpoints behind the CLI

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/public/api-automation/projects` | APIs automated, grouped |
| GET | `/api/v1/public/api-automation/plans[/:id]` | Saved scenario suites (+ cases) |
| GET | `/api/v1/public/api-automation/builds[/:id]` | Executions (+ sessions) |
| GET | `/api/v1/public/api-automation/builds/:id/sessions/:tc` | One scenario result |
| POST | `/api/v1/public/api-automation/runs` | Start the headless pipeline → `{ jobId }` |
| GET | `/api/v1/public/api-automation/runs/:jobId` | Poll (status, progress, result) |
| POST | `/api/v1/public/api-automation/imports` | `{ kind: text\|url\|curl\|graphql\|mcp\|connector, … }` |
| GET | `/api/v1/public/api-automation/imports` | Import history |
| POST | `/api/v1/public/api-automation/analyze` | Pattern intelligence for endpoints |
| GET | `/api/v1/public/api-automation/environments` | Environments |
| GET | `/api/v1/public/api-automation/me` | Token check |

All routes take `Authorization: Bearer <token>`; collections return
`{ data, meta }`, errors return `{ error }`.
