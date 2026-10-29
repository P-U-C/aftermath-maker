# Research: Aftermath stats as strategy-selection inputs

- **Date:** 2026-10-29
- **Decision:** Data is available, but it is **not approved to influence quoting**.

## Finding

Yes. The public [Stats page](https://www.aftermath.finance/stats) exposes a per-market
table with mark/index, 24-hour change, 8-hour funding, next funding, 24-hour volume,
open interest, and maximum leverage. It also exposes UTC-daily protocol/market views for
volume, open interest, liquidations, taker trades, and collateral deposits/withdrawals.

The installed `aftermath-ts-sdk` exposes the same family of data through the existing
Perpetuals client:

- `getMarkets24hrStats({ marketIds })` for volume and price change;
- market state for funding, open interest, and next funding;
- `getMarketsDailyStats(...)` for daily volume, taker-trade count, liquidations, open
  interest, and funding;
- `getCollateralFlows(...)` and `getMarketFundingHistory(...)` for supporting history.

The current gateway already calls `getMarkets24hrStats`, so this is an extension of the
existing read-only market-data path, not a new signing or execution integration.

Sources: [Stats](https://www.aftermath.finance/stats), [Perpetuals SDK
overview](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals),
and [market reference](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals/market).

## Safe first use: selection intelligence only

1. Add transparent category filters to the strategy quick-pick UI: crypto, equities,
   indices, commodities, and FX.
2. Let the user sort or rank candidate rows by 24-hour volume, taker-trade count, or open
   interest, with an `as of` timestamp and unavailable/stale state.
3. Show non-blocking review badges for an approaching funding time or an unusual
   liquidation spike. The badge says what was observed; it does not pause, remove, size,
   reprioritize, or quote a market.
4. Keep the selected/resolved strategy market set explicit. A refreshed ranking never
   changes a saved strategy or a running bundle.

## Guardrails

- No statistic may alter selection, price, spread, size, timing, hedging, limits, or
  order construction without a separate approved decision RFC.
- Treat the source as optional UI data: cache it, show its timestamp, and omit the
  enhancement on an error rather than changing runtime behavior.
- First validate the SDK response shapes/cadence in a read-only fixture before rendering
  them. Do not scrape the Stats page or call it from a runtime loop.
