# Maker Round 8 — acceptance report

The [verbatim spec](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/AGENT_INSTRUCTIONS.md) was committed before implementation. Parts A–D landed through [PR #43](https://github.com/P-U-C/aftermath-maker/pull/43), merged by another actor at 2026-10-31 19:55 UTC while this work was in progress. **I did not merge or deploy.** This PR is the remaining Kit follow-up against current main.

| Part | Accept status | Evidence and missing |
| --- | --- | --- |
| A — actionable errors and durable log | **Partly done** | Typed 4xx/fix responses, owner-scoped 60-second throttled request audit, sanitized 5xx references, [409 row](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-fixable-run-error-phone.png), [5xx Desk log](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-control-log-error-phone.png), [390](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-landing-pending-390.png)/[1440](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-landing-pending-1440.png) sign-in states, and narration coverage pass. **Missing:** executable route-injection cases for every converted precondition; the classifier/catalogue test checks all 109 constructors, while eight route scenarios are exercised directly. |
| B — Paper gas | **Done** | Low-gas Paper start/trial, low-gas Live rejection with numbers/copy address, and mixed Live+Paper tests pass. A stopped Live-configured Core uses the Paper simulation budget for its Paper trial; a running Live Core keeps its Live reserve. |
| C — Strategy summary/edit | **Done** | New-on-Goal selects the name, first-unused names retry archived collisions, saved summary and Edit Markets jump work; Review uses sentences. [Desktop summary](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-strategy-summary-desktop-light.png), [390 summary](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-strategy-summary-header-phone-dark.png), [Goal](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-new-strategy-goal-desktop-light.png). |
| D — Markets/editor | **Done** | Clean 60 px table, 390 sort/Edit hit areas, in-place six-field editor, one-field PATCH-body unit test and focus return. Captured [table](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-markets-clean-desktop-light.png), [inherited](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-policy-inherited-desktop-light.png), [invalid](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-policy-invalid-desktop-light.png), [blocked](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-policy-blocked-desktop-light.png), and [mobile](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/r8-policy-inherited-phone-dark.png). |
| E — shared Kit | **Partly done** | Common page/card/button/segmented/table primitives, 1200 px six-view alignment at 1440/1180/1024, before/after screenshots in [evidence](https://github.com/P-U-C/aftermath-maker/tree/ui/round8-kit/docs/design/round8/evidence), `shots.mjs --view all` all 600 fixture/size captures, and light/dark contrast all 72 combinations pass. The account read in `packages/aftermath/src/gateway.ts:listOwnerAccounts` exposes equity/position count but not *per-account exposure or unrealized result*. The Venues Accounts table shows disclosed dashes, not fabricated figures. Some secondary controls also still use legacy action/status styles (including clickable run-status chips and account/Strategy form controls). The missing per-account read is outside the permitted server edits, so **E is not accepted yet**; complete the remaining Kit sweep and authorize that read separately. |

## Verification — current tree (local mocks only)

`MAKER_AUDIT_PORT=8898 npm run check`:

```text
Tests 40 passed (40) — core
Tests 52 passed (52) — aftermath
Tests 135 passed (135) — control
Tests 80 passed (80) — web
✓ Compiled successfully
✓ Finished TypeScript
customer journey: all stateful audit flows passed
```

`node apps/web/e2e/shots.mjs --view all --base-url http://127.0.0.1:8898`: **600 captures, exit 0, no checks disabled**; last capture: `stopped/learn/desktop-reduced.png`. Post-final-CSS `--state paper-running --view all` also passed all eight sizes; last capture: `paper-running/learn/desktop-reduced.png`.

`node apps/web/e2e/contrast-audit.mjs --base-url http://127.0.0.1:8898`: **72 fixture/theme/viewport results, exit 0**; last lines `ok stopped/dark/desktop`, `ok stopped/dark/phone`, `ok stopped/dark/tablet`. Post-final-CSS paper-running light/dark desktop/phone/tablet: six results, all `ok`.

The server port 8899 was occupied by an existing Next process. Tests used local 8898 without stopping it; a separate pre-Kit worktree was captured on local 8897. A read-only Docker label inspection after the external merge showed web at `29aa9ea` and control still at `a8cce9f`; **neither was deployed by this work**. No production API/database access, wallet signing, funded wallet, bundle start, Live-gate change, deploy or merge was performed by this agent.

## A1 conversion table and B1 gas finding

# Round 8 A1 — user-facing precondition conversions

Current `ui/round8` source locations; the server keeps unknown errors generic 5xx. Template expressions interpolate the named market or bundle and observed gas figures, never request bodies or secrets.

| File:line | Code | Public message expression |
| --- | --- | --- |
| `apps/control/src/server.ts:345` | `account-not-authorized` | "Authorize the selected Maker account in Venues before continuing." |
| `apps/control/src/server.ts:355` | `account-not-authorized` | "Authorize the selected hedge account in Venues before continuing." |
| `apps/control/src/server.ts:368` | `mode-required` | "Choose Paper or Live mode before saving." |
| `apps/control/src/server.ts:379` | `live-unavailable` | "Live mode is unavailable. Keep this bundle in Paper until the operator enables Live." |
| `apps/control/src/server.ts:490` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:506` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:517` | `strategy-not-found` | "This strategy is no longer available. Choose a strategy in Strategy." |
| `apps/control/src/server.ts:530` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:558` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:590` | `strategy-conflict` | error.message |
| `apps/control/src/server.ts:614` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:643` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:665` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:680` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:691` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:703` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:729` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:776` | `account-required` | "Select an authorized Maker account in Venues before creating this bundle." |
| `apps/control/src/server.ts:792` | `hedge-account-required` | "Authorize a separate hedge account in Venues before creating this bundle." |
| `apps/control/src/server.ts:804` | `account-not-authorized` | "Authorize the selected account in Venues before continuing." |
| `apps/control/src/server.ts:833` | `bundle-precondition` | expected.message |
| `apps/control/src/server.ts:857` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:876` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:884` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/server.ts:914` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:943` | `account-not-authorized` | "Authorize the selected account in Venues before continuing." |
| `apps/control/src/server.ts:982` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:993` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1001` | `needs-strategy` | "Attach a strategy in Bundles before starting this bundle." |
| `apps/control/src/server.ts:1009` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1026` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:1037` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1045` | `needs-strategy` | "Attach a strategy in Bundles before starting this bundle." |
| `apps/control/src/server.ts:1053` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1069` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:1087` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:1116` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1434` | `account-setup-required` | "Provision this account in Venues before continuing." |
| `apps/control/src/server.ts:1442` | `builder-registration-required` | "Venue fee registration is not complete. Ask the operator to complete setup before continuing." |
| `apps/control/src/server.ts:1475` | `account-setup-required` | "Provision this account in Venues before continuing." |
| `apps/control/src/server.ts:1483` | `builder-registration-required` | "Venue fee registration is not complete. Ask the operator to complete setup before continuing." |
| `apps/control/src/server.ts:1535` | `account-not-authorized` | "Authorize the trading key for this account in Venues before continuing." |
| `apps/control/src/server.ts:1556` | `orders-open` | 'Cancel ${taggedOrders} open Maker order${taggedOrders === 1 ? "" : "s"} before revoking the trading key.' |
| `apps/control/src/server.ts:1586` | `account-not-authorized` | "Authorize the trading key for this account in Venues before continuing." |
| `apps/control/src/store.ts:1918` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:2579` | `strategy-not-found` | "The attached strategy is no longer available. Choose a strategy in Bundles." |
| `apps/control/src/store.ts:2664` | `shared-strategy` | "This bundle uses a shared strategy. Edit it in Strategy instead." |
| `apps/control/src/store.ts:2832` | `wallet-limit` | '${overLimit[0]} limit exceeds this wallet's confirmed envelope. Raise the wallet limit in Bundles or lower the strategy limit.' |
| `apps/control/src/store.ts:2890` | `accounts-not-distinct` | "Choose separate Maker and hedge accounts in Venues." |
| `apps/control/src/store.ts:2911` | `account-role-taken` | "This account is already assigned to a bundle. Select an unused account in Bundles." |
| `apps/control/src/store.ts:2928` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:2935` | `needs-strategy` | "Attach a strategy in Bundles before starting this bundle." |
| `apps/control/src/store.ts:2961` | `market-taken` | '${market.symbol} is already quoted by ${existing.name}. Duplicate the strategy and change its markets.' |
| `apps/control/src/store.ts:2986` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:2994` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/store.ts:3003` | `core-required` | "Configure Core in Bundles before creating another bundle." |
| `apps/control/src/store.ts:3193` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:3203` | `bundle-version-conflict` | "Bundle changed elsewhere; refresh before saving. Compare your changes with the current bundle." |
| `apps/control/src/store.ts:3304` | `strategy-name-invalid` | "Use a strategy name between 1 and 80 characters." |
| `apps/control/src/store.ts:3317` | `strategy-name-taken` | "Another strategy already uses this name. Choose a different name." |
| `apps/control/src/store.ts:3354` | `strategy-name-invalid` | "Use a strategy name between 1 and 80 characters." |
| `apps/control/src/store.ts:3366` | `strategy-not-found` | "This strategy is no longer available. Choose a strategy in Strategy." |
| `apps/control/src/store.ts:3373` | `strategy-version-conflict` | "Strategy changed elsewhere; refresh before saving. Compare your draft with the latest version." |
| `apps/control/src/store.ts:3391` | `strategy-name-taken` | "Another strategy already uses this name. Choose a different name." |
| `apps/control/src/store.ts:3416` | `market-taken` | '${markets[0]!.symbol} is already quoted by ${running[0]!.bundle.name}. Duplicate the strategy and change its markets.' |
| `apps/control/src/store.ts:3443` | `market-taken` | '${market.symbol} is already quoted by ${existing.name}. Duplicate the strategy and change its markets.' |
| `apps/control/src/store.ts:3536` | `strategy-not-found` | "This strategy is no longer available. Choose a strategy in Strategy." |
| `apps/control/src/store.ts:3555` | `strategy-not-found` | "This strategy is no longer available. Choose a strategy in Strategy." |
| `apps/control/src/store.ts:3563` | `strategy-in-use` | "This strategy is used by a bundle. Detach it in Bundles before deleting it." |
| `apps/control/src/store.ts:3617` | `core-required` | "Configure Core in Bundles before confirming wallet limits." |
| `apps/control/src/store.ts:3732` | `bundle-name-invalid` | "Use a bundle name between 1 and 80 characters." |
| `apps/control/src/store.ts:3740` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/store.ts:3754` | `bundle-limit` | "A wallet can have at most four active bundles. Archive an unused bundle before creating another." |
| `apps/control/src/store.ts:3763` | `core-required` | "Configure Core in Bundles before creating another bundle." |
| `apps/control/src/store.ts:3772` | `wallet-limits-unconfirmed` | "Confirm wallet limits in Bundles before creating a second bundle." |
| `apps/control/src/store.ts:3833` | `bundle-name-invalid` | "Use a bundle name between 1 and 80 characters." |
| `apps/control/src/store.ts:3847` | `bundle-name-taken` | "A bundle already uses that name. Choose a different bundle name." |
| `apps/control/src/store.ts:3855` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/store.ts:3869` | `bundle-limit` | "A wallet can have at most four active bundles. Archive an unused bundle before creating another." |
| `apps/control/src/store.ts:3880` | `strategy-not-found` | "This strategy is no longer available. Choose an active strategy in Strategy." |
| `apps/control/src/store.ts:3894` | `needs-markets` | "Choose a strategy with at least one market before creating this bundle." |
| `apps/control/src/store.ts:3923` | `wallet-limits-required` | "Set Core wallet limits in Bundles before creating this bundle." |
| `apps/control/src/store.ts:3933` | `wallet-limits-unconfirmed` | "Confirm wallet limits in Bundles before creating a second bundle." |
| `apps/control/src/store.ts:3987` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:3997` | `bundle-version-conflict` | "Bundle changed elsewhere; refresh before saving. Compare your changes with the current bundle." |
| `apps/control/src/store.ts:4014` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/store.ts:4026` | `markets-on-strategy` | "Edit markets in Strategy, then return to Bundles." |
| `apps/control/src/store.ts:4038` | `strategy-not-found` | "This strategy is no longer available. Choose an active strategy in Strategy." |
| `apps/control/src/store.ts:4046` | `needs-markets` | "Select at least one market in Strategy before attaching it to a bundle." |
| `apps/control/src/store.ts:4144` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:4162` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:4169` | `core-required` | "Core cannot be archived. Keep it as the wallet control bundle." |
| `apps/control/src/store.ts:4312` | `account-owner-mismatch` | "Connect the wallet that owns this account before setting it up." |
| `apps/control/src/store.ts:4428` | `account-not-found` | "This account setup is no longer available. Select an account in Venues." |
| `apps/control/src/store.ts:4452` | `account-not-found` | "This account setup is no longer available. Select an account in Venues." |
| `apps/control/src/runtime-manager.ts:122` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:163` | `core-required` | "Save a Core bundle before starting a Paper test run." |
| `apps/control/src/runtime-manager.ts:172` | `core-not-found` | "Core is unavailable. Open Bundles and check its setup before testing." |
| `apps/control/src/runtime-manager.ts:190` | `trial-already-running` | "A Paper test run is already in progress. Wait for it to finish before trying again." |
| `apps/control/src/runtime-manager.ts:284` | `needs-strategy` | "Attach a strategy in Bundles before starting this bundle." |
| `apps/control/src/runtime-manager.ts:292` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:299` | `bundle-archived` | "This bundle was archived. Choose an active bundle in Bundles." |
| `apps/control/src/runtime-manager.ts:308` | `live-core-only` | "Only Core can use Live mode. Select Paper for any other bundle." |
| `apps/control/src/runtime-manager.ts:323` | `live-core-only` | "Core must be the only Live bundle. Switch other bundles to Paper first." |
| `apps/control/src/runtime-manager.ts:418` | `gas-reserve-low` | 'Couldn't start ${candidate.name} ${paperTrial ? "Paper test" : candidateConfig.mode}. Its trading key has ${(availableGasMist / 1_000_000_000).toFixed(2)} SUI for gas and needs at least ${(requiredGasMist / 1_000_000_00 |
| `apps/control/src/runtime-manager.ts:483` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:517` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:539` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:597` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |

`WalletLimitError` in `apps/control/src/store.ts` is a typed `wallet-limit` precondition for missing Core limits and limits below running use. It reports the used amount and directs the owner to Bundles.

## B1 finding

The Paper simulation path in `packages/aftermath/src/gateway.ts` sets a gas budget of `config.maxGasMist`, selects a gas coin with `setAgentGasPayment`, and then calls `simulateTransaction`. Paper therefore needs one `maxGasMist` budget; it does not need the Live cancellation, hedge, or multi-bundle safety reserve. The admission guard now computes the Live reserve from Live configs and their resting-order maxima only, and requires the maximum of that reserve and the Paper candidate simulation budget. The Live-only calculation is unchanged; the same guard treats a stopped Core saved in Live mode as a Paper candidate when the Strategy Paper test run is requested. A running Live Core still contributes its Live reserve. No production database, Live setting or trading flow was touched.

## Decisions not specified by the canvas

- For account cells the UI explicitly says `—` and explains absent per-account fields; it does not infer exposure or P&L from wallet-wide totals.
- The Paper admission requirement is `max(liveReserve, onePaperSimulationBudget)`: a Paper start never increments the Live bundle/order count.
- A local post-merge follow-up branch `ui/round8-kit` was created from the new main; no reset or deployment was performed.

---

# Maker Round 8b — PR #44 follow-up

The verbatim owner instructions were committed first as [`AGENT_INSTRUCTIONS-8b.md`](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/AGENT_INSTRUCTIONS-8b.md) (`d2f5b4a`). This work remains on `ui/round8-kit`; no production API, database, signing, deployment, or merge operations were performed. Production inspection was restricted to container labels and logs.

## Acceptance

| Part | Result | Evidence / remaining work |
| --- | --- | --- |
| 1. Build identity | **Done** | `/health` and authenticated `/api/status` share `commit` and `builtAt`; `apps/control/test/build-identity.test.ts`. [Matching](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-build-matching/paper-running-desk-desktop-light.png) and [mismatched operator](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-build-mismatch/paper-running-desk-desktop-light.png) captures (also dark). Production labels below. |
| 2. Paper blocker | **Partly done** | Structured collateral/gas details, 5-market/$10 browser [status](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-paper-blocked/paper-blocked-desk-run-status-phone-light.png), [bundle card](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-paper-bundle/paper-blocked-bundles-desktop-light.png), [Desk log](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-problems-log/paper-blocked-desk-desktop-light.png); runtime tests show one blocked event, one reminder at 15 min, one cleared event, and stop cleanup. A stale-account warning uses 3× strategy cycle interval. **Missing:** the exact 40-hour production read-stall cause cannot be verified from the permitted labels/logs alone. See diagnosis below. |
| 3. Control log | **Done** | 50 server results; newest 12 first, Show more reveals remainder. `PROBLEM_OUTCOMES` filters before the SQL `LIMIT` and respects owner. A test buries a blocker behind 30 info events; [Problems capture](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-problems-log/paper-blocked-desk-desktop-light.png) and `shots.mjs --verify-paper-blocked` exercise Show more, server filter, fix links, and stopping. |
| 4. Landing access | **Done in mocked acceptance** | Control/web log findings below. Typed access responses and inline retry/closed-request handling; [phone 503 capture](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-access/registry503-phone-result.png). `wallet-preauth.mjs` covers request-from-disconnected, denied request, registry 503, expired 410, rate 429 and closed 403 at 1440/390. **Production wallet signature failures remain for owner retry after a matched-build deployment.** |
| 5. Finish Round 8 | **Partly done** | Per-account marked exposure/unrealized venue read tested read-only; old control hides unavailable columns. Two-decimal money, one-market Paper gas, strategy/markets/bundles/desk/performance/venues Kit refinements, [before](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/paper-running-performance-desktop-light.png) and [after](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-desktop/paper-running-performance-desktop-light.png) captures. **Missing:** the requested executable route-level case for *every* pre-existing A1 error code is not supplied; existing tests exercise the classifier/constructors and targeted routes, not all 100+ distinct route conditions. Do not represent 5.1 as passed. |

For each affected 5.4 view (Desk, Strategy, Markets, Bundles, Performance, Venues), the **before** 1440/390 screenshots are the already-committed Round 8 snapshots at `evidence/after/paper-running-{view}-{desktop-light,phone-light}.png` (at `7265924`); the **after** screenshots are in [`evidence/after/round8b-desktop/`](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-desktop/) and [`evidence/after/round8b-phone/`](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/evidence/after/round8b-phone/) with the same filenames. The wallet menu match/mismatch, Paper run status, landing 503, and buried blocker log have separate captures linked above.

## Production inspection — read only

At 2026-11-01 UTC, `org.opencontainers.image.revision` labels read:

| Running container | Commit |
| --- | --- |
| Web | `29aa9eaa44601667a23f5cfe224a74e80ad312e0` |
| Control | `a8cce9fc844b14874cd658e01700fc93312f0a7a` |

They still differ. Neither the Round 8 server changes nor this PR are deployed to control; a PR cannot fix its current response until the owner chooses to deploy matching images.

Control container logs for the last 72 hours (public statuses/messages only; no addresses, request bodies, headers or credentials retained):

| Endpoint | Observed result | Message |
| --- | --- | --- |
| `POST /api/auth/challenge` | 10 × 200 | No errors. |
| `POST /api/auth/verify` | 2 × 200; 4 × 401 | All four rejections: `Wallet signature could not be verified`. No observed registry 503. |
| `POST /api/access-requests` | No requests observed | The request form was not reached in these logged attempts. |

Web container logs had no route-specific records for these paths. Nothing in the allowed reads establishes whether the registry package ID is configured; successful sign-in attempts demonstrate that at least some wallet signatures verified. The four 401 responses arise before the allowlist read in `WalletAuth.verify`; genuine-wallet diagnosis needs a fresh owner-driven attempt, not a production API probe from this agent.

## 40-hour Paper timestamp

`getAgentPortfolioSnapshot` sets `markedAt` from the clock when an account read returns. HTTP status polling does **not** imply that a cycle successfully reread an account. In the old deployed runtime, `stopScheduling` left the last Paper blocker and market errors intact, and blocked events were keyed by the whole timestamp-bearing message; Paper has no Live watchdog and a pending `cyclePromise` can prevent subsequent account reads. Those code paths explain how a timestamp can linger. The old web also printed the raw timestamp. This PR clears the blocker/market errors on stop and start, preserves attention on read-only refresh, provides `accountReadAt`, exposes stale reads in amber at 3× the cycle interval, and logs blocker reminders every 15 minutes. The logs alone cannot distinguish a stuck RPC/cycle from a stale stopped-card observation for the owner's exact 40-hour instance; this acceptance subcondition is therefore **partly done**, not confirmed. No production database or API was inspected.

## Decisions / boundaries

- A Paper simulation gas check now requires one `maxGasMist` instead of the Live three-action reserve. The Live branch retains exactly three gas ceilings; no signing, trading gate, hedge, rotation or risk limit was changed beyond this Paper-only narrowing.
- The e2e fixtures now include the actual second bundle's saved strategy, so BTC/ETH policy and Edit can be verified instead of relying on a Core-only fallback. Equal-to-default overrides are displayed as inherited and discarded when a market policy is saved.
- Unreadable per-account market marks return no fabricated metrics; Venues hides both metrics columns unless every account has a read. The additional SDK requests are read-only `getAccount`/`getMarkets` calls.
- Port 8899 was occupied and left untouched; mock browser work used 8898, with repository checks configured to use a separate free port. The wallet used in browser tests is a mock, never a funded wallet.

## Checks

- `npm run typecheck` — passed.
- `npm run check` — passed (40 core, 53 aftermath, 144 control, 86 web = **323 tests**); final lines: `✓ Running next.config.ts took 26ms` / `customer journey: all stateful audit flows passed`.
- `npm test` — all four workspace suites passed as part of `npm run check`.
- `apps/web/e2e/wallet-preauth.mjs --scenario all` — desktop/phone cases passed.
- `apps/web/e2e/shots.mjs --verify-paper-blocked` — 31-event Show more, server Problems filter, fix links and card cleanup passed.
- `apps/web/e2e/shots.mjs --verify-lane-height` — two rendered desk charts measured 187.7 px each (≤200 px).
- `contrast-audit.mjs` on the final built revision — passed all fixture states in light/dark at desktop, phone and tablet. Last lines: `ok   stopped/dark/desktop` / `ok   stopped/dark/phone` / `ok   stopped/dark/tablet`.
- `shots.mjs --view all` on the final built revision — passed **664 captures** across every fixture state, view and configured size, with no checks disabled. Final lines: `stopped/learn/phone-dark: … (390px wide)` / `stopped/learn/desktop-reduced: … (1440px wide)`.

Round 8 history and the full original A1 conversion table remain in [`PR_BODY.md`](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/PR_BODY.md) and [`A1_CONVERSIONS.md`](https://github.com/P-U-C/aftermath-maker/blob/ui/round8-kit/docs/design/round8/A1_CONVERSIONS.md).
