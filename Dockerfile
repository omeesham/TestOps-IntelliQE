# syntax=docker/dockerfile:1
#
# JBS IntelliQE — single-container image
#   nginx        : serves the React SPA and reverse-proxies /api (+ SSE) to the API
#   supervisor   : runs the Express API and (optionally) the pipeline worker
#   playwright   : base image ships Chromium + OS deps so server-side test execution works
#
# Build context must be the repo root:  docker build -t intelliqe .

# ── Stage 1: Build React UI (Vite) ────────────────────────────────
FROM node:20-alpine AS ui-builder

# Version stamp shown in the sidebar (V<build>-DDMMYY). Passed by CI / compose;
# Vite exposes VITE_-prefixed env vars to the client at build time.
ARG APP_VERSION=dev
ENV VITE_APP_VERSION=$APP_VERSION

WORKDIR /ui
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build          # -> /ui/dist

# ── Stage 2: Build Express API (TypeScript -> dist) ───────────────
# Built on the same glibc/Node base as the runtime so native modules
# (e.g. bcrypt) keep a compatible ABI.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS api-builder

WORKDIR /api
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
RUN npm run build          # tsc -> /api/dist
RUN npm prune --omit=dev   # strip devDeps (tsx, typescript, @types) for runtime

# ── Stage 3: Final Runtime Image ──────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

# Trial/license expiry (YYYY-MM-DD). entrypoint.sh refuses to start the
# container past this date; the backend's license-expiry.middleware.ts
# enforces the same cutoff at request time as a runtime safety net.
ARG LICENSE_EXPIRY=2026-08-25

ENV NODE_ENV=production \
    PORT=3001 \
    RUN_WORKER=true \
    BACKEND_URL=http://127.0.0.1:3001 \
    LICENSE_EXPIRY=$LICENSE_EXPIRY

# nginx + supervisor + envsubst (gettext-base) + wget for healthcheck +
# default-jre-headless: allure-commandline (the Allure 2 `allure generate` CLI)
# is a JAVA app. The Playwright base image ships Node + browsers but NO JRE, so
# without this `allure generate` fails in the container and the Allure report is
# never produced (the Basic/Playwright report is pure Node and works regardless).
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx supervisor gettext-base wget default-jre-headless \
    && rm -f /etc/nginx/sites-enabled/default \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Compiled API + production node_modules
COPY --from=api-builder /api/dist          ./backend/dist
COPY --from=api-builder /api/node_modules  ./backend/node_modules
COPY --from=api-builder /api/package.json  ./backend/package.json
# Pipeline definition + other runtime config (loaded at ../../config from dist/)
COPY --from=api-builder /api/config        ./backend/config
# Agent prompt definitions — worker resolves AGENTS_DIR to backend/.github/agents
COPY .github/agents                        ./backend/.github/agents
# POM scaffold (base.page.ts, fixtures, utils). In-image test execution lays these
# into each test workspace so generated specs/page objects resolve their imports
# (e.g. `../base.page`). WITHOUT it every spec fails with
# "Cannot find module '../base.page'" and the whole suite fails to load.
# Copied to a fixed path + pinned via CLIENT_DELIVERABLE_DIR so the compiled
# (dist/) runtime finds it regardless of relative-path resolution.
COPY client-deliverable/src                ./client-deliverable/src
ENV CLIENT_DELIVERABLE_DIR=/app/client-deliverable/src

# Built React UI -> nginx web root
COPY --from=ui-builder /ui/dist /usr/share/nginx/html

# Configs
COPY docker/nginx.conf      /etc/nginx/templates/default.conf.template
COPY docker/supervisord.conf /etc/supervisord.conf
COPY docker/entrypoint.sh    /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 80  = nginx (SPA + /api proxy)   3001 = API (direct, optional)
EXPOSE 80 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/api/health" || exit 1

CMD ["/entrypoint.sh"]
