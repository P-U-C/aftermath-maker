# Maker

A private, self-hosted market-making control plane for Aftermath perpetuals on Sui.

The owner connects once and authorizes a dedicated agent wallet. The agent can place and cancel orders, but cannot withdraw collateral or grant another agent. Its key is generated locally, encrypted at rest, and reused after restarts.

## Run it

```bash
./scripts/init-local.sh
docker compose up -d --build
```

Open `http://127.0.0.1:8788` in a browser. The protected internal deployment is available at `https://maker.permanentupperclass.com`; its operator credential is stored only on the host at `~/.config/maker/access.env`.

The dashboard walks through the remaining setup:

1. Connect the wallet that owns an Aftermath perpetuals account.
2. Choose the account.
3. Approve one transaction. It grants the trading-only capability and sends the agent 0.1 SUI for gas.

After that, the service runs without repeated wallet prompts.

## Use your validator

Set this in the local `.env` before launch:

```dotenv
SUI_VALIDATOR_GRPC_URL=https://your-private-sui-grpc-endpoint
```

The service health-checks that endpoint first. It uses the public mainnet gRPC endpoint only when the preferred endpoint is unavailable. The dashboard records which endpoint accepted each live transaction.

## Modes

- **Observe:** reads markets and computes quotes without submitting orders.
- **Paper:** records simulated quote cycles.
- **Live:** atomically cancels stale orders and places a post-only bid and ask.

Live mode is disabled by default. Enabling it requires both independent environment gates:

```dotenv
LIVE_TRADING_ENABLED=true
ALLOW_MAINNET=true
```

Restart the containers after changing either value. Start with small limits.

## What it protects

- No withdrawal permission in the agent capability.
- No builder code or integrator fee is supplied.
- Quote cycles are serialized; stop and reconfigure invalidate in-flight execution before signing.
- Every live transaction is simulated before signing.
- Post-only orders and self-cross checks prevent the service from taking its own quote.
- Stable client order IDs replace only this service's quotes, leaving manual orders untouched.
- Inventory, quote size, stale-book, loss, leverage, and gas limits fail closed.
- A live cycle error stops the engine instead of retrying blindly.
- SQLite uses WAL and persists in a Docker volume.
- The control service is not published to the host; the web service binds to localhost by default.

See [SECURITY.md](SECURITY.md) before enabling live mode.

## Builder fees

No `builderCode`, `integratorId`, `integratorFee`, or `maxIntegratorFee` fields appear in the published DegenYok client bundles inspected on 2026-10-26. That is evidence, not proof of zero fees, because its backend builds opaque transaction payloads.

The dashboard can query Aftermath for a known integrator ID on your account. Aftermath does not expose a list-all approvals endpoint in the current SDK, so unknown approvals require transaction-history or on-chain event analysis. This product never includes a builder code in an order.

## Operations

```bash
docker compose ps
docker compose logs -f control
docker compose logs -f web
./scripts/backup.sh
docker compose down
```

`docker compose down` preserves the named data volume. Do not use `down -v` unless the encrypted signer and audit history have already been backed up.

## Development

```bash
npm install
npm run dev
npm run check
```

The repository is private for the internal phase. The code is organized so the execution core, Aftermath adapter, control service, and web interface can be separated before a public release.
