# Maker

A wallet-gated control plane for running bounded, non-custodial market-making strategies on Aftermath perpetuals.

Maker is built for inspectability: users can see account readiness, collateral, gas runway, effective policy per market, quote freshness, fills, known costs, and the exact transaction behind each live action. It does not present volume as profit.

The current strategy is inventory-aware quoting with an optional fill-driven hedge on a second Aftermath account. The paired-account mode reduces bot-attributed directional exposure; it is not a cross-venue hedge and does not remove venue, basis, funding, liquidation, or execution risk.

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
2. Select or create an Aftermath USDC account.
3. Create one encrypted trading agent and authorize it on each account you want Maker to use.
4. Assign a Maker account and, optionally, a different hedge account.
5. Check collateral and gas readiness, select markets, then set portfolio limits.
6. Run Observe, then Paper, then deliberately small Live limits.

The agent can trade but cannot withdraw collateral or grant another agent. Creating an account does not deposit collateral.

## What the desk shows

- Every owner account, its collateral and positions, agent authorization, and assigned Maker or hedge role
- Equity, available and allocated collateral, owner-withdrawable collateral, agent gas, and authority state
- One-sided OI in base units and estimated USD, protocol capacity, volume, funding, inventory, and unrealized PnL
- Global defaults plus per-market spread, size, inventory target, inventory cap, skew, and leverage overrides
- Runtime, last successful cycle, quote freshness, transaction links, measured gas, and estimated gas runway
- A fill ledger limited to order IDs that Maker recorded when posting
- Current-epoch maker rewards, Q-score share, qualifying uptime, volume share, and direct rebates from Aftermath
- A live reward-efficiency ranking across every open market, with one-click staging of a reviewable Observe-mode rotation
- Separate Maker and hedge attribution, protocol fees, estimated builder fees, and combined result after those known costs
- Separate **Stop quoting** and **Flatten at market** actions

Strategy changes reconfigure the running engine and apply on its next cycle.

## Execution and safety

Maker visits selected markets round-robin. Each live visit atomically cancels and replaces two stable, Maker-tagged, post-only orders. Manual orders are outside that cancellation set.

When paired-account hedging is enabled, Maker reacts only to independently filled order IDs that it previously recorded. It aggregates small fills to the configured threshold, cancels its quotes, requires both accounts to have no resting orders, then submits one capped opposite market order from the hedge account. It never creates a paired self-match loop.

Live mode fails closed on setup, signer, mainnet, freshness, spread, quote size, inventory, gross exposure, loss, transaction simulation, and gas limits. An independent watchdog cancels Maker orders if any selected market exceeds its maximum quote age, even when the market RPC is stalled.

Flattening is separate from stopping. It first stops scheduling and cancels Maker-tagged orders, then submits reduce-only market orders for positions in the selected markets. The UI requires a second confirmation and states the slippage ceiling.

Live mode requires both deployment gates:

```dotenv
LIVE_TRADING_ENABLED=true
ALLOW_MAINNET=true
```

## Reward efficiency

The reward desk keeps protocol facts separate from strategy estimates. Account totals come from Aftermath's current-epoch rewards endpoint. Market rankings are Maker's heuristic: organic 24-hour flow per dollar of balanced depth within 50 bps, adjusted for competition, spread, volatility, funding, open-interest capacity, and book balance.

Closed-session markets and markets without meaningful two-sided depth, OI, or organic volume are ineligible. **Stage rotation** selects the requested number of top markets, applies bounded per-market policies, and forces Observe mode. It never saves, starts, or enables Live trading.

Aftermath trading incentives require a manual claim. The desk links to the official Rewards page rather than constructing or automatically signing a value-moving claim transaction.

The ranking is not Aftermath's private per-market rewards formula and does not estimate guaranteed profit. Its purpose is to direct scarce collateral toward measurable, independently generated flow while avoiding volume churn and self-trading.

## Performance boundary

"Net known result" means attributed realized trading PnL minus reported order fees and the deterministic builder-fee estimate. Hedge fills are reconciled from confirmed hedge transaction digests and reported separately. It is not a complete profitability figure: it still excludes gas converted to USD, position-level funding attribution, markouts, explicit slippage decomposition, and inventory carry.

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
