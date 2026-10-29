# RFC 0002: Reusable Maker strategies

- **Status:** Approved — owner approval recorded 2026-10-29; implementation in progress
- **Date:** 2026-10-29
- **Scope:** Reusable strategy model, migration, API, runtime projection, and UI.

## Summary

Strategies become owner-scoped, named objects that can be reused by multiple
bundles. A strategy contains objective, risk profile, global sizing and limits,
hedging policy, advanced quote controls, and a **market rule**. It never contains
accounts or a running mode.

A bundle remains the execution boundary: it has a name, Maker and optional Taker
accounts, mode, actual market assignments, optional strategy attachment, and
lifecycle state. A bundle without a strategy is paused and cannot start.

Core compatibility remains explicit: `GET /api/config` is a projection of Core,
and `POST /api/config` remains a Core-compatible update.

## Necessary refinement

The proposed model works with one refinement:

> A strategy's market rule is a default or recommendation; a bundle owns its
> actual markets and market-specific overrides.

If actual markets lived in a shared strategy, an edit to Core's strategy could
silently add or remove markets in Rewards and violate the owner-wide
unique-market constraint. Therefore:

- a strategy stores either a quick-pick rule or ordered preferred-market list;
- a new bundle uses the rule to prefill **only free** markets;
- bundle market membership and per-market overrides remain bundle-owned;
- editing a strategy updates shared settings, never silently changes attached
  bundles' actual markets.

This is a deliberate pushback on coupling reusable strategy settings to
execution allocation.

## Goals and non-goals

Goals:

1. Name, reuse, edit, and duplicate strategies without copying accounts.
2. Preserve Core behavior and the byte-identical order test.
3. Keep actual markets unique per owner across active bundles.
4. Allow creation of a paused bundle before a strategy is ready.
5. Make the consequences of a shared-strategy save clear.

Non-goals:

- Multiple-bundle Live support.
- Changing quote construction, risk checks, gas reserve, queue priority, or
  Stop all.
- Automatically moving existing bundle markets after a strategy rule changes.
- Reassigning accounts or actual markets through the strategy editor.

## Data model

### Strategies

Add an owner-scoped `strategies` table:

| column                     | purpose                                      |
| -------------------------- | -------------------------------------------- |
| `id`                       | immutable strategy id                        |
| `owner_address`            | tenant scope                                 |
| `name`                     | owner-unique, case-insensitive display name  |
| `config`                   | normalized strategy-only configuration       |
| `market_rule`              | normalized quick-pick or preferred-list rule |
| `version`                  | optimistic-concurrency version               |
| `created_at`, `updated_at` | audit timestamps                             |
| `archived_at`              | soft archive when unused                     |

The strategy-only config excludes `makerAccountId`, `hedge.accountId`, `mode`,
and `markets`. It retains objective, profile, quote sizing, global limits,
hedge threshold/max-order/slippage, and advanced controls.

```ts
type StrategyMarketRule =
  | {
      kind: "quick-pick";
      pick: "rewards" | "balanced" | "quiet" | "steady" | "clear";
    }
  | { kind: "preferred-list"; marketIds: string[] };
```

A preferred list remains valid even when none of its markets is currently free.

### Bundles

Add nullable `strategy_id` and `strategy_version_applied` to the existing
`bundles` record. A bundle retains its execution data:

- `maker_account_id` and `taker_account_id`;
- `mode`, `status`, timestamps, and error state;
- actual markets in `bundle_markets`;
- a new `overrides` JSON column on `bundle_markets`.

The current bundle `config` column remains during this migration as a rollback
and compatibility mirror, not a second editable truth.

### Constraints

1. Bundle and strategy names are each unique per owner, case-insensitively.
2. A bundle can reference only a strategy owned by its owner.
3. Maker/Taker account role and distinct-account constraints remain unchanged.
4. `UNIQUE(owner_address, market_id)` remains on active `bundle_markets`.
5. A bundle with no strategy may only be paused or stopped; Start and Resume
   reject it.
6. A strategy save validates the composed config of every attached bundle
   against the existing schema and wallet envelope before commit.
7. Deleting/archiving an in-use strategy is rejected; Duplicate creates an
   independent copy.

## Runtime projection

There is no new decision engine. The runtime receives the existing Maker config
reconstructed transactionally:

```text
strategy global settings
+ bundle mode
+ bundle Maker/Taker accounts
+ bundle actual markets and per-market overrides
= existing MakerConfig
```

The current `makerConfigSchema`, risk checks, gas reserve, queue, Stop all, and
order construction remain authoritative. Projection is schema-normalized before
runtime reads it.

A strategy edit fan-outs only shared settings. The server first composes and
validates every attached bundle. If one fails the schema or wallet envelope, the
entire update rejects with affected bundle names; it never partially changes
bundles.

## Migration and rollback

The migration is transactional, resumable, and idempotent per owner:

1. Create `strategies`, nullable bundle strategy columns, a bundle-market
   override column, foreign keys, and indexes.
2. Parse each existing bundle's normalized `config`.
3. Create exactly one strategy named `<Bundle name> strategy` for that bundle.
   Its market rule is a preferred list of the bundle's current markets.
4. Attach the bundle, copy actual markets and per-market overrides into
   `bundle_markets`, and retain accounts/mode on the bundle.
5. Write a canonical composed compatibility projection.
6. Verify Core's projection matches the pre-migration config semantically and
   run the byte-identical quote-intent and submitted-order tests on the same
   fixtures.
