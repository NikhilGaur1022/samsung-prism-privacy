#!/usr/bin/env bash
# Prints both tunnels' current public URLs.
set -euo pipefail
cd "$(dirname "$0")"

one() {
  docker compose logs "$1" 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
}

admin=$(one tunnel)
user=$(one tunnel-user)

echo "  user   ${user:-<not up>}"
echo "  admin  ${admin:-<not up>}${admin:+/admin}"
