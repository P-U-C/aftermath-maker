# Round 14: agent instructions

Fixes from the owner's testing of round 13. Base your work on `main` (f595d99).

## How to work

- Every part ends Done, with a ✓ and proof (test name, harness output or capture) for each Accept line.
- Nothing is done until it's pushed and the PR is open.
- If something is truly blocked by a hard constraint, finish the rest. Then report three things: the blocker, what you tried, and the smallest owner action that unblocks it.
- Runtime tests use `cycle({ executeLive: true })`. A bare `cycle()` is read-only and returns before the Paper path.

## Part 1. Go live has nowhere to go

What the owner saw: the "Go live" link doesn't lead anywhere, so Core can't be switched.

Root cause:

- In Strategy > Review, the "Go live" link (maker-dashboard ~6857) only calls `selectView("bundles")`. It doesn't open the sheet.
- Core's "Go live…" button only renders when Core is stopped (`views/bundles.tsx` ~656). While Core runs Paper, Bundles has nothing to click.
- The sheet summary reads `config`, which is the strategy draft open in Strategy, not Core's config. With another strategy selected, it shows the wrong markets and limits.
- The two server gates are off on this server. That's an env setting by design, and the sheet already gives the operator the command. **Don't add a UI toggle for the gates.**

Fix:

- Core's card shows "Go live…" whenever Core is in Paper, running or not.
- The Strategy link opens the Go live sheet directly.
- The "Core stopped" line gets an inline "Stop Core" button using the existing stop action. Stop is never disabled.
- The summary uses Core's saved config.

Accept:

- e2e: the Strategy link opens the sheet.
- e2e: with Core running, the sheet shows "Core stopped: Needed" and a Stop Core button. After stopping, the line is Done.
- e2e: with a different strategy selected, the summary matches Core's config.

## Part 2. "Paused new exposure" keeps appearing

What the log shows, repeatedly: "Core: Paper paused new exposure. One more fill could take gross exposure to $210.00, over the $200.00 limit. …"

Root cause, four parts:

- **The dedupe key includes the amount.** The round 12 spec said the key was trial + code + required amount. That was wrong for this blocker. The projected gross changes with every fill, so each new figure logs again (`recordPaperSimulationBlocker`).
- **Bundle state is computed from the selected market.**
  - `originalGrossCheck` is evaluated on the selected market's two-sided quote. A flat market and a filled market give different projections.
  - So one rotation records the blocker, and the next calls `clearPaperSimulationBlocker` (runtime.ts ~3213–3245). The state flaps as the rotation moves.
- **No hysteresis.** Two-sided quoting resumes as soon as the worst case touches the limit, and the next fill pauses it again.
- **No unwind.** Reduce-only quotes fill only if price comes back through them. Inventory just sits there, and in Paper a simulated fill on the reducing side is rare.

Fix:

- **One bundle state.** Compute exposure once per cycle for the bundle: the worst case across all markets, with two-sided quotes at current inventory.
  - Pause when it's above the limit.
  - Resume only at or below the limit minus the largest quote size, so there's one fill of headroom.
- **Dedupe key = trial + code.** The amount updates in place in the snapshot. Log when the state starts, when it clears, and the 15-minute reminder, nothing else.
- **Unwind.**
  - New setting on Size and limits: "Unwind after pause", in minutes (default 10; 0 turns it off).
  - Once the pause has lasted that long, close the largest position reduce-only, one market per cycle, within `maxSlippageBps`, until the resume threshold.
  - First cancel and confirm our own quotes in that market (the self-trade rule from round 12).
  - Paper simulates at touch prices with estimated fees. Live uses the same path, behind the Live gates.
  - Log each unwind once: "Core: closed $20.00 of NEAR to bring gross exposure under the limit."
- The bundle card shows this as a status, not an error: "Paused new exposure, reducing NEAR and DRAM."

Accept:

- Fake-timer test: 15 markets, a $200 limit, fills that push the worst case to $210.
  - Over 1 hour there is exactly one paused event, even as the amount changes.
  - There's no record/clear alternation across rotations (count the transitions).
  - Two-sided quoting resumes only below the limit minus the quote size.
  - After 10 minutes the largest position closes first, and unwinding stops at the threshold.
  - A gateway call-order test shows no taker close goes out while one of our maker orders rests in that market.
  - With the setting at 0, nothing unwinds.

## Part 3. Inventory moves but fills don't appear

What the owner saw: inventory changes on the bundle cards and on Markets, but no fills are added.

Root cause, four parts:

