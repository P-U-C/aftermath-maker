# RFC 0001: Wallet-scoped Maker bundles

- **Status:** Proposed — owner approval required before implementation
- **Date:** 2026-10-28
- **Scope:** B0 design only. This RFC adds no bundle code.

## Summary

A bundle is one Maker account, one Taker account, one strategy, and one independently
pausable runtime loop. A wallet may own at most four bundles. They share one
owner-scoped gateway queue, one gas reserve, wallet-level limits, and one **Stop all**.

The first migration creates exactly one bundle named **Core**, so the current
configuration API and single-strategy behaviour remain compatible. Multiple bundles
are Observe and Paper only until the independent retest and explicit approval below.

## Data model and migration

A new bundles table is owner-scoped with: immutable id, owner address, owner-unique
name, Maker account id, optional Taker account id, strategy config, status, timestamps,
and a bounded last-error field. A bundle-markets table holds bundle id and market id.
A bundle-wallet-limits table holds the wallet envelope separately from any strategy.

Maker orders, executions, hedge executions, and relevant events gain a nullable
bundle id plus indexes on owner, bundle, and timestamp. Schema constraints enforce:

1. An account is Maker or Taker in at most one bundle for an owner.
2. Maker and Taker differ in every bundle.
3. A market is assigned to at most one bundle for an owner.
4. An owner has at most four non-deleted bundles.
5. A bundle limit cannot exceed its corresponding wallet envelope.

Forward migration is transactional and idempotent:

1. Create tables and nullable attribution columns.
2. For each existing owner config, create Core with its account IDs, config, mode, and
   running state.
3. Backfill bundle-market rows from current config markets.
4. Attribute old records to Core only when account/time linkage is unambiguous; retain
   null attribution and label the rest as unassigned.
5. Add indexes, validate constraints, then switch reads to the Core projection.

Before runtime cutover, store an immutable per-owner legacy-config backup. Rollback
stops affected bundles, restores legacy config/status, and switches the runtime back
to the legacy read path. It preserves audit data and does not drop new tables or
attribution columns until a separately approved retention window.

## API and compatibility

New authenticated endpoints:

- GET /api/bundles lists bundles and wallet limits.
- POST /api/bundles creates a paused, validated bundle.
- GET and POST /api/bundles/:id/config read or update one strategy.
- POST /api/bundles/:id/start starts one bundle after ordinary safety and Live checks.
- POST /api/bundles/:id/pause pauses one bundle and cancels only its orders.
- GET /api/performance?bundle=:id and GET /api/events?bundle=:id filter attribution.
- Existing runtime stop remains **Stop all**, never a per-bundle alias.

Compatibility is explicit: GET /api/config returns Core; POST /api/config updates Core
with today's byte-identical request and response behavior; existing status/performance
consumers receive Core until they opt into bundle-aware data; and no existing trading
route changes request body in B1. Mutation responses include bundle id and
version/updated timestamp to reject stale overwrites.

## Runtime manager, limits, and gas

The runtime manager key becomes owner address plus bundle id. It creates one
MakerRuntime per bundle but injects one owner-scoped gateway/transaction queue. Stop
and cancellations retain priority over quote, hedge, and routine work.

A supervisor refreshes wallet observations once, computes each due bundle proposal
independently, applies aggregate limits in deterministic bundle-id order, then sends
only accepted actions through the shared queue. Every decision writes the bundle id to
the audit trail. An isolated bundle error cancels that bundle's resting orders and
records error status; other bundles run only while wallet observations and aggregate
checks remain valid. Gateway-wide failure, missing wallet observation, or Stop all
halts submission for every bundle.

Bundle limits remain the first check. Before order construction, the supervisor checks
open exposure plus a proposed action's worst-case delta against wallet-wide gross
exposure, worst-case inventory, unrealized loss, run drawdown, quote age, and gas
reserve. A rejected proposal produces an auditable wallet-limit event; it never
silently changes strategy.

For N running bundles and O_i resting orders in bundle i:

    reserve = cancelGasEstimate × (sum(O_i) + N)
              + hedgeGasBuffer × N + fixedSafetyBuffer

Existing conservative gas estimates and minimums remain. Starting a bundle is rejected
when post-start reserve is insufficient. Stop all may use the reserve and is never
blocked by a routine gas check.

## Pause, Stop all, and validation

**Pause** blocks new work and cancels only that bundle's orders while preserving its
history/configuration. **Stop all** first marks every running bundle stopping, then
preempts the shared queue and cancels every known resting order. It is always available
while any bundle runs and is never blocked by one bundle's busy state.

Live needs the existing server gates and a successful bundle-level Go-Live review.
B1 supports exactly one Core bundle. B2 allows multiple Observe/Paper bundles only.
B3 is the sole possible multi-bundle Live phase.

## Test plan

### Migration and compatibility

- Upgrade a current config and assert Core has equivalent config, accounts, mode, and
  status. Rerun migration and prove one Core bundle exists.
- Exercise rollback before runtime cutover and prove legacy config/status return.
- Assert GET and POST /api/config stay byte-compatible with Core.
- Compare serialized quote intents and submitted order bytes for today's single runtime
  and a single Core bundle on identical fixtures; they must be byte-identical.

### Constraints, isolation, attribution

- Reject duplicate roles, equal Maker/Taker, duplicate market, over-cap creation, and
  a bundle limit above the wallet envelope.
- Prove a paused/error bundle submits no work while another eligible bundle can run.
- Prove gateway-wide observation failure halts every bundle.
- Verify record writes have the correct bundle id and unassigned legacy history remains
  visible.

### Aggregate risk, queue, and gas

- Test a proposal that fits its bundle but crosses each wallet-level limit.
- Test deterministic admission when simultaneous proposals compete for remaining
  envelope.
- Test reserve recalculation as bundles/resting orders change and rejected starts below
  reserve.
- Test Stop all preempts queued quote, hedge, and ordinary cancellation.

### Independent retest before Live

Before B3, an independent reviewer reruns runtime, quote, rotation, hedge, risk,
cancellation, recovery, signing-boundary, and stop suites for one Core bundle and
multiple Observe/Paper bundles. The reviewer separately verifies byte-identical
single-bundle orders, shared-queue priority, aggregate limits, gas-reserve checks,
migration rollback, and all Live gates. Multi-bundle Live cannot proceed without
written retest approval.

## Rollout and owner decisions

- **B1:** one Core bundle, schema/API/runtime support, and no behavior change.
- **B2:** multiple Observe/Paper bundles.
- **B3:** Live only after independent retest and written approval.

Open decisions: initialize wallet limits from today's config or require confirmation;
how to present old unassignable history; whether four remains the correct cap after
measuring cancellation gas; and whether an isolated error auto-pauses or requires
manual resume.