7. Mark the owner migrated only after all bundles and mirrors are present.

An owner on the legacy fallback path remains there. A bad stored config records
one audit event and cannot prevent the control service from starting or be
reparsed every boot.

Rollback reverses the read path, not data:

- stop affected runtimes before switching;
- reconstruct and dual-write current Core configuration to
  `tenant_settings.maker_config`;
- retain strategies, attachments, and bundle-market rows;
- use retained legacy backup only if current Core cannot be parsed;
- return an explicit rolled-back state for bundle/strategy routes rather than
  stale configuration.

No rollback drops these tables. A code rollback therefore still reads the
current Core mirror.

## API

All routes retain the existing authenticated owner scope.

### New strategy API

- `GET /api/strategies` lists active strategies with rule summary, version, and
  `Used by` bundle names.
- `POST /api/strategies` creates a named strategy from strategy-only settings
  and a market rule. It accepts neither accounts nor actual markets.
- `GET /api/strategies/:id` returns editor data and bundles using it.
- `PATCH /api/strategies/:id` uses `expectedVersion` and returns affected,
  validated bundle projections.
- `POST /api/strategies/:id/duplicate` makes an independent named copy.
- `POST /api/strategies/:id/archive` rejects while any active bundle uses it.

### Bundle API

- `GET /api/bundles` adds `strategyId`, strategy name, and `needsStrategy`.
  It does not invent a runtime status.
- `POST /api/bundles` accepts accounts, mode, actual free markets, and optional
  `strategyId`. With no strategy it creates a paused bundle.
- `PATCH /api/bundles/:id` changes bundle-owned accounts, mode, markets, or
  strategy attachment; it rejects an in-use account or market before mutation.
- `GET /api/bundles/:id/config` remains a composed compatibility projection.
  Its legacy write form updates only a dedicated strategy; it conflicts if the
  strategy is shared and directs callers to the strategy API.

### Core compatibility

`GET /api/config` returns Core's canonical composed `MakerConfig`.

`POST /api/config` remains a Core-only compatibility adapter. In one
transaction it updates Core's accounts, mode, actual markets/overrides, and
attached strategy settings, then dual-writes `tenant_settings.maker_config`.
If Core's strategy is shared, it first forks an owner-local `Core strategy`
copy, avoiding a legacy caller unexpectedly changing Rewards.

## UI flows

### Strategy

Strategy becomes a strategy list plus editor:

1. list each name, rule summary, and `Used by Core, Rewards`;
2. edit goal, risk profile, size/limits, hedging, advanced settings, and market
   rule;
3. offer explicit **Duplicate** and **Save**.

Saving a shared strategy names the bundles receiving the new settings. It never
claims to move their markets. Duplicate opens a separate editable strategy.

### Bundle creation and editing

New bundle first selects accounts and an optional strategy.

- With strategies, it previews the selected rule and proposes only free markets.
- Users may choose a different free subset.
- With no strategies, it says **“No strategies yet. Create one first.”** and
  still creates a paused bundle.
- A bundle with none shows **Attach strategy**; Start/Resume explains that a
  strategy is required.

Bundle editing owns actual markets, accounts, overrides, and mode. Strategy
editing never changes a Markets row.

Markets remains the all-venue, saved-bundle view; Venues remains grouped by
bundle; Desk and Performance retain bundle attribution.

## Test plan

### Schema, migration, and rollback

- Upgrade Core and non-Core bundles; rerun and prove one correctly named
  strategy per bundle.
- Migrate a bad stored config without throwing from `new Store()`; audit once
  and leave that owner on fallback.
- Prove projection reconstructs pre-migration accounts, mode, markets,
  overrides, and global settings.
- Prove DB/code rollback preserves post-migration Core updates through the
  dual-write mirror.
- Reject cross-owner references, duplicate names, and archive while attached.

### API and concurrency

- Test owner isolation, stale-version rejection, duplicate, archive, and
  attached-bundle listing for every strategy route.
- Test a shared edit updates all attached bundles atomically and rejects if any
  composed bundle fails schema or wallet limits.
- Test no-strategy bundles cannot Start or Resume.
- Test account/market uniqueness for attach, detach, create, and edit.
- Test `GET`/`POST /api/config` remain Core-compatible; a shared Core strategy
  forks on a legacy POST rather than mutating another bundle.

### Runtime and UI

- Run the existing serialized quote-intent and submitted-order byte comparison
  between prior runtime and migrated Core on identical fixtures.
- Run runtime, risk, cancellation, gas reserve, queue-priority, and Stop all
  suites unchanged.
- Prove shared Strategy shows `Used by` and Duplicate forks it.
- Prove bundle creation offers free markets only, works without a strategy, and
  stays paused until attach.
- Prove a market-rule edit never changes existing bundle markets.
- Run the stateful customer journey at 1440 and 390 for reuse, shared edit,
  duplicate, attach-after-create, Core compatibility, and migration output.

## Approval gate

Implementation may begin only after written owner approval of this RFC.

Suggested order after approval:

1. schema, migration, projection, rollback, and Core compatibility;
2. strategy API and exhaustive tests;
3. bundle attachment and runtime projection tests;
4. Strategy/Bundle UI flows with committed screenshots;
5. independent byte-identical Core order test before merge.

Owner approval was recorded on 2026-10-29. Implementation must keep Live off,
leave signing and deployment behavior unchanged, and keep Stop all available.
