# Test Data — Real-time Collections (one file per import method)

Ready-to-test sample inputs for **every import method** in API Automation (see the
"Import by method" screen). Each file targets a **live public API**, so requests
respond for real the moment you import — no mocks, no stubs.

Files are numbered to match the import grid. File-backed methods ship a file you
upload/paste; URL/field methods ship a `.txt` with the exact values to paste in.

| # | Method | File | Live target | How to use |
|---|--------|------|-------------|------------|
| 01 | **OpenAPI / Swagger** | `01-openapi-swagger.json` | httpbin.org | Upload the JSON spec |
| 02 | **Postman Collection** | `02-postman-collection.json` | jsonplaceholder.typicode.com | Upload the v2.1 collection |
| 03 | **Bruno Collection** | `03-bruno-collection.bru` | httpbin.org | Paste into the Text tab |
| 04 | **API URL / Endpoint** | `04-api-url-endpoint.txt` | jsonplaceholder / httpbin / github | Paste one live URL |
| 05 | **cURL** | `05-curl.txt` | jsonplaceholder / httpbin | Paste a command |
| 06 | **API Documentation URL** | `06-api-documentation-url.txt` | petstore3 / docs.github.com | Paste a docs URL (AI-read) |
| 07 | **Custom Connector** | `07-custom-connector.json` | httpbin.org | Upload the JSON manifest |
| 08 | **SDK** | `08-sdk-source.ts` | httpbin.org | Paste the client source (AI-read) |
| 09 | **Webhook** | `09-webhook.txt` | httpbin.org | Fill endpoint + secret + events |
| 10 | **GraphQL** | `10-graphql-schema.graphql` | graphqlzero / countries | Paste endpoint URL, or the SDL |
| 11 | **MCP Server** | `11-mcp-server.txt` | mcp.deepwiki.com | Paste the MCP server URL |
| 12 | **Middleware** | `12-middleware-routes.ts` | (set base URL) | Paste the route source (AI-read) |
| 13 | **Manual HTTP Request** | `13-manual-http-request.txt` | httpbin.org | Type method + URL + headers by hand |
| — | **Integration flow** (bonus) | `integration-flow-live.json` | jsonplaceholder.typicode.com | Chained 4-step flow for Integration Tests |

## Notes per method

- **01 OpenAPI** — self-contained spec for live httpbin; every path (`/ip`, `/uuid`,
  `/get`, `/post`, `/bearer`, `/status/{code}`) answers live. For a URL test instead,
  paste `https://petstore3.swagger.io/api/v3/openapi.json` (set base URL to
  `https://petstore3.swagger.io/api/v3` after import).
- **02 Postman** — `{{baseUrl}}` variable, raw-JSON POST, saved 200/201 responses as
  the expected contract. Probes: `GET /posts/1`→200, `POST /posts`→201, `GET /comments`→200.
- **03 Bruno** — env vars + collection bearer auth inherited by each request. Probes:
  `/get`→200, `/post`→200, `/bearer`→200.
- **04 / 13** — plain live probes; no spec needed.
- **05 cURL** — GET, POST (JSON), Bearer GET, query GET, PUT — method/headers/auth/body
  all parsed.
- **06 / 08 / 12** — AI-read methods; need a tenant Anthropic key configured to extract
  endpoints. Without a key they fail safe with guidance.
- **07 Connector** — portable manifest; base URL joined, global `Accept` applied,
  expected statuses carried.
- **09 Webhook** — registers your consumer endpoint and sends HMAC-signed sample events.
- **10 GraphQL** — prefer live introspection via the endpoint URL; SDL file is the
  fallback for hosts that 413-block introspection.
- **11 MCP** — live Streamable-HTTP handshake + `tools/list`; DeepWiki exposes ~5 tools.

> All deterministic paths were verified end-to-end against live services —
> see `../IntelliQE_Import_Methods_LiveTest_Report.md`.
