# Round 12: agent instructions

This one file is the whole round: Part 0 finishes round 11 (the "11b" follow-up, which is a spec, not a branch), then Parts 1–7.

Base your work on `main` (7336b8a when this was written).

## How to work

- Do Part 0 first. Part 1 builds on its bundle-checks-first order.
- Every part ends Done, with a ✓ and proof (test name, harness output or capture) for each Accept line.
- Nothing is done until it's pushed and the PR is open.
- If something is truly blocked by a hard constraint, finish the rest, then report three things: the blocker, what you tried, and the smallest owner action that unblocks it.
- Trap for runtime tests: `runtime.cycle()` with no arguments is read-only and returns before the Paper path. Use `cycle({ executeLive: true })`, as the timer does. Otherwise a test passes on the broken code too.

## Part 0. Finish round 11 (PR #49)

What was verified on `main` 7336b8a: the Paper margin fix works. On 37b24cf, one simulated fill produced "Maker margin ratio NaN%" on every market. On 7336b8a, the same scenario keeps quoting.

### 0.1 Missing tests from round 11 (each was an Accept line)

- A Paper trial fills on market A, and market B still quotes. It fails on 37b24cf and passes on `main`.
- Market skips:
  - the 15-market, 1-hour fake-timer test (zero bundle blocker transitions, one enter and one leave per real change, no "simulating again");
  - the all-skipped 15-minute warning test.
- Contrast-audit fixtures for "no Aftermath account" and "account without trading key" in both themes, plus captures.
- Deposit suggestion route tests through the Part 0 harness from round 10 (`buildServer`, `FakeGateway`, `signedInAs`). A unit test that passes `collateralPrice` in hides bug 0.2b.
- Wallet switch:
  - the mock-wallet e2e: wallet A has A1 and A2, switch to wallet B, which has B1. Only B1 shows, and no request carries A's ids;
  - the delayed-response test.

### 0.2 Bugs

**0.2a A market skip hides the bundle blocker**

- Repro: Paper, $0 free collateral, every market outside the fair-value limit. Each row shows fair-value, and `paperBlocker` stays null for good. The "Deposit $X" fix never appears.
- Cause: `runCycle` returns on market-scope failures before it evaluates bundle-scope checks.
- Fix: evaluate bundle-scope checks first. Record a market skip only when the bundle checks pass.
- Accept: that repro shows the collateral blocker, and market rows still show their skips.

**0.2b The USDC price adjustment never applies to an empty account**

- Cause: `listOwnerAccounts` reads `account.account.collateralPrice`, but the SDK account object has no such field, so it is always undefined. With `availableCollateral` at 0 (the common case), the suggestion falls back to a price of 1.
- Fix: take the price from the market's `collateralPrice`. The gateway already reads it at ~903. Drop the casts, because the SDK type already has `availableCollateral`.
- Accept: a route test with a $0-free account, USDC at 0.9997 and a $300 shortfall suggests 300.20.

**0.2c Smaller fixes**

- `loadPerformance` isn't owner-guarded like `refresh`. Drop responses that arrive for another owner.
- The Paper fill price uses `toFixed(4)`. Use the round 8b price formatter (significant digits or tick size). Today an asset priced at 0.00001234 prints 0.0000.

## Part 1. Paper stalls for good at the gross exposure limit

What the log shows: a Warning every rotation, once per market:

> Core: Paper skipped NEAR: Worst post-fill gross exposure needs attention ($190.00 after one fill; limit $150.00)

The same line repeats for DRAM, CRCL, XMR and CARDS.

Root cause, three parts:

- **Limits with no headroom.** Core quotes 15 markets in portfolio rotation at $10 a side, and `maxGrossExposureUsd` defaults to $150. `aggregatePortfolioQuoteRisk` counts $10 of worst case per flat market, so quoting alone uses the whole limit. Any fill pushes the worst case over it. $190 is 11 flat markets × $10 plus 4 filled markets × $20.
- **No way back.** When the check fails, the engine quotes nothing, not even the side that would shrink inventory. Simulated inventory can never fall, so Paper never quotes again. Live would freeze the same way.
- **Bundle-wide, but logged per market.** `gross-exposure` is bundle scope, but the blocker dedupe key in `recordPaperSimulationBlocker` (runtime.ts ~2223) includes `selected.marketId`. Every market in the rotation logs it again, and the copy names one market even though the condition covers the whole bundle.

### 1.1 Reduce-only quoting

