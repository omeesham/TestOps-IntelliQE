# API Automation — all 88 tools: Licensed vs Free to use

A scan of every tool in the API Automation gallery, classified by whether it needs a
**paid/commercial dependency** to operate or runs entirely on **free, open-source and
in-house** components.

## How to read this

- **Licensed** = the tool needs a **paid, commercial dependency** to do its job — the
  **Anthropic Claude API** (usage-metered), or an **external LLM provider account**
  (OpenAI / Azure OpenAI / Gemini). You pay a third party for it to run.
- **Free to use** = the tool runs on the platform's own in-house logic plus **permissive
  open-source** engines (MIT / Apache-2.0 / ISC / BSD). No separate paid license is needed.

> Note: the JBSIntelliQE **platform itself** is a commercial product, so every tool ships
> under that license. This table is strictly about each tool's **third-party runtime
> dependency** — whether it additionally needs a paid AI/LLM service, or not.

## Summary

| Classification | Count | What it means |
|---|---|---|
| **Licensed** (paid AI/LLM dependency) | **20** | Needs the Claude API or an external LLM provider to run |
| **Free to use** (open-source + in-house) | **68** | No paid dependency — permissive OSS + our own code |
| **Total** | **88** | |

---

## 1. Generate & author

| # | Tool | Classification | Basis |
|---|---|---|---|
| 1 | AI coworker (Atto) | Licensed | Anthropic Claude API |
| 2 | Autopilot (autonomous loop) | Licensed | Anthropic Claude API |
| 3 | Story-driven generation | Licensed | Anthropic Claude API |
| 4 | Multimodal inputs | Licensed | Anthropic Claude API (vision) |
| 5 | Author in plain English | Licensed | Anthropic Claude API |
| 6 | Chat-to-test | Licensed | Anthropic Claude API |
| 7 | Coverage-guided generation | Licensed | Anthropic Claude API |
| 8 | Stateful / white-box generation | Licensed | Anthropic Claude API |
| 9 | Model-based generation | Licensed | Anthropic Claude API |
| 10 | Synthetic data factory | Licensed | Anthropic Claude API |
| 11 | Flow builder | Free to use | In-house logic |
| 12 | Step groups library | Free to use | In-house logic |
| 13 | Unified cross-layer test | Free to use | In-house + Playwright (Apache-2.0), DB drivers (MIT) |
| 14 | Autonomous maintenance | Licensed | Anthropic Claude API |

## 2. Security & authorization

| # | Tool | Classification | Basis |
|---|---|---|---|
| 15 | Security scan | Licensed | Anthropic Claude API (+ in-house) |
| 16 | OWASP API Top-10 | Free to use | In-house ruleset |
| 17 | Fuzz / property test | Free to use | In-house |
| 18 | Sequence fuzzing | Free to use | In-house |
| 19 | Authorization (BOLA/BFLA) | Free to use | In-house |
| 20 | Deep authorization & data exposure | Licensed | Anthropic Claude API |
| 21 | Assertion strength (mutation) | Free to use | In-house |
| 22 | Semantic assertion | Licensed | Anthropic Claude API (LLM judge) |
| 23 | Data classification (PII/shadow) | Licensed | Anthropic Claude API |
| 24 | OpenAPI security audit | Free to use | ajv (MIT), yaml (ISC) |
| 25 | OAuth & secrets | Free to use | Cloud SDKs (Apache-2.0/MIT); your own cloud account |
| 26 | Access control (RBAC/SSO/SCIM) | Free to use | jsonwebtoken (MIT) |

## 3. Performance & resilience

| # | Tool | Classification | Basis |
|---|---|---|---|
| 27 | Load test | Free to use | In-house engine, undici/axios (MIT) |
| 28 | Load profile & SLA | Free to use | In-house |
| 29 | Geo / distributed load | Free to use | In-house |
| 30 | Distributed cloud load | Free to use | In-house |
| 31 | Distributed load ramp | Free to use | In-house |
| 32 | Chaos / resilience | Free to use | In-house |

## 4. Contracts & virtualization

| # | Tool | Classification | Basis |
|---|---|---|---|
| 33 | Contract validation | Free to use | ajv (MIT), yaml (ISC) |
| 34 | Contract drift | Free to use | In-house, ajv (MIT) |
| 35 | Regression baselines | Free to use | In-house |
| 36 | Breaking-change gate (spec diff) | Free to use | In-house, ajv (MIT) |
| 37 | Record & replay | Free to use | In-house |
| 38 | Pact broker | Free to use | In-house (Pact open spec) |
| 39 | AsyncAPI contracts | Free to use | In-house, ajv (MIT) |
| 40 | Service virtualization | Free to use | In-house, express (MIT) |
| 41 | Hosted mock server | Free to use | express (MIT) |
| 42 | Contract proxy | Free to use | express / undici (MIT) |

