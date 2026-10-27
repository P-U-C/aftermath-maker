#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
destination="${1:-./backups}"
mkdir -p "$destination"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$destination/aftermath-maker-$timestamp.tar.gz"

docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then
  docker_cmd=(sudo -n docker)
fi

trap '"${docker_cmd[@]}" compose start control >/dev/null || true' EXIT
"${docker_cmd[@]}" compose stop control

archive_name="$(basename "$archive")"
"${docker_cmd[@]}" run --rm \
  -e ARCHIVE_NAME="$archive_name" \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  -v aftermath-maker_maker-data:/data:ro \
  -v "$(cd "$destination" && pwd)":/backup \
  alpine:3.22 \
  sh -euc '
    tar -czf "/backup/$ARCHIVE_NAME" -C /data .
    chown "$HOST_UID:$HOST_GID" "/backup/$ARCHIVE_NAME"
    chmod 600 "/backup/$ARCHIVE_NAME"
  '

echo "$archive"
