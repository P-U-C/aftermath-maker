# Mainnet iteration 2: replacement, fill, and recovery

Audit date: 2026-10-27

Network: Sui mainnet

Market: MON perpetual

Accounts: Maker 1745, hedge 1746

> Historical checkpoint: the hedge and two-account flatten evidence gaps recorded below were closed later the same day in [ITERATION-3.md](ITERATION-3.md).

This iteration tested the Farming, Profit, and Both objective controls in Observe and Paper, then exercised repeated Live requotes with a maximum of about $1.05 of Maker inventory. No self-trading was used.

## Pre-Live coverage

- Farming, Profit, and Both each staged successfully in Observe and Paper.
- The production form passed native validity checks after staging.
- Authenticated desktop and 390 px layouts had no page-level horizontal overflow or browser errors.
- The Settings control exposed the advanced strategy controls at both widths.
- Venue minimums, lot-size rounding, spread, and skew now produce a cent-precision minimum quote and inventory-capacity floor.
- The final staged Both policy selected MON at $1.04 per side, 22 bp spread, and $1.05 maximum Maker inventory.

## Atomic replacement proof

The original implementation reused two fixed client order IDs. After the first successful post, Aftermath's transaction builder returned HTTP 409 before it considered the cancellation inputs. The production fix uses:

- a timestamp-derived client ID pair inside a recognizable Maker namespace;
- exact on-chain order IDs from the local ledger and current account snapshot;
- the current active client IDs when available;
- prefix-based ownership checks for replacement, stop, watchdog, and recovery.

Three consecutive transactions first proved the fixed sequence:

1. [Initial quote](https://suiscan.xyz/mainnet/tx/2eRwMvYNTpasK5QszX3PEDuv22giLqCyeAN71U21GAjh)
2. [First atomic cancel and replace](https://suiscan.xyz/mainnet/tx/NF8Um4pmCpXKDrNE4hFS8d6iJ9DkYwuNbHvfcFvDjq4)
3. [Second atomic cancel and replace](https://suiscan.xyz/mainnet/tx/6Xy9sUNfYDWT5gRXqTb6YUgYv17xvEmVb13aat4KHPb4)

Each replacement emitted two `CanceledOrder` events for the prior pair and two `PostedOrder` events with a fresh client-ID pair. The final pair was cancelled in [FtJPNq...](https://suiscan.xyz/mainnet/tx/FtJPNqxtqitsRxLUzsreLYcufDZVTcM2ss47GESFc8uf).

A later 10-minute bounded run confirmed 41 more consecutive quote transactions without a 409, stale order, fill, or runtime error. Its last pair was cancelled in [Ag91ka...](https://suiscan.xyz/mainnet/tx/Ag91kaEac4VH2sRiqS1fHa8rzjLfr9uvP2fYEqAMcMVc).

## Organic fill

An independent account filled one Maker ask:

- Fill transaction: [HETLEy...](https://suiscan.xyz/mainnet/tx/HETLEyv5HkfH819CNLuCX11Soe1XTHHaYL6wW7xEWPVd)
- Maker account: 1745
- External taker account: 402
- Side: ask
- Size: 48.1 MON
- Price: $0.021433
- Notional: $1.0309273
- Integrator: 15
- Builder fee: $0.00010309273
- Base maker rebate: $0.000051546365
- Net known fill cost before gas, markout, and carry: $0.000051546365

The order ID matched Maker's recorded order ledger, so attribution coverage reached 100% of reported Maker volume.

## Finding exposed by the fill

The next cycle evaluated quote-entry inventory and spread safety before fill reconciliation. It halted with `Safety gate failed: spread, inventory` and therefore never reached the hedge path. This was a real ordering defect: a condition requiring risk reduction could block the risk-reduction action.

The deployed fix now enforces this order:

1. Operator Live gates and signer readiness.
2. Attributed-fill reconciliation.
3. Cancel Maker quotes.
4. Execute the configured hedge if combined delta exceeds the threshold.
5. Evaluate whether another quote may be posted.

A regression proves that an attributed fill is hedged before quote-entry safety halts the engine. A successful hedge is no longer mislabeled as a hedge failure when quoting stops afterward.

No second organic fill occurred during the post-fix 10-minute window, so the new ordering has not yet produced an on-chain hedge transaction.

## Flatten recovery

The fill also exposed that the original manual flatten action targeted only the Maker account. The product now flattens the Maker and configured hedge accounts sequentially using reduce-only market orders and returns one receipt per account.

Because the first fill happened before the hedge-ordering fix, only account 1745 held exposure. It was closed through the product in [8gjkdG...](https://suiscan.xyz/mainnet/tx/8gjkdGLMkJWK25aiaSEXfA3dW4CfMvxX4G6WTKhx2kTK). The transaction closed 48.1 MON and paid a $0.00046441512 taker fee.

A two-account regression verifies that portfolio flatten visits both account roles. The two-account branch still lacks a mainnet trace because account 1746 never acquired a position.

## Final state

- Engine: stopped
- Saved mode: Paper
- Live gates: disabled
- Confirmed Live quote transactions: 65 total
- Attributed Maker fills: 1
- Recorded hedge executions: 0
- Account 1745 exposure: $0; pending orders: 0
- Account 1746 exposure: $0; pending orders: 0
- Account 1745 equity: about $7.4961
- Account 1746 equity: about $7.4978
- Owner wallet: 5 USDC and 0.758343458 SUI
- Agent wallet: 0 USDC and 0.184537027 SUI
- Automated tests: 73 passing
- Dependency audit: 0 vulnerabilities
- Post-audit state backup: `backups/aftermath-maker-20261027T061234Z.tar.gz`

## Remaining evidence boundary

Mainnet now proves repeated atomic replacement, exact order attribution, fee parsing, an external Maker fill, protective halt, stop cancellation, and reduce-only Maker flattening. It does not yet prove a fill-triggered hedge transaction, hedge slippage, or a two-account mainnet flatten. Withdrawal, builder-approval removal, and capability revocation are also intentionally deferred while the retained audit accounts remain authorized.
