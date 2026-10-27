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

volume_path="$("${docker_cmd[@]}" volume inspect \
  aftermath-maker_maker-data --format '{{.Mountpoint}}')"
archive_path="$(cd "$destination" && pwd)/$(basename "$archive")"

tar_cmd=(tar)
if [[ ! -r "$volume_path" ]]; then
  tar_cmd=(sudo -n tar)
fi
"${tar_cmd[@]}" -czf "$archive_path" -C "$volume_path" .

if [[ ! -O "$archive_path" ]]; then
  sudo -n chown "$(id -u):$(id -g)" "$archive_path"
fi
chmod 600 "$archive_path"

echo "$archive_path"
