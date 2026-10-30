# RFC 0002 amendment: Strategies own markets

- **Status:** Approved — implementation in progress
- **Date:** 2026-10-29
- **Amends:** [RFC 0002](0002-strategies.md)
- **Scope:** Move the canonical market set from bundles to strategies without changing Live order behavior.

## Decision

This reverses RFC 0002's market-allocation refinement. A strategy now owns its market
rule and its resolved market list; a bundle owns only name, accounts, mode, lifecycle,
and an optional strategy attachment. Bundle screens show strategy markets read-only, for
example: “From Rewards strategy: ETH, BTC.”

A quick pick is resolved and frozen when the strategy is saved or explicitly reapplied.
The rule metadata is retained for explanation, but fresh market data cannot silently
change a running strategy's markets.

## Constraint

Only one running bundle per owner may quote a market. Starting a bundle resolves its
strategy markets under the owner lock and rejects a collision with:

> `BTC is already quoted by Core. Duplicate the strategy and change its markets.`

Paused/stopped bundles may share a market. Saving a strategy that would make any of its
running users collide is rejected with the same named conflict; it never partly changes
attached bundles. Editing a shared strategy applies to all its bundles and the save
confirmation lists `Used by Core, Rewards`. Duplicate creates an independent strategy.

## Data and migration

Add owner-scoped `strategy_markets(strategy_id, market_id, position)` as the canonical,
ordered resolved set. Retain `bundle_markets` as a compatibility mirror during the
migration; remove its owner-market uniqueness constraint only after the runtime starts
reading `strategy_markets`.

Migration is transactional, idempotent, and preserves behaviour:

1. Create `strategy_markets` and compatibility indexes/mirrors.
2. For each bundle, materialize its current bundle-market set into its attached strategy.
3. If a shared strategy has bundles with different current market sets, fork it per
   distinct set before materializing, name the fork after its bundle (for example `Core
strategy`), and attach that bundle to the fork.
4. Rebuild each bundle's composed config and the Core `/api/config` projection from the
   attached strategy; retain the legacy/Core dual-write mirror and rollback backup.
5. Verify Core's composed config and existing quote/submitted-order bytes against the
   pre-migration fixture before marking the owner migrated.

Rollback switches the read path back to the retained bundle-market/compatibility mirror;
it drops no strategy data and remains lossless.

## API and UI

- `GET`/`POST`/`PATCH /api/strategies` return and update the rule plus resolved market
  list and `Used by` names. A shared-market change requires explicit confirmation.
- Bundle creation selects an optional strategy and accounts/mode, not a market picker. A
  bundle without one is paused and cannot start.
- Bundle edit changes attachment/accounts/mode only; markets are read-only from the
  strategy.
- `GET /api/bundles` includes the resolved strategy markets for display.
- `GET`/`POST /api/config` remain Core-compatible: Core reads/writes its attached
  strategy's resolved markets. If Core shares that strategy, the compatibility update
  forks Core first rather than unexpectedly changing another bundle.

## Tests and acceptance

- Migrate ordinary bundles and shared strategies with divergent market sets; prove the
  required forks preserve every bundle's market set and Core bytes.
- Rerun migration idempotently, exercise lossless rollback, and retain `/api/config`
  byte compatibility.
- Reject a running-market collision atomically with the named message; allow the same
  market for paused/stopped bundles and across different owners.
- Reject a shared-strategy edit that would collide, and prove Duplicate isolates later
  edits.
- Existing single-Core order-byte, submitted-order, runtime, risk, gas-reserve, queue,
  and Stop-all suites pass unchanged.

## Non-goals

No automatic quick-pick refresh, autonomous market selection, Live expansion, or
trading-decision change is authorized by this amendment.
