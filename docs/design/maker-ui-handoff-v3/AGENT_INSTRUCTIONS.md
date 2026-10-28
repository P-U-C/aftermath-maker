# Agent instructions: Maker v3.1, explain, theme and bundles RFC

You are continuing the Maker redesign (`P-U-C/aftermath-maker`). The v2 spread identity has shipped. This round has four parts:

- fixes contrast and makes one theme cover the whole app;
- makes the product explain itself;
- rebuilds Strategy and Performance;
- adds the market-making animation and a new landing page.

The round ends with an RFC for **bundles**: several maker/taker account pairs, each running its own strategy. You write the RFC and stop. You do not build bundles in this round.

Read this whole file before you change anything. The design is in `docs/03-product-audit.md` and `mockups/`.

## What changed in v3.1

v3.1 replaces two parts of v3. Everything else is unchanged.

- **The mark.** The two-capsule mark is redrawn on a 16-unit grid with a 45° step, a continuous-corner tile, colours tuned for the tile, a small cut for 16 to 20 px, and live, paper and stopped states. The source is `mockups/mark.js`, and the figure is `docs/images/mark.png`. See step A1b.
- **The market animation.** `mockups/motion.js` is now the mirrored book. Asks rise above the price on the right and bids hang below it on the left, and the animation opens on the mark. It replaces the earlier strip. See step A4.
- **Order-book depth on the desk.** A8 gains a third read-only field, `snapshot.market.book`, filled from the order book the runtime already fetches, so the desk draws the real book. The owner approved it on Oct 28, 2026. See steps A4 and A8.

If you already started from v3:

- **If only the v3 bundle is committed:** bring this bundle in from `handoff/ui-v3.1` (section 0) and commit it as `docs: update Maker handoff to v3.1`.
- **If A1, A4 or A5 already landed:** keep those commits, and add one commit per affected step that brings it to v3.1.
- **If you committed the v3 bundle as it came in the zip:** it contains the security items. Do not push that commit. Replace the bundle with this copy, and squash or drop the old bundle commit before any push.

---

## 0. Context and setup

| Item | Value |
| --- | --- |
| Repo | `~/aftermath-maker` (expected `/home/ubuntu/aftermath-maker`) |
| Base | `origin/fix/wallet-control-and-theme` (`f3c9afb`) if it is not merged into `main` yet; otherwise `origin/main`. Record which one in the PR. |
| Branch to create | `ui/v3-explain-theme` |
| This bundle | `~/aftermath-maker/docs/design/maker-ui-handoff-v3/` |
| Previous handoff | `docs/design/maker-ui-handoff/` (v2). Still valid for the identity, venue neutrality and copy rules. v3 wins where they differ. |
| Main UI files | `apps/web/components/maker-dashboard.tsx` (data and handlers), `components/views/*.tsx`, `components/ui/primitives.tsx`, `app/globals.css`, `lib/format.ts`, `lib/venues.ts` |
| Harnesses | `apps/web/e2e/shots.mjs`, `apps/web/e2e/contrast-audit.mjs` (on the fix branch), `apps/web/e2e/fixtures/` |

**Treat this machine as shared with other services.** Before you start anything:

- Do not run `docker`, `docker compose`, `systemctl` or `nginx`.
- Do not edit anything outside the git checkout, and never touch a database outside it.
- Run your dev server on **port 8899**: `npx next dev -p 8899` or `next start -p 8899`. First check that the port is free with `ss -ltn`.

This copy of the bundle is safe to commit to the public repo: it leaves out the security items, which the owner sends you directly. It reaches you one of two ways: as a zip from the owner, or on the branch `handoff/ui-v3.1` (`origin/fix/wallet-control-and-theme` plus one docs commit).

