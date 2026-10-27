# IntelliQE — Import Method Sample Collections

Ready-to-import samples, **one per method**, each in the exact format that method expects and pointing at a **live public API** so you can import *and* run them in real time. Open the API Studio → **Import by method**, pick the method, and use the matching file (or paste-in value).

> Live hosts used: `httpbin.org`, `jsonplaceholder.typicode.com`, `petstore3.swagger.io`, `graphqlzero.almansi.me`, `mcp.deepwiki.com`. All reachable without an account. `jsonplaceholder` and `httpbin` safely accept writes (POST/PUT) for testing.

## Files & how to use

| # | Method | File / value | Import as | Verified |
|---|--------|--------------|-----------|:--------:|
| 1 | **OpenAPI / Swagger** | `01-openapi-httpbin.json` (or paste the Petstore URL — see PASTE-IN) | Files **or** URL | 7 endpoints ✅ |
| 2 | **Postman Collection** | `02-postman-collection.json` | Files or Text | 4 endpoints ✅ |
| 3 | **Bruno Collection** | `03-bruno-collection/` (upload the `.bru` files) **or** `03-bruno-collection-COMBINED.bru` (paste) | Files or Text | 3 endpoints ✅ |
| 4 | **API URL / Endpoint** | `PASTE-IN-VALUES.txt` → a live URL | Probe | live probe |
| 5 | **cURL** | `05-curl.txt` | Text | 5 endpoints ✅ |
| 6 | **API Documentation URL** | `PASTE-IN-VALUES.txt` → a docs URL | URL (AI-read) | needs LLM key |
| 7 | **Custom Connector** | `07-connector-manifest.json` | Connector / Files | 5 endpoints ✅ |
| 8 | **GraphQL** | paste endpoint `https://graphqlzero.almansi.me/api` (introspect) **or** `08-graphql-schema.graphql` (SDL, AI-read) | GraphQL / Text | 32 ops introspected ✅ |
| 9 | **MCP Server** | `PASTE-IN-VALUES.txt` → `https://mcp.deepwiki.com/mcp` | MCP | 5 tools ✅ |
| 10 | **Manual HTTP Request** | `PASTE-IN-VALUES.txt` → type the fields | Manual | live probe |
| 11 | **SDK** | `11-sdk-sample.ts` | Files or Text (AI-read) | needs LLM key |
| 12 | **Middleware** | `12-middleware-routes.ts` | Files or Text (AI-read) | needs LLM key |
| 13 | **Webhook** | `PASTE-IN-VALUES.txt` → endpoint + events + secret | Webhook | needs secret |

Endpoint counts above were produced by running each file through IntelliQE's own import parser.

## Notes
- **Deterministic (no AI needed):** OpenAPI, Postman, Bruno, cURL, Connector, Endpoint probe, GraphQL *introspection*, MCP, Manual. These import and run live as-is.
- **AI-read (needs a tenant Anthropic key under System Configuration → LLM Configuration):** API Documentation URL, SDK, Middleware, and GraphQL *SDL paste*. Without a key they fail safe with guidance.
- **OpenAPI/Petstore caveat:** the public Petstore spec declares a *relative* server, so import uses a placeholder host and warns you; set the base URL to `https://petstore3.swagger.io/api/v3` in an Environment to run it. The included `01-openapi-httpbin.json` has an absolute server, so it runs live with no extra step.
- **GraphQL caveat:** some hosts (e.g. `countries.trevorblades.com`) block introspection with HTTP 413 — use the SDL file for those; `graphqlzero.almansi.me` introspects fine.

See `PASTE-IN-VALUES.txt` for every URL/field value, and `../IntelliQE_Import_Methods_LiveTest_Report.md` for the full real-time test results these samples came from.
