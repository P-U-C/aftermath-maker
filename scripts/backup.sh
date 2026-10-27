#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
destination="${1:-./backups}"
mkdir -p "$destination"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_path="$(cd "$destination" && pwd)/aftermath-maker-$timestamp.tar.gz"
snapshot_path="/data/.maker-backup-$timestamp.db"
scratch="$(mktemp -d)"

docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then
  docker_cmd=(sudo -n docker)
fi

container_id="$("${docker_cmd[@]}" compose ps -q control)"
if [[ -z "$container_id" ]]; then
  echo "Control container is not running" >&2
  exit 1
fi

cleanup() {
  rm -rf "$scratch"
  "${docker_cmd[@]}" compose exec -T control rm -f "$snapshot_path" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${docker_cmd[@]}" compose exec -T control \
  node apps/control/dist/backup.js "$snapshot_path" >/dev/null
"${docker_cmd[@]}" cp "$container_id:$snapshot_path" "$scratch/maker.db"

tar -czf "$archive_path" -C "$scratch" maker.db
chmod 600 "$archive_path"

echo "$archive_path"
