# Meeting Notes — IntelliQE Product: GCP / Multi-Cloud Deployment Strategy

**Date:** 10 June 2026, 8:18 AM · **Duration:** ~41 min
**Attendees:** Rohit Yadav, Uma Duvvuri, Sathya Kasithangam, Omeesha Mahanta
**Recorded by:** Omeesha (transcript-based notes)

---

## 1. Purpose of the meeting

Decide how to deploy IntelliQE to customers who run on **different clouds (Azure, AWS, GCP)** and **different databases (PostgreSQL, SQL Server, Cosmos DB, MongoDB)** without re-engineering the product for every customer. The current pain: each new customer means manually adapting code, DB libraries, and deployment to their platform — Rohit and Uma agreed this repeated effort is "unnecessary."

---

## 2. The core decision

> **Deploy the product *inside each customer's own infrastructure* using Docker — NOT as a JBS-hosted multi-tenant SaaS.**

Two options were debated and the second one won:

| Option | Outcome |
|--------|---------|
| **A. Multi-tenant SaaS hosted by JBS** (Rohit's first idea — subdomain per customer, e.g. `tenant1.example.com`, pay-as-you-go, like Zoho/Microsoft) | **Rejected for now** |
| **B. Containerized, customer-side deployment** (ship a Docker image into the customer's cloud) | **Adopted** |

**Why A was dropped:**
- *Sathya:* A hosted product implies **24×7 infra + support** owned by JBS; we don't have the people, and bearing that infra cost is expensive.
- *Uma:* Target customers — especially **healthcare (NRG, CNP, Encore)** — will not allow anything to run **outside their own environment**. IntelliQE is a *testing* product, not a core app, so JBS shouldn't take on infra ownership/risk.
- *Rohit (agreed):* Since we're hosting on the customer side, **full multi-tenancy is not required**. What we actually need is **DB flexibility + a clean container deployment flow.**

---

## 3. Rohit's suggestions (the heart of the meeting)

### 3.1 Containerize and stay platform-agnostic
- "A Docker image is a Docker image, whatever the platform." We **don't need to care** whether the customer is on Azure, AWS, or GCP.
- All we need from the customer is a **container registry** + the **connection string** to it. They pull the image and bring the container up on their side.
- This collapses the problem to **two real work items: (1) database flexibility, (2) a CI/CD push pipeline.**

### 3.2 Database-level flexibility — **start here first (Priority #1)**
- Support multiple databases: **PostgreSQL, SQL Server, Cosmos DB, MongoDB** (SQL + NoSQL).
- Use **environment-/DB-specific configuration files**, selected at runtime — same pattern as **.NET `appsettings`** (dev / production variants).
  - e.g. enable PostgreSQL → it loads the PostgreSQL config file and runs against it; switch to Cosmos → loads the Cosmos config.
- Action: get the list of which DBs target customers actually use, then ensure all supported DBs can connect via config selection.
- Omeesha already has **PostgreSQL**; needs to add **Cosmos DB** and **SQL Server**.

### 3.3 CI/CD via GitHub Actions
- In `.github/workflows/`, create a **Docker build-and-push YAML** (only **one** workflow file needed — build + push, not separate files).
- Pipeline steps the workflow performs:
  1. GitHub spins up a **micro VM** runner and pulls our code.
  2. **Builds** the Docker image.
  3. **Connects** to the customer's registry (using their connection string).
  4. **Pushes** the image to that registry.
  5. The customer's cloud (e.g. Azure portal) then **auto-picks up the new revision** and runs the container.
- You can use **GitHub Copilot** to generate the workflow file ("create a git build/push action file"); just fill in the per-customer values (registry, connection string).
- Because registries/connection strings differ per customer, each customer gets its **own workflow action file** + branch.
- Setup is partly on the customer side: they create the registry, we log in to GitHub from their side and **enable CI/CD** there; thereafter every push auto-deploys.

### 3.4 Branching strategy
- **One repository per DB type** (Cosmos repo / SQL repo / PostgreSQL repo), each with `main`, `test`, `dev` branches.
- Per-**customer branches**, named after the customer (e.g. `dev-NRG`, `dev-Satyendra`, `encore`).
- Promotion flow:
  ```
  local → dev  →  test (JBS demo env)  →  main  →  all customer branches
  ```
  - **dev:** developer's own working branch, verify locally.
  - **test:** a **demo/replica environment on the JBS side** that mimics a customer environment for validation.
  - **main:** the golden code; a **pipeline on main pushes to all customer branches at once**. Merging into a customer branch triggers that customer's image build/push.

### 3.5 Demo / test environment on JBS side
- Stand up a **replica "sample customer" environment** internally. Validate every change there before it ever reaches a real customer branch.

### 3.6 IP protection / kill-switch (raised by Omeesha, answered by Rohit)
*Concern: after a POC or if a relationship ends, the customer could keep running our image.*

**What was suggested in the meeting (the push-based teardown):**
- Keep **access to the customer's cloud portal** so we can **disable the service** directly.
- If our access is revoked: push a **blank/empty branch** to theirs → it builds an **empty image** → the app stops working on their side.
- Configure the registry to **keep only the latest image (override / auto-delete old versions)** so they **can't fall back to an older working image**.
- Keep full **version history on the JBS side** (in GitHub) for stable/unstable build tracking. *(Rohit flagged this kill-switch design as something to research further.)*

**⚠️ The gap — "what if they remove access *before* we push the empty image?"**
The empty-image plan is a **cooperative** switch: it only works while we still hold push access **and** the CI/CD trigger is still enabled on their side. The customer controls both. Since they initiate the breakup, **we usually lose the race.** And once the image is running in their infra they can `docker save` / re-tag and keep a copy — "latest-only registry" only stops a lazy rollback, not a deliberate one. **A kill-switch that lives in the deploy pipeline cannot protect IP** once the bits are on the customer's machine.

**What actually protects us (must live in the app + contract, not the pipeline):**
1. **Time-based expiry / signed license baked into each image.** App self-disables after the POC window with no action from us at kill time — survives access revocation. Extending requires a new image/token from JBS. *(Primary mechanism, and the one that works in air-gapped healthcare environments.)*
2. **Gate the AI "brain" behind a JBS-issued key — strongest lever for this product.** IntelliQE can't run without `ANTHROPIC_API_KEY` / `WORKER_SECRET`. If those are JBS-issued/proxied (route Claude calls through a JBS gateway, or per-customer revocable keys), **revoking the key kills the pipeline regardless of who controls the container** — cutting our portal access doesn't help them.
3. **Periodic online license check-in, fail-closed after a grace period.** Pair with #1 as fallback, since locked-down healthcare networks (NRG/CNP) may block outbound calls.
4. **Contract / legal backstop.** POC agreement must define license term, destruction-on-termination, and audit rights — technical measures slow a bad actor but don't make IP un-copyable once deployed in their infra.

> **Bottom line:** treat the empty-image push as a *convenience teardown for an amicable exit* — not as IP protection. When the customer pulls access first, what saves us is an **expiry/license inside the app** + a **JBS-controlled, revocable key for the AI engine**, backed by the contract.

### 3.7 UI enhancement (side discussion)
- Omeesha: the current UI is basic and Claude-generated output looks "boxy" / obviously AI-generated; wants a simpler, lighter ("thinness"), enterprise-appropriate look with the right fonts/colors.
- Rohit's suggestions:
  - Use an **AI UI-generation tool** (HuggingFace-based "design-to-code" site he shared; requires a HuggingFace sign-up with the official email) — it generates full HTML/CSS/JS, shows a live preview, and is downloadable.
  - Or ask **Copilot/Claude to first generate a good prompt**, then paste that prompt into the UI tool. Be specific: state the current UI is very basic and ask for a modern, professional, elegant design.
  - Work on a **separate branch** for UI changes.

---

## 4. Other decisions & notes
- **Resourcing:** Omeesha needs a **React / front-end (full-stack) developer** besides Rohit. Suggested: **Milan** (front-end, her preferred contact), Khushi Chandwani, **Amir**, Pushpanjali, Nikita. (Hilal is stronger on .NET/Python.) Uma encouraged reaching across the org freely.
- **Customer cloud spread (validates the need for flexibility):** Encore, Informative, Satyendra → **Azure**; NRG → **AWS**; CNP → **GCP**. "All the flavors."
- Most target customers run **.NET web applications** — a plus for the config-file pattern Rohit described.

---

## 5. Action items

| # | Owner | Action |
|---|-------|--------|
| 1 | Omeesha | **Start today on DB-level flexibility** — add config-driven support for Postgres (have it), **Cosmos DB**, and **SQL Server**. Do it on a **separate "flexible" branch**. |
| 2 | Omeesha | Set up the **GitHub Actions Docker build/push** workflow (use Copilot to scaffold). |
| 3 | Omeesha / Rohit | **Test the Docker flow against both Azure and AWS** sample environments. |
| 4 | Omeesha | Stand up an internal **demo/test (replica) environment** for validation before customer pushes. |
| 5 | Omeesha | Research the **kill-switch / IP-protection** mechanism (empty-image push + latest-only registry). |
| 6 | Omeesha | Engage a **React developer (Milan / Amir)** for UI work; explore the AI UI-generation tool Rohit shared. |
| 7 | All | **Frequent check-ins with Rohit at each checkpoint** for direction before moving to the next step. |
| 8 | Uma | **Share the meeting recording** with the team. |

---

## 6. One-line summary
Ship IntelliQE as a **Docker container into each customer's own cloud** (no JBS-hosted multi-tenancy). Win on **two fronts**: **config-driven DB flexibility** (Postgres / SQL / Cosmos / Mongo) and a **per-customer GitHub Actions build-push pipeline**, with a **branch-per-customer** model, an internal **demo environment**, and a **registry kill-switch** to protect IP. **First task: DB-level flexibility.**
