# Operating model

Maker is an execution and measurement system, not a promise that one spread setting is profitable. Professional market making is a loop: estimate fair value, quote, manage inventory, measure fills and adverse selection, then update the policy.

## What is implemented

### Account readiness

The account desk discovers every Aftermath USDC account held by the signed-in wallet. It shows equity, available collateral, positions, agent authorization, and the assigned Maker or hedge role. One locally encrypted agent signer can hold a separate trading capability for each authorized account; account creation and each capability grant remain owner-signed transactions.

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

### Paired-account delta hedge

A wallet can assign one authorized Aftermath account to quoting and a different authorized account to hedging. The hedge path is fill-driven:

1. accept only fills whose order IDs were recorded by Maker;
2. aggregate their signed notional until it crosses the configured hedge threshold;
3. cancel Maker-tagged quotes on that market;
4. require both accounts to have no resting orders, including manual orders;
5. cap the hedge to the smaller of combined account delta, attributed pending-fill delta, and the configured maximum; and
6. submit an opposite market order from the hedge account and record its transaction digest.

This design cannot intentionally self-match: the hedge is triggered by a previously confirmed independent fill, and no hedge is submitted while either account has a resting order. It also avoids absorbing unrelated manual exposure by capping each action to newly attributed fill delta.

For example, $1,000 of attributed Maker bids creates positive perp delta. Once the threshold is crossed, the second account sells up to that attributable delta into the public Aftermath book. This reduces wallet-level direction, but both legs remain on Aftermath. It is not a cross-venue or spot hedge and still carries venue, basis, funding, liquidation, slippage, and execution risk.

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
- confirmed hedge executions and matched taker fills;
- realized trading PnL before fees;
- reported order fees;
- deterministic builder-fee estimates; and
- Maker, hedge, and combined results after those known costs.

Historical orders created before order tracking, manual orders, and other clients' orders are not claimed. Coverage reports attributed notional as a percentage of account-wide maker volume.

“Net known result” still excludes gas converted to USD, position-level funding attribution, markouts, explicit slippage decomposition, and inventory carry. Those are the next accounting fields required before calling a strategy profitable.

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

Maker now supplies the measurement and control foundation for those experiments. It implements a guarded same-venue paired-account hedge, but does not yet provide external fair-value feeds or automated cross-venue hedging.

## Strategy families to test

These are hypotheses to compare in Observe, Paper, and small Live runs:

- **Inventory-aware quoting:** the current baseline, with market-specific targets and limits.
- **Volatility-adaptive quoting:** widen, reduce size, or pause when realized volatility and source divergence cross thresholds.
- **Paired-account hedging:** the implemented same-venue baseline for reducing bot-attributed delta while measuring taker fees and residual exposure.
- **Cross-venue hedged market making:** quote on Aftermath and hedge externally when expected spread exceeds hedge, funding, fee, gas, and basis costs.
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
6. Add external fair-value inputs and a venue-diversified hedge after same-venue reconciliation is validated with mainnet traces.

## References

- [Aftermath account SDK](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals/account)
- [Aftermath account architecture](https://docs.aftermath.finance/perpetuals/architecture/account)
- [Aftermath market SDK](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals/market)
- [Aftermath perpetual fees](https://docs.aftermath.finance/perpetuals/architecture/fees)
- [Aftermath builder codes](https://docs.aftermath.finance/perpetuals/architecture/builder-codes-front-end-fee)
- [Optiver: market making](https://www.optiver.com/insights/explainers/market-making/)
- [Hummingbot market-making paper](https://hummingbot.org/hummingbot.pdf)
