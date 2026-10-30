# Maker

A wallet-gated control plane for running bounded, non-custodial market-making strategies on Aftermath perpetuals.

Maker is built for inspectability: users can see account readiness, collateral, gas runway, effective policy per market, quote freshness, fills, known costs, and the exact transaction behind each live action. It does not present volume as profit.

The current strategy is inventory-aware quoting with an optional fill-driven hedge on a second Aftermath account. The paired-account mode reduces bot-attributed directional exposure; it is not a cross-venue hedge and does not remove venue, basis, funding, liquidation, or execution risk.

Hosted service: [maker.permanentupperclass.com](https://maker.permanentupperclass.com)

## External review

The repository is public for independent review. Start with the [external audit guide](docs/REVIEW_GUIDE.md), then inspect the [October 27 remediation ledger](audits/2026-10-27-external/REMEDIATION.md), [security model](SECURITY.md), [mainnet evidence](audits/2026-10-27-mainnet/EVIDENCE.md), and [latest live-testing iteration](audits/2026-10-27-mainnet/ITERATION-5.md). The immutable audited baseline is the `external-audit-v1` tag.

The remediation branch currently has 138 passing TypeScript application tests, three passing Move tests, successful production builds, zero vulnerabilities reported by `npm audit --omit=dev`, and authenticated browser checks at desktop and mobile widths. The mainnet evidence includes failed-closed defects found during testing as well as corrected runs. An independent source audit was completed against `external-audit-v1`; remediation still requires an independent retest before capital increases.

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
- Runtime, last successful cycle, quote freshness, transaction links, measured gas, avoided paid actions, reserve-aware runway time, and projected stable-market SUI use
- A fill ledger limited to order IDs that Maker recorded when posting
- Current-epoch maker rewards, Q-score share, qualifying uptime, volume share, and direct rebates from Aftermath
- A live reward-efficiency ranking across every open market, with one-click staging of a reviewable Observe-mode rotation
- Separate Maker and hedge attribution, protocol fees, estimated builder fees, and combined result after those known costs
- Separate **Stop quoting** and **Flatten at market** actions

In the Strategy wizard, **Save and next** writes only a wallet- and strategy-scoped draft in this browser. It does not reconfigure a running bundle. **Apply strategy** validates and submits the full versioned strategy once; the resulting changes reconfigure every attached bundle and take effect on its next cycle. Drafts do not sync across browsers or devices. The review step lists affected bundles and changed settings.

## Execution and safety

Maker supports an operator-selected universe of up to 64 markets and visits them round-robin. **Portfolio** mode leaves each market's Maker-tagged pair resting until its next atomic cancel-and-place refresh. **One live pair** mode is intended for small accounts: it carries one resting pair, polls price and risk cheaply, and pays for a transaction only when price movement crosses the configured threshold, the resting-age limit expires, or the dwell timer switches markets. It reconciles attributed fills before switching and atomically cancels the prior market while placing the next pair. A switch is blocked if prior order state is not visible. Manual orders are outside both cancellation sets.

When paired-account hedging is enabled, Maker reacts only to independently filled order IDs that it previously recorded. It aggregates small fills to the configured threshold, cancels its quotes, waits through a bounded account-index consistency window until both accounts report no resting orders, then submits one capped opposite market order from the hedge account. It reloads both accounts and marks fills processed only after actual combined delta reaches the completion tolerance. Partial progress suppresses new quotes and retries; no progress fails closed. It never creates a paired self-match loop or raises the user-approved slippage cap automatically.

Optional **Auto-rebalance** bounds the gross positions that same-venue hedging leaves on the two dedicated accounts. Before the configured threshold, Maker cancels every tracked quote, submits reduce-only market orders on both accounts, and requires three consecutive flat reads before quoting again. Because account indexing can expose positions in stages, it makes up to three bounded reduce-only sweeps and records each retry. This control spends spread, slippage, and gas; it limits accumulated exposure but does not make the strategy profitable.

Live mode fails closed on setup, signer, mainnet, freshness, book/index divergence, quote size, worst post-fill inventory and aggregate gross exposure, two-sided collateral, agent gas, unrealized loss, combined-account run equity drawdown, per-account margin/liquidation distance, returned transaction intent, simulation effects, and gas limits. Portfolio exposure includes every resting pair's worst side plus every position on both dedicated accounts, including deselected markets. Position inventory is marked as signed base size times a timestamped current index. An independent watchdog cancels Maker orders when an actively quoted market stops being observed, even when its market RPC is stalled. Portfolio mode watches every selected market because every pair remains live.

Flattening is separate from stopping. It first stops scheduling and confirms Maker-tagged order cancellation, then submits reduce-only market orders for every open position on each configured account, including deselected markets. If one multi-market transaction hits the venue slippage abort, Maker retries each market independently and reports any residual position. The UI requires a second confirmation and states the slippage ceiling.

The **3-cycle canary** runs Farming, Profit, and Both on one currently eligible saved market for two seconds each. Paper signs nothing. Live requires an exact second confirmation, never raises saved quote or exposure limits, cancels before each policy change, stops after the third round, and flattens both configured accounts before restoring the saved strategy. Three rounds validate mechanics; they do not establish profitability.

A two-second paid cadence could sign up to 43,200 quote transactions per day, so it is reserved for bounded canaries. For unattended one-live-pair operation, poll quickly for risk while using a longer dwell, a material-movement threshold, and a forced-refresh ceiling. The desk derives runway and stable-market SUI per 24 hours from measured quote gas and the likely paid-action interval, and reports how many transactions were avoided. Price movement can make actual cost higher. When the configured worst-case transaction reserve is reached, Live fails closed and attempts all-market cancellation.

Live mode requires both deployment gates:

```dotenv
LIVE_TRADING_ENABLED=true
ALLOW_MAINNET=true
```

## Two-week capital validation

Capital does not scale automatically. A practical validation ladder for moving from **$1,000 to $20,000** is:

| Phase | Earliest window | Maximum dedicated capital |
| ----- | --------------- | ------------------------- |
| A     | Days 1-3        | $1,000                    |
| B     | Days 4-6        | $2,500                    |
| C     | Days 7-9        | $5,000                    |
| D     | Days 10-11      | $10,000                   |
| E     | Days 12-14      | $20,000                   |

Start with an approximately equal collateral split between the dedicated Maker and hedge accounts. For each phase, begin around 0.25%-0.50% of total strategy equity per quoted side, a 10% gross-exposure cap, a 7.5% auto-rebalance line, a 1% run-drawdown stop, and 1x leverage. The dashboard shows the saved dollar limits as percentages of current Maker-account equity so stale limits are visible after deposits, withdrawals, or losses.

Do not advance merely because the date arrived. Require at least 25 independently attributed fills, a clean stop-and-flatten drill, zero unresolved order or position mismatches, complete hedge coverage, reconciled gas and fee records, and drawdown inside the saved limit at the current phase. Restart a phase after any unexplained position, watchdog trip, RPC ambiguity, or manual recovery. Maker does not yet include USD-converted gas, complete funding attribution, markouts, or inventory carry in net PnL, so promotion also requires external account reconciliation.

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

The public access form stores one pending request per wallet in SQLite, including the submitted X handle. It is honeypot-protected and limited to three submissions per client IP per hour. Repeated submissions update the handle without generating repeated notifications. [`deploy/aftermath-maker-access-mail.timer`](deploy/aftermath-maker-access-mail.timer) can poll for unnotified requests once a minute through the host's `sendmail`; verify that the host has a working authenticated outbound relay before enabling it.

## Operations

```bash
docker compose ps
docker compose logs -f control
docker compose logs -f web
./scripts/backup.sh
docker compose down
```

`./scripts/backup.sh` uses SQLite's online backup API and verifies the snapshot without stopping any runtime. It writes a mode-`0600` archive containing `maker.db`. Keep the independent `.env`/master-key copy offline; the database alone cannot recover agent signers. Test a restore by extracting into a fresh directory, running `PRAGMA quick_check`, and starting with both Live gates disabled. `docker compose down` preserves the named volume. Never use `down -v` without a verified database and master-key backup.

Master-key rotation is an offline control-plane operation:

```bash
# 1. Disable both Live gates, stop the control service, and take a backup.
docker compose stop control
# 2. Supply old/new keys without writing them to shell history.
sudo -n docker compose run --rm \
  -e OLD_MAKER_MASTER_KEY -e NEW_MAKER_MASTER_KEY \
  control node apps/control/dist/rotate-master-key.js
# 3. Replace MAKER_MASTER_KEY in .env, clear the temporary variables, and restart.
docker compose up -d control web
```

The command verifies every decrypted address and rotates all ciphertext plus bound context in one database transaction. If any signer fails, no row is changed. Runtime retention is per tenant: 10,000 audit events, 50,000 quote executions, 2,000 tracked Maker orders, 10,000 hedge executions, and 20,000 processed hedge fills.

## Development

```bash
npm install
npm run check
sudo docker run --rm \
  -v "$PWD/move/maker_access:/workspace" \
  -w /workspace mysten/sui-tools:mainnet sui move test
```

The application uses the official Aftermath TypeScript SDK and is MIT licensed.
