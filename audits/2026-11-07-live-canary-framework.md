# Live canary framework audit — 2026-11-07

## Decision

Normal `dev` remains a Mainnet **Paper/shadow** deployment with both Live
gates hard-off and no signer. A separate root-only, manually invoked canary
exercises one dedicated Maker/hedge account pair. It is capped at **$5 per
side**, one market, and one bounded observation window. It is neither a timer
nor a deploy hook.

## Verified Mainnet evidence

- A $5/side NEAR quote was built and simulated without a signature.
- A real post-only two-sided quote was placed, observed resting, then cancelled.
- The final independent account read showed no Maker orders and no positions on
  either dedicated account.

The recorded public transaction references live in the root-only canary state,
not this public audit. No audit account, production service, or normal dev
container was used.

## Framework controls

`apps/control/src/live-canary.ts` implements the lifecycle below. It persists a
checkpoint after every externally visible action, so a restart resumes by
cancelling and recovering; it never posts a second quote.

```text
new -> simulate -> post one quote -> cancel -> confirm no resting orders
    -> hedge confirmed combined delta -> flatten both -> prove both flat
                                  └-> recovery-required
```

- The runner accepts Mainnet only, exactly one configured market, a distinct
  authorized account pair, Live config, $5 maximum quote/hedge, and a 30-second
  maximum resting/reconciliation window. Its required builder policy matches
  the agent's authorization, so simulation and execution use the same order
  shape as Live.
- It simulates the exact quote before execution. Without the explicit execute
  and confirmation flags, it cannot sign or broadcast.
- It refuses an existing position or resting order before opening.
- It confirms cancellation on both accounts before sending a taker hedge or
  reduce-only close.
- It observes the cancelled market for a bounded settlement window and requires
  three consecutive separate-account flat reads before reporting a clean run.
- Gateway construction, every gateway read, simulation, and submission have a
  15-second deadline. A deadline after checkpoint creation moves it to
  `recovery-required`; an initialization deadline exits before any quote can
  exist. The one-shot CLI then exits rather than leaving an idle process that
  could be mistaken for a run.
- It caps observed per-account inventory to one side and requires separately
  flat accounts—not merely a net-flat pair—before success.
- The CLI reads root-only configuration/key files and writes an atomic,
  root-only checkpoint. Its report includes only outcome and public digests.

## Audit findings and status

| Finding                                         | Status                                             | Required proof                                                                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quote construction and exact no-sign simulation | Proven                                             | Existing Mainnet simulation plus `live-canary.test.ts` dry-run case.                                                                                                                                                                               |
| Post-only quote and cancellation                | Proven                                             | Existing bounded Mainnet canary; framework now checkpoints the action.                                                                                                                                                                             |
| Fill attribution before account indexing        | Guarded in runtime; unproven live                  | Runtime waits and cancels rather than hedging unobserved position state. The canary has a deterministic recovery test; a real canary fill is still required.                                                                                       |
| Hedge quote price/slippage error                | Fixed in the gateway path, pending live fill proof | Gateway inspects against the same market observation used to construct the order. Canary test exercises capped hedge call-order, but does not claim a venue fill.                                                                                  |
| No taker while a Maker order rests              | Covered                                            | Runtime confirmation loop and canary call-order test require cancellation first.                                                                                                                                                                   |
| Flatten after a filled hedge                    | Deterministically covered; unproven live           | Canary test proves both account flatten calls and separate-flat check. A future bounded fill must supply receipt/evidence.                                                                                                                         |
| Crash/restart during cancellation               | Covered                                            | Canary checkpoint test resumes recovery and never re-quotes.                                                                                                                                                                                       |
| RPC timeout/unknown transaction outcome         | Guarded; digest reconciliation remains open        | Each gateway operation has a 15-second deadline and the fixture proves a hung portfolio read persists `recovery-required` before any action. A timed-out signed request remains an unknown outcome and requires venue reconciliation before retry. |
| Partial fills / late fills after cancellation   | Bounded detection added; unproven live             | The canary now watches a post-cancel settlement window and routes any late visible fill through the capped hedge/flatten path. A real late-fill fixture remains required before raising size.                                                      |
| Long-running strategy behavior                  | Open                                               | This canary validates one lifecycle only. It must not be used as profitability, uptime, fee, or scale evidence.                                                                                                                                    |

## Operator contract

The root-only config is deliberately not committed. Invoke a dry run first:

```bash
node apps/control/dist/live-canary-cli.js \
  --config /etc/aftermath-maker/live-canary.json \
  --state /var/lib/aftermath-maker/live-canary/state.json
```

The only execution form requires both flags:

```bash
node apps/control/dist/live-canary-cli.js \
  --config /etc/aftermath-maker/live-canary.json \
  --state /var/lib/aftermath-maker/live-canary/state.json \
  --execute --confirm-live-canary
```

For an explicitly bounded strategy exercise, `--cycles 1` through `--cycles
12` creates a separate checkpoint for every cycle and emits attributed account
history, realized PnL, fees, and estimated builder fees. It does not count gas
as zero: the report labels it unavailable until receipt gas is persisted.

An early 2026-11-07 exercise encountered a delayed attributed fill after a
cancel. It entered recovery, cancelled the remaining order, and submitted the
bounded hedge. It was not a cycle-10 stall; later no-fill checkpoints completed
normally. The exercise is not counted as a clean reliability result because its
first reduce-only close was rejected locally, as described below.

After that process was stopped, a fresh preflight found a delayed attributed
fill that had not been visible during the prior settlement reads. It refused a
new quote, cancelled, and sent the bounded hedge. The first reduce-only close
was rejected locally because `flattenPositions` built from one market snapshot
and inspected against a later one. The hedge account was then manually
reduce-only flattened at the same 75 bps cap, and three independent reads
confirmed both accounts flat with no orders. This is a real late-fill/recovery
exercise, but not a clean ten-minute strategy result; the single-observation
flatten fix must merge before another run.

It must be run manually on the host under the root-only account boundary. Do
not put it in a systemd timer, the normal dev deploy service, CI, or a browser
test.

## Clean bounded reliability run

At 2026-11-07T22:08Z, the fixed runner completed 12 consecutive 30-second
post-only Mainnet observations on its dedicated $5/side account pair. Every
cycle recorded a quote, cancellation, and separate-account flat confirmation;
there were no timeout, recovery, residual-position, or open-order events. All
12 were no-fill observations, so the report correctly records zero fills,
notional, realized PnL, and fees. This proves the bounded no-fill lifecycle for
roughly 12 minutes; it is not evidence of fill handling, profitability, or
long-running strategy performance.
