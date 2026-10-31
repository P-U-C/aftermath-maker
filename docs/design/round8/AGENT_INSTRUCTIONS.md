round 8. full spec below, save it to the repo first like it says, then work from it. A and B first (errors + paper gas), those are blocking testing. no prod db changes, live stays off, no deploys.

# Agent instructions: Maker round 8

You are continuing Maker (`P-U-C/aftermath-maker`). This round has five parts:

- **A.** Errors that tell the user what to fix, plus a durable request-error log.
- **B.** Paper bundles stop being blocked by the Live gas reserve.
- **C.** Strategy opens as a summary, and New strategy opens on Goal.
- **D.** Markets gets a clean table and an in-place policy editor.
- **E.** One kit, applied to every view, so the app stops looking assembled from parts.

The owner's design canvas, "Maker round 8", has a board for C, D and E. You can't open it, so every value you need is written here.

First, save this whole message as `docs/design/round8/AGENT_INSTRUCTIONS.md` and commit it.

Same rules as before:

- **Mark a line done only when its Accept check passes.** If it partly passes, say "partly done" and list what's missing.
- **Commit your evidence screenshots** to `docs/design/round8/evidence/`.

---

## 0. Setup

| Item | Value |
| --- | --- |
| Base | `origin/main` (`521f567` or later) |
| Branch | `ui/round8`. You may split it into `fix/round8-errors` (A, B) and `ui/round8` (C, D, E) if that's easier to review. |
| Server | Port 8899; check it's free with `ss -ltn` first |
| Harnesses | `apps/web/e2e/shots.mjs`, `user-journey.mjs`, `contrast-audit.mjs` |

Run these first:

```bash
cd ~/aftermath-maker && git fetch origin && git status --porcelain   # must be empty
git checkout -b ui/round8 origin/main
mkdir -p docs/design/round8   # save this message as AGENT_INSTRUCTIONS.md here, then commit it
```

---

## 1. Hard constraints

1. **Live stays off.**
    - Never change `LIVE_TRADING_ENABLED` or `ALLOW_MAINNET`.
    - Never edit `.env*` or the master key.
    - Never sign or broadcast.
    - Never call the production API.
    - Never connect a funded wallet.
2. **Never touch the production database.** That means no deletes, no migrations run by hand, and no scripts against it. Part B below covers the owner's question about deleting Core.
3. **Don't deploy.** Push and open a PR.
4. **Server changes are allowed only where this file names them** (A1, A3, A4 and B). Quoting, hedging, rotation, signing, Stop and the live gates don't change. The risk math doesn't change either, apart from B's narrowing of the gas reserve to Live bundles.
5. **The request layer stays.**
    - The same `request()` paths, methods and bodies are used.
    - The strategy save stays byte-identical for the same inputs, and the existing test keeps passing.
    - Flatten keeps its two-step confirm.
6. **The repo is public.**
    - Security details stay out of commits, PRs and issues.
    - Error messages never include secrets, keys, raw request bodies or stack traces.

---

## Part A. Errors that say what to fix

**Root cause.** `classifyHttpError` (`apps/control/src/http-error.ts`) turns any error without a `statusCode` into a 500 with the text "Internal server error". Most preconditions on the server are a plain `throw new Error(...)`: about 90 of them across `store.ts`, `runtime-manager.ts` and `server.ts`. So the UI shows "Internal server error (reference req-9j3)" for things the user can fix:

- "Wallet gas reserve is too low to start this bundle" (13 times since the last deploy);
- "A strategy already uses that name" (twice);
- "Attach a strategy before starting this bundle";
- "{MARKET} is already quoted by {bundle}…";
- "The selected Maker account is not authorized";
- "Only Core can use Live mode";
- and others.

**A1. A typed user error (server).**

- **Add the class.** Put a `UserFacingError` in `http-error.ts`:
    - `statusCode` (default 409);
    - `code` (a short stable id such as `gas-reserve-low`, `strategy-name-taken`, `needs-strategy`, `market-taken`, `account-not-authorized`, `live-core-only`);
    - `message` (one or two plain sentences that say what to do);
    - an optional `fix`: `{ kind: "venues" | "strategy" | "bundles" | "accounts" | "copy", value?: string }`.
- **Convert every throw a user can hit** from these routes:
    - start, resume, pause;
    - bundle create and edit;
    - strategy create, save, rename and delete;
    - wallet limits;
    - account setup;
    - paper trial.
