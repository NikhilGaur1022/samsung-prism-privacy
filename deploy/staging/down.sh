#!/usr/bin/env bash
# Stops every container. Volumes survive — the database, the media tree, the
# Qdrant galleries and the downloaded model weights are all still there on the
# next ./up.sh.
#
# To destroy the data as well:  docker compose down -v
# That is not reversible, and it includes every blob sealed under MEDIA_KEK.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