```bash
cd ~/aftermath-maker
git fetch --tags origin
git status --porcelain            # must be empty, except docs/design/maker-ui-handoff-v3/ (the bundle)
# If anything else is dirty or untracked: stop and report.
git merge-base --is-ancestor origin/fix/wallet-control-and-theme origin/main && BASE=origin/main || BASE=origin/fix/wallet-control-and-theme

# From the zip, new start: unzip into docs/design/ (it creates maker-ui-handoff-v3/), then
git checkout -b ui/v3-explain-theme "$BASE"
git add docs/design/maker-ui-handoff-v3 && git commit -m "docs: add Maker v3.1 handoff bundle"

# From the branch, new start, instead of the two lines above:
#   git fetch origin handoff/ui-v3.1
#   git checkout -b ui/v3-explain-theme origin/handoff/ui-v3.1
#   [ "$BASE" = origin/main ] && git rebase --onto origin/main origin/fix/wallet-control-and-theme

# Already working on ui/v3-explain-theme from v3: check it out, put this bundle in place
# (unzip over the folder, or: git checkout origin/handoff/ui-v3.1 -- docs/design/maker-ui-handoff-v3), then
#   git add docs/design/maker-ui-handoff-v3 && git commit -m "docs: update Maker handoff to v3.1"
```

Record which base you used in the PR.

---

## 1. Hard constraints (these override everything else)

1. **Live stays off.**
    - Never set or change `LIVE_TRADING_ENABLED` or `ALLOW_MAINNET`.
    - Never edit `.env*` files or the master key.
    - Never sign or broadcast a transaction.
    - Never connect a funded wallet or call the production control API.
    - Do not test Live against the retained audit accounts or the production deployment.
2. **Do not deploy.** Push the branch and open a pull request. Deploying is a human decision.
3. **No trading behaviour change.**
    - Phase A is web-only (`apps/web/**`, `docs/**`, root package files), with exactly two exceptions:
        - step A8, which adds three read-only fields;
        - steps S1 and S4, which are security fixes.
    - Neither exception may change any quoting, hedging, risk, rotation, signing or Stop decision.
    - The diff for A8, S1 and S4 is limited to response shaping and the fixes the owner briefs, each with tests.
4. **No bundle code.** Step B0 is a document only. Do not change the config schema, the runtime manager, the store tables used by trading, or the request bodies of trading routes.
5. **Keep every remediation fix.**
    - The CSP and security headers in `next.config.ts` stay as they are.
    - The `request()` paths, methods, bodies and `cache: "no-store"` stay as they are.
    - Every confirm flow stays: Flatten two-step, setup provision/confirm/revoke, operator whitelist confirms, and the `liveGates` checks.
    - The strategy save must send a byte-identical `POST api/config` body for the same inputs. The existing test must keep passing.
6. **Stop is never disabled while anything is running.** Keep the separate Stop control and its 409 handling from v2.
7. **No external requests at runtime.** No CDNs, analytics or remote images. Fonts stay self-hosted.
8. **No fake data in the product.**
    - On the desk, the animation is driven only by real snapshot values and real fills and hedges. Simulated takers, sweeps, "someone else traded" and the illustrative book depth appear only on the landing page and the Learn view, labelled "Illustration".
    - A figure the API does not provide is omitted or labelled honestly, and logged in `DATA_GAPS.md`.
9. **No test backdoors.** Do not add query flags, env switches or code paths that bypass auth or fake a wallet in the app. Mock at the browser level only, using the existing fixtures and the fix branch's wallet-standard mock.
10. **One commit per step,** each passing section 4.

If anything in the design conflicts with these constraints, the constraints win. Note the conflict in your report.

---

## 2. Sources of truth, in order

1. Section 1.
2. Existing behaviour and data. If a mockup shows something the API does not return, the mockup adapts.
3. `mockups/maker3.css`, `mockups/mark.js`, `mockups/motion.js`, `mockups/coach.js` and `mockups/*.html`, for exact tokens, geometry, sizes and structure.
4. `docs/03-product-audit.md`, for intent, copy, rules and the bundle model.
5. The v2 handoff, for anything v3 does not cover.

