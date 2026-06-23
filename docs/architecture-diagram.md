# JBSIntelliQE End-to-End System Architecture

Shows the complete flow from user input through the AI pipeline, real-time event system, and external integrations.

```mermaid
graph LR
    subgraph "User Interface"
        User["QA Engineer / Analyst"]
        Chat["Chat UI + Dashboard"]
    end

    subgraph "Real-Time Events"
        SSE["SSE Manager<br/>(Server-Sent Events)"]
    end

    subgraph "API Gateway"
        Auth["Auth + RBAC<br/>(Multi-Tenant)"]
        API["REST API"]
    end

    subgraph "AI Pipeline Orchestrator"
        direction TB
        S1["1. Requirements Intake"]
        S2["2. Test Planning"]
        S3["3. Spec Generation"]
        S4["4. Test Healing"]
        S5["5. Quality Audit"]
        S1 --> S2 --> S3 --> S4 --> S5
    end

    subgraph "Worker Fleet"
        Worker["Worker Process"]
        Claude["Claude AI (Anthropic)"]
    end

    subgraph "Integrations"
        Playwright["Playwright (Test Runner)"]
        Allure["Allure (Reports)"]
        Jira["Jira (Issue Sync)"]
        Teams["Teams/Email (Notifications)"]
    end

    subgraph "Persistence"
        DB[("PostgreSQL")]
        Artifacts["Azure Blob (Artifacts)"]
    end

    User --> Chat
    Chat -->|"Submit Requirements"| API
    API --> Auth
    API -->|"Create Run"| S1
    S1 -.->|"Enqueue Task"| Worker
    Worker -->|"Execute Agent"| Claude
    Worker -->|"Report Result"| API
    API -->|"Advance Stage"| S2
    SSE -->|"Progress Updates"| Chat
    API --> SSE
    S4 -.-> Playwright
    S5 -.-> Allure
    API --> Jira
    API --> Teams
    API --> DB
    API --> Artifacts
```

## Key Points

- **Event-driven pipeline**: Each stage is asynchronous — the orchestrator enqueues tasks, workers execute them via Claude AI, and results flow back to advance the pipeline. Dotted lines represent async/event-driven flows.
- **Self-healing loop**: If tests fail during execution (Stage 4), the healing agent automatically analyzes failures and regenerates fixes before the quality audit.
- **Convergence guards** prevent infinite loops: budget caps ($2/run, $0.50/stage), max iteration limits, and same-findings detection automatically terminate runs that aren't converging.