- **List them in the PR** as a table of file:line, code and message.
- **Unknown errors stay 500**, with the generic text and the reference.
- **The gas message names the numbers and the address.** For example: "Couldn't start Core live. Its trading key has 0.08 SUI for gas and needs at least 0.50 SUI to pay for cancels and hedges." Use `fix: { kind: "copy", value: <agentAddress> }`, taken from the runtime snapshot's `agentAddress`.
- **The response body** is `{ error, code, fix? }` for 4xx. Keep `requestId` on 5xx only, as today.

**A2. The web shows the real message and the fix.**

- **In the run status row** (`lib/run-state.ts` `startErrors`), show the message in amber-text. Show a link chosen by `fix.kind`:
    - "Authorize it in Venues";
    - "Open Strategy";
    - "Open Bundles";
    - "Copy trading key address", which copies to the clipboard and confirms with "Copied".
- **Strategy name conflicts** show inline under the name field: "Another strategy already uses this name." This is the Kit's field error style. They no longer show as a notice.
- **Only a true 5xx** shows "Maker couldn't {action} {bundle}. Reference {req-id} is in your control log."

**A3. Durable, owner-scoped request-error log (server).** This closes the observability gap: today generic API failures exist only in the container logs.

- **Record an audit event** in `setErrorHandler`, when the request has `makerAuth`:
    - `category: "request"`;
    - `action`: a stable route name, e.g. `bundle-start`, `strategy-save`;
    - `outcome`: `"rejected"` for 4xx or `"error"` for 5xx;
    - `detail`: `{ status, code?, message: <publicMessage>, reference: request.id, bundleId?, strategyId? }`.
- **Never store** internal messages, stack traces, bodies or headers.
- **Throttle it** to one event per (owner, action, code or message) per 60 s, so a retry loop can't flood the table.
- **Auth failures** (401 and 403) are not recorded per owner. They stay in the logs.

**A4. Every event has a sentence, and the fixtures use real ones.**

- **Narrate the new kinds.** `lib/audit-events.ts` gets sentences for `request:*:rejected` and `request:*:error`, built from `detail.message`, the bundle name and `reference`.
- **Fix the fixture names.** The narration covers every literal kind the server emits today. Every Desk capture shows ten "Maker recorded an unclassified control event." lines because `e2e/fixtures/control.ts` uses names the server never emits (`quote-confirmed`, `engine-started`, `market-cycle-completed`). Replace them with real kinds.
- **Keep it from drifting.** Export one list, `AUDIT_EVENT_KINDS`, from the server: every `category:action:outcome` it can record, including the ones whose outcome is computed. Add a web test that fails if any kind has no sentence.
- **The Desk control log gets a two-option filter:** "All" and "Problems" (warnings and errors). It uses the Kit's segmented control.

**A5. Landing: the waiting button stays short** (`components/access-screen.tsx:303`).

- While busy, the button reads "Check your wallet", with a 14 px spinner.
- Under it, a `role="status"` line reads: "Approve the sign-in message in your wallet. Signing is free and moves no funds."
- Use "…", not "...", everywhere in that file.

**Accept:**
- A route test table covers each converted error and asserts a 4xx with its `code` and message.
- With the `paper-running` fixture plus a mocked 409 on `bundles/:id/start`, the run status row shows the message and its fix link.
- A forced 5xx records one `request:*:error` audit event that the Desk log shows with its reference.
- The narration-coverage test passes.
- No fixture capture shows "unclassified".
- The landing button doesn't wrap at 390 or 1440.

---

## Part B. Paper isn't blocked by the Live gas reserve

**Root cause.** `assertStartGasReserve` (`runtime-manager.ts:286`) reserves gas for cancels, hedges and a safety buffer across every running bundle, whatever the mode. Paper never signs or broadcasts, so it never pays for any of that. With live gates off in production, every one of the 13 "gas reserve" rejections was a Paper start.

**B1. Count only Live bundles in the reserve.**
- Compute the reserve only over Live configs, with the Live bundles' resting orders.
- A Paper candidate needs at most one simulation's gas: check whether `simulateTransaction` in `packages/aftermath/src/gateway.ts` needs a gas coin with a budget. If it does, require `maxGasMist` for the candidate. If it doesn't, require nothing.
- Write down what you found in the PR.
- The Live path is unchanged.
- The Strategy paper test run (`runPaperTrial`, which calls the same guard) gets the same rule.

**B2. Tests.**
- A Paper start with gas below the Live reserve succeeds.
- A Live start below the reserve fails with the A1 message.
- Mixed: a running Live bundle plus a Paper start reserves only for the Live one.

