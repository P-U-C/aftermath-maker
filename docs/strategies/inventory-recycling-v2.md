# Inventory recycling v2

**Bucket:** `paper`  
**Objective:** Test whether independently filled, inventory-aware Aftermath
quotes can produce a positive all-in no-reward result per collateral-day while
reward signals remain a separately labelled hypothesis.

## What this is

This extends the default **Inventory recycling** preset. It is not a new
runtime, strategy objective, funding strategy, or a path to automatic Live
trading. New instances remain unattached, Paper, Balanced, Both, unhedged, and
1× leverage until an owner explicitly changes a reviewed version.

## Evidence and decision rule

The historical review shows high known paired activity and rewards that are
wallet-level allocations. It is evidence for investigating independent maker
economics, not a reward forecast and not evidence that rapid paired turnover
is profitable.

Admission ranking uses observed no-reward economics only:

`expected captured spread + maker credit − builder fee − adverse markout − carry − hedge/unwind costs − gas − tail reserve`

Markets without enough attributed history are `insufficient_evidence`; they
may be observed or Paper-tested but cannot outrank a known positive market by
assuming zero costs. A wallet-level reward export stays `unallocated` to this
strategy unless a separate verified allocation source exists.

## Safety invariants

- No intentional same-parent execution. A known same-parent match stops
  risk-increasing activity and requires review.
- Every source observation records its source, network, timestamps, raw
  evidence and coverage; an incomplete range is `partial`, never zero.
- Paper fills are simulated estimates and do not earn rewards.
- Stop only cancels Maker-tagged orders; flatten remains a separate confirmed
  action. Existing exposure, cancellation, slippage and wallet limits remain
  authoritative.
- Live gates remain disabled in development. No strategy score can enable or
  start Live execution.

## Current evidence status

| Item                                                   | Status                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Durable source-aware observation/fill/reward contracts | Implemented; effects and reconciliation records are append-only and tenant-scoped                   |
| Actual epoch replay                                    | Blocked: sanitized raw Epoch 4/5 source fixtures are not in this repository or the provided handoff |
| Independent-fill sample and markouts                   | Not yet collected                                                                                   |
| Wallet-paid gas reconciliation                         | Not yet collected                                                                                   |
| Per-strategy reward allocation                         | Unavailable by design without a verified allocation source                                          |

## Next evidence

1. Ingest sanitized epoch fixtures with idempotent source keys and reconcile
   coverage, fees, funding and reward fields.
2. Collect read-only market observations and Maker-attributed fills.
3. Score a 3–5 market shortlist in Observe, then Paper, with time-split
   evaluation and no reward claim.
4. Present complete coverage, no same-parent matches, gas, markouts and a
   zero-reward result for human review. Live requires its independent existing
   go-live process and explicit approval.

## Delivery checklist

| Spec acceptance                                         | Evidence or limitation                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Source-aware, idempotent accounting records             | `persistent control store > persists Inventory recycling evidence idempotently and keeps rewards wallet-level` |
| Fail closed on incomplete fills, ownership or positions | `Inventory recycling accounting contracts > fails closed until fills, ownership and positions reconcile`       |
| Trading-only P&L; rewards/transfers excluded            | `Inventory recycling accounting contracts > keeps rewards and transfers outside reconciled trading P&L`        |
| Epoch 4/5 replay totals                                 | Blocked pending sanitized source fixtures; the specification alone is not a replay fixture                     |
| Runtime risk admission and UI ranking                   | Pending the read-only source adapters and a complete reconciliation feed                                       |

Paper preserves the existing strict book-through estimate: a touch is never a
fill. The shared contract now also rejects incomplete book evidence and models
side-aware markouts only after their requested horizon. Attached strategies
named `Inventory recycling` reject risk-increasing quotes until a durable
reconciliation is `reconciled`; passive reduction, Stop, and Flatten remain
available. This is a conservative admission boundary, not proof of reward
eligibility or actual market fills.