To view the mockups, run `cd docs/design/maker-ui-handoff-v3/mockups && python3 -m http.server 8090`, then open `http://localhost:8090/desk3.html`. Add `?theme=dark` for dark mode. Other views are `desk3.html?explain=1`, `desk3.html?book=0` (the desk before A8, best prices only) and `strategy3.html?step=3`. The pages are `landing.html`, `learn.html`, `bundles.html`, `strategy3.html`, `performance3.html` and `phone3.html`.

**Important:** in Phase A there are no bundles yet. Wherever a mockup shows a second bundle ("Rewards"), build the single-bundle version:

- one desk lane;
- the strategy builder works on today's single config;
- the nav keeps Strategy, and Accounts moves under Venues.

The Bundles tab and the by-bundle tables come in B2.

---

## 3. Steps

### A1. Tokens, the 12 px floor and the contrast gate (2 days)

- Apply the token changes from the audit's "Token fixes" table to `globals.css`. The exact values are in `mockups/maker3.css`:
    - `--ink-3` becomes `#676c77` (light) and `#8e94a0` (dark);
    - new `--stop: #d83427` with `--on-stop: #fff`;
    - new `--amber-bar`;
    - `--on-tide`;
    - the Live pill text uses `--ink`, and its dot uses `--ember`;
    - selected segments in dark get a 1 px inner light ring.
- Stop and every destructive fill use `--stop`, never `--ember`. Never put white text on Tide.
- Enforce a 12 px minimum font size in every view at every width. Most violations are 9 to 11 px labels in the legacy panels.
- Extend `apps/web/e2e/contrast-audit.mjs` so it fails on any visible, enabled text below 4.5:1 (3:1 for 24 px and up, or 18.66 px bold) **or** below 12 px. It runs on every view, for every fixture state, in light and dark, at 1440 and 390. `tools/contrast_fn.js` in this bundle is the measuring function I used; reuse it or keep yours.

**Accept:** the contrast audit reports 0 failures in both themes, and the report includes its output.

### A1b. The mark (1 day)

Replace the v2 mark everywhere with the refined one in `mockups/mark.js`.

- **Write `components/maker-mark.tsx`** with `state` (`"live"`, `"paper"` or `"stopped"`) and `size` props. Port the geometry exactly:
    - the 16-unit viewBox and the continuous-corner tile path `MAKER_TILE`;
    - master capsules 8 × 3.5 with a 1.5 gap and a 3 overlap;
    - the small cut at 20 px and below: 8 × 4, gap 2, overlap 2, so it lands on whole pixels at 16 px;
    - colours `#FF6F61` for the ask and `#22C7BA` for the bid, on the tile;
    - paper draws the capsules as `#C9CDD3` outlines; stopped lines them up in `#5E636E`;
    - the tile is `var(--icon-bg)` with a 1 px `var(--mark-edge)` hairline. Add `--mark-edge` to `globals.css` from `maker3.css`: transparent in light, 10% white in dark.
- **State changes animate.** The capsules slide apart (stopped to live or paper) or back into line, 240 ms ease-out, using `transform: translateX`. Under reduced motion they jump.
- **The lockup** is `wordmarkHTML()` as a component:
    - the tile at 1.08 em and a 0.38 em gap;
    - "Maker" in Mona Sans 640, width 118%, tracking −2%;
    - the text nudged up 0.035 em so the tile centres on the capitals.
- **Favicons:**
    - three static SVGs from the small cut: `icon-live.svg`, `icon-paper.svg` and `icon-stopped.svg`;
    - swap `<link rel="icon">` when the desk state changes;
    - add a 180 px `apple-touch-icon.png` from the master on the ink tile.
- Use the mark in the nav, the phone header, the landing page and the sign-in screen.

**Accept:**

- The nav, phone header and favicon match `mockups/renders/` and `docs/images/mark.png`.
- The favicon changes with state in the shots harness.

### A2. Legacy surfaces onto shared components (4 to 5 days)

Rebuild these from `components/ui/primitives.tsx`. Don't restyle the old markup in place.