**On "delete Core for everyone in the DB":** don't. Core is woven through the store:
- the legacy runtime resolves to it (`coreRuntimeBundleId`);
- legacy config writes sync to it (`writeCoreConfig`);
- Live is Core-only.

Deleting it would break those paths for every owner. The "Internal server error (req-97n)" on Core was most likely this same masked gas error. Ship A and B, and the owner will retry. If Core still fails, the new log line will say why. If the owner then still wants a clean slate, write an RFC for an owner-run reset script (dry-run by default, backup first). Don't write the script this round.

**Accept:** B2's three tests pass, and A1's route test includes the Live gas case.

---

## Part C. Strategy: summary first, edit on demand

**C1. New strategy opens on Goal.**
- `createStrategy()` (`maker-dashboard.tsx:1438`) names the strategy with the first unused "Strategy N". Today `strategies.length + 1` can collide and throw.
- It sets `strategyStep` to 0 and enters edit mode.
- It focuses and selects the name field. The name field is a 48 px input styled as the 30/650 title.
- Above the field, show "New strategy" in 13.5/600 ink-2.
- Under it, show: "Starts from {current strategy}'s settings. Nothing changes for your bundles until you attach it."
- A quiet "Discard" button deletes the new strategy through the existing delete flow, as long as it's unused.
- `selectStrategy()` also resets the step: it opens the summary if the strategy is complete, or Goal if it isn't.

**C2. A finished strategy opens as a summary.**

When every `strategySteps` entry is complete and `!configDirty`, render a summary instead of the stepper:

- **Header:**
    - a quiet menu button "{n} strategies ⌄" that replaces the picker card;
    - the name (32/650) with a "Saved" tag, which is a tide-soft pill;
    - "Used by {bundles}. Last saved {date} at {time}.";
    - on the right, "New strategy" (secondary) and "Edit strategy" (primary).
- **"What Maker will do":** one card holding a 19/520 sentence built from the config. It's the same text the builder's side panel shows.
- **One card, a 2×2 grid split by hairlines.** Each cell has a title and an "Edit" link that enters edit mode at that step, and its own rows:
    - **Goal:** "Aim for" and "Risk profile".
    - **Markets:** "Chosen" ("5, picked by hand" or the rule name), "Custom settings" (the symbols), and one chip per market. Markets with overrides get a tide-soft "MON, 2 custom" chip.
    - **Size and limits:** quote size per side, spread, largest position in one market, total position, and stop after drawdown.
    - **Hedging:** on or off, and where.
- **"Bundles using it":** names, mode tag and state chip, plus "A saved change reaches each bundle the next time it starts."
- **Delete** sits as a quiet button at the bottom. It's disabled, with a reason, while bundles use the strategy.

**C3. Edit mode.**
- **Stepper:** a numbered stepper (Goal, Markets, Size and limits, Hedging, Review). It shows progress only.
- **Navigation:** Back and "Save and continue to {next}". The last step reads "Save and finish", which returns to the summary.
- **The side panel** "What Maker will do" stays at 340 px.
- **Remove the old furniture:**
    - the picker card with its all-caps "STRATEGY" label;
    - the floating pencil button;
    - "Draft Strategy" and "Applied elsewhere as … until strategy finalized" (`maker-dashboard.tsx:5167–5173`);
    - the white outlined "New strategy" and "Delete" buttons.
- **Leaving with unsaved changes** uses the existing in-app sheet, never a browser dialog.

**C4. The Review step stops showing raw JSON.** `reviewMarketChanges` uses `JSON.stringify`. Write each change as a sentence instead, for example: "MON: spread 42 → 30 bps. Largest position: strategy → $2.00."

**Accept:**
- New strategy lands on Goal with the name selected.
- Selecting a complete strategy shows the summary, and Edit on its Markets cell opens step 2.
- Two quick New strategy clicks never collide on a name.
- No JSON appears in Review.
- Captures at 1440 and 390 are committed.

---

## Part D. Markets: a clean table and an in-place policy editor

**D1. The table.** It's one card titled "Aftermath markets", with the sub "4 in use by your bundles, 1 available." On the right of the header: a 6 px tide dot and "Updated 2 s ago".

