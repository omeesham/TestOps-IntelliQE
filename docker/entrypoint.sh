#!/usr/bin/env bash
set -euo pipefail

# ── License / trial expiry gate ─────────────────────────────────
# Baked in at build time via LICENSE_EXPIRY (Dockerfile ARG/ENV).
# Hard-stops the container before nginx/API ever start once the trial
# period has passed. The backend's license-expiry.middleware.ts enforces
# the same cutoff for a container that was already running when the
# date rolled over.
if [ -n "${LICENSE_EXPIRY:-}" ]; then
  now_epoch=$(date -u +%s)
  expiry_epoch=$(date -u -d "${LICENSE_EXPIRY}" +%s 2>/dev/null || echo 0)
  if [ "$expiry_epoch" -gt 0 ] && [ "$now_epoch" -ge "$expiry_epoch" ]; then
    echo "════════════════════════════════════════════════════════" >&2
    echo " JBS IntelliQE — trial period expired on ${LICENSE_EXPIRY}" >&2
    echo " This deployment is no longer authorized to run." >&2
    echo " Contact JBS to renew or obtain a production license." >&2
    echo "════════════════════════════════════════════════════════" >&2
    exit 1
  fi
fi

# API port the backend listens on (Express reads process.env.PORT).
export API_PORT="${PORT:-3001}"

# Keep the in-container worker pointed at the local API by default.
export BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:${API_PORT}}"

# Render nginx config — only ${API_PORT} is substituted so nginx's own
# $uri/$host variables survive.
envsubst '${API_PORT}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

exec /usr/bin/supervisord -c /etc/supervisord.conf
