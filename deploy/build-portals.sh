#!/usr/bin/env bash
# Builds both SPAs into deploy/www/, which Caddy serves as static files.
# Re-run after any portal change; `docker compose restart caddy` is not needed,
# the bind mount picks it up.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "deploy/.env missing — copy .env.example and set the hosts." >&2; exit 1; }
set -a; . ./.env; set +a

export VITE_API_BASE_URL="https://${API_HOST}"
echo "Building against ${VITE_API_BASE_URL}"

for portal in user admin; do
  src="../${portal}-portal"
  ( cd "$src" && npm ci && npm run build )
  rm -rf "www/${portal}"
  mkdir -p www
  cp -r "${src}/dist" "www/${portal}"
done
echo "Built into deploy/www/{user,admin}"
