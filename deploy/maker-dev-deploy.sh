#!/usr/bin/env bash
set -euo pipefail

# Runs from the system timer as root. The checkout remains owned by ubuntu so
# normal development work never needs root. Docker is used only for the
# isolated aftermath-maker-dev Compose project.
repo=/home/ubuntu/aftermath-maker-dev
branch=dev
env_file=/etc/aftermath-maker/dev.env
lock_file=/run/lock/aftermath-maker-dev-deploy.lock

if [[ ! -r "$env_file" ]]; then
  echo "Missing $env_file; refusing to deploy dev" >&2
  exit 1
fi

as_ubuntu() {
  runuser -u ubuntu -- env HOME=/home/ubuntu "$@"
}

mkdir -p "$(dirname "$lock_file")"
exec 9>"$lock_file"
flock -n 9 || exit 0

if [[ ! -d "$repo/.git" ]]; then
  install -d -o ubuntu -g ubuntu "$(dirname "$repo")"
  as_ubuntu git clone --branch "$branch" --single-branch \
    https://github.com/P-U-C/aftermath-maker.git "$repo"
fi

as_ubuntu git -C "$repo" fetch --depth=1 origin "$branch"
current=$(as_ubuntu git -C "$repo" rev-parse HEAD)
target=$(as_ubuntu git -C "$repo" rev-parse FETCH_HEAD)
export MAKER_DEV_ENV_FILE="$env_file"
compose=(docker compose --project-name aftermath-maker-dev \
  --env-file "$env_file" -f "$repo/docker-compose.dev.yml")

if [[ "$current" == "$target" ]]; then
  # A fresh clone starts at the target SHA but has no containers yet. Only
  # skip work when the dev web service is actually running.
  if "${compose[@]}" ps --status running --services 2>/dev/null | grep -qx web; then
    echo "Maker dev already runs $current"
    exit 0
  fi
else
  as_ubuntu git -C "$repo" reset --hard "$target"
fi

sha=$(as_ubuntu git -C "$repo" rev-parse HEAD)
export VCS_REF="$sha"
"${compose[@]}" build --build-arg "VCS_REF=$sha"
"${compose[@]}" up -d --remove-orphans

# Compose has already waited for control's private healthcheck. This confirms
# the publicly proxied web listener without calling a venue or public endpoint.
for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 \
    http://127.0.0.1:8789/ >/dev/null; then
    echo "Maker dev deployed $sha"
    exit 0
  fi
  sleep 2
done

echo "Maker dev did not become healthy at $sha" >&2
exit 1
