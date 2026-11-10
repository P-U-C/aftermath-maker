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

Accounts #613/#1706 are a **negative control**: their Epoch 5 perps result
was about −$702 before gas, excluding referrals. Their high known paired
turnover, volume, and wallet-level rewards must not tune, rank, or otherwise
justify the Core Inventory recycling default. They are accounting and
same-parent-matching evidence only, not a reward forecast or proof that rapid
paired turnover is profitable.

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

| Item                                                   | Status                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Durable source-aware observation/fill/reward contracts | Implemented; effects and reconciliation records are append-only and tenant-scoped                          |
| Epoch 4/5 accounting targets                           | Sanitized fixture verifier and fixture-backed regression test; no historical quote replay is claimed       |
| Paper/Observe market snapshots                         | Runtime records source-stamped index, book, depth, fees, OI and volume; incomplete fields stay unavailable |
| Paper fixed-horizon markouts and decisions             | Durable tenant-scoped 1/5/30/60-minute index-reference records; missing references remain unavailable      |
| Independent-fill sample and markouts                   | Not yet collected                                                                                          |
| Wallet-paid gas reconciliation                         | Not yet collected                                                                                          |
| Per-strategy reward allocation                         | Unavailable by design without a verified allocation source                                                 |

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
| Epoch 4/5 accounting targets                            | Sanitized fixture verifier and fixture-backed regression test; no historical quote replay is claimed           |
| Runtime risk admission and UI ranking                   | Pending the read-only source adapters and a complete reconciliation feed                                       |

Paper preserves the existing strict book-through estimate: a touch is never a
fill. The shared contract now also rejects incomplete book evidence and retains
side-aware Paper markouts only after their requested horizon, alongside an
append-only fixed-policy quote/pause decision log. Index-reference marks are
explanatory evidence, not realised P&L or a reward estimate. Attached strategies
named `Inventory recycling` reject risk-increasing quotes until a durable
reconciliation is `reconciled`; passive reduction, Stop, and Flatten remain
available. This is a conservative admission boundary, not proof of reward
eligibility or actual market fills.

## Supplied Epoch accounting fixtures

The sanitized Epoch 4/5 package is a Phase A accounting fixture, not a quote
placement replay. Its verifier is run by
`Inventory recycling sanitized Epoch 4/5 accounting fixtures`; it validates
the published fill, fee, funding, cost, matched-digest, and candle-volume
targets without querying a venue. The CSV reward row, rounded UI observation,
and claimable balance are kept as three separate sources. Their mismatch is
unresolved and no strategy or market reward is inferred from it.

Epoch 5 candles support the aggregate market-volume check only. Historical
order books, wallet-paid gas, builder charges, and the competitor's fill-level
evidence are absent. Strategy replay and parameter calibration are therefore
`insufficient_evidence`; they cannot authorize a risk-increasing quote or
change the Paper-only preset.