| Column | Content |
| --- | --- |
| Market | the symbol (620), with the display name under it in 12.5 ink-3 |
| Bundle | the name plus the Paper or Live tag; otherwise "Not in a bundle" in ink-3 |
| State | a 7 px dot plus one phrase: Quoting, Waiting for first quote, Paused, Needs attention, or Available |
| Policy | "Strategy" in ink-3, or a tide-soft pill "{n} custom" whose title lists the fields; "—" for available markets |
| Price | formatted by the market's `tickSize` (BTC $79,621.1, not $79,621.1328) |
| Open interest | USD compact, with a 72 × 3 px capacity bar under it in tide; the title and aria read "{pct}% of the venue limit" |
| 24h volume | USD compact |
| Funding | signed, 4 decimals, ember when negative |
| Position | the inventory, or "—"; the unrealized result under it in ember or tide only when it isn't zero |
| (Edit) | a 32 px secondary "Edit" with `aria-label` "Edit {SYMBOL} policy", in use rows only |

- **Group rows:** "In use" and "Available", 13/620, with the count in ink-3. They're sentence case, never all caps.
- **Row height:** 60.
- **Remove:**
    - the Venue column (bring it back as a filter only when there are 2+ venues);
    - the separate OI capacity column;
    - the Freshness column;
    - the raw addresses in the market cell;
    - "Checking this market";
    - the dry-run text and transaction link in State, which belong on Desk;
    - the "Edit Core policy" link.
- **Sort headers** are real buttons with an arrow. Their hit area is ≥32 px on desktop and ≥44 px on phone. `shots.mjs` currently fails on these at 15 px.
- **The table scrolls** inside a horizontal-scroll box in the card. The page never does.

**D2. The policy editor sheet.** Edit opens a right-side sheet over Markets: 440 px wide, full height under the nav, over a `rgba(16,18,22,.14)` scrim. On phone it's a full-screen sheet. It doesn't navigate to Strategy.

- **Header:**
    - "{SYMBOL} policy" (19/650);
    - "Part of {strategy}, used by {bundle names}.";
    - a 40 px close button.
- **Intro:** "Empty fields use the strategy's value. Anything you set here applies to {SYMBOL} in every bundle that uses {strategy}."
- **Six rows**, one per `makerMarketOverridesSchema` field, at least 64 px high and split by hairlines:

  | Label | Field | Unit |
  | --- | --- | --- |
  | Quote size | `quoteSizeUsd` | $ prefix, note "per side" |
  | Spread | `spreadBps` | bps suffix |
  | Largest position | `maxInventoryUsd` | $, "long or short" |
  | Target position | `inventoryTargetUsd` | $ |
  | Inventory skew | `inventorySkewBps` | bps |
  | Leverage | `maxLeverage` | × |

- **Each row:**
    - the label (14/600) with a note under it;
    - a 132 px right-aligned field;
    - a 36 px reset button.
- **Empty means inherit.** The placeholder shows the strategy's value, and the note reads "Strategy value".
- **A typed value means custom.** The border is `rgba(8,113,107,.55)` and the weight 620. The note reads "Custom. Strategy uses $1.04" in tide-text, and the reset button is enabled.
- **Out of range** uses the schema's limits. The border and note turn ember: "Spread must be between 8 and 500 bps." Save stays disabled.
- **Footer:**
    - "Use strategy for all" (quiet) on the left;
    - "Cancel" (secondary);
    - "Save to {strategy}" (primary), disabled until something has changed and everything is valid.
- **Save:**
    - It loads that strategy, sets `markets[i].overrides` (an empty object becomes undefined), and saves through the same strategy-save request the builder uses.
    - A notice says "Saved {SYMBOL} policy to {strategy}."
    - The row's Policy cell updates, and focus returns to its Edit button.
- **If the strategy has unapplied builder changes**, the sheet is read-only, with an amber-soft note: "{strategy} has changes you haven't applied yet. Apply or discard them in Strategy, then come back to edit {SYMBOL}." Add an "Open Strategy" link and hide Save.
- **One editor.** Delete the "Saved effective policy · per-market exceptions" block in Strategy › Size and limits. In Strategy › Markets, each selected market gets an Edit that opens this same sheet component. There is only one policy editor in the app.

**Accept:**
- At 1440, Markets has no column cut off and no row taller than 60.
- The sheet's three states (all inherited, invalid, blocked) are captured.
- Saving a spread override changes the strategy body by exactly that field (unit test).
- The sort and Edit hit areas pass `shots.mjs` at 390.

---

## Part E. One kit, applied everywhere