- **Performance:**
    - Remove the hairline cells and the teal and gold bands.
    - Every money value goes through `lib/format.ts`, so there is no "-$0.00".
    - Rank starts at 1.
    - Nothing clips at the right edge. Wide tables get their own `overflow-x: auto` container.
- **Accounts:**
    - Move it under Venues as an "Accounts" section.
    - Keep every action and its confirms: new account, deposit, withdraw, assign maker or taker role, name and tags, revoke trading key.
    - Visible copy says **"Taker"** instead of "Hedge". Code identifiers stay.
- **The Markets table:** 12 px headers in `--ink-2`, with no tinted band.
- **Strategy internals:** the "Maker path" and "Hedge path" summary and every 9 to 11 px label.
- **The Venue fee inspector:** move it to an operator-only section with ordinary styling. It is still only visible to operators.
- **The onboarding card:** use standard card styling, not an inverted black card. Keep the 0/2 progress.
- **The footer:** remove the slash-joined string. Keep at most one plain line, or nothing.
- **The control log:** don't clip the time column ("5:08 PN"). Show date, time, severity and the sentence.
- **The phone dock:** opaque `--surface` background.

**Accept:**

- No view uses a component-local colour literal.
- Screenshots of every view match the v3 look in both themes.
- Every account action still works against the fixtures. The shots harness already exercises names and tags; extend it to role assignment.

### A3. Explain layer (4 days)

- **`lib/glossary.ts`:** one entry per term listed in the audit's "Learning built in" section, each with a one-sentence plain definition and an optional "See it animated" link to `#learn`. The fix branch's `glossary-term.tsx` tooltip reads from it.
- **`lib/narrate.ts`:** the "Right now" sentence built from the snapshot, using the audit's template table.
    - Drop any clause whose value is missing.
    - Unit-test every template, including missing-value cases.
- **A caption under the desk market strip, and plain status words:** "Quoting now", "Up next, 12 s", "Waiting its turn" and "Paper". This replaces "healthy" and "queued".
- **Column headers on the desk Markets list,** including "Unrealized P&L" with a `?`.
- **The run drawdown row:**
    - It shows the real value once A8 lands; until then, "Not reported".
    - Add the sentence "Stops if it falls $X from its best point this run."
    - Add a link to Strategy › Size and limits.
- **Explain mode:**
    - A nav switch that places up to 5 numbered notes on the current view. Port `mockups/coach.js` positioning into a React component.
    - Each note has a title and one or two sentences, and points at a real element.
    - A first-run tour turns it on once. Store the "seen" flag in `localStorage` inside try/catch, and it must work without storage.
    - Esc closes it. Focus is handled.

**Accept:**

- `narrate` tests pass.
- Every desk number has either a header or a `?`.
- Explain mode renders on Desk, Strategy, Markets, Performance and Venues without overlapping off-screen. Check at 1440 and 390.

### A4. Market motion component and Learn view (4 days)

`mockups/motion.js` (v3) draws the order book mirrored around the price. Asks rise above it on the right, bids hang below it on the left, and your ask and bid rest as capsules just above and just below the line. Port it to `components/market-motion.tsx`: SVG, `requestAnimationFrame`, the springs as written, no library.

- **What it draws:**
    - **The opening, once per mount.** The two capsules appear as the mark and hold for 0.6 s. Then they part to their prices while the price line draws out and the book grows from the middle.
    - **The book** as thin bars on an absolute price grid, so it slides as the price moves, under a camera that follows the price.
    - **The readout** (your ask, market, your bid, spread) at the top left, and the inventory meter with the taker account at the bottom right.
    - **Fills.** The taker's dot lands on your capsule, the capsule folds into a dot, and the dot drops into the inventory meter. A new order grows back at the new price.
    - **Hedges.** A dot leaves the taker account and takes from the front of the book, and the meter returns to zero.
