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
3. Deposit collateral from the owner wallet.
4. Create one encrypted trading agent and authorize it on each account you want Maker to use.
5. Assign a Maker account and, optionally, a different hedge account.
6. Check collateral and gas readiness, select markets, then set portfolio limits.
7. Run Observe, then Paper, then deliberately small Live limits.
8. Stop, reconcile, withdraw, or revoke the agent and Maker fee approval from the account desk.

The agent can trade but cannot withdraw collateral or grant another agent. Owner-signed account, collateral, authorization, and revocation transactions are simulated before the wallet is asked to sign.

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

Live mode fails closed on setup, signer, mainnet, freshness, book/index divergence, quote size, worst post-fill inventory and gross exposure, two-sided collateral, agent gas, unrealized loss, run equity drawdown, transaction simulation, and gas limits. An independent watchdog cancels Maker orders if any selected market exceeds its maximum quote age, even when the market RPC is stalled.

Flattening is separate from stopping. It first stops scheduling and cancels Maker-tagged orders, then submits reduce-only market orders for positions in the selected markets. The UI requires a second confirmation and states the slippage ceiling.

Live mode requires both deployment gates:

```dotenv
LIVE_TRADING_ENABLED=true
ALLOW_MAINNET=true
```

## Strategy objectives

Risk profile and strategy objective are separate controls. Cautious, Balanced, and Active govern execution intensity. The objective determines how eligible markets are ranked and which bounded policy is staged:

- **Farming** favors reported turnover and reward signals per dollar of near-book capital. High turnover can rank first when the measured economics support it.
- **Profit** favors positive half-spread after the live market maker fee and Maker's builder fee, then discounts weak depth, large price movement, and funding risk.
- **Both** requires positive pre-risk fill edge and ranks the harmonic mean of Farming and Profit scores so one strong dimension cannot completely hide the other.

Closed sessions and markets with less than $10,000 of reported 24-hour volume, $100 of balanced depth within 50 bps, positive OI, or a valid two-sided book are ineligible. **Thin books** is an optional $100-$1,000 depth filter, not a separate strategy. Staging always forces Observe mode and never saves, starts, or enables Live trading.

Account reward totals come from Aftermath's current-epoch endpoint. Market scores remain transparent Maker heuristics: they do not know the future reward pool denominator, fill probability, adverse selection, or whether a particular activity will qualify. Self-matched volume is excluded from Maker's execution design and must not be treated as eligible without explicit protocol confirmation. Aftermath rewards are claimed manually through the official interface.

## Performance boundary

"Net known result" means attributed realized trading PnL minus reported order fees and the deterministic builder-fee estimate. Hedge fills are reconciled from confirmed hedge transaction digests and reported separately. It is not a complete profitability figure: it still excludes gas converted to USD, position-level funding attribution, markouts, explicit slippage decomposition, and inventory carry.

Attribution starts when this release records posted order IDs. Older account activity and other clients' orders remain account-wide and are not claimed as Maker performance.

The default builder fee is **1 bp (0.01%) of filled notional**. Maker reads each market's current maker fee from Aftermath and includes it in the displayed known fill cost and pre-risk edge. Fee schedules and incentives can change; the dashboard does not rely on a fixed rebate assumption. Builder revenue is disclosed and reported separately from trader performance.

Read [the operating model](docs/OPERATING_MODEL.md), [review guide](docs/REVIEW_GUIDE.md), [security model](SECURITY.md), [mainnet findings](audits/2026-10-27-mainnet/FINDINGS.md), and [transaction evidence](audits/2026-10-27-mainnet/EVIDENCE.md) before using Live.

## Public access

Access membership is stored in the Sui Move package under [`move/maker_access`](move/maker_access). Each approved wallet gets isolated configuration, encrypted signer material, execution records, order attribution, and audit events.

Only the bootstrap operator wallet that deployed the registry and owns its `AdminCap` can see or call membership management. It can add or remove wallets through signed Sui transactions. Member wallets receive HTTP 403 from operator endpoints. Sessions are HTTP-only, expire after 12 hours, and re-check membership on-chain every 30 seconds.

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
