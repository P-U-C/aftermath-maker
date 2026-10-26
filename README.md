# Maker

Wallet-gated autonomous market making for Aftermath perpetuals on Sui.

Each approved wallet receives an isolated strategy, encrypted agent signer, execution loop, and audit log. Access membership lives in a shared Sui object; the server checks that object during login and throughout the session.

## Run

```bash
./scripts/init-local.sh
docker compose up -d --build
```

Open `http://127.0.0.1:8788`. The hosted service is
[https://maker.permanentupperclass.com](https://maker.permanentupperclass.com).

The default data endpoint is Sui's public mainnet gRPC service. A private validator endpoint is optional:

```dotenv
SUI_VALIDATOR_GRPC_URL=https://your-sui-grpc-endpoint
SUI_FALLBACK_GRPC_URL=https://fullnode.mainnet.sui.io:443
```

## User setup

1. Connect a Sui wallet and sign the readable login message.
2. Choose an existing Aftermath USDC perpetuals account, or create one in Maker.
3. Create the encrypted agent and approve its trading capability once.
4. Select up to 12 markets, set portfolio limits, and begin in Observe.

The owner transaction grants a dedicated trading-only agent, sends it 0.1 SUI for gas, and approves the disclosed builder fee. The agent cannot withdraw collateral or grant another agent. No further wallet prompts are required for normal quoting.

Creating an account does not deposit or allocate collateral. Fund the account before moving from Observe to Paper or Live.

## Public access

The Move package is in [`move/maker_access`](move/maker_access). Deployment creates:

- a shared `Registry` containing approved wallet addresses;
- an `AdminCap` owned by the operator wallet; and
- an initial membership for the deployer.

The operator console deploys the package and signs wallet additions or removals. Sessions are opaque, HTTP-only, expire after 12 hours, and re-check on-chain membership every 30 seconds. A removed wallet loses access without a server-side allowlist edit.

First deployment is deliberately staged:

1. Keep Nginx Basic Auth enabled.
2. Set `WALLET_AUTH_BOOTSTRAP=true`.
3. Sign in with the intended operator wallet.
4. Deploy the registry from the operator console.
5. Set `WALLET_AUTH_BOOTSTRAP=false`.
6. Replace the Nginx site with `deploy/nginx-public.conf`.

This order prevents an unguarded first-wallet race.

## Builder incentive

The operator console uses Aftermath's permissionless `create-integrator-registration` transaction and stores the returned numeric integrator ID. The default fee is **1 bp (0.01%) of filled notional**.

The fee is not hidden:

- onboarding displays the exact rate;
- the owner approves that exact maximum on-chain;
- each order is checked against the configured ID and rate before building; and
- the owner can revoke the approval through Aftermath.

Set `AFTERMATH_INTEGRATOR_FEE_BPS` to a value from `0` to `5`. An active integrator ID is required before a fee is attached.

## Desk model

Maker runs one bounded portfolio per approved wallet:

- Markets are visited round-robin. The configured cycle interval multiplied by the number of selected markets is each market's effective refresh interval.
- Every visit refreshes the book, current one-sided open interest, funding, account inventory, portfolio exposure, and unrealized PnL.
- OI in USD is the current base OI multiplied by the live index price. OI capacity is measured against the protocol's market limit.
- Quote prices skew with inventory. Per-market inventory, portfolio gross exposure, loss, leverage, book freshness, and gas limits remain hard gates.
- A manual stop or live safety failure cancels only Maker's tagged orders across the selected markets. Manual orders are untouched.

The operating rationale and remaining institutional gaps are documented in [docs/OPERATING_MODEL.md](docs/OPERATING_MODEL.md).

## Modes

- **Observe:** read every selected market and compute quotes without submitting orders.
- **Paper:** rotate through the portfolio and record simulated quote cycles.
- **Live:** atomically replace a post-only bid and ask on the current market.

Live mode is fail-closed and requires both environment gates:

```dotenv
LIVE_TRADING_ENABLED=true
ALLOW_MAINNET=true
```

Start in Observe, move to Paper, and use small limits for the first live run.

## Safety

- Per-wallet tenant isolation in SQLite and memory.
- AES-256-GCM encryption for each agent key.
- Trading-only Aftermath capability; no withdrawals.
- Exact builder ID and fee policy.
- Serialized quote cycles and stale-cycle cancellation.
- Pre-sign transaction simulation and explicit gas ceiling.
- Stable client order IDs that leave manual orders untouched.
- Per-market inventory, portfolio gross exposure, quote size, loss, leverage, spread, and stale-book limits.
- Manual stop and live safety failures cancel Maker-tagged quotes across the portfolio.
- Any live-cycle error stops that wallet's engine.
- Control API stays on the internal Docker network.

Read [SECURITY.md](SECURITY.md) before enabling live mode.

## Operations

```bash
docker compose ps
docker compose logs -f control
docker compose logs -f web
./scripts/backup.sh
docker compose down
```

`docker compose down` preserves the named volume. Do not use `down -v` unless the encrypted signers and audit history are backed up.

## Development

```bash
npm install
npm run check
sudo docker run --rm \
  -v "$PWD/move/maker_access:/workspace" \
  -w /workspace mysten/sui-tools:mainnet sui move test
```
