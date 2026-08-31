#!/usr/bin/env bash
# Runs the go-live gate against the deployed stack, inside a container that has
# the real environment loaded — the same 15 checks docs/DEPLOY.md §2 describes.
#
# Under NODE_ENV=development a failure prints RED and still exits 0. Read the
# output, do not just read the exit code.
set -euo pipefail
cd "$(dirname "$0")"
docker compose run --rm --no-deps backend npm run preflight
