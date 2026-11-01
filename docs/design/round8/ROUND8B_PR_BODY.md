# Maker Round 8b — draft follow-up to merged PR #44

**PR #44 was merged by another actor at 2026-11-01 18:49:58 UTC**, before the Round 8b branch commits were pushed. Its merge commit `6dc3bf3` does not contain Round 8b. This report accompanies a separate draft follow-up PR against that merged main. The agent did not merge or deploy.

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
