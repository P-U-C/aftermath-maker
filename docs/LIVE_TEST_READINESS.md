# Live-test readiness

**Status: draft for the operator to confirm.** This table is the definition
of "the Aftermath MVP is ready for a live test". Agents work to move rows;
only the operator changes what a row means or adds and removes rows.

"Live test" here means a bounded Mainnet exercise on the dedicated account
pair at canary size, as described in
[the live-canary audit](../audits/2026-11-07-live-canary-framework.md). It
does not mean increasing capital, which stays behind the external retest.

A row is closed only by the proof in its own column. "Implemented" without
that proof leaves it open.

## Rows

| Row | Requirement                                                          | Proof that closes it                                                                                                     | Who      | Status on 2026-11-11 (`734273c`)                                             |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------- |
| R0  | The gate can be trusted                                              | `node scripts/agent-gate.mjs --repeat 5` prints `GATE PASS` on `dev`                                                     | Agents   | **Failing.** One flaky test, see below                                       |
| R1  | A timed-out signed request is reconciled by digest before any retry  | A canary test: signed request times out, outcome is resolved by digest, no second quote is posted                        | Agents\* | Open. Audit: "digest reconciliation remains open"                            |
| R2  | A fill that appears after cancellation is handled from recorded data | A sanitized fixture of the 2026-11-07 delayed fill, replayed in a test through hedge and flatten                         | Agents\* | Open. Audit: "a real late-fill fixture remains required"                     |
| R3  | The canary report states gas actually paid                           | A test that receipt gas is persisted and reported; the report no longer labels gas unavailable                           | Agents\* | Open. Audit: gas "unavailable until receipt gas is persisted"                |
| R4  | A Paper run stays healthy over time and across a restart             | A soak report from `maker-dev`: continuous Paper for the agreed duration, one forced restart, no unreconciled event      | Agents   | Open. Audit: "long-running strategy behavior: open". Duration not yet agreed |
| R5  | A live result can be read: gas in USD, funding and markouts per run  | Tests that a Live fill produces fixed-horizon markouts and that the run result includes gas and funding, or says why not | Agents   | Partly present for Paper (#113, #121). Live path not verified                |
| R6  | Every external finding has a named regression test                   | A retest packet mapping AM-EXT-01 to 25 to test names, with a script that fails if a named test is missing               | Agents   | Open. All 25 findings read "retest pending"                                  |
| R7  | The filled lifecycle works on Mainnet at canary size                 | One bounded canary cycle with a real fill: attribution, capped hedge, flatten, three flat reads, receipt evidence        | Operator | Open. Audit: fill attribution, hedge price and flatten are "unproven live"   |
| R8  | An independent reviewer has retested the findings                    | The external reviewer's retest result                                                                                    | External | Open                                                                         |

\* Touches `apps/control/src/live-canary*.ts`, a human-only path. The gate
returns `HOLD` and the operator reviews before merge.

R0 to R6 are work agents can finish against tests. R7 needs R1 to R3 merged
first and is run by hand. R8 gates capital, not the live test.

### R0 detail

`apps/control/test/runtime.test.ts`, "pauses fresh Paper exposure after
adverse markouts but preserves the normal reduce-only path" (added in #124),
failed in 5 of 15 isolated runs and in 2 of 4 full-suite runs on a clean
checkout of `734273c`. The assertion that fails is
`expect(executionSequence).not.toContain("paper-dry-run")`: the guard did not
pause.

Likely cause, not yet confirmed: the runtime evaluates the guard as of the
market observation time, `evaluatePaperAdverseSelection` ignores fills
stamped later than that time, and the test stamps its twelve fills with the
wall clock. When a fill lands after the observation timestamp the guard sees
fewer than twelve and stays in `collecting`. The task should also answer
whether production can hit the same ordering, and what the guard should do
if it does.

## Proposed as out of scope for this milestone

The operator should confirm each of these is correctly left out:

- Atomic and Atomic TWAP basket execution (issue #123).
- Realized-spread, hedge-slippage and inventory-carry decomposition. Needed
  before calling a strategy profitable, not before a canary-size test.
- Reward-pool valuation and farming scores.
- Further interface and brand work.

## Second track: Hyperliquid observation

This is independent of the rows above and shares no file with them, so it
can run in its own lane (`venue-hl`) at the same time. The data it collects
needs calendar time: regular hours, overnight and weekends.

Everything in this track is read-only. No order, no signer, no Live path.
Tests run from recorded fixtures; the gate makes no network request.

| Row | Requirement                                                                            | Proof that closes it                                                                               |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| H1  | Public Hyperliquid adapter: book, mark, oracle, funding history for one HIP-3 market   | Parser tests over recorded responses; stale or missing fields fail closed                          |
| H2  | Read-only Metric quoter, both directions, at $1k, $5k, $25k and $50k                   | Tests over recorded quotes; a revert or missing quote is recorded as unavailable                   |
| H3  | One reviewed `NVDA` mapping, including the shares-per-token multiplier                 | A `REVIEWED` mapping record plus a test that hedge size follows the multiplier                     |
| H4  | A recorder that stores both legs of the basis at each size, with source and timestamps | Deterministic replay test: recorded inputs give the same entry, exit, fee, gas and funding figures |
| H5  | One HIP-4 book captured with its settlement source, observation window and expiry      | Fixture plus a test that a market without pinned settlement rules cannot be selected               |
| H6  | A Markets view that shows the recorded basis by size and session                       | Web test over a fixture                                                                            |

H1 to H5 are the inputs for the two Paper replays (equity basis, outcome
maker). Paper execution logic is a later milestone with its own rows.

## First queue

One issue each, in the task shape from [SWARM.md](SWARM.md).

| Order | Lane       | Task                                                                                 | Row    |
| ----- | ---------- | ------------------------------------------------------------------------------------ | ------ |
| 1     | `runtime`  | Make the adverse-selection guard test deterministic; decide the production behavior  | R0     |
| 2     | `evidence` | Retest packet and its checking script for AM-EXT-01 to 25                            | R6     |
| 3     | `evidence` | Soak report script for `maker-dev` Paper runs; propose a duration for the operator   | R4     |
| 4     | `core`     | Pure functions for Live-fill markouts and run-level gas and funding, with fixtures   | R5     |
| 5     | `runtime`  | Wire those functions into the Live result path, after task 4 merges                  | R5     |
| 6     | `runtime`  | Persist receipt gas and report it in the canary (human-only path, expect `HOLD`)     | R3     |
| 7     | `runtime`  | Digest reconciliation for an unknown transaction outcome (expect `HOLD`)             | R1     |
| 8     | `runtime`  | Late-fill fixture and replay; needs the operator's sanitized 2026-11-07 record first | R2     |
| 9     | `venue-hl` | Public Hyperliquid adapter with recorded fixtures                                    | H1     |
| 10    | `venue-hl` | Metric quoter and the reviewed `NVDA` mapping                                        | H2, H3 |

Task 1 goes first and alone: until the gate is trustworthy, no other lane's
result can be believed. After it merges, tasks 2, 4 and 9 can start together,
one per lane, and task 3 follows task 2 in `evidence`. Tasks 5 to 8 queue
behind each other in `runtime`, which is why that lane sets the pace.
