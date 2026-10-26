# Maker

A wallet-gated control plane for running bounded, non-custodial market-making strategies on Aftermath perpetuals.

Maker is built for inspectability: users can see account readiness, collateral, gas runway, effective policy per market, quote freshness, fills, known costs, and the exact transaction behind each live action. It does not present volume as profit.

The current strategy is inventory-aware quoting on Aftermath. It is not delta-neutral and does not place external hedge orders.

Hosted service: [maker.permanentupperclass.com](https://maker.permanentupperclass.com)

## Run locally

```bash
./scripts/init-local.sh
docker compose up -d --build
```

Open `http://127.0.0.1:8788`.

Sui's public mainnet gRPC endpoint is the default. A private validator endpoint is optional:

```dotenv
SUI_VALIDATOR_GRPC_URL=https://your-sui-grpc-endpoint
SUI_FALLBACK_GRPC_URL=https://fullnode.mainnet.sui.io:443
```

## User flow

1. Connect a Sui wallet and sign a readable login message.
2. Select an existing Aftermath USDC account or create one in Maker.
3. Create an encrypted trading agent and approve it once.
4. Check collateral and gas readiness.
5. Select markets, choose a profile, then tune global or per-market limits.
6. Run Observe, then Paper, then deliberately small Live limits.

The agent can trade but cannot withdraw collateral or grant another agent. Creating an account does not deposit collateral.

## What the desk shows

- Equity, available and allocated collateral, owner-withdrawable collateral, agent gas, and authority state
- One-sided OI in base units and estimated USD, protocol capacity, volume, funding, inventory, and unrealized PnL
- Global defaults plus per-market spread, size, inventory target, inventory cap, skew, and leverage overrides
- Runtime, last successful cycle, quote freshness, transaction links, measured gas, and estimated gas runway
- A fill ledger limited to order IDs that Maker recorded when posting
- Realized PnL, protocol fees, estimated builder fees, and net result after those known costs
- Separate **Stop quoting** and **Flatten at market** actions

Strategy changes reconfigure the running engine and apply on its next cycle.

## Execution and safety

Maker visits selected markets round-robin. Each live visit atomically cancels and replaces two stable, Maker-tagged, post-only orders. Manual orders are outside that cancellation set.

Live mode fails closed on setup, signer, mainnet, freshness, spread, quote size, inventory, gross exposure, loss, transaction simulation, and gas limits. An independent watchdog cancels Maker orders if any selected market exceeds its maximum quote age, even when the market RPC is stalled.

Flattening is separate from stopping. It first stops scheduling and cancels Maker-tagged orders, then submits reduce-only market orders for positions in the selected markets. The UI requires a second confirmation and states the slippage ceiling.

Live mode requires both deployment gates:

```dotenv
LIVE_TRADING_ENABLED=true
ALLOW_MAINNET=true
```

## Performance boundary

"Net known result" means attributed realized trading PnL minus reported order fees and the deterministic builder-fee estimate. It is not a complete profitability figure. It currently excludes gas converted to USD, position-level funding attribution, markouts, hedging costs, and inventory carry.

Attribution starts when this release records posted order IDs. Older account activity and other clients' orders remain account-wide and are not claimed as Maker performance.

The default builder fee is **1 bp (0.01%) of filled notional**. That exceeds Aftermath's base 0.5 bp maker rebate before market-share rebates, spread capture, and adverse selection. The dashboard discloses and reports it separately.

Read [the operating model](docs/OPERATING_MODEL.md), [review guide](docs/REVIEW_GUIDE.md), and [security model](SECURITY.md) before using Live.

## Public access

Access membership is stored in the Sui Move package under [`move/maker_access`](move/maker_access). Each approved wallet gets isolated configuration, encrypted signer material, execution records, order attribution, and audit events.

The operator console can deploy the registry and add or remove wallets through signed Sui transactions. Sessions are HTTP-only, expire after 12 hours, and re-check membership on-chain every 30 seconds.

## Operations

```bash
docker compose ps
docker compose logs -f control
docker compose logs -f web
./scripts/backup.sh
docker compose down
```

`docker compose down` preserves the named volume. Never use `down -v` without a verified backup of the database and master key.

## Development

```bash
npm install
npm run check
sudo docker run --rm \
  -v "$PWD/move/maker_access:/workspace" \
  -w /workspace mysten/sui-tools:mainnet sui move test
```

The application uses the official Aftermath TypeScript SDK and is MIT licensed.
