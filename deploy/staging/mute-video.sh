#!/usr/bin/env bash
# Strips the audio track off a video so it can be uploaded.
#
#   ./mute-video.sh clip.mp4 [more.mp4 ...]
#
# Writes <name>.muted.mp4 beside each input and leaves the original alone.
#
# Why this is needed: video.service.js refuses any clip carrying a soundtrack
# (HTTP 422). That is deliberate — no voice-consent decision is attached to a
# video, so audio in one cannot lawfully be processed or served. Muting is the
# supported way through it; VIDEO_ALLOW_AUDIO=true would switch the control off
# and must not be set on a real deployment.
#
# ffmpeg runs inside the video-worker container, because this host has none. The
# video stream is copied, not re-encoded (-c:v copy), so there is no quality loss
# and no wait — only the audio stream is dropped.
set -euo pipefail
cd "$(dirname "$0")"

[ $# -gt 0 ] || { echo "usage: ./mute-video.sh <video> [video ...]" >&2; exit 1; }

svc=video-worker
docker compose ps --status running --services 2>/dev/null | grep -qx "$svc" \
  || { echo "$svc is not running — start the stack with ./up.sh first." >&2; exit 1; }

for src in "$@"; do
  [ -f "$src" ] || { echo "skipping '$src': not a file" >&2; continue; }
  base=$(basename "$src"); ext="${base##*.}"; stem="${base%.*}"
  out="$(dirname "$src")/${stem}.muted.${ext}"

  docker compose exec -T "$svc" rm -f /tmp/in /tmp/out 2>/dev/null || true
  docker compose exec -T "$svc" sh -c 'cat > /tmp/in' < "$src"
  # -an drops audio; -c:v copy keeps the original video bitstream untouched.
  docker compose exec -T "$svc" sh -c \
    "ffmpeg -loglevel error -y -i /tmp/in -c:v copy -an -f ${ext} /tmp/out"
  docker compose exec -T "$svc" sh -c 'cat /tmp/out' > "$out"
  docker compose exec -T "$svc" rm -f /tmp/in /tmp/out 2>/dev/null || true

  echo "  $src  ->  $out"
done

echo
echo "Upload the .muted.* files. The originals are untouched."