- **Two modes:**
    - **`live`** (`sim: false`):
        - Call `update({ mid, bid, ask, bestBid, bestAsk, inventoryUsd, book })` from each snapshot: the index price, your quotes, the venue's best bid and ask, inventory, and `snapshot.market.book` from A8. Positions glide between polls.
        - Call `fill(side)` only when a new attributed fill appears (a new `orderId` in `performance.fills`).
        - Call `hedge()` only when `hedge.lastDigest` changes.
        - There are no simulated takers, no sweeps and no "someone else traded" events.
    - **The book in live mode** comes only from `snapshot.market.book`.
        - `motion.js` sums the levels into its price bins and draws each bar at its real resting size, scaled at the 90th percentile so one large order can't flatten the rest. It adds no breathing, envelope or noise in live mode.
        - When `book` is null (before A8 lands, or for a cycle without a fresh book), draw only the venue's best bid and best ask, one bar each. `motion.js` does exactly this for `book: null`.
        - Never draw illustrative depth on the desk.
        - If A4 lands before A8, ship the best-prices fallback, and switch to the book in the A8 commit.
    - **`illustration`** (the default): the simulation and its small director. It runs only on the landing page and Learn, with the visible label "Illustration".
- **Behaviour:**
    - Under reduced motion, render one settled still frame with its caption and no loop. `update()` redraws it.
    - Pause when off screen (IntersectionObserver) or when the tab is hidden.
    - Read colours from the CSS variables. The book's tints are stronger in dark mode (`tintBoost`), as in `motion.js`.
    - Use the compact layout in each desk lane.
    - Under 620 px wide it switches to the phone layout by itself. Text is scaled to land near 13 px on screen, and never under 12 px.
- **Learn view:** add it at `#learn` (no server route), following `learn.html`. Link the five chapters to the motion events `fill`, `queue`, `skew` and `hedge`.

**Accept:**

- In a fixture where a fill is added between two polls, the desk animates exactly one fill.
- In a fixture with no new fills, no dot ever appears on the desk.
- With the fixture book, the desk draws one bar per occupied price bin and nothing else. With `book: null`, it draws only the venue's best bid and ask.
- The reduced-motion screenshot passes, and the illustration's opening frame shows the mark.

### A5. Landing page (2 days)

- Follow `mockups/landing.html`. The headline is "Your own market-making desk. Working for you.", with the full-width illustration animation below it.
- Keep these unchanged: the connect flow, the access-request flow and the not-on-list screen. Only the visuals and copy change.
- Aftermath is named once, at the foot.
- Remove any personal email address or `mailto:` from the page. The in-app request form is the only way to request access.

**Accept:** matches `renders/landing.png`, `landing-dark.png` and, at 390 px, `landing-phone.png`. The shots harness's access-request path still passes.

### A6. Strategy builder over today's config (5 days)

- Replace the long Strategy form with the five-step builder in `strategy3.html`: Goal, Markets, Size and limits, Hedging, Review.
    - The step list shows each step's current answer.
    - The right side, or the left column on narrow screens, shows the live "What Maker will do" sentences.
- **Quick picks.** All read `rewards.marketModel.opportunities` from `rankRewardMarkets`:

    | Pick | Rule |
    | --- | --- |
    | Best for rewards | Top 3 eligible by `farmingScore` |
    | Balanced | Top 5 `objectiveEligible` by `bothScore` |
    | Quiet books | `thinActive`, top 5 by `farmingScore` |
    | Steadiest | Eligible, sorted by the absolute value of `priceChange24hPct`, ascending, top 5 |
    | Clear | Selects nothing |

    - Respect `MAX_SELECTED_MARKETS`.
    - Market rows show reward potential (the objective score as a 0 to 100 bar), edge after fees (`preRiskEdgeBps`), 24 h volume and `reasons[0]`.
