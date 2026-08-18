#!/usr/bin/env bash
# Emits the seven preflight-gated secrets. Paste into prod.env.
# Run once per environment and keep the output — MEDIA_KEK in particular is not
# recoverable, and losing it makes every sealed media blob permanently
# unreadable.
set -euo pipefail
b64() { node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"; }
cat <<OUT
AUDIT_HMAC_SECRET="$(b64)"
JWT_ADMIN_SECRET="$(b64)"
JWT_SUBJECT_SECRET="$(b64)"
FACE_EMBEDDING_KEY="$(b64)"
MEDIA_KEK="$(b64)"
MEDIA_KEK_VERSION="1"
DSAR_SIGNING_SEED="$(b64)"
OUT
