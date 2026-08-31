#!/usr/bin/env bash
# Brings the whole stack up and prints the public URL.
#
# Safe to re-run: the database work it does is idempotent, and it only rewrites
# PUBLIC_URL when the tunnel has actually handed out a different hostname.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] && [ -f app.env ] || { echo "Run ./init.sh first." >&2; exit 1; }
set -a; . ./.env; set +a

dc() { docker compose "$@"; }

echo "==> datastores"
dc up -d postgres redis qdrant
# `depends_on: service_healthy` covers the application containers, but the two
# steps below run before those exist.
until dc exec -T postgres pg_isready -U postgres -d prism >/dev/null 2>&1; do sleep 1; done

echo "==> migrations (as the owner role, which is the only role allowed DDL)"
dc run --rm --no-deps \
  -e DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/prism?sslmode=require" \
  -e DIRECT_URL="postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/prism?sslmode=require" \
  backend npx prisma migrate deploy

echo "==> least-privilege application role"
# Ordering matters and is the reverse of what reads naturally: this grants on
# ALL TABLES IN SCHEMA public, so it has to run after the migrations that create
# them. ALTER DEFAULT PRIVILEGES inside it covers whatever a later migration
# adds.
dc run --rm --no-deps \
  -e DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/prism?sslmode=require" \
  -e DIRECT_URL="postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/prism?sslmode=require" \
  backend node scripts/run-sql.js scripts/sql/provision-app-role.sql \
    -v "password='${APP_DB_PASSWORD}'"

echo "==> everything else"
dc up -d

echo "==> waiting for the tunnels to be assigned hostnames"

# Each quick tunnel prints its hostname once, into its own container's log.
# Read them per-service: a combined `docker compose logs` would interleave the
# two and there would be no way to tell which URL belonged to which origin.
wait_for_url() {
  local svc="$1" url=""
  for _ in $(seq 1 60); do
    url=$(dc logs "$svc" 2>/dev/null \
          | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
    [ -n "$url" ] && { printf '%s' "$url"; return 0; }
    sleep 2
  done
  return 1
}

admin_url=$(wait_for_url tunnel)      || admin_url=""
user_url=$(wait_for_url tunnel-user)  || user_url=""

if [ -z "$admin_url" ] || [ -z "$user_url" ]; then
  echo "  a tunnel did not report a URL (admin='${admin_url:-none}' user='${user_url:-none}')." >&2
  echo "  The stack is up on http://localhost:8080 and :8081; check" >&2
  echo "  'docker compose logs tunnel' / 'docker compose logs tunnel-user'." >&2
  exit 1
fi

if [ "$admin_url" = "$user_url" ]; then
  echo "  both tunnels reported the same hostname ($admin_url) — refusing to" >&2
  echo "  continue, because the split would be a no-op." >&2
  exit 1
fi

if [ "$admin_url" != "${PUBLIC_URL:-}" ] || [ "$user_url" != "${USER_URL:-}" ]; then
  echo "==> PUBLIC_URL -> $admin_url"
  echo "==> USER_URL   -> $user_url"
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=${admin_url}|" .env
  sed -i "s|^USER_URL=.*|USER_URL=${user_url}|" .env
  # Re-export, and do NOT rely on compose re-reading the file it just had
  # rewritten. `set -a; . ./.env` above put the OLD values in this shell's
  # environment, and a variable exported in the environment takes precedence
  # over the .env file — so without these two lines compose interpolates the
  # stale URLs and the containers come back up with them. That failure is
  # silent: the stack is healthy, and the only symptom is that join QRs and
  # invite emails point at a tunnel that no longer exists.
  export PUBLIC_URL="$admin_url" USER_URL="$user_url"
  # Only the backend containers read these — the portals issue same-origin
  # relative requests, so no asset needs rebuilding for a URL change.
  dc up -d --no-deps backend \
    worker-recognition worker-redaction worker-purge worker-retention \
    worker-item-action worker-export worker-reaper

  # Assert they actually took, rather than trusting that they did. Checked on
  # the two variables the backend genuinely reads: USER_PORTAL_URL builds the
  # join link (join.service.js:14) and ADMIN_APP_BASE_URL builds the admin
  # invite link (auth-admin.service.js:24). APP_BASE_URL is set for parity with
  # the repo's other compose files but no backend code reads it, so asserting
  # on it would prove nothing.
  check() {
    local var="$1" want="$2" got
    got=$(dc exec -T backend printenv "$var" 2>/dev/null | tr -d '\r')
    [ "$got" = "$want" ] && return 0
    echo "  $var in the container is '$got', expected '$want'." >&2
    echo "  Run 'docker compose up -d --force-recreate backend' and re-check." >&2
    return 1
  }
  check USER_PORTAL_URL   "$user_url"          || exit 1
  check ADMIN_APP_BASE_URL "$admin_url/admin"  || exit 1
fi

lan=$(hostname -I | awk '{print $1}')

echo
echo "  USER  (data principals)"
echo "    portal        $user_url"
echo "    LAN (no TLS)  http://$lan:8081"
echo
echo "  ADMIN (operators)"
echo "    console       $admin_url/admin"
echo "    LAN (no TLS)  http://$lan:8080/admin"
echo
echo "  API           $admin_url/api/v1  ·  health: $admin_url/health"
echo "                (also served under $user_url, same paths)"
echo
echo "  First admin:  ./bootstrap-admin.sh <your-email>"
echo "  Test subject: ./seed-subject.sh <their-email>"
