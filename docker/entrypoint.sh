#!/usr/bin/env bash
set -euo pipefail

# ── License / trial expiry gate ─────────────────────────────────
# The date is baked into the image at build time (Dockerfile ARG ->
# backend/LICENSE_EXPIRY). Hard-stops the container before nginx/API start
# once the trial has passed; a missing or unreadable date also stops it.
# license-expiry.middleware.ts enforces the same cutoff at request time.
license_expiry="$(cat /app/backend/LICENSE_EXPIRY 2>/dev/null || true)"
expiry_epoch=$(date -u -d "${license_expiry:-invalid}" +%s 2>/dev/null || echo 0)
if [ "$expiry_epoch" -le 0 ] || [ "$(date -u +%s)" -ge "$expiry_epoch" ]; then
  echo "════════════════════════════════════════════════════════" >&2
  echo " JBS IntelliQE — trial period expired on ${license_expiry:-unknown date}" >&2
  echo " This deployment is no longer authorized to run." >&2
  echo " Contact JBS to renew or obtain a production license." >&2
  echo "════════════════════════════════════════════════════════" >&2
  exit 1
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