- **The card shows one market.** `snapshot.balances.inventoryUsd` is the selected market's inventory (runtime.ts ~2896 and ~3175), not the bundle's. In a rotation the card shows a different market every cycle.
- **"All bundles" means Core.** `GET /api/performance` with no bundle uses `runtime(request)`, which is `runtimeManager.get(owner)`: Core's runtime only (server-app.ts ~1365). The Desk fills list comes from that response, so fills from other bundles never show.
- **Maker fills only.** Confirmed fills are filtered to `order.maker`, and Paper rows to maker fills (runtime.ts ~1350 and ~1381). Hedge, close and unwind legs move inventory without ever appearing.
- **Different polling rates.** Fills poll every 30 s and the snapshot every 5 s, so inventory moves before its fill shows.

Fix:

- The snapshot gains `inventory: { netUsd, grossUsd, positions: [{ marketId, symbol, account, inventoryUsd }] }` for the whole bundle, covering both accounts when hedged. Rename the per-market value to `selectedMarketInventoryUsd` and use it only for the chart.
- **Inventory widget** on the bundle card and on Desk:
  - a gross-vs-limit meter;
  - the top 3 positions by size, each a signed bar against `maxInventoryUsd`, with symbol and amount;
  - "+n more" opens the full list.

  It's sorted by size so it doesn't jump with the rotation. Values change in place, with no other motion.
- Performance "All" aggregates every active bundle, and each fill carries its bundle name.
- Fills include taker legs with a role: Maker fill, Hedge, Close or Unwind. Paper ones are marked Estimated.
- The snapshot carries `fillSequence`. The web reloads fills when it changes, instead of waiting for the 30 s poll.

Accept:

- A test rotates through 3 markets with fixed positions: the bundle net and gross stay constant across cycles.
- A fill in a second bundle appears in "All".
- Hedge and close legs appear with their roles.
- e2e: a fill appears in the Desk list within one snapshot poll of the inventory change.
- Captures of the widget at desktop and phone width, in both themes.

## Part 4. Desk cards lose a common height

Root cause:

- `.bundle-desk-lanes > div { align-items: start }` and `.bundle-desk-lane { height: auto }` (globals.css ~12502) override the grid's stretch. A card with a notice (stale data or an error, up to 2 lines each) grows taller than the rest.
- The chart switches between 110 and 140 px depending on whether there's a quote (`bundle-desk-lanes.tsx` ~117).

Fix:

- Cards stretch to the row.
- Each card is a grid with fixed rows, in this order:
  - the header;
  - one notice slot: always reserved, one line with an ellipsis, and a "Details" control showing the full text;
  - the inventory widget (Part 3);
  - the chart at a fixed 140 px.
- Several notices collapse into one line, most important first: "Paused new exposure, and 1 more".

Accept:

- A harness check asserts every card in a row has the same height, with and without notices.
- Captures at desktop and phone width.

## Part 5. Strategy

### 5.1 Max leverage can't be changed

What the owner saw: "Fix the highlighted field in Size and limits. Go to that step". Clicking it goes nowhere, and nothing is highlighted.

Root cause, three defects found in the code. Reproduce them in e2e first:

- **The maximum collapses to 1x.**
  - `strategyMarketMaxLeverage` is the highest `maxLeverage` among the strategy's markets, matched against the loaded market list by id. It falls back to `configured.marketMaxLeverage ?? 1`.
  - Core's markets were added before round 12, so none of them stores `marketMaxLeverage`.
  - If the market list hasn't loaded, or an id doesn't match, the maximum becomes 1 and every value above 1x is an error.
- **The draft never resyncs once it's invalid.** `NumericDraftInput` copies `value` into its text only while the draft is valid (`numeric-draft-input.tsx` ~33). After an invalid entry, the Max button updates config but the box keeps the invalid text, so the error never clears.
- **Focus goes nowhere.**
  - `focusStrategyField` sets the step and focuses on the next animation frame. If the field isn't mounted yet, nothing gets focus.
  - The step nav has no error marker.
  - The message hides the actual error.

Fix:

- The maximum comes from loaded market data only.
  - While it's unknown, validate against the schema ceiling and let the server enforce per-market caps.
  - When the market list loads, backfill `marketMaxLeverage` for existing markets at the next save.
- `NumericDraftInput`: an external value change replaces the draft, even an invalid one. Track the last external value to do this.
- Focus:
  - set a pending focus target, and focus it in an effect once it's mounted;
  - the field gets `aria-invalid` and the error ring;
  - the step tab gets an error dot;
  - the message names the field and the error, for example "Maximum leverage: enter 1x to 20x."

Accept:

- e2e with Core's legacy markets (no stored `marketMaxLeverage`):
  - 10x saves;
  - typing 500 and then pressing Max clears the error;
  - with an error showing, "Go to that step" puts focus on the field.
- A unit test covers the draft resync.

### 5.2 Focus control overflows in Suggest markets