- **Move "Stage rotation" and the focus and count controls from Performance into the Markets step.** They keep calling the same staging logic and send the same requests.
- **Markets tab rows** get "Add to strategy". In B2 this becomes "Add to bundle".
- **Limits are written as sentences** with inline inputs, mapped to:
    - `maxRunDrawdownUsd`
    - `maxInventoryUsd`
    - `maxGrossExposureUsd`
    - `maxUnrealizedLossUsd`

    Everything else goes under Advanced: refresh, staleness, divergence, leverage, requote, resting and dwell.
- **Mode** (Observe, Paper or Live) moves to Review. It keeps the `liveGates` behaviour and the Go-Live sheet.

**Accept:**

- The byte-identical config body test passes.
- A new test checks that each quick pick produces the expected markets from the fixture.
- Every field from the old form is still reachable.

### A7. Performance v3 (3 days)

- **Stat row:** net result, volume (maker plus taker), fills and estimated rewards, with the Today, Epoch and All time segments.
- **Volume by market:**
    - Maker volume and fills per market are computed from `performance.fills`.
    - Taker volume per market comes from A8 when it's present; otherwise show only the taker total.
    - Show share of volume and net.
    - Each row expands to its fills.
    - If `historyComplete` is false, say how many fills the table covers.
- **The Rewards card** in plain words, as in `performance3.html`. Check the unit of `rewards.account.uptime` before labelling it: show "Time your quotes qualified" as a percentage only if it is a fraction, and log any doubt in `DATA_GAPS.md`.
- **"Is the goal working?"** replaces "Pass condition / Current evidence / Still unmeasured".
- **Remove "By bundle"** until B2.

**Accept:** matches `renders/performance.png` and `performance-dark.png`, with real fixture values.

### A8. Three read-only API fields (2 days, server)

- **`snapshot.risk = { runDrawdownUsd, runHighEquityUsd, measuredAt }`:** take the values the runtime already computes for the run-drawdown check (`runtime.ts`, near the `runDrawdownUsd` calculation). Expose them; do not recompute them differently.
- **`performance.volumeByMarket`:** an array of `{ marketId, symbol, makerNotionalUsd, makerFills, takerNotionalUsd, takerFills, realizedPnlUsd, feesUsd }`, built from the same history the response already uses.
- **`snapshot.market.book`:** the order-book depth for the desk animation. The owner approved this field on Oct 28, 2026.
    - **Shape:** `{ bids: [price, size][], asks: [price, size][], observedAt } | null`. Sizes are in base units, as the SDK returns them.
    - **Source:** the `orderbook` the cycle already fetches in `runtime.ts` (`const { market, orderbook } = await this.gateway.getOrderbook(selected.marketId)`).
        - Make no new network call.
        - Read nothing else.
    - **Contents:**
        - Up to 50 levels per side: `orderbook.bids` keeps its order (best first, descending), and `orderbook.asks` keeps its order (ascending).
        - Drop any level whose price or size is not a finite positive number.
        - `observedAt` is the same timestamp as `market.updatedAt`.
    - **Where it's set:** in the same snapshot write that sets `market.bestBid` and `market.bestAsk`.
        - It is `null` in `initialSnapshot()`.
        - It is `null` whenever the selected market has no fresh book this cycle, so a stale book never sits under a new market.
    - **Types:**
        - Add `book` to `RuntimeSnapshot.market` in `packages/core/src/schema.ts`.
        - It goes only on the selected market, not on the `markets[]` rows.
    - **It feeds nothing.** It must not reach `buildQuoteIntent`, risk, rotation, hedging or Stop. The observation passed to `buildQuoteIntent` stays byte-identical.
- **Tests:**
    - all three fields;
    - for the book: it is null before the first cycle; it is capped at 50 levels per side; it keeps the order; it drops bad levels;
    - quote output is unchanged when the book is deeper or shallower.
- **Web fixtures:** add `book` to the MON market in `apps/web/e2e/fixtures/control.ts` from `mockups/fixture-book.json`. Add a second fixture state with `book: null`.
- Run `git diff` to confirm that no trading decision code changed. Paste the A8 diff summary in the report.

### S1 to S5, security items (2 to 3 days, server)

The owner sends these to you directly. This repo is public, so they are not written here.

