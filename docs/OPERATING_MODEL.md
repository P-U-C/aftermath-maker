# Operating model

Maker is an execution and measurement system, not a promise that one spread setting is profitable. Professional market making is a loop: estimate fair value, quote, manage inventory, measure fills and adverse selection, then update the policy.

## What is implemented

### Account readiness

The account desk discovers every Aftermath USDC account held by the signed-in wallet. It shows equity, available collateral, positions, agent authorization, and the assigned Maker or hedge role. It can create an account, deposit or withdraw USDC, and revoke the agent plus Maker fee approval. One locally encrypted agent signer can hold a separate trading capability for each authorized account; every account, collateral, capability, and revocation transaction remains owner-signed and is simulated before signing.

Collateral changes are blocked while an engine is running. Revocation first stops the engine, checks every listed market for remaining Maker-tagged orders, and refuses to proceed until they are clear.

### Portfolio policy

A profile supplies conservative global defaults. Every selected market can override:

- quote size;
- spread;
- inventory target;
- inventory cap;
- inventory skew; and
- leverage.

The engine resolves the effective policy for the current market before quote calculation, risk checks, and transaction construction. Saving while running stops, cancels tagged orders, and restarts with the new configuration.

A strategy can select up to 15 markets in two rotation modes:

- **Portfolio:** each market keeps its pair until the next lap. Capital and stale-quote limits must cover every selected market.
- **One live pair:** one pair rests at a time. Before switching, Maker checks the prior market for attributed fills. A clean switch combines prior-market cancellation and next-market placement in one Sui transaction. Missing or delayed prior-order state blocks the switch and triggers fail-closed cancellation.

Both modes wrap continuously from the final selected market to the first until stopped or a safety gate trips. One-live-pair rotation uses less simultaneous collateral, but each market receives only its share of active quote time; 15 selected markets imply roughly one-fifteenth uptime per market.

One-live-pair mode reduces simultaneous collateral demand; it does not create 15-market uptime from one market's capital. At a two-second cadence it can submit up to 43,200 quote transactions per day, so two seconds is reserved for bounded testing rather than the recommended unattended cadence.

### Quote lifecycle

Maker uses Aftermath's protocol index as fair value and the live best bid and ask as execution constraints. It refuses to quote when book midpoint diverges from the index beyond policy, creates a post-only bid and ask around the index, rounds against the venue tick while reserving one tick behind the opposite side, skews both around the configured inventory target, and uses Aftermath's atomic cancel-and-place transaction to replace its prior quote pair.

Every quote receives fresh client order IDs in Maker's reserved namespace. Portfolio cancellation recognizes that namespace and uses the exact IDs recorded from confirmed transactions and live account state. It does not cancel manual orders or orders created by another client.

### Paired-account delta hedge

A wallet can assign one authorized Aftermath account to quoting and a different authorized account to hedging. The hedge path is fill-driven:

1. accept only fills whose order IDs were recorded by Maker;
2. aggregate their signed notional until it crosses the configured hedge threshold;
3. cancel Maker-tagged quotes on that market;
4. poll both accounts through a bounded index-consistency window and require no resting orders, including manual orders;
5. cap the hedge to the smaller of combined account delta, attributed pending-fill delta, and the configured maximum;
6. submit an opposite market order from the hedge account; and
7. reload both accounts and mark the fills processed only when actual combined delta is inside the completion tolerance.

The trigger threshold controls when hedging begins; it is not the success threshold. A partial hedge suppresses new quotes and retries. No progress, material over-hedging, persistent orders, or an expired consistency window stops fail-closed.

This design cannot intentionally self-match: the hedge is triggered by a previously confirmed independent fill, and no hedge is submitted while either account reports a resting order. It also avoids absorbing unrelated manual exposure by capping each action to newly attributed fill delta.

For example, $1,000 of attributed Maker bids creates positive perp delta. Once the threshold is crossed, the second account sells up to that attributable delta into the public Aftermath book. This reduces wallet-level direction, but both legs remain on Aftermath. It is not a cross-venue or spot hedge and still carries venue, basis, funding, liquidation, slippage, and execution risk. Thin books may require a wider slippage ceiling; Maker reports the failure and never raises the user-approved cap automatically.

### Independent freshness protection

The rotation interval grows with the number of selected markets. Configuration is rejected unless the stale-quote cutoff can cover one complete rotation plus a buffer.

Live mode also runs an independent watchdog. If any selected market exceeds the cutoff, the watchdog invalidates the current cycle, stops scheduling, and immediately cancels Maker-tagged orders with retries. It does not wait for a stalled market RPC. Manual stop uses a bounded wait instead of hanging behind the RPC, and both paths reconcile again after an ambiguous cycle resolves.

Gas runway excludes the configured worst-case transaction reserve. The desk projects both runway time and SUI use per 24 hours from measured quote transactions and the selected cadence. Reaching the reserve fails the next pre-signing safety gate and invokes fail-closed cancellation.

### Three-cycle canary

The canary compares Farming/Active, Profit/Cautious, and Both/Balanced on one saved market that currently passes all three objective gates. It uses the live ranking inputs but caps quote size, inventory, gross exposure, and leverage at the saved policy. Each round lasts two seconds.

Paper records three simulated rounds. Live requires both deployment gates and an exact confirmation, cancels before each policy change, and performs reduce-only recovery on the Maker and hedge accounts after the final round. The original configuration is restored only after recovery succeeds. A failed recovery leaves the final Live configuration saved and stopped so the operator can retry without hiding the active risk state.

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

Maker's default builder fee is 1 bp of filled notional and applies to fills carrying its code. The market scorer reads the current maker fee exposed for each Aftermath market instead of assuming a fixed rebate. Its **pre-risk edge** is half the observed book spread less that maker fee and Maker's builder fee.

