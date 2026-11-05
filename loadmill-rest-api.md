# Loadmill REST API Reference

> Source: <https://docs.loadmill.com/help-and-reference/rest-api>
> Crawled: 2026-11-05. Tip: append `.md` to any Loadmill docs page URL for its Markdown source; a full index lives at `https://docs.loadmill.com/llms.txt`.

## Overview

The Loadmill REST API lets you interact with Loadmill's servers to create and launch tests (test suites, load tests, and test plans) programmatically — for example from CI.

- **Base URL:** `https://app.loadmill.com/api/v1`
- All paths below are relative to that base URL.

## Authentication

Most endpoints require an API token sent in the `Authorization` header.

- Generate a token under **User menu → Settings → Security**.
- See the **API Tokens** integration guide for details.

```http
Authorization: <YOUR_API_TOKEN>
```

---

## Test Suites

### Run Test Suite

`POST /test-suites/:id/run`

Runs a predefined test suite.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `id` | string (UUID) | yes | The test suite id |
| Query | `forceAllFlows` | boolean | no | Default `false`. By default only flows with the CI toggle run; `true` runs all flows |
| Header | `Authorization` | string | yes | API token |
| Body | `additionalDescription` | string | no | Appended to the suite description |
| Body | `overrideParameters` | object | no | Parameter name/value pairs applied to this run only |

**Response 200**

```json
{ "testSuiteRunId": "<uuid>" }
```

### Get Test Suite Run

`GET /test-suites-runs/:id`

Returns results for a launched suite.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `id` | string (UUID) | yes | The run id returned when launching the suite |

**Response fields**

- `id`, `description`, `displayName`
- `startTime`, `endTime` (null while running)
- `conf`
- `status` — `PASSED` \| `FAILED` \| `RUNNING`
- `testSuiteId` (null if the suite was deleted)
- `testSuiteFlowRuns` — array of per-flow results
- `progress` (e.g. `"1/1"`), `successRate`, `avgResTime`

Each entry in `testSuiteFlowRuns` includes: `id`, start/end times, `conf`, `description`, `status`, `numOfRequests`, `avgResTime` (ms), `duration`.

### Get Test Suite Flow Run

`GET /test-suites-runs/flows/:id`

Returns results for a single flow run.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `id` | string (UUID) | yes | The flow run id, found in the Test Suite Run response |

**Response fields:** `id`, `description`, `conf`, `status`, `startTime`, `testSuiteFlowId` (null if deleted), `testSuiteId` (null if deleted).

### Stop Test Suite Run

`PUT /test-suites-runs/:id`

Stops a running suite.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `id` | string (UUID) | yes | The Test Suite Run id |
| Query | `forceFail` | boolean | no | `true` stops the run and sets its status to `FAILED` |
| Body | `additionalDescription` | string | no | Appended to the run description |

**Response 200:** empty body.

### Get Test Suites

`GET /test-suites`

Returns a list of test suites.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Query | `search` | string | no | Filter by phrase |
| Query | `rowsPerPage` | number | no | One of `10`, `25`, `50`, `100`. Default `10` |

**Response:** object with a `testSuites` array.

---

## Load Tests

### Create Load Test

`POST /tests`

Creates a load test from a configuration.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Body | `config` | object | yes | Export it from the test editor or a previous run. See the **Configuration Files** doc for an example |

**Response**

```json
{ "testId": "<id>" }
```

### Create Load from Test Suite Flow

`POST /test-suites/:suiteId/flows/:flowId/loads`

Creates a draft load test from a suite flow.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `suiteId` | string | yes | Test suite id |
| Path | `flowId` | string | yes | Flow id |
| Body | `loadTestOptions` | object | no | Defaults apply if omitted (see below) |

**`loadTestOptions` fields**

| Name | Type | Default | Notes |
|------|------|---------|-------|
| `targetedCountries` | string[] | — | Country codes |
| `monitoredEnv` | string | — | |
| `rampUp` | number | — | Seconds |
| `alwaysDistributed` | boolean | `false` | |
| `useStaticIp` | boolean | `false` | |
| `sensitiveData` | boolean | `false` | |
| `duration` | number | — | Seconds |
| `concurrency` | number | — | Concurrent users |
| `rps` | number | — | Requests per second |

**Response**

```json
{ "testId": "<id>" }
```

