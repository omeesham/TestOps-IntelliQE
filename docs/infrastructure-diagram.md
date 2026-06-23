# JBSIntelliQE Infrastructure & Deployment Topology

High-level view of deployment components, their hosting, and communication protocols between them.

```mermaid
graph TB
    subgraph "Client Layer"
        Browser["React SPA<br/>(Vite, port 5173)"]
    end

    subgraph "Application Layer"
        API["Express API Server<br/>(Node.js, port 3001)"]
        Worker["Worker Process(es)<br/>(Node.js, polling)"]
    end

    subgraph "Data Layer"
        PG[("PostgreSQL<br/>(port 5432)")]
        AzSQL[("Azure SQL Server")]
        Blob["Azure Blob Storage"]
    end

    subgraph "External Services"
        Claude["Anthropic Claude API"]
        Jira["Jira (REST API)"]
        Teams["Microsoft Teams (Webhooks)"]
        SMTP["Email (SMTP)"]
    end

    Browser -->|"HTTP/REST + SSE"| API
    API -->|"SQL (pg Pool)"| PG
    API -->|"TDS (Tedious)"| AzSQL
    API -->|"HTTPS"| Blob
    Worker -->|"HTTP Polling (x-worker-secret)"| API
    Worker -->|"HTTPS (Anthropic SDK)"| Claude
    API -->|"REST"| Jira
    API -->|"Webhook POST"| Teams
    API -->|"SMTP"| SMTP
```

## Key Points

- **Worker isolation**: Worker processes are separate Node.js instances that authenticate via a shared secret and poll the API server for tasks — enabling horizontal scaling.
- **Real-time streaming**: The browser maintains an SSE (Server-Sent Events) connection to the API server for live pipeline progress updates without WebSocket overhead.