- Treat them as part of this round, with the same constraints as A8: tests for every change, and no trading decision touched.
- Until the fixes merge, keep their details out of commit messages, PR text, issues and anything you commit. Name them only as "S1" to "S5".
- Send the report-only findings to the owner directly, never in the repo.

### B0. Bundles RFC, then stop (2 days)

Write `docs/rfc/0001-bundles.md` from the audit's Bundles section. It covers:

- the SQL migration, with the existing config becoming bundle "Core" and a rollback;
- the API, including `/api/config` compatibility;
- the runtime manager keyed by wallet and bundle, with gateway sharing;
- how wallet-level limits are aggregated, and when they're checked;
- the gas reserve formula;
- what happens when one bundle errors while others run;
- the Stop all and Pause semantics;
- enforcement of one account per bundle and one market per bundle;
- the bundle cap;
- a test plan, including proof that a single bundle produces byte-identical orders to today;
- the scope of the independent retest.

**Then stop.** Commit the RFC and report. Do not write any bundle code until the owner approves the RFC in writing.

---

## 4. Verification for every step

```bash
npm ci
npm run format && npm run check       # format, typecheck, tests, build: must pass
npm audit --omit=dev                  # 0 vulnerabilities
node apps/web/e2e/shots.mjs --base-url http://127.0.0.1:8899 --view all   # every state, 1440/390, light/dark/reduced
node apps/web/e2e/contrast-audit.mjs  # 0 failures (A1 onwards)
```

The pass bar for each step:

- No console errors, no page-level horizontal overflow, and no request that leaves `localhost`.
- Screenshots compared against `mockups/renders/`. Structure and tokens must match; pixel equality is not expected.
- Under reduced motion, nothing animates.

---

## 5. Copy rules (in addition to v2)

- Plain words for states: "Quoting now", "Up next", "Waiting its turn", "Paused" and "Paper". Never use raw engine words.
- "Taker account" in the UI; "hedge" only in code.
- Every number on the desk has a header, a label or a `?`.
- The "Right now" sentence is assembled from templates only. Never use generated or guessed text.
- Money uses 2 decimals on heroes and stats, with the exact value in a tooltip. Use a true minus sign, never "-$0.00", and never colour a zero.

---

## 6. Definition of done

- A1, A1b and A2 to A8, S1 and S4 are committed on `ui/v3-explain-theme`, each passing section 4. The S2 and S3 findings went to the owner directly.
- The contrast audit shows 0 failures in both themes, and the 12 px floor holds everywhere.
- The legacy surfaces are rebuilt on the shared components, and dark mode reads correctly in every view.
- The desk explains itself (Right now, captions, headers, `?`, Explain mode), and the animation is driven by real data on the desk.
- The refined mark is in the nav, phone header and favicons, with its three states.
- The strategy builder, quick picks, Performance v3 and the landing page match the mockups.
- `docs/rfc/0001-bundles.md` is written. No bundle code exists.
- Live gates are untouched, nothing was signed, nothing was deployed, and no production service was touched.

## 7. Report back

Open a PR titled "UI v3: explain, one theme, strategy builder, motion". Also write `docs/design/maker-ui-handoff-v3/IMPLEMENTATION_REPORT.md` with:

1. A summary in three sentences, and which base branch you used.
2. A step table: commit SHA, what changed and the check results.
3. The contrast audit's output, before and after.
4. Screenshot paths for each target render.
5. Deviations from the mockups, and why.
6. The `DATA_GAPS.md` contents.
7. The A8 diff summary, with confirmation that no trading decision changed. For S1 and S4, the same confirmation and the test names only.
8. A note that the S2 and S3 findings were sent to the owner directly. Do not put them in this file.
9. A one-paragraph summary of the B0 RFC and the open questions for the owner.
10. The tail of the final `npm run check` and `npm audit` output.

If a constraint blocks you, stop at the end of the current step, commit what passes, and report the blocker. Do not work around a constraint.
