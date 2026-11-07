#!/usr/bin/env bash
set -euo pipefail

# Runs from the system timer as root. The checkout remains owned by ubuntu so
# normal development work never needs root. Docker is used only for the
# isolated aftermath-maker-dev Compose project.
repo=/home/ubuntu/aftermath-maker-dev
branch=dev
env_file=/etc/aftermath-maker/dev-shadow.env
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

service_container_id() {
  local container_id
  container_id=$("${compose[@]}" ps -q "$1")
  [[ -n "$container_id" ]] || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id")" == "$1" ]] || return 1
  printf '%s\n' "$container_id"
}

service_revision() {
  local container_id
  container_id=$(service_container_id "$1") || return 1
  docker inspect --format \
    '{{if .State.Running}}{{index .Config.Labels "org.opencontainers.image.revision"}}{{end}}' \
    "$container_id"
}

service_health() {
  local container_id
  container_id=$(service_container_id "$1") || return 1
  docker inspect --format '{{.State.Health.Status}}' "$container_id"
}

web_ready() {
  curl --fail --silent --show-error --max-time 3 \
    http://127.0.0.1:8789/ >/dev/null
}

if [[ "$current" == "$target" ]]; then
  # A fresh clone starts at the target SHA but has no containers yet. The dev
  # tag is mutable, so a running service alone is not proof that the
  # containers use this revision (for example after an interrupted deploy).
  control_revision=$(service_revision control || true)
  web_revision=$(service_revision web || true)
  if [[ "$control_revision" == "$current" && "$web_revision" == "$current" ]] && web_ready; then
    echo "Maker dev already runs $current"
    exit 0
  fi
else
  as_ubuntu git -C "$repo" reset --hard "$target"
fi

sha=$(as_ubuntu git -C "$repo" rev-parse HEAD)
export VCS_REF="$sha"
"${compose[@]}" build --build-arg "VCS_REF=$sha"
# The local dev tag is intentionally mutable. Compose does not recreate a
# service merely because that tag now resolves to a newly built image. Recreate
# in dependency order: forcing both services together can leave control stopped
# while Compose waits indefinitely to replace web.
"${compose[@]}" up -d --remove-orphans --no-deps --force-recreate control
for _attempt in $(seq 1 30); do
  if [[ "$(service_revision control || true)" == "$sha" ]] && \
    [[ "$(service_health control || true)" == "healthy" ]]; then
    break
  fi
  sleep 2
done

if [[ "$(service_revision control || true)" != "$sha" ]] || \
  [[ "$(service_health control || true)" != "healthy" ]]; then
  echo "Maker dev control did not become healthy at $sha" >&2
  exit 1
fi

"${compose[@]}" up -d --no-deps --force-recreate web

# The control health wait above leaves the web proxy a live backend. This
# confirms the publicly proxied web listener without calling a venue or public
# endpoint.
for _attempt in $(seq 1 30); do
  if web_ready; then
    echo "Maker dev Mainnet Paper/shadow deployed $sha; Live gates remain off"
    exit 0
  fi
  sleep 2
done

echo "Maker dev did not become healthy at $sha" >&2
exit 1