## 5. Coverage & intelligence

| # | Tool | Classification | Basis |
|---|---|---|---|
| 43 | Test coverage | Free to use | In-house |
| 44 | Traffic coverage gaps | Free to use | In-house |
| 45 | Test intelligence (flaky/quarantine) | Free to use | In-house |
| 46 | Change impact | Free to use | In-house |
| 47 | Suite optimizer | Free to use | In-house |
| 48 | Semantic self-healing | Licensed | Anthropic Claude API |
| 49 | Data-correctness verify | Free to use | DB drivers (MIT) |

## 6. Protocols, data & AI

| # | Tool | Classification | Basis |
|---|---|---|---|
| 50 | Async & streaming (WS/SSE) | Free to use | In-house (native WebSocket/SSE) |
| 51 | Events & gRPC | Free to use | kafkajs (MIT), grpc-js (Apache-2.0) |
| 52 | Callback verification | Free to use | express (MIT) |
| 53 | Data-driven testing | Free to use | xlsx / SheetJS (Apache-2.0) |
| 54 | Test data profiles | Free to use | In-house |
| 55 | Database validation | Free to use | mssql / mysql2 / pg (MIT) |
| 56 | Traffic capture | Free to use | In-house |
| 57 | Browser recorder | Free to use | In-house |
| 58 | Trace correlation | Free to use | axios (MIT); Jaeger/Zipkin REST |
| 59 | LLM providers | Licensed | External LLM provider account (OpenAI/Azure/Gemini) |
| 60 | MCP server | Free to use | In-house (MCP open spec) |
| 61 | AI / LLM & MCP testing | Licensed | Anthropic Claude API |
| 62 | LLM eval harness | Licensed | Anthropic Claude API |

## 7. Governance & compliance

| # | Tool | Classification | Basis |
|---|---|---|---|
| 63 | API governance | Free to use | In-house rules |
| 64 | Governance lint | Free to use | In-house |
| 65 | Compliance packs (PCI/HIPAA/GDPR) | Free to use | In-house |
| 66 | AI-era compliance (EU AI Act/DORA) | Free to use | In-house |
| 67 | AI cost / FinOps | Free to use | In-house |
| 68 | On-prem / air-gapped | Free to use | In-house |
| 69 | Full-code & Monitoring-as-Code | Free to use | In-house generators (generated k6 project is AGPL-3.0, in your repo) |

## 8. Execution, CI & lifecycle

| # | Tool | Classification | Basis |
|---|---|---|---|
| 70 | Schedules & webhooks | Free to use | In-house, nodemailer (MIT) |
| 71 | CI / GitHub Action | Free to use | @octokit/rest (MIT) |
| 72 | Release gate | Free to use | In-house |
| 73 | Parallel run queue | Free to use | In-house |
| 74 | Cloud browser lab | Free to use | Playwright (Apache-2.0), axe-core (MPL-2.0), pixelmatch (ISC) |
| 75 | API + UI hybrid test | Free to use | Playwright (Apache-2.0) |
| 76 | Monitoring | Free to use | In-house |
| 77 | Public status page | Free to use | In-house |
| 78 | Failure → fix workflow | Licensed | Anthropic Claude API |
| 79 | Bug report | Free to use | In-house + tracker clients (MIT) |
| 80 | Remediation PR | Free to use | @octokit/rest, @gitbeaker/rest (MIT) |
| 81 | Git-synced tests | Free to use | @octokit/rest, @gitbeaker/rest (MIT) |
| 82 | Evidence export | Free to use | pdf-lib / archiver / jszip (MIT) |
| 83 | Audit log | Free to use | In-house, mssql (MIT) |
| 84 | Traceability matrix | Free to use | In-house |
| 85 | Test management | Free to use | In-house |
| 86 | TM connectors (TestRail/Xray/Zephyr/qTest) | Free to use | In-house REST clients, axios (MIT) |
| 87 | Approvals | Free to use | In-house |
| 88 | Collaboration | Free to use | In-house |

---

## Notes

- The 20 **Licensed** tools are the AI-powered ones — they call the **Anthropic Claude API**
  (metered/commercial), except **LLM providers** (#59), which needs your own **OpenAI/Azure/Gemini**
  account. Turn those off and the tool cannot do its AI work.
- The **Free to use** engines are all permissive (MIT / Apache-2.0 / ISC / BSD) with only two
  weak-copyleft items in the stack — **axe-core (MPL-2.0)** behind the cloud browser lab and
  **JSZip (dual MIT/GPL → elect MIT)** behind evidence export. Neither restricts commercial use.
- **No GPL/AGPL is bundled.** The one AGPL mention — **k6** — only applies to the *code the
  Full-code export generates for your repo*, not to the platform itself.
- Cross-reference: a fuller per-tool engine + license breakdown is in
  `api-automation-tool-licenses.md`.