- When a two-sided quote fails inventory (market) or gross exposure (bundle), quote only the side that brings that market's inventory toward its target. Size it min(quote size, |inventory − target|) so it can't flip the position.
- A flat market posts nothing while the bundle is over its limit.
- Add `sides: "both" | "bid" | "ask"` to `QuoteIntent`. The gateway places only those sides, and Paper simulates only those sides.
- Live uses the same path. Its post-only and cancel rules don't change.
- The market row reads: "Reducing: quoting the ask to bring inventory from $20.00 back to $0.00."

### 1.2 One bundle message

- The bundle-scope dedupe key is trial + code + required amount, with no market.
- Copy: "Core: Paper paused new exposure. One more fill could take gross exposure to $190.00, over the $150.00 limit. Maker quotes only the sides that reduce inventory until it's back under. Raise the limit in Strategy, or quote fewer markets."
- Log it once when the state starts, remind every 15 minutes, and log once when it clears.

### 1.3 Limits that fit the quotes

- Size and limits shows: "Quoting 15 markets at $10.00 a side uses $150.00 of your $150.00 gross limit."
- When quoting uses more than 80% of the limit, add a "Set to $X" button, where X = all quote sizes + `maxInventoryUsd`.
- Review repeats the warning. It doesn't block saving, because reduce-only quoting handles it.

### Accept

- Fake-timer Paper test: 15 markets at $10, a $150 limit and 4 simulated fills. Filled markets quote only their reducing side, and flat markets wait. Once the reducing fills land, two-sided quoting resumes.
- Over 1 hour above the limit there is exactly one paused event, the 15-minute reminders and one cleared event, and no per-market rows.
- A gateway test shows a bid-only and an ask-only placement.
- A unit test covers the "Set to $X" value.

## Part 2. New strategy: Volume

A delta-neutral strategy that loops through markets on a fixed interval to produce volume.

### Goal step

- Add a fourth goal: "Volume", measured as "Volume per $1 of cost".
- When Volume is picked, the Goal step adds two fields:
  - "Time in each market": 1 to 60 minutes, default 5;
  - "Daily fee budget": default $5.00.

### What choosing Volume sets

All of these stay editable later:

- single-slot rotation, with `marketDwellMs` = time in each market;
- the tightest allowed spread (8 bps);
- hedge on, with `thresholdUsd` = quote size, so every fill is hedged on the taker account;
- a new `flattenOnRotate: true` (default false for other goals).

### The loop, once per market interval

1. Quote. A maker fill is hedged right away on the taker account.
2. At the end of the interval, cancel the market's quotes and confirm the cancel.
3. Close both accounts in that market, reduce-only. Reuse the `autoRebalanceIfNeeded` flatten path, scoped to one market.
4. Confirm both accounts are flat, then rotate.

Each filled loop trades about 4 × the quote size: the fill, the hedge and two closes.

### Fee budget

- Count fees paid since 00:00 UTC: maker plus taker, from account history, or the estimates in Paper.
- When they reach the budget, finish the current close, stop starting loops until 00:00 UTC, and log one Warning.

### Self-trade rule (hard)

- Never send a taker order (hedge or close) in a market while any of the owner's accounts has a resting Maker order there. Cancel and confirm first.
- The hedge path already does this. The new close path must too.
- Live still allows one bundle per market, so two bundles can't cross each other.

### Markets, review and readiness

- Suggest markets ranks for Volume by lowest cost per $1,000 of volume, using the market's maker and taker fees plus half the spread. It requires depth of at least 3× the quote size within 10 bps.
- Review shows the estimate: "Each filled loop trades about $40.00 (maker fill, hedge, two closes) and costs about $0.06 at current fees and spreads, about $1.50 per $1,000 of volume. Daily fee budget $5.00."
- Readiness: Volume needs both accounts authorized and funded. Use the existing hedge-account stages.

### Paper

Paper simulates the whole loop:

- an estimated maker fill;
- a simulated hedge;
- simulated closes at touch prices when the interval ends;
- estimated fees.

Performance shows the trial's volume and estimated fees.

### Accept

- Fake-timer Paper test: 3 markets, 5-minute intervals, fills on loops 1 and 3.
  - Each interval ends flat on both accounts.
  - Volume counts 4 × quote size per filled loop.
  - The fee budget stops new loops at the cap and resumes after 00:00 UTC.
- A gateway call-order test shows no taker order is sent while a maker order rests in that market.
- Strategy e2e: pick Volume, set the interval, and the review shows the estimate.