Today each view invents its own:
- page header;
- buttons: at least six styles, including fill pills, black pills, black rectangles, white outlined rectangles, an outlined black "Claim rewards" and oversized grey "Edit"/"Archive";
- tables: four different styles;
- containers: cards inside cards, a dashed card, grey boxes and full-bleed tables;
- numbers.

Make these parts once, in `components/ui/primitives.tsx` and `globals.css`, then use them everywhere. Delete the one-off classes they replace.

**E1. The kit.**

- **Content width:**
    - max 1200;
    - side padding 32, or 24 at 1024–1279, or 16 on phone;
    - the same left edge on every view.
- **Page header:**
    - h1 32/650, `font-stretch: 110%`, letter-spacing −0.02em;
    - a 15 px ink-2 sentence under it;
    - actions on the right, bottom-aligned;
    - 40 px above and 28 below;
    - no eyebrow labels ("Wallet desk", "Running bundles", "Last 24 hours").
- **Card:**
    - surface background, radius 18, padding 24, shadow `0 1px 1px rgba(16,18,22,.04)`, 16–20 px between cards;
    - title 17/650 with one 13.5 ink-2 line under it, actions on the right;
    - inside a card, group with a hairline or a soft panel (`rgba(22,24,29,.035)`, radius 12);
    - never a card inside a card, a dashed border, or a full-row color fill.
- **Buttons:**
    - Actions are rectangles: radius 12, height 40, or 32 in table rows, or 44 on phone. Text is 13.5/600, or 650 for primary and danger.
    - **Primary:** ink background, white text.
    - **Secondary:** `--fill` background, ink text.
    - **Quiet:** transparent, ink-2 text, `--fill` on hover.
    - **Danger:** ember-soft background, ember-text.
    - **Link:** tide-text 600, underlined on hover.
    - **Disabled:** `rgba(22,24,29,.12)` background, ink-3 text.
    - A menu button gets a trailing chevron, and an external link a trailing external icon.
- **Pills mean state or a filter, never an action:**
    - status chip: 28 px, dot plus word;
    - mode tag: 20 px, radius 6;
    - count or custom tag: 24 px, tide-soft.
- **Choosers:**
    - The segmented control matches the nav tabs (fill background, padding 3, 32–34 px items, the active item on surface with a shadow).
    - Option tiles are radius 14, with an inset 1 px border; when selected, the border is 2 px ink.
- **Fields:**
    - 40 px high, radius 10, 1 px `rgba(22,24,29,.14)` border;
    - the unit inside the field;
    - numbers right-aligned;
    - a focus ring of tide-text plus a 3 px tide-soft halo;
    - the error border and note in ember-text.
- **Tables:**
    - header 12.5/600 ink-2 at 40 px, with a bottom hairline;
    - rows ≥52 px, split by hairlines;
    - no vertical lines, zebra stripes or colored rows;
    - numbers right-aligned;
    - group rows in sentence case with a count;
    - wide tables scroll inside their card.
- **Stats:** the label 13 ink-2, the value 28–30/640 (20/640 for secondary stats), with no boxes around them.
- **Numbers:**
    - one utility applies `tabular-nums` to every money, price and count, so no element mixes figure styles;
    - monospace only for addresses and transaction digests;
    - money ≥$1 with 2 decimals; under $1 with up to 4 significant digits; prices by tick size; percentages 1 decimal (funding 4);
    - never show "−$0.00".
- **Copy:** sentence case everywhere. No all-caps labels (STRATEGY, IN USE, AVAILABLE, CORE, RIGHT NOW). No "A · B · C" meta strings where a sentence reads better.
- **The tour banner** becomes a surface card with:
    - the 28 px mark;
    - "New to Maker?" (14/620);
    - "A 30-second tour of the desk, strategies and the run control.";
    - "Not now" (quiet) and "Take the tour" (primary).

  The teal band and the white box buttons go.

**E2. Per view.**

