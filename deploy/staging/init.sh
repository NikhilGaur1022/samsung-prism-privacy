#!/usr/bin/env bash
# Generates .env and app.env with fresh secrets. Idempotent: an existing file is
# left alone, so re-running this can never rotate MEDIA_KEK out from under blobs
# that were sealed with it.
set -euo pipefail
cd "$(dirname "$0")"

# openssl, not `node -e crypto.randomBytes` as deploy/gen-secrets.sh uses: the
# point of this stack is that the host needs nothing but Docker, and there is no
# node on it.
b64() { openssl rand -base64 32 | tr -d '\n'; }
pw()  { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32; }

if [ -f .env ]; then
  echo "  .env exists — leaving it alone"
else
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(pw)|" \
      -e "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$(pw)|" \
      env.example > .env
  echo "  .env written (2 database passwords generated)"
fi

if [ -f app.env ]; then
  echo "  app.env exists — leaving it alone"
else
  cp app.env.example app.env
  for key in AUDIT_HMAC_SECRET JWT_ADMIN_SECRET JWT_SUBJECT_SECRET \
             FACE_EMBEDDING_KEY MEDIA_KEK DSAR_SIGNING_SEED; do
    # A generated value can contain / and +, so use a delimiter that base64
    # cannot produce.
    sed -i "s|^${key}=.*|${key}=\"$(b64)\"|" app.env
  done
  echo "  app.env written (6 secrets generated)"
  echo
  echo "  MEDIA_KEK is in deploy/staging/app.env and is NOT recoverable."
  echo "  Every sealed media blob is permanently unreadable without it. Back it up."
fi
