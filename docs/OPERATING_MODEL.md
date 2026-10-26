# Operating model

Maker is an operator console, not a promise that a fixed spread is profitable. The design borrows the parts of professional market making that can be applied honestly at this stage.

## Principles applied

### Quote two ways from a reference price

Market makers continuously publish a bid and ask around a reference price. Maker uses the live Aftermath order book as its initial reference, keeps both orders post-only, and atomically replaces its own tagged quote pair.

### Manage a portfolio, not isolated bots

Established firms trade many instruments but manage exposure centrally. Maker rotates through a selected market set while enforcing both a per-market inventory limit and a portfolio gross-exposure limit. The market board keeps OI, volume, funding, inventory, and PnL visible in one place.

### Let inventory change the quote

A fill creates inventory risk. Maker shifts both quote prices away from acquiring more of an oversized position. The skew is bounded by the configured per-market inventory limit.

### Pull quotes when controls fail

Market-maker protection systems remove quotes when execution or risk limits are breached. Maker stops on any live-cycle error and cancels only orders carrying its two client order IDs. Manual orders are never included in that cancellation set.

### Separate execution activity from performance

A submitted quote transaction is not a fill and must not be presented as revenue. The current evidence log records configuration, quote cycles, and confirmed transactions. Realized spread, fill ratio, adverse selection, fee revenue, and inventory carry require fill-level history and are intentionally not claimed yet.

## Current desk

- Wallet-signed creation or selection of an Aftermath USDC account
- Isolated encrypted agent signer per approved wallet
- Up to 12 selected markets in round-robin rotation
- Current one-sided OI, estimated OI USD, protocol-capacity utilization, 24h volume, and funding
- Account equity, per-market inventory/PnL, portfolio gross exposure/PnL
- Observe, Paper, and separately gated Live modes
- Inventory skew, global loss stop, stale-book checks, gas ceiling, and emergency quote cancellation
- On-chain access registry and disclosed builder fee

## Before material capital

The next operating layer should be driven by verified fills:

1. Reconcile maker fills and fees from Aftermath account history.
2. Attribute realized spread, markout, funding, fees, and inventory PnL separately.
3. Adapt spread and size to measured volatility, book depth, and adverse selection.
4. Allocate capital by expected return on risk rather than OI alone.
5. Add alerting, restart policy, and independent reconciliation against on-chain state.
6. Run long Paper sessions, then use deliberately small Live limits.

## Public references

- [Aftermath Perpetuals SDK](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals/perpetuals)
- [Aftermath account architecture](https://docs.aftermath.finance/perpetuals/architecture/account)
- [Optiver: Market making](https://www.optiver.com/insights/explainers/market-making/)
- [Optiver: Market-maker protections](https://optiver.com/wp-content/uploads/2023/07/Insights_market_maker_protections.pdf)
- [Jane Street overview](https://www.janestreet.com/what-we-do/overview/)
- [Hummingbot market-making paper](https://hummingbot.org/hummingbot.pdf)
- [Hummingbot kill switch](https://hummingbot.org/client/global-configs/kill-switch/)
