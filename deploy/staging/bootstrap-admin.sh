#!/usr/bin/env bash
# Creates the very first super_admin and prints its single-use accept-invite
# link. Needs no SMTP: the link is printed here rather than emailed.
#
# It refuses to run once ANY admin row exists — that guard is the reason this is
# not a back door, and preflight check #9 asserts the guard is still in the
# source. Every further admin comes from the invite flow inside the console,
# where the inviting admin is on the record.
set -euo pipefail
cd "$(dirname "$0")"

[ $# -eq 1 ] || { echo "usage: ./bootstrap-admin.sh <email>" >&2; exit 1; }

docker compose run --rm --no-deps backend node prisma/seed-admin.js "$1"
