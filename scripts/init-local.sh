#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -e .env ]]; then
  echo ".env already exists; leaving it unchanged."
  exit 0
fi

umask 077
master_key="$(openssl rand -base64 32 | tr -d '\n')"
control_token="$(openssl rand -hex 32)"

sed \
  -e "s|^MAKER_MASTER_KEY=.*$|MAKER_MASTER_KEY=$master_key|" \
  -e "s|^CONTROL_TOKEN=.*$|CONTROL_TOKEN=$control_token|" \
  .env.example > .env

chmod 600 .env
echo "Created .env with local-only secrets (mode 0600)."
echo "Set SUI_VALIDATOR_GRPC_URL in .env before launch to prefer your validator."