Root cause:

- Round 13 added a third focus option, but the group is still capped at `flex: 0 1 168px` (globals.css ~11046), with three `1fr` columns of about 54 px each.
- The old `.reward-focus button { min-width: 76px }` (~2177) still applies, so the labels wrap inside a 44 px row and spill over the Markets input.
- Round 12's request to use the Kit segmented control wasn't done. This one control has five rule sets: ~2163, ~6686, ~8683, ~9334 and ~11046.

Fix:

- Use `SegmentedTabs` from `ui/primitives` and delete the old `.reward-focus` rules.
- The group sizes to its labels, on one line: "All eligible", "Thin books", "Reward share".
- At phone width it takes the full row, with three equal segments and one-line labels.

Accept:

- The round 12 button-overflow check passes.
- A harness check asserts the focus group and the Markets input don't overlap at 1440, 1024 and 390 px.
- Captures.

### 5.3 Show each strategy's overall result

Each strategy shows how it has done overall: across every bundle that has run it, all time.

- **Live (confirmed) and Paper (estimated) are separate lines, never summed.**
- Each line shows:
  - net result: realized plus unrealized PnL, minus fees (protocol and builder), plus rebates;
  - volume;
  - fills;
  - time running.
- Return = net ÷ the strategy's collateral requirement, labelled, for example, "on $300.00 required collateral".
- Positive results in tide, negative in ember.

Attribution:

- Add `strategy_attachments` (bundleId, strategyId, strategyVersion, attachedAt, detachedAt).
- Record a row on every attach, detach and version change from now on.
- Backfill current attachments from each bundle's last strategy change.
- Fills count toward a strategy only inside its attachment intervals.
- Where history starts at the backfill, show "since {date}".

Where: the strategy list rows, and the top of the strategy overview card.

Accept:

- Unit tests: attribution across two bundles, and a detach.
- A test shows Paper and Live are never summed.
- e2e captures.

## Part 6. Venues

### 6.1 Authorize doesn't look like a button

- Root cause: it's `<Button variant="quiet">` (`views/venues.tsx` ~351), which reads as text.
- Fix:
  - Use primary when the trading key is the row's next step, and then Deposit becomes secondary.
  - Use secondary otherwise.
  - Keep one primary per row.

### 6.2 Retire the hidden Accounts view

Root cause:

- Accounts is filtered out of the nav (`maker-shell.tsx` ~820), but these still open it:
  - Venues Authorize (~9586);
  - the wallet menu's "N authorized" (~908);
  - the Bundles fix-stage links for accounts and trading keys (~8686);
  - the Strategy account links (~3938);
  - first-run onboarding (~2393).
- Once the owner is on it there's no way back to it, and the shell falls back to Venues.

Fix: do the account actions in Venues sheets and remove the Accounts view.

- **Authorize** opens a Venues sheet: "Authorize a trading key for account {id}".
  - Keep the current copy: trading only, can't withdraw, seeds 0.1 SUI of gas, builder fee disclosure.
  - It runs the existing owner-signed flow (`provision` / `authorizeAgent`).
  - On success the sheet closes, the row shows Authorized, and focus returns to the row.
- **Add account** goes in the Venues header and uses the same create flow.
- **Revoke** already lives in Venues.
- Every `selectView("accounts")` caller goes to Venues, with the row focused and, where it fits, the sheet open.
- First-run onboarding lands on Venues with a short setup banner.
- The `#accounts` hash redirects to Venues.

Accept:

- grep: no `selectView("accounts")` and no `AccountsView` remain.
- e2e with the mock wallet: authorize end to end from Venues without leaving it.
- The wallet menu link lands on Venues.
- Captures.

## Not in this round: Post Fiat

The API answers `{"ok":false,"error":"not_signed_in"}`, per `docs/design/round13/POSTFIAT_GA_MODELS.md`. There's nothing to build until the owner provides read access. Leave that doc as it is.

## Hard constraints (unchanged)

- `LIVE_TRADING_ENABLED` and `ALLOW_MAINNET` stay off in `.env`, docker-compose and every default. Tests may turn them on only through `buildServer`'s injected env, with FakeGateway.
- Never sign or broadcast a transaction. Tests use FakeGateway and the mock wallet only.
- No production API calls from tests, and no deploys. The owner deploys. Don't edit `.env` or the master key.
- Don't test Live against the retained audit accounts or production without written authorization.
- Stop is never disabled while anything runs.
- The repo is public. Keep security details, real account IDs and real account volumes out of commits, fixtures, PR text and docs.

## Report

- Parts 1–6 in order. Every Accept line gets a ✓ and its proof.
- Any blockers go last.
- End with the deploy steps for the merged SHA, so web and control ship from the same commit.
