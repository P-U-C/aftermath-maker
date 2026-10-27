# External audit guide

This is the reviewer entry point for Maker. The immutable `external-audit-v1` tag is the audited baseline. The October 27 findings and current fix evidence are tracked in [the remediation ledger](../audits/2026-10-27-external/REMEDIATION.md); reviewers should compare that ledger's remediation commit with the baseline tag.

Maker controls real perpetuals positions. It is not represented as audited, profitable, delta-neutral across venues, or safe to operate without independent review. The repository includes bounded Sui mainnet evidence because passing unit tests alone does not establish live protocol behavior.

## System in one paragraph

Maker is a wallet-gated, self-hosted control plane for Aftermath perpetual market making on Sui. An owner connects a Sui wallet, proves membership in an on-chain registry, creates or selects Aftermath accounts, funds them, and grants a locally encrypted trading agent limited account capabilities. The agent posts post-only bid/ask pairs, rotates through up to 64 selected markets, tracks only its own client order IDs, reacts to independently attributed fills, can hedge through a second Aftermath account, and can automatically flatten both dedicated accounts before a configured gross-exposure threshold. Observe and Paper modes do not sign transactions. Live mode requires two deployment gates and fails closed when a safety or reconciliation check cannot be proven.

Hosted deployment: [maker.permanentupperclass.com](https://maker.permanentupperclass.com)

Bounded mainnet evidence: [EVIDENCE.md](../audits/2026-10-27-mainnet/EVIDENCE.md)

Latest iteration: [ITERATION-5.md](../audits/2026-10-27-mainnet/ITERATION-5.md)

## Architecture

```text
Owner wallet
  |  signed login + owner-approved account lifecycle transactions
  v
Next.js web app  ---- public HTTPS ----  Browser
  |
  |  authenticated server-side proxy + internal service token
  v
Fastify control service
  |-- tenant-scoped SQLite state and audit log
  |-- AES-256-GCM encrypted trading-agent secret
  |-- runtime, risk, watchdog, reconciliation, and recovery
  |
  |  official Aftermath SDK + Sui gRPC
  v
Sui mainnet
  |-- maker_access Registry and AdminCap
  |-- Aftermath owner accounts and agent capabilities
  |-- Aftermath orderbooks, positions, fills, rewards, and builder approvals
```

### Components

| Component                             | Responsibility                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`                            | Wallet connection, signed authentication, account desk, strategy controls, risk visibility, performance ledger, and server-side API proxy.             |
| `apps/control/src/server.ts`          | Private API, request authorization, operator authorization, tenant selection, and lifecycle endpoints.                                                 |
| `apps/control/src/runtime-manager.ts` | One isolated runtime per authenticated owner.                                                                                                          |
| `apps/control/src/runtime.ts`         | Quote lifecycle, N-market rotation, fill reconciliation, hedging, watchdog, auto-rebalance, stop, and flatten.                                         |
| `apps/control/src/store.ts`           | SQLite persistence scoped by normalized owner address, including settings, encrypted agents, tracked orders, executions, and audit events.             |
| `packages/core`                       | Schemas, units, strategy selection, rewards model, transaction policy, and pre-signing risk checks.                                                    |
| `packages/aftermath`                  | Official Aftermath SDK adapter, account/cap discovery, order and fill normalization, transaction construction, simulation, and encrypted key handling. |
| `move/maker_access`                   | On-chain public membership registry; only the `AdminCap` owner can add or remove members.                                                              |
| `deploy`                              | Nginx configuration for the public edge. Docker keeps the control API off the host's public interface.                                                 |

### Authority model

The owner wallet remains responsible for account creation, deposits, withdrawals, agent grants, agent revocation, builder-fee approval, and membership administration where applicable. Maker does not store the owner key.

The generated agent signer is encrypted at rest and receives a separate Aftermath capability for each account it trades. The intended capability permits trading but not withdrawal or delegation. This restriction is a critical external-review target: verify it against the current Aftermath Move packages and representative transaction effects rather than trusting this description.

The bootstrap operator can add or remove public-service members through the on-chain `AdminCap`. Member wallets cannot access membership-management API routes. Each member's configuration, signer ciphertext, tracked orders, executions, and audit events are tenant-scoped.

### Execution model

1. Read the protocol index, orderbook, account state, agent gas, and saved policy.
2. Reconcile pending current-run fills across every selected market before considering a switch.
3. Evaluate freshness, divergence, worst next-fill inventory and gross exposure, collateral, leverage, gas reserve, unrealized loss, and run drawdown.
4. Construct a post-only bid and ask, rounded one venue tick away from the opposite side.
5. Inspect builder fields and order semantics, simulate, then submit one atomic cancel-and-place transaction.
6. Persist the confirmed digest and emitted Maker order IDs.
7. In one-live-pair mode, poll off-chain risk cheaply and pay only for a material requote, forced refresh, or market switch.

Client order IDs use Maker's reserved namespace. Cancellation combines IDs from confirmed Maker transactions with matching live state. Manual orders and another client's orders are outside the cancellation set.

### Hedge and rebalance model

The optional second account does not self-match against the Maker account. A hedge begins only after Aftermath reports an independent fill for an order ID Maker previously persisted. Maker cancels its remaining quotes, requires both accounts to report no resting orders, and places a capped opposite market order from the hedge account. It marks fills processed only after fresh account state shows combined delta inside tolerance.

Both legs remain on Aftermath, so this is a same-venue directional hedge, not cross-venue delta neutrality. It can leave offsetting gross positions and consume collateral.

Optional auto-rebalance bounds that accumulated gross exposure. Before the configured threshold, it cancels Maker orders, performs reduce-only market sweeps on both dedicated accounts, and requires three consecutive flat reads before quoting resumes. Delayed account indexing can require up to three paired sweeps. Every retry is logged. Once a risk unwind starts, a Stop request cannot interrupt it.

Stop and flatten are deliberately separate:

- **Stop quoting** cancels Maker-tagged orders but does not close positions.
- **Flatten at market** additionally submits reduce-only market orders at the user-approved slippage ceiling.

## Deployment trust boundaries

- The host holds the master key capable of decrypting member agent signers. Host compromise can therefore trade through granted capabilities.
- The web container does not receive the master key. Only the private control container does.
- The control API is Docker-internal; the web service is the only public application listener.
- Both containers run as non-root, read-only, capability-dropped processes.
- Sessions are HTTP-only, expire after 12 hours, and re-check on-chain membership.
- The service depends on the Aftermath SDK, deployed Aftermath Move packages, Sui protocol behavior, oracle/index data, and the configured gRPC endpoint.
- SQLite, the encrypted signer record, and the independent master key must be backed up together. Losing either key material or state can make recovery impossible.
- Live does not auto-resume after a process restart or hard host failure.

## Automated verification

Run:

```bash
npm ci
npm run check
npm audit --omit=dev
sudo docker run --rm \
  -v "$PWD/move/maker_access:/workspace" \
  -w /workspace mysten/sui-tools:mainnet sui move test
```

Current remediation verification on 2026-10-27:

| Suite                       |                          Result | Coverage emphasis                                                                                                                                       |
| --------------------------- | ------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`             |                      40 passing | Schemas, required risk inputs, aggregate portfolio exposure, priority mutation queues, rewards, transaction policy, and safety limits.                  |
| `packages/aftermath`        |                      36 passing | Returned transaction intent/effects, owner intent serialization, exact gas selection, key envelopes, mark valuation, cancellation, fills, and failures. |
| `apps/control`              |                      62 passing | Authentication, rate/challenge bounds, allowlist identity, retention, key rotation, endpoint recovery, runtime concurrency, risk, stop, and flatten.    |
| Move package                |                       3 passing | Operator add/remove plus duplicate-add and remove-nonmember failures; `AdminCap` is not publicly transferable.                                          |
| Production dependency audit |      0 vulnerabilities reported | `npm audit --omit=dev`.                                                                                                                                 |
| Production build            |                          Passed | Core, adapter, control service, and Next.js application.                                                                                                |
| Browser checks              | Passed at 1440x1100 and 390x844 | Authenticated render, no page-level horizontal overflow, required controls present, and no console/page errors.                                         |

Total TypeScript application tests: **138**.

These are regression tests, not formal verification. The single Move test is intentionally called out as narrow coverage.

## Mainnet tests performed

All live tests used a dedicated owner, encrypted agent, and two small Aftermath USDC accounts. Private key material is not in the repository. The accounts and transaction links are public in [EVIDENCE.md](../audits/2026-10-27-mainnet/EVIDENCE.md).

### Account and authority lifecycle

- Created two Aftermath accounts through the interface.
- Deposited 7.50 USDC into each.
- Granted the same encrypted agent a separate capability for each account.
- Approved integrator 15 at a 1 bp builder fee.
- Verified account readiness and capability discovery after a fresh container restart.
- Did not execute final withdrawal or capability revocation because the audit setup is retained.

### Quote, cancellation, and attribution

- Posted an atomic post-only BTC bid/ask pair.
- Stopped and cancelled the exact two persisted order IDs.
- Ran sustained MON replacement with fresh client IDs.
- Filled Maker orders from an independent taker and matched the resulting fills to persisted order IDs.
- Confirmed manual/unrelated order handling in regression tests.
- Confirmed post-only crossing abort code 47 has no transaction effect and retries from a fresh book without disabling post-only.

### Objective and rotation canaries

- Ran Farming, Profit, and Both as three bounded Live policy rounds, cancelling between each.
- Ran a corrected 15-market one-live-pair canary across three consecutive market switches.
- Ran a larger suite of 45 confirmed quote actions in 15 bounded batches across 20 distinct markets.
- The 45-action suite produced 14 newly attributed Maker fills, seven hedge orders, and 18 recovery transactions with zero cycle errors and zero watchdog trips.
- Eight post-only crossing races recovered.
- Seven post-cancel and seven post-hedge indexing waits resolved.
- Two fill/position ordering mismatches resolved inside their bounded windows.

### Hedge and recovery

- Confirmed real fill-triggered market hedges from the second account.
- Verified quote cancellation before hedging.
- Verified fresh combined account delta after hedge execution.
- Reproduced a 75 bps Aftermath slippage failure; the product reported it and did not raise the cap automatically.
- Flattened Maker and hedge accounts independently with reduce-only orders.
- Required both accounts to begin flat and two consecutive flat reads after canary recovery.

### Automatic rebalance

The first mainnet auto-rebalance canary found a defect: both initial flatten transactions confirmed, but delayed indexing exposed an earlier market position and the runtime could not prove three flat reads. It stopped fail-closed. The recovery path performed a second paired reduce-only sweep and restored both accounts flat.

The fix moved bounded multi-pass recovery into the product path and added a delayed-position regression test. The corrected canary then completed:

- 15 confirmed quote actions across 15 selected markets;
- four independently triggered hedge executions;
- four automatic paired-account rebalance epochs;
- continuation into later markets after every rebalance;
- 12 avoided paid replacements;
- no runtime error; and
- final recovery with both accounts already flat.

The agent's observed SUI balance changed by `-0.008615794 SUI` during the corrected canary. Reported account-pair equity changed by about `-$0.015608`. These are balance movements, not complete PnL.

## Defects found during live testing

The live program found issues that passing application tests had not exposed:

1. Gas readiness counted one SUI object rather than all agent balance sources.
2. A post-only crossing race was treated as fatal instead of a safe fresh-book retry.
3. Snapshot bootstrap and paid quote readiness were conflated.
4. A watchdog compared quote age against a pre-hedge observation.
5. Fresh fill history and account positions could become visible in either order.
6. Hedge success was judged before account indexing reflected the transaction.
7. Rotation reconciled only the selected market rather than every current-run pending fill.
8. Old tracked orders could leak into a restarted run's hedge attribution.
9. A single flatten pass was insufficient when delayed indexing exposed another position.

The fixes and transaction evidence are recorded chronologically in [ITERATION-2.md](../audits/2026-10-27-mainnet/ITERATION-2.md), [ITERATION-3.md](../audits/2026-10-27-mainnet/ITERATION-3.md), [ITERATION-4.md](../audits/2026-10-27-mainnet/ITERATION-4.md), and [ITERATION-5.md](../audits/2026-10-27-mainnet/ITERATION-5.md).

## Claim map

| Claim                       | Implementation                                                                                                | Evidence                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Wallet-scoped tenancy       | `server.ts`, `runtime-manager.ts`, and `store.ts` resolve every request into owner-scoped runtime and tables. | Cross-tenant store/auth tests.                                                   |
| Operator-only membership    | Operator routes require the bootstrap operator and on-chain `AdminCap`.                                       | Move test, API regressions, and production member HTTP 403.                      |
| Trading-only agent          | `gateway.ts` builds and verifies Aftermath grant/revoke transactions; owner key is never stored.              | Two mainnet grants; capability semantics require external Move review.           |
| Exact builder authorization | Transaction policy rejects moved, missing, or changed builder fields.                                         | Core regressions and representative mainnet quote effects.                       |
| Maker-only cancellation     | Persisted IDs plus reserved namespace and matching live state define the cancellation set.                    | Gateway/runtime regressions and exact mainnet cancellation.                      |
| N-market one-pair rotation  | One active pair, global fill sweep, atomic cross-market cancel/place, and restart sweep.                      | 45-action/20-market suite and corrected 15-market canary.                        |
| Fill-driven hedge           | Only current-run persisted order fills can trigger a capped opposite order after all orders clear.            | Runtime regressions and real hedge transactions.                                 |
| Automatic rebalance         | Bounded paired reduce-only sweeps followed by three flat reads.                                               | Delayed-index regression, failed-closed first canary, and four corrected epochs. |
| Independent watchdog        | Separate timer invalidates a stalled cycle and cancels with retries.                                          | Stalled-RPC and uncertain-broadcast regressions.                                 |
| Fail-closed Live            | Two deployment gates plus pre-signing and post-transaction state checks.                                      | Core/runtime tests and public gated deployment.                                  |
| Performance attribution     | Fills must match persisted Maker order IDs; builder fees and hedge results are separate.                      | Store/runtime tests and mainnet fill ledger.                                     |
| Gas runway                  | Net Sui gas uses computation plus storage cost minus storage rebate and preserves a reserve.                  | Gateway/store tests and observed balance deltas.                                 |

## Highest-value review targets

1. **Aftermath capability semantics:** prove the agent cannot withdraw, delegate, or mutate owner-only controls.
2. **Transaction policy completeness:** inspect every SDK transaction shape and look for ways builder, reduce-only, post-only, account, or market fields can move outside the checked structure.
3. **Cancellation ownership:** attempt collisions, missing events, partial state, stale account snapshots, and another client's orders.
4. **Tenant isolation:** test every read/write route, runtime-manager lifecycle, encrypted signer context, and operator endpoint across two wallets.
5. **Concurrency:** race Stop, reconfigure, watchdog, fill reconciliation, hedge, auto-rebalance, and process termination.
6. **Eventual consistency:** reorder fills, positions, open orders, transaction effects, and history pagination beyond the latest 200 records.
7. **Recovery:** kill the host during quote broadcast, hedge, first flatten account, database write, and key rotation.
8. **Risk math:** inspect decimal/base-unit conversions, tick/lot rounding, worst two-sided fills, collateral assumptions, leverage, and limits across all supported markets.
9. **On-chain registry:** expand Move tests for AdminCap transfer, duplicate membership, shared-object access, and upgrade/deployment assumptions.
10. **Deployment:** verify image provenance, secret mounts, internal-token handling, proxy headers, rate limits, session invalidation, backups, and restore.

## Known limits and unproven claims

- The October 27 independent source audit is complete; the remediation commit still requires independent retesting before capital increases.
- Profitability and reward efficiency are unproven.
- Fair value uses Aftermath's protocol index checked against the local book; there is no independent multi-venue price source.
- Both hedge legs use Aftermath, so venue and liquidation risk remain concentrated.
- Net known result excludes USD-converted gas, complete funding attribution, fixed-horizon markouts, explicit hedge slippage, and inventory carry.
- Fill ingestion reads the latest 200 records and needs cursor-based ingestion before high-volume operation.
- A deliberate restart resets run drawdown; daily and lifetime loss limits are not implemented.
- Live does not auto-resume after a hard host failure.
- Withdrawal and final capability revocation have not been exercised in the retained mainnet setup. Backup/restore and key-rotation drills use isolated databases, not retained mainnet signer state.
- Public gRPC is the default. A private validator endpoint is supported but has not been used in this audit.
- Strategy rankings are transparent heuristics, not predictions of rewards or profit.
- Auto-rebalance can cross the spread, incur slippage and gas, and realize losses.
- The 1 bp builder fee is additional to protocol economics and applies to fills carrying Maker's code.
- The two-week $1,000 to $20,000 capital plan is a manual evidence-gated validation ladder, not an automatic allocation or safety guarantee.

## Reviewer reporting

Please include:

- commit or tag reviewed;
- threat model and assumptions;
- severity, exploit path, affected component, and reproducible evidence for each finding;
- whether a finding needs owner-wallet authority, agent authority, member access, operator access, host access, or no authentication;
- recommended fix and a regression test; and
- explicit distinction between source-level findings and behavior reproduced on Sui mainnet.

Security reports can be sent privately using the contact process in [SECURITY.md](../SECURITY.md). Do not test Live against the retained audit accounts or production deployment without written authorization.
