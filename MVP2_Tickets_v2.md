# MVP2 Tickets — IntelliQE API Automation

> Source: `MVP2_Tickets_v2 2.xlsx` · Generated 2026-11-12 · 38 child features across 17 parent features, plus a 120-row Pattern Coverage reference.

## Contents

- **IQE-044 REST API Testing (JSON, XML and HTML)**
  - [IQE-044.1 REST API testing – JSON responses](#iqe-044-1-rest-api-testing-json-responses)
  - [IQE-044.2 REST API testing – XML responses](#iqe-044-2-rest-api-testing-xml-responses)
  - [IQE-044.3 REST API testing – HTML responses](#iqe-044-3-rest-api-testing-html-responses)
- **IQE-040 Generator Agent**
  - [IQE-040.1 Generate API test scripts – positive cases and create/read/update/delete methods](#iqe-040-1-generate-api-test-scripts-positive-cases-and-create-read-update-delete-methods)
  - [IQE-040.2 Generate API test scripts – negative and boundary cases](#iqe-040-2-generate-api-test-scripts-negative-and-boundary-cases)
  - [IQE-040.3 Generate API test scripts – auth cases](#iqe-040-3-generate-api-test-scripts-auth-cases)
- **IQE-041 Healer Agent**
  - [IQE-041.1 API failure analysis – suggest likely cause (no auto-fix)](#iqe-041-1-api-failure-analysis-suggest-likely-cause-no-auto-fix)
- **IQE-045 GraphQL Testing (JSON)**
  - [IQE-045.1 GraphQL API testing – queries and mutations](#iqe-045-1-graphql-api-testing-queries-and-mutations)
- **IQE-037 API Automation Flow**
  - [IQE-037.1 Guided API automation flow – import to report](#iqe-037-1-guided-api-automation-flow-import-to-report)
  - [IQE-037.2 API automation flow – end-to-end validation and 15-minute first report](#iqe-037-2-api-automation-flow-end-to-end-validation-and-15-minute-first-report)
- **IQE-046 SOAP Testing (XML)**
  - [IQE-046.1 SOAP – import operations from WSDL](#iqe-046-1-soap-import-operations-from-wsdl)
  - [IQE-046.2 SOAP – run tests with XML, schema and fault checks](#iqe-046-2-soap-run-tests-with-xml-schema-and-fault-checks)
- **IQE-047 API import – OpenAPI / Swagger**
  - [IQE-047.1 Import OpenAPI / Swagger into the endpoint catalogue](#iqe-047-1-import-openapi-swagger-into-the-endpoint-catalogue)
- **IQE-048 API import – Postman collection**
  - [IQE-048.1 Import Postman collection – requests, folders, variables and auth](#iqe-048-1-import-postman-collection-requests-folders-variables-and-auth)
  - [IQE-048.2 Import Postman environments into IntelliQE environments](#iqe-048-2-import-postman-environments-into-intelliqe-environments)
- **IQE-049 API import – Bruno**
  - [IQE-049.1 Import Bruno collection – .bru files and folders](#iqe-049-1-import-bruno-collection-bru-files-and-folders)
  - [IQE-049.2 Import Bruno environments into IntelliQE environments](#iqe-049-2-import-bruno-environments-into-intelliqe-environments)
- **IQE-050 API import – cURL**
  - [IQE-050.1 Import endpoints from cURL commands](#iqe-050-1-import-endpoints-from-curl-commands)
- **IQE-051 API import – HAR**
  - [IQE-051.1 Import endpoints from a HAR recording](#iqe-051-1-import-endpoints-from-a-har-recording)
- **IQE-052 API import – GraphQL**
  - [IQE-052.1 Import GraphQL schema by introspection or SDL](#iqe-052-1-import-graphql-schema-by-introspection-or-sdl)
- **IQE-053 GitHub Code Push (API Automation)**
  - [IQE-053.1 Push API test scripts to GitHub and open a pull request](#iqe-053-1-push-api-test-scripts-to-github-and-open-a-pull-request)
  - [IQE-053.2 Secret check before any code push (shared by all git providers)](#iqe-053-2-secret-check-before-any-code-push-shared-by-all-git-providers)
- **IQE-054 GitLab Code Push (API and Web Automation)**
  - [IQE-054.1 GitLab code push – API scripts](#iqe-054-1-gitlab-code-push-api-scripts)
  - [IQE-054.2 GitLab code push – Web scripts](#iqe-054-2-gitlab-code-push-web-scripts)
- **IQE-055 Bitbucket Code Push (API and Web Automation)**
  - [IQE-055.1 Bitbucket code push – API scripts](#iqe-055-1-bitbucket-code-push-api-scripts)
  - [IQE-055.2 Bitbucket code push – Web scripts](#iqe-055-2-bitbucket-code-push-web-scripts)
- **IQE-056 Azure DevOps (ADO) Repository – code push**
  - [IQE-056.1 Azure DevOps Repos – connection and Web script push](#iqe-056-1-azure-devops-repos-connection-and-web-script-push)
  - [IQE-056.2 Azure DevOps code push – API scripts](#iqe-056-2-azure-devops-code-push-api-scripts)
- **IQE-043 API Studio (import, endpoints, scenarios, scripts, runs, reports, environments)**
  - [IQE-043.1 API Studio – environments and variables](#iqe-043-1-api-studio-environments-and-variables)
  - [IQE-043.2 API Studio – workspace navigation and role-based access](#iqe-043-2-api-studio-workspace-navigation-and-role-based-access)
  - [IQE-043.3 API pattern – request building (parameters, headers and body types)](#iqe-043-3-api-pattern-request-building-parameters-headers-and-body-types)
  - [IQE-043.4 API pattern – response validation (schema, types and content types)](#iqe-043-4-api-pattern-response-validation-schema-types-and-content-types)
  - [IQE-043.5 API pattern – pagination, search, filter and sort](#iqe-043-5-api-pattern-pagination-search-filter-and-sort)
  - [IQE-043.6 API pattern – chaining, data-driven and parallel calls (integrated APIs)](#iqe-043-6-api-pattern-chaining-data-driven-and-parallel-calls-integrated-apis)
  - [IQE-043.7 API pattern – error contract and status handling](#iqe-043-7-api-pattern-error-contract-and-status-handling)
  - [IQE-043.8 API pattern – timeouts, retries, redirects and rate limits](#iqe-043-8-api-pattern-timeouts-retries-redirects-and-rate-limits)
  - [IQE-043.9 API pattern – cookies and caching](#iqe-043-9-api-pattern-cookies-and-caching)
  - [IQE-043.10 API pattern – observability and secure logging](#iqe-043-10-api-pattern-observability-and-secure-logging)
- [Pattern Coverage](#pattern-coverage)

---

## IQE-044 REST API Testing (JSON, XML and HTML)

### IQE-044.1 REST API testing – JSON responses

**Description**

> User story
> As a QA engineer,
> I want to run tests on REST APIs that return JSON and check the status, headers, data and response time,
> so that I can confirm each endpoint behaves as expected before release, without writing manual checks.
>
> Background
> Most REST APIs return JSON. Today the QA engineer has to check each response by hand to see whether the API returned the right status, the right headers and the right data, and whether it was fast enough. This story lets those checks run inside IntelliQE and shows clearly what failed and why.
>
> User flow
> 1. The QA engineer opens an imported REST endpoint that returns JSON.
> 2. They add the checks they need: status code, header, a value at a JSON path, and response time.
> 3. They run positive, negative and boundary cases for the endpoint's method (GET, POST, PUT, PATCH or DELETE).
> 4. IntelliQE shows pass or fail for each check.
> 5. For a failed check, they see expected vs actual, with the full request and response, so they can tell what went wrong.
> 6. All results appear in the run report.
>
> In scope
> • Checks on status code, headers, JSON path values and response time
> • Positive, negative and boundary cases for GET, POST, PUT, PATCH and DELETE
> • Failure view showing expected vs actual, with the full request and response
> • Results in the run report
>
> Out of scope
> • XML responses (IQE-044.2) and HTML responses (IQE-044.3)
> • Auth flows such as OAuth 2.0, JWT and API keys (IQE-061)
>
> Dependencies
> • At least one REST endpoint imported (IQE-047 OpenAPI or another import feature)

**Acceptance Criteria**

1. The user can add a check on the response status code (for example 200, 201, 400 or 404).
2. The user can add a check on a response header's name and value (for example Content-Type = application/json).
3. The user can add a check on a value at a JSON path (for example $.data.id equals 101).
4. The user can add a response-time check with a maximum time in milliseconds. The test fails when the response is slower.
5. Positive, negative and boundary cases run for GET, POST, PUT, PATCH and DELETE.
6. On failure, the result shows expected vs actual for each failed check, plus the full request (method, URL, headers, body) and the full response (status, headers, body).
7. Passed and failed checks appear in the run report.
8. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-044.2 REST API testing – XML responses

**Description**

> User story
> As a QA engineer,
> I want to run tests on REST APIs that return XML and check the status, headers, data and response time,
> so that I can validate XML-based services the same way as JSON ones.
>
> Background
> Some REST APIs return XML instead of JSON. The QA engineer needs the same checks as for JSON, but must be able to read values from the XML body. This story adds XML support on top of the checks and failure view built in IQE-044.1.
>
> User flow
> 1. The QA engineer opens an imported REST endpoint that returns XML.
> 2. They add the checks they need: status code, header, a value at an XML path, and response time.
> 3. They run positive, negative and boundary cases for the endpoint's method (GET, POST, PUT, PATCH or DELETE).
> 4. IntelliQE shows pass or fail for each check.
> 5. For a failed check, they see expected vs actual, with the full request and response, so they can tell what went wrong.
> 6. All results appear in the run report.
>
> In scope
> • Checks on status code, headers, XML path values and response time
> • Positive, negative and boundary cases for GET, POST, PUT, PATCH and DELETE
> • Clear failure when the body is not valid XML
> • The same failure view and run report as IQE-044.1
>
> Out of scope
> • JSON responses (IQE-044.1) and HTML responses (IQE-044.3)
> • SOAP services (IQE-046)
> • Auth flows such as OAuth 2.0, JWT and API keys (IQE-061)
>
> Dependencies
> • IQE-044.1 (checks and failure view)
> • At least one REST endpoint that returns XML imported

**Acceptance Criteria**

1. The user can add a check on a value at an XML path (for example /order/status equals CONFIRMED).
2. Status code, header and response-time checks work for XML responses the same way as in IQE-044.1.
3. Positive, negative and boundary cases run for GET, POST, PUT, PATCH and DELETE.
4. An invalid or non-XML body fails the test with a clear message, not a crash.
5. On failure, the result shows expected vs actual, plus the full request and response.
6. Passed and failed checks appear in the run report.
7. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-044.3 REST API testing – HTML responses

**Description**

> User story
> As a QA engineer,
> I want to run tests on REST endpoints that return HTML and check the status, headers, content and response time,
> so that I can confirm the returned page content is correct.
>
> Background
> Some endpoints return HTML rather than data. The QA engineer needs to confirm that the right content comes back, together with the usual status, header and response-time checks. This story adds HTML content checks on top of IQE-044.1.
>
> User flow
> 1. The QA engineer opens an imported REST endpoint that returns HTML.
> 2. They add the checks they need: status code, header, HTML content, and response time.
> 3. They run positive, negative and boundary cases for the endpoint's method (GET, POST, PUT, PATCH or DELETE).
> 4. IntelliQE shows pass or fail for each check.
> 5. For a failed check, they see expected vs actual, with the full request and response, so they can tell what went wrong.
> 6. All results appear in the run report.
>
> In scope
> • Checks on status code, headers, HTML content and response time
> • Positive, negative and boundary cases for GET, POST, PUT, PATCH and DELETE
> • The same failure view and run report as IQE-044.1
>
> Out of scope
> • JSON responses (IQE-044.1) and XML responses (IQE-044.2)
> • Browser UI testing of web pages (Web automation)
> • Auth flows such as OAuth 2.0, JWT and API keys (IQE-061)
>
> Dependencies
> • IQE-044.1 (checks and failure view)
> • At least one REST endpoint that returns HTML imported

**Acceptance Criteria**

1. The user can add a check that the HTML response contains, or does not contain, given text.
2. Status code, header and response-time checks work for HTML responses the same way as in IQE-044.1.
3. Positive, negative and boundary cases run for GET, POST, PUT, PATCH and DELETE.
4. On failure, the result shows expected vs actual, plus the full request and response.
5. Passed and failed checks appear in the run report.
6. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-040 Generator Agent

### IQE-040.1 Generate API test scripts – positive cases and create/read/update/delete methods

**Description**

> User story
> As a QA engineer,
> I want IntelliQE to generate runnable API test scripts from the approved test plan,
> so that I get working automation for every endpoint without writing scripts by hand.
>
> Background
> The existing Generator agent writes Web scripts. For API we do not build a new agent: the existing Generator is given API instruction and skill files as context. This story delivers the base: positive-case scripts that validate every create, read, update and delete method on the imported API.
>
> Market note (BA): competing tools can send API data to a third-party AI model. IntelliQE runs inside the customer environment with the customer's own keys, so credentials must never reach the AI model or the scripts.
>
> User flow
> 1. The QA engineer approves the API test plan.
> 2. They start script generation.
> 3. IntelliQE generates scripts in the project language for each planned endpoint.
> 4. They review the scripts and run them.
>
> In scope
> • API instruction and skill files for the existing Generator agent
> • Scripts only (JS or TS), not test case documents
> • Positive cases and validation of every create, read, update and delete method on the imported API
> • Each script includes the request, expected status, expected body or schema, and the checks
>
> Out of scope
> • Negative and boundary cases (IQE-040.2)
> • Auth cases (IQE-040.3)
> • Analysing failed scripts (IQE-041 Healer)
>
> Dependencies
> • Approved API test plan (IQE-039 Planner)
> • Imported API (IQE-047 to IQE-052)

**Acceptance Criteria**

1. Scripts are generated in the language set for the project (JS or TS); the default is TS. (BA recommendation – language setting to be confirmed by Omeesha)
2. Every planned endpoint gets positive-case scripts covering each of its methods (create, read, update, delete).
3. Every script contains the request, expected status, expected body or schema, and checks.
4. No invented endpoints or fields: every script maps to the imported API.
5. At least 90% of generated scripts run without manual fixes on the sample API.
6. Generation uses the existing Generator agent with the API instruction and skill files. No new agent is added.
7. No credentials, tokens or secrets are sent to the AI model or written into scripts; scripts read them from the environment. (BA recommendation)
8. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-040.2 Generate API test scripts – negative and boundary cases

**Description**

> User story
> As a QA engineer,
> I want the generated scripts to include negative and boundary cases by default,
> so that I find how the API behaves with bad, missing and edge-value input without having to ask for it.
>
> Background
> Positive cases (IQE-040.1) only show the API works when everything is correct. Most API defects appear with invalid input or limit values. This story extends generation to those cases, driven only by what the API spec states.
>
> Market note (BA): leading tools generate negative and boundary cases only when the user asks for them explicitly. Generating them by default, from the spec, is an IntelliQE differentiator.
>
> User flow
> 1. The QA engineer approves the API test plan.
> 2. IntelliQE generates negative and boundary scripts alongside the positive scripts.
> 3. They run the scripts and review the results.
>
> In scope
> • Missing-field and wrong-type cases
> • Boundary cases for limits stated in the spec (min/max, length, enum)
> • Checks on the expected error status and error body
>
> Out of scope
> • Auth cases (IQE-040.3)
> • Inventing limits the spec does not state
>
> Dependencies
> • IQE-040.1

**Acceptance Criteria**

1. Every required field in the spec gets a "missing field" case. (BA recommendation)
2. Every field with a type in the spec gets a "wrong type" case. (BA recommendation)
3. Every min/max, length or enum limit in the spec gets cases at the limit and just outside it. (BA recommendation)
4. Fields with no limits in the spec get no invented boundary cases. (BA recommendation)
5. Each negative and boundary case checks the expected error status and error body.
6. No invented endpoints or fields: every script maps to the imported API.
7. At least 90% of generated scripts run without manual fixes on the sample API.
8. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-040.3 Generate API test scripts – auth cases

**Description**

> User story
> As a QA engineer,
> I want the generated scripts to include auth cases,
> so that I can confirm secured endpoints reject requests without valid access.
>
> Background
> Secured endpoints must refuse calls that lack valid credentials or the right role. This story generates those scripts. The auth setup, token refresh and secure token storage belong to IQE-061; this story only generates the test scripts.
>
> Market note (BA): AI-generated API tests in competing tools often miss auth-boundary checks such as one user reading another user's data (IDOR).
>
> User flow
> 1. The QA engineer configures auth for the API (IQE-061).
> 2. IntelliQE generates auth-case scripts for every secured endpoint.
> 3. They run the scripts and review the results.
>
> In scope
> • Missing, invalid, expired and wrong-role token cases
> • Cross-user access (IDOR) cases for endpoints that take a resource ID
>
> Out of scope
> • Auth setup, token refresh and token storage (IQE-061)
>
> Dependencies
> • IQE-040.1
> • IQE-061 Auth Testing

**Acceptance Criteria**

1. Every secured endpoint gets cases for a missing, invalid, expired and wrong-role token, each checking the expected rejection status.
2. Where an endpoint takes a resource ID, a case checks that a user cannot read another user's resource (IDOR). (BA recommendation)
3. No tokens or credentials are written into scripts.
4. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-041 Healer Agent

### IQE-041.1 API failure analysis – suggest likely cause (no auto-fix)

**Description**

> User story
> As a QA engineer,
> when an API test fails I want IntelliQE to suggest the likely cause with evidence,
> so that I know where to look first, while I stay in control of any change.
>
> Background
> For Web tests the Healer fixes broken locators. API tests have no locators, so automatic fixing is not safe. For API, the Healer only analyses the failure and gives a high-level suggestion. It never changes a script.
>
> Market note (BA): some competitors change API tests automatically when the API changes. IntelliQE never changes a script silently; every suggestion is explainable and the user stays in control.
>
> User flow
> 1. An API test fails during a run.
> 2. IntelliQE classifies the failure and suggests the likely reason, citing the evidence.
> 3. The suggestion appears with the failed test and in the report, with the note "Please check all the API details and revalidate."
> 4. The QA engineer reviews it and decides what to do.
>
> In scope
> • Classifying each failure as a likely API change, real defect or environment issue
> • A high-level suggestion of the likely reason, with evidence
> • The fixed revalidation note on every suggestion
> • Suggestions listed in the run report
>
> Out of scope
> • Changing scripts automatically
> • Re-running tests automatically
>
> Dependencies
> • API scripts and runs (IQE-040, IQE-044)

**Acceptance Criteria**

1. Every failed API test gets a classification: likely API change, real defect or environment issue.
2. Every failed API test gets a high-level suggestion of the likely reason.
3. Each suggestion cites its evidence: the field, header or status that differed (expected vs actual). (BA recommendation)
4. Every suggestion shows the note "Please check all the API details and revalidate."
5. The Healer never changes a script and never re-runs a test on its own.
6. Every suggestion is listed in the run report for review.
7. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-045 GraphQL Testing (JSON)

### IQE-045.1 GraphQL API testing – queries and mutations

**Description**

> User story
> As a QA engineer,
> I want to test GraphQL queries and mutations generated from the schema,
> so that I can validate GraphQL APIs as reliably as REST APIs.
>
> Background
> GraphQL often returns HTTP 200 even when the request failed, and reports the error in an "errors" array. A status-only check would pass a broken call. This story makes sure those errors fail the test.
>
> Market note (BA): best practice also fails a partial result (data and errors together) by default, and a malformed query returns a 4xx rather than 200.
>
> User flow
> 1. The QA engineer imports a GraphQL schema (IQE-052).
> 2. IntelliQE generates queries and mutations, with variables, from the schema.
> 3. They add field-level checks and run the tests.
> 4. Any response with an "errors" array fails, even when the status is 200.
>
> In scope
> • Queries and mutations generated from the schema, with variables
> • The "errors" array and partial-result checks
> • Field-level checks on returned data
>
> Out of scope
> • Subscriptions
>
> Dependencies
> • IQE-052 GraphQL import

**Acceptance Criteria**

1. Queries and mutations are generated from the imported schema, with variables.
2. A response containing an "errors" array fails the test even when the HTTP status is 200.
3. A response containing both "data" and "errors" (a partial result) fails by default. (BA recommendation)
4. A malformed query is reported with the server's 4xx status and error message. (BA recommendation)
5. The user can add field-level checks on returned data (for example data.order.status equals "PAID").
6. On failure, the result shows expected vs actual, plus the full request and response.
7. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-037 API Automation Flow

### IQE-037.1 Guided API automation flow – import to report

**Description**

> User story
> As a QA engineer,
> I want one guided flow that takes me from importing an API to a test report,
> so that I can automate API testing without knowing every screen of the product.
>
> Background
> The API features (import, agents, run, report) are built as separate pieces. This story joins them into one guided flow: import an API, review endpoints, generate tests, run them and get a report. Each step must show where the user is, what went wrong and what to do next.
>
> Market note (BA): time from sign-up to first test result is a key adoption measure for API tools; a guided first run is the main lever for it.
>
> User flow
> 1. The QA engineer starts the API automation flow.
> 2. Import: they import an API (any supported format).
> 3. Endpoints: they review the imported endpoints.
> 4. Generate: they generate test scripts.
> 5. Run: they run the scripts against a selected environment.
> 6. Report: they see the run report.
>
> In scope
> • One guided flow with the five steps: import, endpoints, generate, run, report
> • Progress, error and "next action" shown at every step
> • Requirement inputs: API spec or requirement document (including Confluence)
>
> Out of scope
> • End-to-end sign-off on a real customer API (IQE-037.2)
> • The extra API Studio tools moved to MVP3
>
> Dependencies
> • Import features (IQE-047 to IQE-052)
> • Agents (IQE-038 to IQE-041)
> • REST testing (IQE-044)

**Acceptance Criteria**

1. The flow shows five steps in order: import, endpoints, generate, run, report.
2. Each step shows its progress while it is working.
3. Each step shows a clear error message when it fails, and a next action the user can take.
4. The user can move to the next step only when the current step has finished successfully.
5. The flow accepts an API spec or a requirement document, including Confluence, as the starting input.
6. The user can leave the flow and return to the same step later without losing work. (BA recommendation)
7. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-037.2 API automation flow – end-to-end validation and 15-minute first report

**Description**

> User story
> As a new IntelliQE user,
> I want to reach my first API test report quickly and without help,
> so that I see value from the product on day one.
>
> Background
> This story proves the guided flow (IQE-037.1) works end to end, on the built-in sample API and on one real customer API, and that a new user can finish it in under 15 minutes without help.
>
> User flow
> 1. A new user, with no training, opens the guided flow.
> 2. They complete all five steps on the sample API.
> 3. The same flow is completed on one real customer API.
> 4. Time to first report is measured.
>
> In scope
> • End-to-end run on the sample API
> • End-to-end run on one real customer API
> • Measuring time to first report
>
> Out of scope
> • New functionality (covered by IQE-037.1 and the feature tickets)
>
> Dependencies
> • IQE-037.1
> • Access to one real customer API

**Acceptance Criteria**

1. A new user goes from import to a first report in under 15 minutes without help.
2. All five steps work end to end on the sample API.
3. All five steps work end to end on one real customer API.
4. Any defects found are logged and fixed, or accepted by the product owner, before sign-off.
5. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-046 SOAP Testing (XML)

### IQE-046.1 SOAP – import operations from WSDL

**Description**

> User story
> As a QA engineer,
> I want to import a SOAP service from its WSDL and get every operation with a sample request,
> so that I can start testing SOAP services without building XML requests by hand.
>
> Background
> Many enterprise systems still expose SOAP services described by a WSDL. This story reads the WSDL and creates one endpoint per operation, each with a ready sample XML request.
>
> Market note (BA): WSDL import with generated sample requests is the baseline in established SOAP tools (e.g. SoapUI / ReadyAPI); without it SOAP support is not credible.
>
> User flow
> 1. The QA engineer uploads a WSDL file or gives its URL.
> 2. IntelliQE lists every operation found.
> 3. Each operation gets a sample XML request.
> 4. They review the operations in the endpoint catalogue.
>
> In scope
> • WSDL by file upload or URL
> • One endpoint per operation, with a sample request
> • Import summary
>
> Out of scope
> • Running tests and checks (IQE-046.2)
> • WS-Security (pending confirmation)
>
> Dependencies
> • Endpoint catalogue (API Studio)
> • SOAP version (1.1 / 1.2) to be confirmed by Omeesha

**Acceptance Criteria**

1. The user can import a WSDL by file upload or by URL.
2. Every operation in the WSDL appears as an endpoint in the catalogue.
3. Each operation has a sample XML request built from the WSDL.
4. An invalid WSDL gives a clear error message, not a crash.
5. An import summary shows how many items were imported and lists anything skipped, with the reason.
6. Supported SOAP version(s): to be confirmed by Omeesha (1.1, 1.2 or both).
7. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-046.2 SOAP – run tests with XML, schema and fault checks

**Description**

> User story
> As a QA engineer,
> I want to run SOAP tests and check the XML response, its schema and SOAP faults,
> so that I can validate SOAP services in the same suites and reports as my REST tests.
>
> Background
> SOAP services report errors as SOAP faults inside the XML body. This story runs SOAP operations and checks the response, its schema and faults, with results in the same suites and reports as REST.
>
> User flow
> 1. The QA engineer opens an imported SOAP operation.
> 2. They add checks on XML values, the schema and expected faults.
> 3. They run the test, alone or in a suite with REST tests.
> 4. Results appear in the shared run report.
>
> In scope
> • Checks on XML response values
> • Response validation against the WSDL schema
> • SOAP fault checks
> • Same suites and reports as REST
>
> Out of scope
> • WS-Security (pending confirmation)
>
> Dependencies
> • IQE-046.1
> • IQE-044.2 (XML checks and failure view)

**Acceptance Criteria**

1. The user can add a check on a value in the XML response.
2. The response is validated against the schema in the WSDL; a mismatch fails the test and names the element.
3. A SOAP fault fails the test unless the test expects that fault; the fault code and message are shown.
4. SOAP tests run in the same suites and appear in the same reports as REST tests.
5. On failure, the result shows expected vs actual, plus the full request and response.
6. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-047 API import – OpenAPI / Swagger

### IQE-047.1 Import OpenAPI / Swagger into the endpoint catalogue

**Description**

> User story
> As a QA engineer,
> I want to import an OpenAPI or Swagger spec by file or URL,
> so that the endpoint catalogue is built for me automatically.
>
> Background
> OpenAPI / Swagger is the most common way APIs are described. This story reads the spec and creates the full endpoint catalogue: paths, methods, parameters, schemas and auth. Re-importing a newer version updates the catalogue without duplicates.
>
> Market note (BA): specs often split schemas with $ref and list several servers; leading tools resolve both. Showing what changed on re-import helps users see the impact of an API change.
>
> User flow
> 1. The QA engineer uploads a spec file or gives its URL.
> 2. IntelliQE validates it and builds the catalogue.
> 3. They see an import summary.
> 4. Later, they re-import a new version and see what changed.
>
> In scope
> • OpenAPI 3.x and Swagger 2.0, JSON or YAML, by file or URL
> • Paths, methods, parameters, schemas and auth
> • Re-import without duplicates
>
> Out of scope
> • Contract/breaking-change validation on every run (IQE-088, MVP3)
>
> Dependencies
> • Endpoint catalogue (API Studio)

**Acceptance Criteria**

1. OpenAPI 3.x and Swagger 2.0 specs import as JSON or YAML, by file upload or URL.
2. All paths, methods, parameters, schemas and auth schemes are imported.
3. An invalid spec gives a clear message naming the problem, not a crash.
4. Re-importing the same API updates changed endpoints without creating duplicates.
5. Schemas referenced with $ref are resolved. (BA recommendation)
6. Server URLs in the spec are offered as environment base URLs. (BA recommendation)
7. Re-import shows a summary of endpoints added, changed and removed. (BA recommendation)
8. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-048 API import – Postman collection

### IQE-048.1 Import Postman collection – requests, folders, variables and auth

**Description**

> User story
> As a QA engineer,
> I want to import my existing Postman collection,
> so that I can move my API tests into IntelliQE without rebuilding them.
>
> Background
> Postman is the most widely used API client, so most teams already hold their APIs in Postman collections. This story imports a collection with its folders, variables and auth into the endpoint catalogue.
>
> Market note (BA): Postman collections often contain JavaScript pre-request and test scripts that cannot run outside Postman. Users must be told clearly what was not carried over.
>
> User flow
> 1. The QA engineer exports a collection from Postman.
> 2. They upload it to IntelliQE.
> 3. IntelliQE builds the catalogue from the requests and folders.
> 4. They see an import summary.
>
> In scope
> • Postman v2.0 and v2.1 collections
> • Folders, requests, collection variables and auth
> • Import summary
>
> Out of scope
> • Postman environments (IQE-048.2)
> • Running Postman pre-request or test scripts
>
> Dependencies
> • Endpoint catalogue (API Studio)

**Acceptance Criteria**

1. Postman v2.0 and v2.1 collections import with their folders, requests, variables and auth.
2. Folders appear as groups in the endpoint catalogue.
3. Auth set on a folder or the collection is applied to the requests under it. (BA recommendation)
4. Saved example responses are kept as the expected response. (BA recommendation)
5. Pre-request and test scripts are not run; they are listed as skipped in the import summary. (BA recommendation)
6. An import summary shows how many items were imported and lists anything skipped, with the reason.
7. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-048.2 Import Postman environments into IntelliQE environments

**Description**

> User story
> As a QA engineer,
> I want my Postman environments to become IntelliQE environments,
> so that I can run the imported requests against Dev, QA or UAT straight away.
>
> Background
> Postman keeps base URLs and secrets in environments. This story maps collection and environment variables to IntelliQE environments, with secrets masked.
>
> User flow
> 1. The QA engineer uploads a Postman environment file with or after the collection.
> 2. IntelliQE creates or updates the matching IntelliQE environment.
> 3. They switch environment and run the imported requests.
>
> In scope
> • Postman environment files
> • Mapping of variables to IntelliQE environments
> • Masking of secret values
>
> Out of scope
> • Postman globals (to be confirmed)
>
> Dependencies
> • IQE-048.1
> • Environments (API Studio IQE-043.1)

**Acceptance Criteria**

1. A Postman environment file imports into an IntelliQE environment with all its variables.
2. Collection and environment variables used in requests resolve correctly after import.
3. Variables marked secret in Postman are stored masked and never shown in plain text. (BA recommendation)
4. An import summary shows how many items were imported and lists anything skipped, with the reason.
5. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-049 API import – Bruno

### IQE-049.1 Import Bruno collection – .bru files and folders

**Description**

> User story
> As a QA engineer,
> I want to import my Bruno collection,
> so that teams that keep their APIs in Git with Bruno can use IntelliQE without rework.
>
> Background
> Bruno stores each request as a .bru text file in folders kept in Git. This story imports those files and folders, with requests, variables and auth, into the endpoint catalogue.
>
> Market note (BA): Bruno is growing as a Git-friendly alternative to Postman; a whole collection is usually shared as a folder, so importing a zipped folder in one step matters.
>
> User flow
> 1. The QA engineer uploads .bru files or a zipped collection folder.
> 2. IntelliQE builds the catalogue, keeping the folder structure.
> 3. They see an import summary.
>
> In scope
> • .bru files and folders
> • Requests, variables and auth
> • Import summary
>
> Out of scope
> • Bruno environment files (IQE-049.2)
> • Running Bruno scripts
>
> Dependencies
> • Endpoint catalogue (API Studio)

**Acceptance Criteria**

1. Bruno .bru files and folders import with their requests, variables and auth.
2. The folder structure is kept as groups in the endpoint catalogue.
3. A whole collection can be imported in one step as a zipped folder. (BA recommendation)
4. Bruno scripts and tests are not run; they are listed as skipped in the import summary. (BA recommendation)
5. An import summary shows how many items were imported and lists anything skipped, with the reason.
6. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-049.2 Import Bruno environments into IntelliQE environments

**Description**

> User story
> As a QA engineer,
> I want my Bruno environment files to become IntelliQE environments,
> so that I can run the imported requests against the right environment straight away.
>
> Background
> Bruno keeps base URLs and secrets in environment files. This story maps them to IntelliQE environments, with secrets masked.
>
> User flow
> 1. The QA engineer uploads Bruno environment files.
> 2. IntelliQE creates or updates the matching IntelliQE environments.
> 3. They switch environment and run the imported requests.
>
> In scope
> • Bruno environment files
> • Mapping of variables to IntelliQE environments
> • Masking of secret values
>
> Out of scope
> • Bruno .bru request files (IQE-049.1)
>
> Dependencies
> • IQE-049.1
> • Environments (API Studio IQE-043.1)

**Acceptance Criteria**

1. Bruno environment files import into IntelliQE environments with all their variables.
2. Variables used in imported requests resolve correctly after import.
3. Variables marked secret in Bruno are stored masked and never shown in plain text. (BA recommendation)
4. An import summary shows how many items were imported and lists anything skipped, with the reason.
5. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-050 API import – cURL

### IQE-050.1 Import endpoints from cURL commands

**Description**

> User story
> As a QA engineer,
> I want to paste one or more cURL commands and get endpoints from them,
> so that I can start testing from a call I copied from the browser or terminal.
>
> Background
> Testers often have a working cURL command from browser developer tools, documentation or a developer. This story turns pasted cURL commands into endpoints and moves any secrets into the environment.
>
> Market note (BA): browser developer tools offer "Copy as cURL" in both bash and Windows (cmd) formats; supporting both avoids failed imports for Windows users.
>
> User flow
> 1. The QA engineer pastes one or more cURL commands.
> 2. IntelliQE parses each command into an endpoint.
> 3. Secrets are moved to the environment and masked.
> 4. They see an import summary.
>
> In scope
> • Method, URL, headers, body and auth from standard cURL syntax
> • Several commands in one paste
> • Moving secrets into the environment
>
> Out of scope
> • cURL options that do not describe the request (for example output or proxy settings)
>
> Dependencies
> • Endpoint catalogue and Environments (API Studio)

**Acceptance Criteria**

1. Method, URL, headers, body and auth are parsed correctly from standard cURL syntax.
2. Several commands can be pasted at once; each becomes its own endpoint.
3. Secrets found in a command (tokens, passwords, API keys) are moved to the environment and masked.
4. Commands copied as "cURL (bash)" and "cURL (cmd)" from browser developer tools both import. (BA recommendation)
5. Options that cannot be imported are listed in the import summary, not silently dropped. (BA recommendation)
6. An import summary shows how many items were imported and lists anything skipped, with the reason.
7. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-051 API import – HAR

### IQE-051.1 Import endpoints from a HAR recording

**Description**

> User story
> As a QA engineer,
> I want to build endpoints from a browser HAR recording of real traffic,
> so that I can test the APIs an application really calls, even when there is no spec.
>
> Background
> A HAR file records every network call a browser made. This story extracts the API calls, ignores static files, merges duplicates and masks cookies and tokens.
>
> Market note (BA): HAR files usually also contain third-party calls (analytics, ads, fonts). Letting the user pick which domains to import keeps the catalogue clean.
>
> User flow
> 1. The QA engineer records traffic in the browser and saves a HAR file.
> 2. They upload it to IntelliQE.
> 3. They choose which domains to import.
> 4. IntelliQE builds endpoints and shows an import summary.
>
> In scope
> • Extracting API calls from a HAR file
> • Ignoring static files
> • Merging duplicate calls
> • Masking cookies and tokens
>
> Out of scope
> • Live traffic capture (MVP3 tool)
>
> Dependencies
> • Endpoint catalogue (API Studio)

**Acceptance Criteria**

1. API calls are extracted from a HAR file; static files (images, CSS, JS, fonts) are ignored.
2. Duplicate calls are merged into one endpoint.
3. Cookies and tokens are masked before saving.
4. The user can choose which domains to import before the endpoints are created. (BA recommendation)
5. An import summary shows how many items were imported and lists anything skipped, with the reason.
6. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-052 API import – GraphQL

### IQE-052.1 Import GraphQL schema by introspection or SDL

**Description**

> User story
> As a QA engineer,
> I want to import a GraphQL schema from a live endpoint or a schema file,
> so that I can test GraphQL APIs from their real schema.
>
> Background
> A GraphQL schema can be read from a live server (introspection) or from an SDL file. This story loads the schema and lists queries, mutations and types in the catalogue.
>
> Market note (BA): most production GraphQL servers need auth for introspection, and many switch introspection off. Both cases must be handled clearly.
>
> User flow
> 1. The QA engineer gives a GraphQL endpoint URL (with headers if needed) or uploads an SDL file.
> 2. IntelliQE loads the schema.
> 3. Queries, mutations and types appear in the catalogue.
>
> In scope
> • Live introspection by URL
> • SDL file upload
> • Queries, mutations and types listed
>
> Out of scope
> • Generating and running GraphQL tests (IQE-045)
> • Subscriptions
>
> Dependencies
> • Endpoint catalogue (API Studio)

**Acceptance Criteria**

1. A schema can be loaded by live introspection from a URL or by SDL file upload.
2. Queries, mutations and types are listed in the catalogue.
3. When introspection is disabled on the server, a clear message tells the user to upload the SDL file instead.
4. Auth headers can be supplied for introspection; they are stored masked. (BA recommendation)
5. An import summary shows how many items were imported and lists anything skipped, with the reason.
6. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-053 GitHub Code Push (API Automation)

### IQE-053.1 Push API test scripts to GitHub and open a pull request

**Description**

> User story
> As a QA engineer,
> I want to push generated API test scripts to our GitHub repository as a pull request,
> so that the scripts go through our normal code review and CI without manual copying.
>
> Background
> GitHub push for Web scripts already exists (MVP1, IQE-016). This story adds the same for API scripts: commit to a new branch and open a pull request automatically.
>
> Market note (BA): customer CI needs to know which environment variables the scripts expect; committing a template with the names (no values) makes the scripts runnable straight away.
>
> User flow
> 1. The QA engineer has generated API scripts.
> 2. They choose "Push to GitHub".
> 3. IntelliQE commits the scripts to a new branch and opens a pull request.
> 4. The pull request link appears in IntelliQE.
>
> In scope
> • Commit to a new branch with a clear commit message
> • Automatic pull request
> • Pull request link shown and stored with the run
>
> Out of scope
> • Triggering or creating CI pipelines
> • Web script push (already delivered in MVP1)
>
> Dependencies
> • IQE-040 Generator (API scripts)
> • IQE-053.2 Secret check before push

**Acceptance Criteria**

1. Scripts are committed to a new branch with a clear commit message.
2. A pull request is opened automatically against the configured target branch.
3. The pull request link is shown in IntelliQE and stored with the run.
4. No secrets, tokens or passwords appear in committed files (enforced by IQE-053.2).
5. The commit includes an environment template listing the variable names the scripts need, without values. (BA recommendation)
6. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-053.2 Secret check before any code push (shared by all git providers)

**Description**

> User story
> As a QA lead,
> I want every code push to be checked for secrets before it leaves IntelliQE,
> so that tokens and passwords never end up in our repositories.
>
> Background
> All four code push features (GitHub, GitLab, Bitbucket, Azure DevOps) require "no secrets in committed files". This story builds that check once and applies it to every provider, instead of four times.
>
> Market note (BA): leaked credentials in Git are a leading cause of breaches; Git hosts now block pushes that contain secrets, so IntelliQE should catch them first.
>
> User flow
> 1. The user starts a push to any provider.
> 2. IntelliQE scans the files about to be committed.
> 3. If a secret is found, the push is stopped and the file and line are shown.
> 4. If none is found, the push continues.
>
> In scope
> • Scanning files before push
> • Blocking the push when a secret is found
> • Used by GitHub, GitLab, Bitbucket and Azure DevOps push
>
> Out of scope
> • Scanning the customer's existing repository
>
> Dependencies
> • None (first used by IQE-053.1)

**Acceptance Criteria**

1. Before every push, the files to be committed are scanned for secrets (tokens, passwords, API keys, private keys).
2. If a secret is found, the push is stopped and the user sees the file and line, with the value masked.
3. Scripts read secrets from the environment, so a normal generated push contains none.
4. The same check runs for GitHub, GitLab, Bitbucket and Azure DevOps pushes.
5. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-054 GitLab Code Push (API and Web Automation)

### IQE-054.1 GitLab code push – API scripts

**Description**

> User story
> As a QA engineer,
> I want to push generated API test scripts to our GitLab repository as a merge request,
> so that the scripts go through our normal code review without manual copying.
>
> Background
> This story adds GitLab push for API scripts, matching GitHub (IQE-053.1).
>
> Market note (BA): many enterprises run self-managed GitLab on their own domain, not gitlab.com.
>
> User flow
> 1. The QA engineer has generated API scripts.
> 2. They choose "Push to GitLab".
> 3. IntelliQE commits the scripts to a new branch and opens a merge request.
> 4. The merge request link appears in IntelliQE.
>
> In scope
> • Commit to a new branch and automatic merge request
> • Merge request link shown and stored with the run
>
> Out of scope
> • Web script push (separate ticket)
> • Triggering CI pipelines
>
> Dependencies
> • IQE-040 Generator (API scripts)
> • IQE-053.2 Secret check before push

**Acceptance Criteria**

1. Scripts are committed to a new branch with a clear commit message.
2. A merge request is opened automatically against the configured target branch.
3. The merge request link is shown in IntelliQE and stored with the run.
4. No secrets, tokens or passwords appear in committed files (enforced by IQE-053.2).
5. Works with gitlab.com and self-managed GitLab URLs, including nested groups. (BA recommendation – self-hosted scope to be confirmed by Omeesha)
6. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-054.2 GitLab code push – Web scripts

**Description**

> User story
> As a QA engineer,
> I want to push generated Web test scripts to our GitLab repository as a merge request,
> so that the scripts go through our normal code review without manual copying.
>
> Background
> GitLab push for Web scripts already exists in the product. This story checks it against the MVP2 criteria (link stored with the run, secret check) and closes any gaps, rather than rebuilding it.
>
> User flow
> 1. The QA engineer has generated Web scripts.
> 2. They choose "Push to GitLab".
> 3. IntelliQE commits the scripts to a new branch and opens a merge request.
> 4. The merge request link appears in IntelliQE.
>
> In scope
> • Commit to a new branch and automatic merge request
> • Merge request link shown and stored with the run
>
> Out of scope
> • API script push (separate ticket)
> • Triggering CI pipelines
>
> Dependencies
> • Existing Web script generation
> • IQE-053.2 Secret check before push

**Acceptance Criteria**

1. Scripts are committed to a new branch with a clear commit message.
2. A merge request is opened automatically against the configured target branch.
3. The merge request link is shown in IntelliQE and stored with the run.
4. No secrets, tokens or passwords appear in committed files (enforced by IQE-053.2).
5. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-055 Bitbucket Code Push (API and Web Automation)

### IQE-055.1 Bitbucket code push – API scripts

**Description**

> User story
> As a QA engineer,
> I want to push generated API test scripts to our Bitbucket repository as a pull request,
> so that the scripts go through our normal code review without manual copying.
>
> Background
> This story adds Bitbucket push for API scripts, matching GitHub (IQE-053.1).
>
> User flow
> 1. The QA engineer has generated API scripts.
> 2. They choose "Push to Bitbucket".
> 3. IntelliQE commits the scripts to a new branch and opens a pull request.
> 4. The pull request link appears in IntelliQE.
>
> In scope
> • Commit to a new branch and automatic pull request
> • Pull request link shown and stored with the run
>
> Out of scope
> • Web script push (separate ticket)
> • Triggering CI pipelines
>
> Dependencies
> • IQE-040 Generator (API scripts)
> • IQE-053.2 Secret check before push

**Acceptance Criteria**

1. Scripts are committed to a new branch with a clear commit message.
2. A pull request is opened automatically against the configured target branch.
3. The pull request link is shown in IntelliQE and stored with the run.
4. No secrets, tokens or passwords appear in committed files (enforced by IQE-053.2).
5. Bitbucket Server / Data Center support: to be confirmed by Omeesha (today only bitbucket.org is supported).
6. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-055.2 Bitbucket code push – Web scripts

**Description**

> User story
> As a QA engineer,
> I want to push generated Web test scripts to our Bitbucket repository as a pull request,
> so that the scripts go through our normal code review without manual copying.
>
> Background
> Bitbucket push for Web scripts already exists in the product. This story checks it against the MVP2 criteria (link stored with the run, secret check) and closes any gaps, rather than rebuilding it.
>
> User flow
> 1. The QA engineer has generated Web scripts.
> 2. They choose "Push to Bitbucket".
> 3. IntelliQE commits the scripts to a new branch and opens a pull request.
> 4. The pull request link appears in IntelliQE.
>
> In scope
> • Commit to a new branch and automatic pull request
> • Pull request link shown and stored with the run
>
> Out of scope
> • API script push (separate ticket)
> • Triggering CI pipelines
>
> Dependencies
> • Existing Web script generation
> • IQE-053.2 Secret check before push

**Acceptance Criteria**

1. Scripts are committed to a new branch with a clear commit message.
2. A pull request is opened automatically against the configured target branch.
3. The pull request link is shown in IntelliQE and stored with the run.
4. No secrets, tokens or passwords appear in committed files (enforced by IQE-053.2).
5. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-056 Azure DevOps (ADO) Repository – code push

### IQE-056.1 Azure DevOps Repos – connection and Web script push

**Description**

> User story
> As a QA engineer,
> I want to connect IntelliQE to Azure DevOps Repos and push Web test scripts as a pull request,
> so that teams on Azure DevOps get the same code delivery as GitHub teams.
>
> Background
> IntelliQE already connects to Azure DevOps for work items and bug push, but cannot push code to Azure DevOps Repos. This story adds the repository connection and Web script push.
>
> Market note (BA): Azure DevOps is common in Microsoft-centred enterprises; reusing the existing Azure DevOps connection avoids a second set of credentials.
>
> User flow
> 1. An admin enters the organisation URL, project, repository and access token.
> 2. They test the connection.
> 3. A QA engineer pushes Web scripts.
> 4. IntelliQE commits to a new branch and opens a pull request; the link appears in IntelliQE.
>
> In scope
> • Connection with organisation URL, project and personal access token
> • Read-only connection test
> • Web script push and automatic pull request
>
> Out of scope
> • API script push (IQE-056.2)
> • Azure DevOps pipelines (IQE-081, MVP3)
>
> Dependencies
> • IQE-053.2 Secret check before push

**Acceptance Criteria**

1. An admin can connect with organisation URL, project and personal access token; the token is stored encrypted.
2. A connection test confirms access to the repository and target branch without creating anything. (BA recommendation)
3. Web scripts are committed to a new branch and a pull request is opened in Azure DevOps.
4. The pull request link is shown in IntelliQE and stored with the run.
5. No secrets, tokens or passwords appear in committed files (enforced by IQE-053.2).
6. The existing Azure DevOps connection is reused when its token has code access. (BA recommendation)
7. Azure DevOps Server (on-premises) support: to be confirmed by Omeesha.
8. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-056.2 Azure DevOps code push – API scripts

**Description**

> User story
> As a QA engineer,
> I want to push generated API test scripts to our Azure DevOps repository as a pull request,
> so that the scripts go through our normal code review without manual copying.
>
> Background
> This story adds API script push to Azure DevOps Repos, using the connection from IQE-056.1.
>
> User flow
> 1. The QA engineer has generated API scripts.
> 2. They choose "Push to Azure DevOps".
> 3. IntelliQE commits the scripts to a new branch and opens a pull request.
> 4. The pull request link appears in IntelliQE.
>
> In scope
> • Commit to a new branch and automatic pull request
> • Pull request link shown and stored with the run
>
> Out of scope
> • Web script push (separate ticket)
> • Triggering CI pipelines
>
> Dependencies
> • IQE-056.1
> • IQE-040 Generator (API scripts)
> • IQE-053.2 Secret check before push

**Acceptance Criteria**

1. Scripts are committed to a new branch with a clear commit message.
2. A pull request is opened automatically against the configured target branch.
3. The pull request link is shown in IntelliQE and stored with the run.
4. No secrets, tokens or passwords appear in committed files (enforced by IQE-053.2).
5. The feature is QA-tested and signed off in a client-like environment.

---

## IQE-043 API Studio (import, endpoints, scenarios, scripts, runs, reports, environments)

### IQE-043.1 API Studio – environments and variables

**Description**

> User story
> As a QA engineer,
> I want to keep base URLs, variables and secrets in environments (Dev, QA, UAT) and switch between them,
> so that the same tests run anywhere without editing them.
>
> Background
> Hard-coding hosts and secrets in tests makes them break when moved between environments and leaks secrets. The 120 Real Industry API Testing Patterns workbook lists environment management as a core framework pattern (keep the host outside tests).
>
> User flow
> 1. The QA engineer creates environments (for example Dev, QA, UAT) with a base URL and variables.
> 2. Requests use variables such as {{baseUrl}}/posts/{{id}}.
> 3. They switch environment and run the same tests.
>
> In scope
> • Environments with base URL, variables and secret values
> • Switching environment without editing tests
> • Masking of secret values
>
> Out of scope
> • Importing Postman / Bruno environments (IQE-048.2, IQE-049.2)
>
> Dependencies
> • Endpoint catalogue and run engine (API Studio)
> • 120 Real Industry API Testing Patterns workbook (pattern list and reference APIs)

**Acceptance Criteria**

1. The user can create, edit and delete environments with a base URL and variables.
2. Variables in a request (for example {{baseUrl}}, {{id}}) resolve from the selected environment.
3. Switching environment changes where tests run without editing any test.
4. Secret values are masked on screen, in logs and in reports.
5. The workbook patterns #117 run and pass against the reference APIs listed in its Verified Sources tab.
6. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-043.2 API Studio – workspace navigation and role-based access

**Description**

> User story
> As a QA lead,
> I want all API Studio areas in one workspace, with access based on role,
> so that my team works in one place and each person sees only what their role allows.
>
> Background
> API Studio holds seven areas: import, endpoints, scenarios, scripts, runs, reports and environments. The registry requires them to be reachable from one screen, to keep their data, and to follow user roles.
>
> User flow
> 1. The user opens API Studio.
> 2. They reach any of the seven areas from one screen.
> 3. What they can see and do depends on their role.
>
> In scope
> • Navigation to the seven areas from one screen
> • Data kept after refresh or re-login
> • Access by role: admin, QA engineer, analyst
>
> Out of scope
> • Extra Studio tools (Autopilot, Spec Audit/Diff, MCP server, traffic capture, CI pipeline) – moved to MVP3
>
> Dependencies
> • Existing user roles

**Acceptance Criteria**

1. All seven areas (import, endpoints, scenarios, scripts, runs, reports, environments) are reachable from one screen.
2. Data in every area is kept after a page refresh and after logging out and in again.
3. Access follows user roles (admin, QA engineer, analyst); a user cannot open or change what their role does not allow.
4. The MVP3 tools are not shown in MVP2. (BA recommendation – Omeesha moved them to MVP3; hide or keep visible to be confirmed)
5. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-043.3 API pattern – request building (parameters, headers and body types)

**Description**

> User story
> As a QA engineer,
> I want to build any kind of API request: path and query parameters, headers and every common body type,
> so that I can test real APIs whatever request format they expect.
>
> Background
> Omeesha asked for API Studio tickets split by API pattern, because some APIs are simple and some need request body validation. This ticket covers request building, as listed in the 120 Real Industry API Testing Patterns workbook: path and query parameters (including encoding and repeated keys), custom headers, JSON, form, multipart, Unicode, null values, nested arrays and larger payloads, plus HEAD and OPTIONS methods.
>
> User flow
> 1. The QA engineer opens an endpoint.
> 2. They set path and query parameters, headers and the body in the format the API needs.
> 3. They send the request and see exactly what was sent.
>
> In scope
> • Path and query parameters, URL encoding, repeated query keys
> • Custom headers
> • Body types: JSON, form URL-encoded, multipart (field + file)
> • Unicode, explicit null / 0 / false values, nested arrays, larger payloads
> • HEAD and OPTIONS as well as GET, POST, PUT, PATCH, DELETE
>
> Out of scope
> • Response checks (IQE-043.4, IQE-044)
>
> Dependencies
> • Endpoint catalogue and run engine (API Studio)
> • 120 Real Industry API Testing Patterns workbook (pattern list and reference APIs)

**Acceptance Criteria**

1. Path parameters, query parameters and repeated query keys are sent exactly as entered, correctly URL-encoded.
2. Custom headers are sent exactly as entered.
3. JSON, form URL-encoded and multipart (field + file) bodies are sent with the correct Content-Type.
4. Unicode text, null, 0 and false values are sent without being changed or dropped.
5. HEAD and OPTIONS requests are supported.
6. The user can see the exact request that was sent (method, URL, headers, body).
7. The workbook patterns #2, #3, #10, #32, #33, #34, #35, #36, #37, #67, #68, #69, #70, #71, #72, #85, #86, #98, #101, #105, #106, #107, #108, #110, #111 run and pass against the reference APIs listed in its Verified Sources tab.
8. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-043.4 API pattern – response validation (schema, types and content types)

**Description**

> User story
> As a QA engineer,
> I want to validate response bodies against required fields, types and content type, including non-JSON responses,
> so that I catch broken or changed responses, not just wrong status codes.
>
> Background
> Response body validation is one of the patterns Omeesha called out. Beyond the JSON / XML / HTML value checks in IQE-044, the 120 Real Industry API Testing Patterns workbook lists required-field and type validation, schema drift (extra fields), nested resources and non-JSON content: binary, images, streamed lines and compressed (gzip / deflate) responses.
>
> User flow
> 1. The QA engineer opens an endpoint.
> 2. They add checks on required fields, field types and content type.
> 3. They run the test and see which field or type failed.
>
> In scope
> • Required-field and type checks
> • Policy for extra (unexpected) fields: allow or fail
> • Content-Type check before parsing
> • Binary, image, streamed and compressed responses
>
> Out of scope
> • Contract validation against OpenAPI on every run and breaking-change detection (IQE-088, MVP3)
>
> Dependencies
> • Endpoint catalogue and run engine (API Studio)
> • 120 Real Industry API Testing Patterns workbook (pattern list and reference APIs)
> • IQE-044.1 (checks and failure view)

**Acceptance Criteria**

1. The user can check that required fields are present and have the expected type (for example id integer, title string, price number).
2. The user can choose whether an extra, unexpected response field is allowed or fails the test.
3. The Content-Type header is checked before the body is parsed; a mismatch fails with a clear message.
4. Binary, image, streamed and gzip / deflate responses are handled without errors and can be checked for type and size.
5. On failure, the result names the exact field and shows expected vs actual.
6. The workbook patterns #1, #4, #11, #13, #26, #27, #28, #53, #58, #59, #60, #61, #66, #73, #74, #75, #76, #77, #78, #81, #83, #84, #89, #90, #96, #120 run and pass against the reference APIs listed in its Verified Sources tab.
7. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-043.5 API pattern – pagination, search, filter and sort

**Description**

> User story
> As a QA engineer,
> I want to test list endpoints that page, search, filter and sort,
> so that I know lists return the right items, in the right order, on every page.
>
> Background
> Most real APIs return lists through limit/offset or page parameters, with search, filters and sorting. The 120 Real Industry API Testing Patterns workbook has 15+ patterns for these, including edge cases such as limit=0, negative or text limits, deep pages and case-insensitive search.
>
> User flow
> 1. The QA engineer opens a list endpoint.
> 2. They set paging, search, filter or sort parameters.
> 3. They add list checks (page size, all items match, order).
> 4. They run the test.
>
> In scope
> • Limit / offset and page / per-page paging
> • Search, field filters and combined filters
> • Sorting ascending and descending
> • Edge values: limit=0, negative or text limits, pages beyond the end
>
> Out of scope
> • Cursor-based paging (not in the workbook – to be confirmed)
>
> Dependencies
> • Endpoint catalogue and run engine (API Studio)
> • 120 Real Industry API Testing Patterns workbook (pattern list and reference APIs)

**Acceptance Criteria**

1. The user can check that a page returns no more items than the requested limit.
2. The user can check that every returned item matches the search or filter.
3. The user can check that items are sorted in the requested order.
4. The user can check that consecutive pages contain no duplicate items. (BA recommendation)
5. Edge values (limit=0, negative or text limit, page beyond the end) run and their actual status and body are shown, without assuming 200.
6. The workbook patterns #9, #12, #14, #15, #23, #24, #25, #29, #30, #79, #80, #99, #100, #102, #103 run and pass against the reference APIs listed in its Verified Sources tab.
7. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-043.6 API pattern – chaining, data-driven and parallel calls (integrated APIs)

**Description**

> User story
> As a QA engineer,
> I want to pass values from one response into the next request, run one test over many data rows, and run independent calls in parallel,
> so that I can test integrated, multi-step API flows the way real clients use them.
>
> Background
> Omeesha called out integrated APIs as a key pattern. The 120 Real Industry API Testing Patterns workbook covers chaining (GET -> extract ID -> GET child), data-driven runs (loop through IDs or search terms) and parallel independent calls.
>
> User flow
> 1. The QA engineer builds a scenario with several requests.
> 2. They extract a value (for example an ID) from one response and use it in the next request.
> 3. They attach a data set so the scenario runs once per row.
> 4. They run independent requests in parallel.
>
> In scope
> • Extracting values from a response and using them in later requests
> • Data-driven runs over a data set
> • Parallel independent calls
>
> Out of scope
> • Login -> token -> authorised call (auth chaining is IQE-061)
> • Load testing (IQE-085, MVP3)
>
> Dependencies
> • Endpoint catalogue and run engine (API Studio)
> • 120 Real Industry API Testing Patterns workbook (pattern list and reference APIs)

**Acceptance Criteria**

1. The user can extract a value from a response (by JSON path) and use it in a later request in the same scenario.
2. If an extracted value is missing or null, the next step fails with a clear message instead of sending a broken request.
3. A scenario can run once per row of a data set, and each row gets its own pass/fail result.
4. Independent requests can run in parallel, and each response is checked separately.
5. The workbook patterns #91, #92, #115, #116 run and pass against the reference APIs listed in its Verified Sources tab.
6. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-043.7 API pattern – error contract and status handling

**Description**

> User story
> As a QA engineer,
> I want to test that the API returns the right error status and error body,
> so that clients of the API get clear, consistent errors.
>
> Background
> The 120 Real Industry API Testing Patterns workbook lists the error contract as a framework pattern: 400, 401, 403, 404, 409, 422, 429, 5xx and non-standard codes (for example 418), plus invalid path identifiers. Tests must check the exact status and the error body, and handle unknown codes safely.
>
> User flow
> 1. The QA engineer sets the expected status (success or error) on a test.
> 2. They add checks on the error body.
> 3. They run the test.
>
> In scope
> • Expected non-2xx statuses
> • Error body checks
> • Non-standard status codes
> • Invalid path identifiers
>
> Out of scope
> • Generating negative cases (IQE-040.2)
>
> Dependencies
> • Endpoint catalogue and run engine (API Studio)
> • 120 Real Industry API Testing Patterns workbook (pattern list and reference APIs)

**Acceptance Criteria**

1. The user can set any expected status, including 4xx and 5xx; a test expecting 404 passes when 404 is returned.
2. The user can add checks on the error body (for example error code and message fields).
3. Non-standard status codes (for example 418) are shown exactly as returned, not mapped or hidden.
4. An invalid path identifier gives the API's actual status and body, with no unhandled error in IntelliQE.
5. The workbook patterns #41, #42, #43, #44, #45, #46, #47, #48, #49, #50, #95, #104 run and pass against the reference APIs listed in its Verified Sources tab.
6. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-043.8 API pattern – timeouts, retries, redirects and rate limits

**Description**

> User story
> As a QA engineer,
> I want to control timeouts, retries and redirects, and to test rate limits,
> so that tests behave predictably with slow, unstable or rate-limited APIs.
>
> Background
> The 120 Real Industry API Testing Patterns workbook lists timeout, retry/backoff and redirect policies as framework patterns: retry only transient failures (for example 503) and never validation errors (400), retry only safe / idempotent methods, follow or do not follow redirects, and read rate-limit headers.
>
> User flow
> 1. The QA engineer sets a timeout, retry policy and redirect policy (per test or per environment).
> 2. They run the test.
> 3. The result shows elapsed time, attempts made and the final status.
>
> In scope
> • Timeout per request or test
> • Retry policy: which statuses, how many attempts, idempotent methods only
> • Redirect follow / no-follow
> • Rate-limit headers and 429 handling
>
> Out of scope
> • Load and performance testing (IQE-085, MVP3)
>
> Dependencies
> • Endpoint catalogue and run engine (API Studio)
> • 120 Real Industry API Testing Patterns workbook (pattern list and reference APIs)

**Acceptance Criteria**

1. The user can set a timeout; a slower response fails the test with a clear timeout message and the elapsed time.
2. The user can set which statuses are retried and the maximum attempts; the result shows the number of attempts.
3. A 400 (or any status not in the retry list) is never retried.
4. Automatic retries apply only to safe / idempotent methods (GET, PUT, DELETE, HEAD, OPTIONS) unless the user changes it. (BA recommendation)
5. The user can choose to follow redirects or not; with no-follow, the redirect status and Location header can be checked.
6. Rate-limit headers and 429 responses can be checked.
7. The workbook patterns #31, #51, #52, #57, #82, #87, #88, #93, #94, #113, #114 run and pass against the reference APIs listed in its Verified Sources tab.
8. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-043.9 API pattern – cookies and caching

**Description**

> User story
> As a QA engineer,
> I want to test cookie-based sessions and HTTP caching,
> so that APIs that rely on cookies or caching headers behave correctly.
>
> Background
> The 120 Real Industry API Testing Patterns workbook covers the cookie lifecycle (set, read, delete) and caching (ETag / If-None-Match returning 304, Cache-Control headers).
>
> User flow
> 1. The QA engineer runs a request that sets a cookie.
> 2. Later requests in the scenario send it back.
> 3. They test conditional requests and cache headers.
>
> In scope
> • Cookies kept across requests in a scenario
> • Setting, reading and deleting cookies
> • ETag / If-None-Match and Cache-Control checks
>
> Out of scope
> • Browser session reuse from Web tests
>
> Dependencies
> • Endpoint catalogue and run engine (API Studio)
> • 120 Real Industry API Testing Patterns workbook (pattern list and reference APIs)

**Acceptance Criteria**

1. Cookies set by a response are sent on later requests in the same scenario.
2. The user can check, add and delete cookies.
3. A conditional request with If-None-Match can be checked for a 304 response.
4. Cache-Control and ETag headers can be checked.
5. The workbook patterns #54, #55, #56, #62, #63 run and pass against the reference APIs listed in its Verified Sources tab.
6. The feature is QA-tested and signed off in a client-like environment.

---

### IQE-043.10 API pattern – observability and secure logging

**Description**

> User story
> As a QA engineer,
> I want every request to carry a correlation ID and record its timing, with secrets masked in logs,
> so that I can trace failures and share logs safely.
>
> Background
> The 120 Real Industry API Testing Patterns workbook lists observability as a framework pattern: a unique correlation ID per test, elapsed time attached to the report, response metadata captured, and secret headers (for example Authorization) masked in logs.
>
> User flow
> 1. The QA engineer runs a test.
> 2. Each request gets a correlation ID and its timing is recorded.
> 3. The report shows the request ID, elapsed time and headers, with secrets masked.
>
> In scope
> • Correlation ID per request
> • Elapsed time and response metadata in the report
> • Masking of secret headers and values in logs and reports
>
> Out of scope
> • External monitoring or APM tools
>
> Dependencies
> • Endpoint catalogue and run engine (API Studio)
> • 120 Real Industry API Testing Patterns workbook (pattern list and reference APIs)

**Acceptance Criteria**

1. Each request can carry a unique correlation ID (for example X-Correlation-ID), shown in the result.
2. Elapsed time is recorded for every request and shown in the report.
3. Response metadata (for example Date, Server, Content-Length when present) is stored with the result.
4. Authorization and other secret headers or values are masked in logs and reports.
5. The workbook patterns #97, #109, #118, #119 run and pass against the reference APIs listed in its Verified Sources tab.
6. The feature is QA-tested and signed off in a client-like environment.

---

## Pattern Coverage

The 120 reference API patterns and the ticket that covers each (as mapped in the workbook).

| Pattern ID | Category | API Pattern | Method | Covered by ticket |
| --- | --- | --- | --- | --- |
| 1 | CRUD | List collection | GET | IQE-043.4 |
| 2 | CRUD | Get resource by ID | GET | IQE-043.3 |
| 3 | Filtering | Filter by query parameter | GET | IQE-043.3 |
| 4 | Nested Resource | Nested child resource | GET | IQE-043.4 |
| 5 | CRUD | Create resource | POST | IQE-040.1 / IQE-044.1 (already written) |
| 6 | CRUD | Full replacement | PUT | IQE-040.1 / IQE-044.1 (already written) |
| 7 | CRUD | Partial update | PATCH | IQE-040.1 / IQE-044.1 (already written) |
| 8 | CRUD | Delete resource | DELETE | IQE-040.1 / IQE-044.1 (already written) |
| 9 | Pagination/Limit | Top-N with query | GET | IQE-043.5 |
| 10 | Filtering | Filter and sort-like query composition | GET | IQE-043.3 |
| 11 | CRUD | List products | GET | IQE-043.4 |
| 12 | Pagination | Page using limit and skip | GET | IQE-043.5 |
| 13 | Field Selection | Select response fields | GET | IQE-043.4 |
| 14 | Search | Search resources | GET | IQE-043.5 |
| 15 | Sort/Projection | Sort products by field | GET | IQE-043.5 |
| 16 | CRUD | Create product | POST | IQE-040.1 / IQE-044.1 (already written) |
| 17 | CRUD | Update product - PUT | PUT | IQE-040.1 / IQE-044.1 (already written) |
| 18 | CRUD | Update product - PATCH | PATCH | IQE-040.1 / IQE-044.1 (already written) |
| 19 | CRUD | Delete product | DELETE | IQE-040.1 / IQE-044.1 (already written) |
| 20 | Authentication | Login and capture access token | POST | IQE-040.3 / IQE-061 (auth) |
| 21 | Authentication | Get current user with bearer token | GET | IQE-040.3 / IQE-061 (auth) |
| 22 | Authentication | Refresh access token | POST | IQE-040.3 / IQE-061 (auth) |
| 23 | Pagination | Get users with page | GET | IQE-043.5 |
| 24 | Search | Search users | GET | IQE-043.5 |
| 25 | Filtering | Filter users by key path | GET | IQE-043.5 |
| 26 | Nested Resource | User posts | GET | IQE-043.4 |
| 27 | Nested Resource | User carts | GET | IQE-043.4 |
| 28 | Nested Resource | Product reviews | GET | IQE-043.4 |
| 29 | Search | Global post search | GET | IQE-043.5 |
| 30 | Pagination | Limit comments | GET | IQE-043.5 |
| 31 | Functional | Delay response | GET | IQE-043.8 |
| 32 | HTTP Method | Echo GET request | GET | IQE-043.3 |
| 33 | HTTP Method | Echo POST JSON | POST | IQE-043.3 |
| 34 | HTTP Method | Echo PUT JSON | PUT | IQE-043.3 |
| 35 | HTTP Method | Echo PATCH JSON | PATCH | IQE-043.3 |
| 36 | HTTP Method | Echo DELETE | DELETE | IQE-043.3 |
| 37 | Request Inspection | Custom header echo | GET | IQE-043.3 |
| 38 | Request Inspection | Bearer header echo | GET | IQE-040.3 / IQE-061 (auth) |
| 39 | Authentication | Basic authentication success | GET | IQE-040.3 / IQE-061 (auth) |
| 40 | Authentication | Basic authentication failure | GET | IQE-040.3 / IQE-061 (auth) |
| 41 | Status Handling | Explicit 201 response | GET | IQE-043.7 |
| 42 | Status Handling | Client error 400 | GET | IQE-043.7 |
| 43 | Status Handling | Unauthorized 401 | GET | IQE-043.7 |
| 44 | Status Handling | Forbidden 403 | GET | IQE-043.7 |
| 45 | Status Handling | Not found 404 | GET | IQE-043.7 |
| 46 | Status Handling | Conflict 409 | GET | IQE-043.7 |
| 47 | Status Handling | Unprocessable 422 | GET | IQE-043.7 |
| 48 | Status Handling | Too many requests 429 | GET | IQE-043.7 |
| 49 | Status Handling | Server error 500 | GET | IQE-043.7 |
| 50 | Status Handling | Service unavailable 503 | GET | IQE-043.7 |
| 51 | Redirect | Single 302 redirect | GET | IQE-043.8 |
| 52 | Redirect | No-follow redirect validation | GET | IQE-043.8 |
| 53 | Headers | Generate response headers | GET | IQE-043.4 |
| 54 | Cookies | Set cookie | GET | IQE-043.9 |
| 55 | Cookies | Read cookies | GET | IQE-043.9 |
| 56 | Cookies | Delete cookie | GET | IQE-043.9 |
| 57 | Delay/Timeout | Delayed response | GET | IQE-043.8 |
| 58 | Streaming | Stream N JSON lines | GET | IQE-043.4 |
| 59 | Payload | Generate binary bytes | GET | IQE-043.4 |
| 60 | Compression | Gzip response | GET | IQE-043.4 |
| 61 | Compression | Deflate response | GET | IQE-043.4 |
| 62 | Caching | Conditional cache with ETag | GET | IQE-043.9 |
| 63 | Caching | Cache-Control endpoint | GET | IQE-043.9 |
| 64 | Content Negotiation | Request XML response | GET | IQE-044.2 (already written) |
| 65 | Content | HTML response | GET | IQE-044.3 (already written) |
| 66 | Content | Image response | GET | IQE-043.4 |
| 67 | Path Parameter | Dynamic anything path | GET | IQE-043.3 |
| 68 | Query Encoding | Special-character query values | GET | IQE-043.3 |
| 69 | Request Body | Form URL encoded POST | POST | IQE-043.3 |
| 70 | Request Body | Multipart-style form POST | POST | IQE-043.3 |
| 71 | HTTP Method | HEAD request | HEAD | IQE-043.3 |
| 72 | HTTP Method | OPTIONS request | OPTIONS | IQE-043.3 |
| 73 | Real-world Data | Weather by coordinates | GET | IQE-043.4 |
| 74 | Real-world Data | Hourly forecast selection | GET | IQE-043.4 |
| 75 | Real-world Data | Forecast horizon control | GET | IQE-043.4 |
| 76 | Geospatial | Geocoding search | GET | IQE-043.4 |
| 77 | Geospatial | Geocoding with country filter | GET | IQE-043.4 |
| 78 | Public API | Authenticated-free public repository | GET | IQE-043.4 |
| 79 | Search | Search repositories | GET | IQE-043.5 |
| 80 | Pagination | List repository issues | GET | IQE-043.5 |
| 81 | Headers | Inspect GitHub API version header | GET | IQE-043.4 |
| 82 | Rate Limiting | Read rate-limit headers | GET | IQE-043.8 |
| 83 | Filtering | List public gists | GET | IQE-043.4 |
| 84 | Nested Resource | Repository contents | GET | IQE-043.4 |
| 85 | Security | Missing Content-Type negative | POST | IQE-043.3 |
| 86 | Security | Unexpected extra header | GET | IQE-043.3 |
| 87 | Idempotency | Repeat PUT request | PUT | IQE-043.8 |
| 88 | Idempotency | Repeat DELETE request | DELETE | IQE-043.8 |
| 89 | Contract | Required response key check | GET | IQE-043.4 |
| 90 | Contract | Type validation | GET | IQE-043.4 |
| 91 | Data Driven | Loop through IDs | GET | IQE-043.6 |
| 92 | Data Driven | Loop through search terms | GET | IQE-043.6 |
| 93 | Timeout | Very short delay | GET | IQE-043.8 |
| 94 | Timeout | Maximum delay boundary | GET | IQE-043.8 |
| 95 | Error Contract | Custom 418 response | GET | IQE-043.7 |
| 96 | Header Assertion | Check Content-Type | GET | IQE-043.4 |
| 97 | Response Metadata | Server timing / response headers capture | GET | IQE-043.10 |
| 98 | URL Construction | Encoded slash-like identifier | GET | IQE-043.3 |
| 99 | Pagination | Deep offset pagination | GET | IQE-043.5 |
| 100 | Pagination | Clear limit / fetch all | GET | IQE-043.5 |
| 101 | Projection | Multiple select query params | GET | IQE-043.3 |
| 102 | Search | Case-insensitive search | GET | IQE-043.5 |
| 103 | Input Validation | Invalid pagination type | GET | IQE-043.5 |
| 104 | Input Validation | Invalid path identifier | GET | IQE-043.7 |
| 105 | Payload Size | Large JSON echo | POST | IQE-043.3 |
| 106 | Unicode | Unicode JSON payload | POST | IQE-043.3 |
| 107 | Null Handling | Explicit null values | POST | IQE-043.3 |
| 108 | Array Payload | Nested array JSON | POST | IQE-043.3 |
| 109 | Correlation | Correlation ID round trip | GET | IQE-043.10 |
| 110 | Content Type | Accept JSON response | GET | IQE-043.3 |
| 111 | Content Type | Form data request | POST | IQE-043.3 |
| 112 | Auth | Authorization scheme negative | GET | IQE-040.3 / IQE-061 (auth) |
| 113 | Retry | Retry on 503 | GET | IQE-043.8 |
| 114 | Retry | No retry on 400 | GET | IQE-043.8 |
| 115 | Parallel | Parallel independent GET calls | GET | IQE-043.6 |
| 116 | Chaining | GET -> extract ID -> GET child | GET | IQE-043.6 |
| 117 | Environment | Base URL + path variables | GET | IQE-043.1 |
| 118 | Security | Do not log secret-like headers | GET | IQE-043.10 |
| 119 | Observability | Capture latency | GET | IQE-043.10 |
| 120 | Schema Drift | Unexpected additional response field | GET | IQE-043.4 |
