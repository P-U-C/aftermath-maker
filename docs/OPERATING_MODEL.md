# Operating model

Maker is an execution and measurement system, not a promise that one spread setting is profitable. Professional market making is a loop: estimate fair value, quote, manage inventory, measure fills and adverse selection, then update the policy.

## What is implemented

### Account readiness

The desk reads the selected Aftermath account and shows equity, available collateral, collateral allocated to positions, free margin, owner-withdrawable collateral, agent SUI, and agent authority. Account creation and agent authorization are separate owner-signed transactions.

Do not withdraw collateral while an engine is running. Stop quoting first, reconcile open orders and positions, then withdraw through the owner account.

### Portfolio policy

A profile supplies conservative global defaults. Every selected market can override:

- quote size;
- spread;
- inventory target;
- inventory cap;
- inventory skew; and
- leverage.

The engine resolves the effective policy for the current market before quote calculation, risk checks, and transaction construction. Saving while running stops, cancels tagged orders, and restarts with the new configuration.

### Quote lifecycle

Maker currently uses the live Aftermath best bid and ask as its reference. It creates a post-only bid and ask, skews both around the configured inventory target, and uses Aftermath's atomic cancel-and-place transaction to replace its prior quote pair.

Every market has stable Maker client order IDs. Portfolio cancellation looks up pending orders and selects only those IDs. It does not cancel manual orders or orders created by another client.

### Delta-neutral boundary

The current engine is inventory-aware but not delta-neutral. It can skew or pull Aftermath quotes as inventory moves away from target, but it does not place an offsetting order on another venue.

A delta-neutral extension would:

1. calculate the delta created by each attributed Aftermath fill;
2. aggregate small fills until the net delta crosses a configured hedge band;
3. place an opposite spot or perpetual order on an independent hedge venue;
4. verify the hedge fill and continue rebalancing toward the target; and
5. report spread capture and incentives separately from hedge fees, slippage, funding, basis, gas, and residual delta.

For example, a Maker bid filled for $1,000 of SUI perp creates positive SUI delta. A hedge engine would sell roughly $1,000 of SUI spot or short a SUI perp elsewhere. The position is only economically close to neutral after both legs are confirmed, and it still carries venue, basis, funding, liquidation, and execution risk.

### Independent freshness protection

The rotation interval grows with the number of selected markets. Configuration is rejected unless the stale-quote cutoff can cover one complete rotation plus a buffer.

Live mode also runs an independent watchdog. If any selected market exceeds the cutoff, the watchdog invalidates the current cycle, stops scheduling, and immediately cancels Maker-tagged orders. It does not wait for a stalled market RPC. If a transaction was already broadcast, it performs another cancellation after that cycle resolves.

### Stop and flatten

**Stop quoting** stops scheduling and cancels Maker-tagged open orders. It does not change an existing position.

**Flatten at market** is a separate, confirmed action. It stops the engine, cancels Maker orders, and submits reduce-only market orders for positions in selected markets. It does not attach a builder fee. The user sees the slippage ceiling before confirmation.

### Fill attribution

A confirmed quote transaction is activity, not performance. Maker records order IDs from each confirmed post transaction. Its 24-hour fill ledger includes only maker fills whose order IDs match that tenant's recorded IDs.

The desk separates:

- account-wide maker and taker volume;
- attributed Maker fill count and notional;
- realized trading PnL before fees;
- reported order fees;
- deterministic builder-fee estimate; and
- net result after those known costs.

Historical orders created before order tracking, manual orders, and other clients' orders are not claimed. Coverage reports attributed notional as a percentage of account-wide maker volume.

“Net known result” still excludes gas converted to USD, position-level funding attribution, markouts, hedge costs, and inventory carry. Those are the next accounting fields required before calling a strategy profitable.

## Fee economics

Maker's default builder fee is 1 bp of filled notional and applies to maker and taker fills carrying its code. Aftermath's documented base maker fee is a 0.5 bp rebate. Before any market-share rebate or spread capture, the builder fee therefore creates a 0.5 bp user cost.

The fee is displayed before authorization, approved on-chain at an exact maximum, checked before every quote transaction, and reported separately in the fill ledger. Platform revenue must not be combined with trader strategy PnL.

## What professional operations suggest

There is no single Wintermute setting to copy. The transferable operating ideas are:

1. **Use stronger fair value.** Combine index, local book, and eventually independent venue inputs instead of trusting one midpoint.
2. **Keep inventory duration short.** Skew or pull quotes as exposure grows; hedge only when fees, funding, basis, and slippage justify it.
3. **Adapt to regime changes.** Widen spread, reduce size, or pause when volatility or source divergence rises.
4. **Measure realized outcomes.** Compare spread capture, markouts, funding, incentives, builder fees, protocol fees, gas, hedge cost, and capital at risk.
5. **Prefer reliability over nominal activity.** Stale-order controls, atomic replacement, reconciliation, and collateral visibility matter more than gross volume.

Maker now supplies the measurement and control foundation for those experiments. It does not yet implement external fair-value feeds or automated cross-venue hedging.

## Strategy families to test

These are hypotheses to compare in Observe, Paper, and small Live runs:

- **Inventory-aware quoting:** the current baseline, with market-specific targets and limits.
- **Volatility-adaptive quoting:** widen, reduce size, or pause when realized volatility and source divergence cross thresholds.
- **Hedged market making:** quote on Aftermath and hedge externally when expected spread exceeds hedge, funding, fee, gas, and basis costs.
- **Funding and basis:** pair spot and perps, or two perp venues, while measuring funding reversal, margin, liquidation, and basis risk.
- **Incentive-aware liquidity:** allocate by verified net return per unit of collateral, not low OI or gross volume alone.

A market score should eventually use organic fills, depth, spread, volatility, funding, realized rewards, adverse selection, gas, and collateral usage. Low OI can mean less competition; it can also mean little flow and higher thin-book risk.

## Next measurement layer

The next implementation sequence is:

1. Calculate post-fill markouts at fixed horizons.
2. Attribute actual funding and gas in USD to each position and run.
3. Add realized spread and inventory-carry decomposition.
4. Add volatility and oracle-versus-book divergence signals.
5. Run profiles long enough to compare net return on collateral at risk.
6. Add external fair-value inputs and optional hedging only after reconciliation is reliable.

## References

- [Aftermath account SDK](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals/account)
- [Aftermath account architecture](https://docs.aftermath.finance/perpetuals/architecture/account)
- [Aftermath market SDK](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals/market)
- [Aftermath perpetual fees](https://docs.aftermath.finance/perpetuals/architecture/fees)
- [Aftermath builder codes](https://docs.aftermath.finance/perpetuals/architecture/builder-codes-front-end-fee)
- [Optiver: market making](https://www.optiver.com/insights/explainers/market-making/)
- [Hummingbot market-making paper](https://hummingbot.org/hummingbot.pdf)
