# Aftermath Epoch 4/5 sanitized source exports

Fixture data for Maker Phase A accounting replay. Run `python3 verify.py` in this directory.

- UTC windows: Epoch 4 `[2026-10-12 05:00, 2026-10-26 05:00)`; Epoch 5 `[2026-10-26 05:00, 2026-11-09 05:00)`.
- `epoch_*/filled_orders.json` and `collateral_events.json` contain the complete retained history for sample accounts #613/#1706 in the window. They retain execution amounts, fees, P&L, timestamps and cross-account event joins.
- `epoch_5/hourly_market_candles.json` contains 65 listed markets over the exact epoch and matched `volume` once per trade. No Epoch 4 hourly candle archive or historical order book was retained.
- `reward_observations.json` retains **one parent-wallet CSV row** and user-provided rounded UI observations. Epoch 5 claimable is a 6-decimal USDC balance observation, not an epoch-labeled payment event. Treat any payout/export difference as unresolved.
- Sui transaction digests, order IDs, market object IDs, package IDs and the parent wallet address were replaced with stable fixture aliases. Account numeric IDs are retained because they are public and referenced by the implementation tests. `eventType` contains a Move event name only. Do not use aliases to query live endpoints.

`expected_metrics.json` contains reconciliation targets from the audit. Epoch 4's $914.02 older SUI position is part of the $1,133.63 full cost; the remaining paired-period cost is $219.61. It is a documented audit split, not a reward allocation. The verification script recomputes full-epoch realized cost from fill and collateral events and validates Epoch 5 matching and candle share. No test should infer reward eligibility, historical quotes, paid gas, or an exact strategy ROI from these fixtures.

Data origin: official Aftermath public account filled-order and collateral histories, market metadata and hourly candles; official per-address reward CSV; `/api/rewards/claimable` for the sampled Epoch 5 wallet; user Rewards screenshots. API fields can change, so normalize from the current OpenAPI schema in production.