## Part 3. Leverage up to each market's maximum

Today the limit is 3x in four places:

- `packages/core/src/schema.ts:36` and `:92`;
- `apps/control/src/store.ts:147`;
- the Strategy input (maker-dashboard ~8114) and `market-policy-sheet.tsx`.

### Fix

- Market summaries gain two fields: `maxLeverage` (the SDK's `market.maxLeverage()`, which is 1 / `marginRatioInitial`) and `maintenanceMarginRatio` (`marginRatioMaintenance`).
- Raise the schema ceiling to 100.
- The Strategy input's maximum is the highest `maxLeverage` among the strategy's markets. A "Max" button sets it to that value.
- A per-market override is capped at that market's `maxLeverage`. A higher value is rejected with a typed code.
- Effective leverage = min(strategy or override, market max). It is computed in one place, `resolveMarketConfig`, and used for quoting, the collateral requirement and the hedge requirement.
- Show where a cap applies:
  - Review: "NEAR and DRAM use their maximum of 10x."
  - The Markets policy cell: "10x (max)".

### Risk thresholds must scale

Otherwise high leverage blocks Live on its first fill.

- `MIN_ACCOUNT_MARGIN_RATIO` (12%) and `MIN_LIQUIDATION_DISTANCE_BPS` (10%) are fixed today. At 10x, a new position opens near a 10% margin ratio and fails at once.
- Make both per market, from effective leverage L and maintenance ratio m:
  - minMarginRatio = min(12%, m + 0.5 × (1/L − m))
  - minLiquidationDistance = min(10%, 0.5 × (1/L − m))
- In words: keep at least half of the starting cushion above maintenance. Both are unchanged at 3x and below.

### Accept

- Unit tests cover capping, the thresholds at 1x and 3x (unchanged), and 10x and 20x.
- A route test saves a strategy at 20x.
- A route test rejects an override above the market's max.
- e2e: the review shows the capped list.

## Part 4. Strategy UI

### 4.1 Suggest markets row

- Root cause, two parts:
  - `.strategy-suggestion-panel .strategy-rotation-stage { display: grid; justify-items: end }` (globals.css ~10967) overrides the flex row at ~6508, so the fields and the actions stack in two rows.
  - `.strategy-suggestion-fields` has `justify-content: flex-end`.

  The same element has three rules spread across the file.
- Fix:
  - Use one rule: a flex row with `align-items: end`, `justify-content: space-between` and wrap. Focus and Markets sit on the left; Preview selection and Refresh suggestions on the right.
  - At phone width they stack.
  - `.reward-focus` and `.reward-count` still carry dark-theme hex colours from the old UI (#252a27, #adb5b0, #d2d7d3, ~2142–2209). Replace them with the Kit segmented control and tokens.
- Accept: desktop and phone captures in both themes. At 1024px and up, a harness check asserts the fields and the actions share one row.

### 4.2 Next button overflow

- Root cause: the label is `` `Save and continue to ${label}` `` (maker-dashboard ~6527), and the button doesn't wrap.
- Fix:
  - The label becomes "Next: Size and limits", and the last step keeps "Save and finish".
  - Step buttons wrap instead of overflowing.
- Add a generic check to `shots.mjs`: every view, at desktop and phone width, fails if any visible button has scrollWidth > clientWidth.
- Accept: the new check passes on every view.

## Part 5. Markets table shading

- The group rows ("In use", "Available") get `background: var(--fill)`.
- The header row with the column titles gets `var(--fill-2)`, slightly darker.
- Header text must stay at 4.5:1 or better on fill-2 in both themes. The v3 audit measured ink-2 on a tinted header at 2.9:1, so use ink if ink-2 fails.
- Put this in the shared `.ui-table` rules, so Venues group rows and the Performance tables match.
- This replaces "no colored rows" in `docs/design/round8/AGENT_INSTRUCTIONS.md`, so update that line.
- Accept: contrast-audit passes in both themes, plus captures of Markets, Venues and Performance.

## Part 6. Performance: share of market volume per epoch

- Today "Share of volume" divides each row by our own total, so it shows our mix across markets, not our share of each market.
- Source: the SDK's Perpetuals `getMarketsDailyStats({ fromTimestamp, toTimestamp, marketIds })`.
  - `volumeUsd` per market per UTC day is taker-side, so each trade counts once.
  - Today's row is provisional.
  - Up to 50 market ids per call.
- Window:
  - Epochs start at 05:00 UTC (`rewardEpochWindow`), but daily stats are UTC days.
  - Measure our volume and the market's over the same window: from 00:00 UTC on the epoch's first day until now.
  - Label it: "Epoch 17, since Oct 26 00:00 UTC".
  - Other periods use the same aligned window.
- Per market: our maker plus taker notional ÷ the market's volume.
- Total row: our sum ÷ the sum for the markets we traded.
- Rename our-mix to "Mix" and keep it as a smaller column.
- Cache completed days, and refresh today's row at most every 5 minutes.
- If stats can't be read, show "Not available", with the reason in the title.
- Accept:
  - Unit tests cover the share and the window.
  - A gateway test uses fake daily stats.
  - Include a capture of the table.

## Part 7. Make going Live findable

What's wrong today: the owner couldn't find how to go Live.

- Mode sits inside Strategy > Review as a Paper/Live toggle. But mode belongs to the bundle, not the strategy.
- With the server gates off, the Live button is disabled and only carries a hover title, "Live trading is off on this server". Nothing says what turns it on.
- Three conditions are invisible until Save fails:
  - `live-core-only`: only Core can be Live;
  - the `LIVE_TRADING_ENABLED` and `ALLOW_MAINNET` env gates;
  - the higher Live gas reserve, 3 × `maxGasMist`.

### Fix

- Move mode to the bundle.
  - Core's card and the run control get "Go live…" while Core is stopped.
  - A Live bundle that is stopped gets "Switch to Paper".
  - While it runs, mode can't change, and Stop stays as it is.
- Strategy > Review drops the Mode toggle. It shows "Runs in Paper on Core" with a "Go live" link to Bundles.
- The "Go live" sheet is a checklist checked by control. Each line shows done or the fix:
  1. Live is on for this server (both gates).
     - If not, operators see: "Set LIVE_TRADING_ENABLED=true and ALLOW_MAINNET=true in control's .env, then recreate control: `docker compose up -d --no-build --force-recreate control`."
     - Everyone else sees: "Live is off on this server. Ask the operator."
  2. The signing key is available on control. Add `liveGates.signerReady = Boolean(MAKER_MASTER_KEY)`: a boolean only, never the key.
  3. This bundle is Core. Otherwise: "Live runs on Core today. To run this strategy live, attach it to Core in Bundles." `PATCH /api/bundles/:bundleId` already accepts `strategyId`.
  4. The readiness stages, computed as Live: trading key, Live gas reserve and collateral. Each line has its Add gas or Deposit action.
  5. Last Paper run, for information only, not a gate: duration, estimated fills and any open blockers.
- Below the checklist, keep the existing GoLiveSheet summary: venue, markets, size, limits, taker and how to stop.
- The sheet ends with a checkbox, "Maker will trade real funds on account {id}", and the button "Switch Core to Live". The button is enabled only when lines 1–4 pass and the box is ticked.

### Control

- Return `liveReadiness` on Core in `GET /api/bundles`.
- Add `POST /api/bundles/:bundleId/mode { mode, confirmed: true }`.
  - It requires a stopped bundle and re-checks every line server-side.
  - It uses typed codes: `live-unavailable`, `live-signer-missing`, `live-core-only`, `bundle-not-ready-*`, `mode-requires-stopped`.
  - It logs an audit event.
- Switching only changes mode. Starting is still the separate Start, and its label reads "Start Live".

### Accept

- Route tests: gates off, gates on, signer missing, a non-Core bundle, a running bundle, missing confirmation, and success with its audit event.
- e2e with gates off, as operator (instructions shown) and as a non-operator ("Ask the operator").
- e2e with gates on in the test env: checklist green, switch, the card shows the Live tag, and Start reads "Start Live". No Start click in Live, and no signing.

## Hard constraints (unchanged)

- `LIVE_TRADING_ENABLED` and `ALLOW_MAINNET` stay off in `.env`, docker-compose and every default.
- Tests may turn the gates on through `buildServer`'s injected env, with `FakeGateway` only.
- Never sign or broadcast a transaction. Tests use `FakeGateway` and the mock wallet only.
- No production API calls and no deploys. The owner deploys. Don't edit `.env` or the master key.
- Don't test Live against the retained audit accounts or the production deployment without written authorization.
- Stop is never disabled while anything runs.
- The repo is public. Keep security details out of commits, PR text and docs.

## Report

- Parts 0–7 in order. Every Accept line gets a ✓ and its proof.
- Any blockers go last.
- End with the deploy steps for the merged SHA, so web and control ship from the same commit.
