#!/usr/bin/env bash
# Creates a data-principal (subject) account for testing, and prints the OTP.
#
#   ./seed-subject.sh someone@example.com ["Their Name"] [GROUP]
#
# There is no admin-side "create a subject and set their password" — subjects
# authenticate by emailed OTP and nothing else, so this goes through exactly the
# public self-registration endpoint the portal's own "Create an account" page
# uses. Nothing here is a back door: it is the ordinary flow, driven by curl.
#
# It works without a mailbox only because this stack runs non-hardened with
# EXPOSE_DEV_OTP=on, so the API echoes the code back in the response. Under
# NODE_ENV=production this script prints no code and the account is unreachable
# until SMTP_* is configured — which is the intended behaviour, not a gap.
set -euo pipefail
cd "$(dirname "$0")"

email="${1:-}"
name="${2:-Test Principal}"
group="${3:-VOLUNTEER}"

if [ -z "$email" ]; then
  echo "usage: ./seed-subject.sh <email> [\"Full Name\"] [GROUP]" >&2
  echo "GROUP: SAMSUNG_EMPLOYEE | EX_SAMSUNG_EMPLOYEE | SEED_LAB_EMPLOYEE |" >&2
  echo "       EX_SEED_LAB_EMPLOYEE | VOLUNTEER   (default VOLUNTEER)" >&2
  exit 1
fi

[ -f .env ] || { echo "Run ./init.sh first." >&2; exit 1; }
set -a; . ./.env; set +a

# Against the local user origin, not the tunnel: same backend, one less hop, and
# it still works when the tunnel is down. TRUST_PROXY_HOPS=2 means the rate
# limiter buckets this by the forwarded chain either way.
api="http://127.0.0.1:8081"

body=$(printf '{"group":"%s","fullName":"%s","email":"%s"}' "$group" "$name" "$email")
res=$(curl -sS -X POST "$api/auth/subject/register" \
        -H 'Content-Type: application/json' -d "$body" || true)

# Already registered from an earlier run — ask for a fresh login code instead.
# Registration and login share a rate-limit bucket on purpose (auth-subject
# .routes.js), so this second call draws from the same budget.
if printf '%s' "$res" | grep -q '"error"'; then
  echo "  register said: $(printf '%s' "$res" | sed 's/.*"error":"\([^"]*\)".*/\1/')"
  echo "  requesting a login code for the existing account instead"
  res=$(curl -sS -X POST "$api/auth/subject/login" \
          -H 'Content-Type: application/json' \
          -d "$(printf '{"email":"%s"}' "$email")")
fi

otp=$(printf '%s' "$res" | sed -n 's/.*"devOtp":"\([0-9]*\)".*/\1/p')

echo
echo "  Sign in at   ${USER_URL:-http://127.0.0.1:8081}"
echo "  Email        $email"
if [ -n "$otp" ]; then
  echo "  OTP          $otp   (valid for a few minutes, single use)"
else
  echo "  OTP          not returned — the API is hardened or EXPOSE_DEV_OTP is off."
  echo "               Raw response: $res"
fi
echo
echo "  The portal also shows the code on its own verify screen, so on a phone"
echo "  you can just enter the email and read it off the page."
