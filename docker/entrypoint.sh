#!/usr/bin/env bash
set -euo pipefail

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