- **Desk:**
    - The hero stays.
    - "Running bundles" plus "Bundles" becomes one heading, "Bundles on the desk".
    - Lanes sit on the same grid and left edge as the Risk card.
    - A lane's height fits its content: no 300 px of empty white when the book is sparse.
    - "RIGHT NOW" becomes a sentence.
    - Risk bars: tide under 75%, amber at 75–90%, ember above 90%.
    - Gas runway gets a real bar.
    - The Markets mini-table:
        - one-line state words;
        - no "A" venue badge on each row;
        - policy shows "Strategy" or "{n} custom".
    - The Fills card loses its teal and red row fills. Only the side word is colored.
    - The control log:
        - plain rows, per Kit;
        - no inner grey panel (today it stops short of the card's right edge);
        - the A4 filter.
    - Flatten aligns with the facts row.
- **Strategy:** Part C.
- **Markets:** Part D.
- **Bundles:**
    - The header follows the kit. Today the h1 is 48 px with −0.05em tracking, on a 1180 px page (left edge x=130), with a "Wallet desk" eyebrow. Markets and Venues use 34 px at x=120.
    - "2 of 4 active" must match the cards shown; it shows 2 cards. Investigate it and report.
    - The Core card's teal outline goes.
    - The result value uses the stat style.
    - Edit and Archive become 32 px secondary buttons, not 44 px pills with 15 px text.
    - Cards in a row share a height.
- **Performance:**
    - **Header:** a page header with "Results from Maker's own fills, after known costs." On the right, the 24h | Epoch | All time segmented control and an "All bundles ⌄" menu (it replaces "By wallet | Core | Rewards | Before bundles").
    - **Coverage:** "100.0% traced" becomes a tide-text line with a check: "Every maker fill in this period is traced to a bundle."
    - **The results card:**
        - four stats in one row: Net known result, Volume, Fills, Estimated rewards;
        - a hairline;
        - two definition lists replace the misaligned 6- and 4-column grids:
            - "Maker side": fills, notional, realized, fees, maker result;
            - "Hedge side": account, orders filled, notional, hedge result;
        - a final "Combined known result" row.
    - **Cards:**
        - "By market" becomes its own card (it's nested today);
        - "Recent fills" uses the kit table (today it's full-bleed with vertical lines);
        - "Rewards" puts six stats in a row, with "Claim on Aftermath ↗" as a secondary button;
        - "Is the goal working?" rows have a status icon and no teal row fill, and a "Your goal" tag marks the chosen goal.
    - **Remove:**
        - "Strategy opportunity" (the round 4 review asked for market ranking to live in Strategy › Markets);
        - "Method and limits" as a floating `<details>`. It becomes a quiet "How these numbers are measured" disclosure.
    - **Phone:** fix the 418 px overflow.
- **Venues:**
    - **Header:** a page header with the sub "Where Maker trades, what it's allowed to do there, and what your accounts hold."
    - **The venue card:**
        - "Aftermath" (20/650) with a "Connected, quoting" status chip, and "Open Aftermath ↗" on the right;
        - a 3 × 2 facts grid: Network, Collateral, Markets selected, Trading key ("Trades only" / "It can't withdraw or move funds"), Venue fee, Gas ("2.99 SUI" / "About 244 paid actions after the reserve");
        - no grey "A" letter avatar.
    - **The Accounts card:**
        - the sub "Equity $14.89, exposure $2.08 of your $16.00 wallet limit.";
        - the kit table (Account with its number under the name, Role, Equity, Exposure, Unrealized);
        - group rows by bundle;
        - "Manage accounts" (secondary) and "New account" (primary).
    - **"Exposure by venue"** goes; its one row is the Accounts sub line. Bring it back when there are 2+ venues.
    - **"Execution boundary"** (dashed card, numbered circles) becomes a plain card, "What Maker can and can't do here", with three bullets. "Revoke trading key…" is a danger button in that card, opening the existing confirm.
    - **Phone:** fix the 404 px overflow. On the Accounts view, fix the tap targets: "View trading-key permission" is 18 px and "Revoke this key" 36 px.

**Accept:**
- All of these return nothing outside tests and docs:
    - `rg -n "eyebrow" apps/web/components`;
    - any all-caps label;
    - any dashed border;
    - any nested `.card .card`.
- The page header has the same x on all six views at 1440, 1180 and 1024.
- One table component renders every table.
- `shots.mjs --view all` passes at every size **without disabling any check**.
- `contrast-audit.mjs` passes in light and dark.

---

## Evidence and report

- Commit before and after captures for every view at 1440, 1024 and 390, in light and dark, plus:
    - the policy sheet's three states;
    - the strategy summary;
    - New strategy on Goal;
    - a run status row with a 409 fix link;
    - the Desk log with a request error.
- The PR body holds:
    - the Accept table (done, partly done or not done, with the evidence path);
    - the A1 conversion table;
    - the B1 finding on simulation gas;
    - anything you decided that this file didn't cover;
    - the last lines of `npm run check` and the three harnesses.

## Out of scope

- Deleting or resetting Core, or any production data.
- Multi-venue UI.
- Live mode and the Go Live review.
- New quoting, hedging or risk behavior.