### Set Flow (attach a parameter pool)

`PATCH /test-suites/:suiteId/flows/:flowId/pools`

Creates a parameter pool and attaches it to a flow.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `suiteId` | string | yes | Test suite id |
| Path | `flowId` | string | yes | Flow id |
| Query | `name` | string | yes | Pool name |
| Header | `content-type` | string | yes | Must be `text/csv` |
| Header | `Authorization` | string | yes | API token |
| Body | — | string (CSV) | yes | CSV data |

### Run Load Test

`PUT /tests/:id/load`

Runs an existing load test. A test can run only once — recreate it to run again.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `id` | string | yes | Load test id |

### Get Load Test

`GET /tests/:id`

Returns load test data, including results once it has ended.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `id` | string | yes | Load test id |

**Response fields:** `id`, `startTime`, `endTime`, `usedSeconds`, `description`, `conf`, `result` (`aborted` \| `done` \| `failed`), `failedIterations`, `successfulIterations`.

---

## Labels

### Get Labels

`GET /labels`

Returns all labels for the user's team.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Query | `filter` | string | no | e.g. `active`, `evaluating` — limits to labels on flows with that status |

**Response**

```json
{ "teamLabels": [ { "id": "<id>", "description": "<label>" } ] }
```

---

## Test Plans

### Run Test Plan

`POST /test-plans/:test-plan-id/run`

Runs a predefined test plan.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `test-plan-id` | string | yes | |
| Body | `additionalDescription` | string | no | |
| Body | `labels` | string[] | no | Only flows with matching labels run |
| Body | `labelsExpression` | string | no | Boolean logic, e.g. `(label1 \| label2) & !label3` |
| Body | `overrideParameters` | object | no | Parameter name/value overrides |
| Body | `pool` | string | no | Use a private agent's pool |
| Body | `parallel` | number | no | Concurrency of suites, max `10` |
| Body | `maxFlakyFlowRetries` | number | no | Retry limit for flaky flows |

**Response:** object with `testPlanRunId`.

### Get Test Plan Run

`GET /test-plans-runs/:plan-run-id`

Returns the result of a plan run.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `test-plan-run-id` | string | yes | Returned when the plan launches |

### Re-run Test Plan

`POST /test-plans-runs/:test-plan-run-id/re-run`

Reruns a plan run.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Path | `test-plan-run-id` | string | yes | |
| Query | `onlyFailed` | boolean | no | Default `false`. `true` reruns only failed or stopped suites |

**Response:** object with `testPlanRunId`.

### Get Test Plans

`GET /test-plans`

Returns a list of test plans.

| In | Name | Type | Required | Notes |
|----|------|------|----------|-------|
| Query | `search` | string | no | Filter by phrase |
| Query | `rowsPerPage` | number | no | One of `10`, `25`, `50`, `100`. Default `10` |

---

## Endpoint Summary

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | POST | `/test-suites/:id/run` | Run a test suite |
| 2 | GET | `/test-suites-runs/:id` | Get a test suite run |
| 3 | GET | `/test-suites-runs/flows/:id` | Get a test suite flow run |
| 4 | PUT | `/test-suites-runs/:id` | Stop a test suite run |
| 5 | GET | `/test-suites` | List test suites |
| 6 | POST | `/tests` | Create a load test |
| 7 | POST | `/test-suites/:suiteId/flows/:flowId/loads` | Create a load from a suite flow |
| 8 | PATCH | `/test-suites/:suiteId/flows/:flowId/pools` | Attach a parameter pool to a flow |
| 9 | PUT | `/tests/:id/load` | Run a load test |
| 10 | GET | `/tests/:id` | Get a load test |
| 11 | GET | `/labels` | List team labels |
| 12 | POST | `/test-plans/:test-plan-id/run` | Run a test plan |
| 13 | GET | `/test-plans-runs/:plan-run-id` | Get a test plan run |
| 14 | POST | `/test-plans-runs/:test-plan-run-id/re-run` | Re-run a test plan |
| 15 | GET | `/test-plans` | List test plans |

## Related Links

- REST API page: <https://docs.loadmill.com/help-and-reference/rest-api>
- API Tokens integration guide (token setup)
- Configuration Files (load test `config` example)
- Full docs index: <https://docs.loadmill.com/llms.txt>
- Markdown version of any page: append `.md` to its URL