Pre-risk edge is a comparison input, not a profit forecast. It excludes adverse selection, fill probability, gas converted to USD, funding attribution, markouts, hedge slippage, and inventory carry. The builder fee is displayed before authorization, approved on-chain at an exact maximum, checked before every quote transaction, and reported separately in the fill ledger. Platform revenue must not be combined with trader strategy PnL.

## What professional operations suggest

There is no single Wintermute setting to copy. The transferable operating ideas are:

1. **Use stronger fair value.** Combine index, local book, and eventually independent venue inputs instead of trusting one midpoint.
2. **Keep inventory duration short.** Skew or pull quotes as exposure grows; hedge only when fees, funding, basis, and slippage justify it.
3. **Adapt to regime changes.** Widen spread, reduce size, or pause when volatility or source divergence rises.
4. **Measure realized outcomes.** Compare spread capture, markouts, funding, incentives, builder fees, protocol fees, gas, hedge cost, and capital at risk.
5. **Prefer reliability over nominal activity.** Stale-order controls, atomic replacement, reconciliation, and collateral visibility matter more than gross volume.

Maker now supplies the measurement and control foundation for those experiments. It anchors fair value to Aftermath's index and implements a guarded same-venue paired-account hedge, but does not yet provide independent external fair-value feeds or automated cross-venue hedging.

## Strategy families to test

These are hypotheses to compare in Observe, Paper, and small Live runs:

- **Inventory-aware quoting:** the current baseline, with market-specific targets and limits.
- **Volatility-adaptive quoting:** widen, reduce size, or pause when realized volatility and source divergence cross thresholds.
- **Paired-account hedging:** the implemented same-venue baseline for reducing bot-attributed delta while measuring taker fees and residual exposure.
- **Cross-venue hedged market making:** quote on Aftermath and hedge externally when expected spread exceeds hedge, funding, fee, gas, and basis costs.
- **Funding and basis:** pair spot and perps, or two perp venues, while measuring funding reversal, margin, liquidation, and basis risk.
- **Farming:** rank reported flow and turnover per dollar of balanced near-book depth, with competition, uptime proxies, funding, capacity, and book balance as controls. This mode deliberately allows a high-turnover market to win when its measured capital efficiency is stronger.
- **Profit:** rank half-spread after known maker and builder fees, then favor stable markets with stronger two-sided exit depth and lower funding risk.
- **Both:** require positive pre-risk edge and rank the harmonic mean of Farming and Profit scores. This prevents a very high farming score from fully masking weak fill economics.
- **Thin-book liquidity:** optionally restrict any objective to otherwise-eligible books with $100-$1,000 of balanced depth within 50 bps. Thinness alone never qualifies a market.

All objectives retain the same structural gates: at least $10,000 reported 24-hour volume, $100 balanced depth within 50 bps, positive OI, an open session, and a valid two-sided book. Suggested quote size cannot exceed 5% of measured depth before the objective-specific size reduction and account-aware collateral cap. Farming stages tighter, larger quotes; Profit stages wider, smaller quotes; Both sits between them. Every staged rotation remains in Observe mode.

These rankings are transparent allocation heuristics, not Aftermath reward or profit formulas. Exact current-epoch account Q-score, qualifying uptime, maker volume share, rewards, and rebates come directly from Aftermath. Gross turnover can be economically optimal when marginal rewards, rebates, and spread exceed all costs. Maker does not generate self-matched volume: its second account hedges only after an independently attributed fill and only after both accounts have no resting orders. Because no explicit published eligibility rule was found for self-trading, it is treated as an unresolved policy risk rather than assumed eligible activity.

## Objective tests and blind spots

Each mode has a falsifiable pass condition:

1. **Farming:** realized reward value and rebates per collateral-day increase after every trading, builder, gas, funding, hedge, and inventory cost.
2. **Profit:** complete trading PnL is positive after the same costs, with positive fixed-horizon markouts.
3. **Both:** both tests pass in the same run; rewards cannot convert a negative trading operation into “profitable farming” unless the final combined net result is positive.

The current dashboard cannot complete those tests yet. It still lacks reward valuation against the final pool denominator, fixed-horizon markouts, gas converted to USD, position-level funding, realized spread, hedge slippage decomposition, and inventory carry. Current-epoch Q-score is account-level rather than a guaranteed marginal reward for the next selected market. The public reward formula and eligibility rules may also change.

The next implementation sequence is:

1. Calculate post-fill markouts at fixed horizons.
2. Attribute actual funding and gas in USD to each position and run.
3. Add realized spread, hedge slippage, and inventory-carry decomposition.
4. Record collateral-time and compare staged rotations by net rewards per collateral-day.
5. Add reward-pool valuation and break-even cost per $1 million of turnover.
6. Add realized-volatility sizing around the implemented index-versus-book divergence gate.
7. Run objective/profile combinations long enough to compare net return on collateral at risk.
8. Add independent external fair-value inputs and a venue-diversified hedge.

## References

- [Aftermath account SDK](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals/account)
- [Aftermath account architecture](https://docs.aftermath.finance/perpetuals/architecture/account)
- [Aftermath market SDK](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals/market)
- [Aftermath perpetual fees](https://docs.aftermath.finance/perpetuals/architecture/fees)
- [Aftermath builder codes](https://docs.aftermath.finance/perpetuals/architecture/builder-codes-front-end-fee)
- [Optiver: market making](https://www.optiver.com/insights/explainers/market-making/)
- [Hummingbot market-making paper](https://hummingbot.org/hummingbot.pdf)
