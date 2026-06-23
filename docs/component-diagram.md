# JBSIntelliQE Logical Component Architecture

Organizes the system by logical layer — Frontend, Backend, and Data — showing major component groups and their relationships.

```mermaid
graph TB
    subgraph "Frontend (React + Vite + TailwindCSS)"
        Pages["Pages<br/>Chat | Dashboard | Reports<br/>Automation"]
        Components["Components<br/>Layout | Config Panels | Shared"]
        FEServices["Services<br/>API Client (Axios)<br/>Auth Context | TTS"]
    end

    subgraph "Backend (Express + TypeScript)"
        Middleware["Middleware<br/>Auth (Bearer Token)<br/>Worker Auth"]
        Routes["API Routes (23 groups)<br/>Pipeline | Chat | Generate<br/>Reports | Users"]
        Orchestrator["Orchestrator<br/>Pipeline Definitions<br/>Dependency Engine<br/>Convergence Guards"]
        Agents["AI Agents<br/>Requirement | Planner<br/>Generator | Script<br/>Execution | Healing | Audit"]
        Services["Services<br/>SSE Manager | Playwright<br/>Allure | Notifications"]
        WorkerProc["Worker<br/>Task Poller | SDK Executor"]
    end

    subgraph "Data Layer"
        PGStore[("PostgreSQL<br/>Users | Tenants | Pipelines<br/>Test Cases | Audit Logs")]
        BlobStore["Azure Blob<br/>Scripts | Reports | Artifacts"]
    end

    Pages --> Components
    Pages --> FEServices
    FEServices -->|"HTTP/SSE"| Routes
    Routes --> Middleware
    Routes --> Orchestrator
    Routes --> Services
    Orchestrator --> Agents
    WorkerProc --> Agents
    Services --> PGStore
    Services --> BlobStore
```

## Key Points

- **7 AI agents** form the core intelligence layer: each specializes in one pipeline stage (requirements analysis, test planning, code generation, script writing, execution, healing, and audit).
- **Orchestrator** manages pipeline flow with convergence guards (budget limits, max iterations, same-findings detection) to prevent runaway execution.
- **Multi-tenant isolation** is enforced at every layer — middleware attaches tenant context, services filter by tenant ID, and the frontend renders role-based navigation.
