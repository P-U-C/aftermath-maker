# Agent instructions: Maker UI, spread identity

You are implementing a front-end redesign of Maker (`P-U-C/aftermath-maker`, web app in `apps/web`). The design is fully specified in this folder. The work is presentation only: the trading engine, risk limits, auth, and the security fixes from the external audit must behave exactly as they do today.

Read this whole file before you change anything.

---

## 0. Context

| Item                | Value                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Repo                | `~/aftermath-maker` (expected `/home/ubuntu/aftermath-maker`)                                                                   |
| Base                | tag `external-audit-remediation-v1`, commit `6b1ffe1`                                                                           |
| Branch to create    | `ui/spread-identity`                                                                                                            |
| This bundle         | `~/aftermath-maker/docs/design/maker-ui-handoff/`                                                                               |
| Main file today     | `apps/web/components/maker-dashboard.tsx` (about 4,400 lines, data and UI mixed)                                                |
| Styles today        | `apps/web/app/globals.css` (about 3,000 lines)                                                                                  |
| Layout and metadata | `apps/web/app/layout.tsx`                                                                                                       |
| API access          | every call goes through `request()` to `/api/control/<path>`, which is proxied by `apps/web/app/api/control/[...path]/route.ts` |
| Checks              | `npm run check` runs format:check, typecheck, tests, and build                                                                  |

```bash
cd ~/aftermath-maker
git fetch --tags origin
git status                      # must be clean; stop and report if it is not
git checkout -b ui/spread-identity external-audit-remediation-v1
git log --oneline -1            # expect 6b1ffe1
```

---

## 1. Hard constraints (these override everything else in this bundle)

1. **No change to trading behavior.** Do not edit `apps/control/**`, `packages/**`, `move/**`, `deploy/**`, `Dockerfile`, `docker-compose.yml`, `scripts/**`, or `audits/**`. If a design element needs data the API does not return, do not add it to the server. Log it in `DATA_GAPS.md` (section 5) and render what is available honestly.
2. **Live stays off.** Never set or change `LIVE_TRADING_ENABLED` or `ALLOW_MAINNET`, and never edit any `.env*` file or the master key. Never sign or broadcast a transaction, never connect a funded wallet, and never call the production control API. Do not test Live against the retained audit accounts or the production deployment. Nothing in the guide authorizes it.
3. **Do not deploy.** Push the branch and open a pull request. Deploying is a human decision.
4. **Keep every remediation fix.** Do not loosen `securityHeaders` or the CSP in `apps/web/next.config.ts`. Do not add external origins. Keep the `request()` helper's paths, methods, bodies, and `cache: "no-store"` exactly as they are. Keep every confirm step: the Flatten two-step (`flattenArmed`), setup provision/confirm/revoke, the operator whitelist confirms, and the live-gate checks that use `liveGates`.
5. **Stop is never disabled while anything is running.** Today Stop shares a button with Start and is disabled when `busy` is truthy (`toggleRuntime`, around line 2440). Split it into two buttons. Start keeps its current disable rules. Stop calls the same `api/runtime/stop` request, is enabled whenever `snapshot?.running` is true, and ignores `busy`. If the server answers a Stop sent mid-action with an error, show that error inline under Stop, leave the button enabled, and record the behavior in your report. Do not change the server to "fix" it.
6. **No external requests at runtime.** Fonts are self-hosted (section 3, step 1). No CDNs, analytics, or remote images.
7. **No fake data in the product.** The mockups contain illustrative numbers. In the app, every figure must come from an existing API field or be computed from one. If a field does not exist, say less, for example "This run" instead of "Today", or hide the element, and log the gap.
8. **No test backdoors.** Do not add query flags, env switches, or code paths to the app that bypass auth or fake a wallet. Screenshots use browser-level route mocks only (section 4).
9. **Small, reviewable commits.** Make one commit per step in section 3. Each commit must pass `npm run check`.

If any instruction in the design documents conflicts with these constraints, the constraints win. Note the conflict in your report.

---

## 2. Sources of truth, in order of precedence

1. Section 1 above.
2. **Existing behavior.** If a mockup implies a flow the code does not have, or skips a confirm the code has, the code's behavior wins and the visuals adapt.
3. **`mockups/maker2.css`, `mockups/mark.js`, and `mockups/*.html`** for exact values: tokens, sizes, radii, spacing, and markup structure. These produced the renders.
4. **`docs/01-visual-polish-audit.md`** for look, brand, copy, venue neutrality, and screen-by-screen rules.
5. **`docs/02-ux-design-review.md`** for layout, information architecture, controls, and states the polish audit does not cover. Its "keep warm paper, frames, mono" advice is superseded. Its "Accounts" tab is now "Venues".
6. **`mockups/renders/*.png`** are the visual targets for screenshot comparison.

Open the mockups in a browser: run `cd docs/design/maker-ui-handoff/mockups && python3 -m http.server 8090`, then visit `http://localhost:8090/desk.html`. Add `?theme=dark` for dark mode; `desk.html?sheet=1` shows the Go-Live sheet. Opening the files directly also works, but the font may not load from `file://` in some browsers.

---

## 3. Steps

Do them in order. Each step lists what to build and how it is accepted. "Mockup" means the matching file in `mockups/`.

### Step 0: Harness and baseline (no UI change)

- Add a screenshot script, for example `apps/web/e2e/shots.mjs`, using the repo's existing `playwright-core` devDependency. It starts nothing itself. Run it against `npm run dev -w @puc/web` (port 8788) or a local `next start`.
- Mock the API in the browser with `page.route("**/api/control/**", ...)`. Serve fixtures from `apps/web/e2e/fixtures/` that satisfy the existing TypeScript types (`AccessIdentity`, `OperatorStatus`, `SetupState`, `MakerConfig`, `Snapshot`, `Performance`, `RewardDashboard`, `AuditEvent`, `LiveGates`, and so on). Make fixtures for at least these states: signed out, not on the access list, onboarding, Paper running, Live running (with `liveGates` false, as it really is), and stopped. Base the values on the public figures in `audits/2026-10-27-mainnet/` screenshots. Do not copy any real key, cookie, or secret.
- Each run captures 1440×900 and 390×844 (device scale 2), in light and dark (`colorScheme`), plus one run with `reducedMotion: "reduce"`. It also fails on console errors and on horizontal overflow (`document.documentElement.scrollWidth > innerWidth`).
- Capture a **baseline** of the current UI into `apps/web/e2e/shots/baseline/`. Do not commit the PNGs if they are large; list them in the PR instead. If the dashboard needs a connected wallet object to render a state, capture what renders and note it.
- If Chromium is missing on this machine, `npx playwright install chromium` is fine, but do not commit browser binaries.

Accept: the script runs green on the untouched UI and produces the baseline set. `npm run check` passes.

### Step 1: Tokens, type, and mark (about 2 days)

- Replace the `:root` palette in `globals.css` with the tokens in `mockups/maker2.css` (`--canvas … --icon-bg`), and add the `[data-theme="dark"]` set. Also apply the dark set under `@media (prefers-color-scheme: dark)` when the root has no explicit `data-theme`. Change `color-scheme: light` to follow the theme. Delete the body grid background.
- **Font.** Add `@fontsource-variable/mona-sans@5.3.0` to `apps/web`. Prefer `next/font/local` pointed at its `files/mona-sans-latin-standard-normal.woff2` and `files/mona-sans-latin-ext-standard-normal.woff2`, with `weight: "200 900"`, `declarations: [{ prop: "font-stretch", value: "75% 125%" }]`, `variable: "--font-mona"`, and `display: "swap"`. If `next/font/local` cannot resolve from `node_modules`, copy those two files and `LICENSE` into `apps/web/app/fonts/`. Importing `@fontsource-variable/mona-sans/standard.css` is an acceptable fallback. Remove the unused `Inter` and `Georgia` stacks.
- Set the type roles from the polish audit's Type table. Width is the hierarchy: `font-stretch: 125%` for money, 112–122% for titles, 100% for the interface. Use proportional figures by default. Use `font-feature-settings: "tnum" 1` only in aligned data columns (prices, sizes, PnL in tables), as `maker2.css` does.
- Remove the uppercase tracked eyebrows (about 33 `text-transform: uppercase` rules) and monospace for data (about 68 references). Keep monospace only for transaction digests and full addresses.
- **Mark.** Create `apps/web/components/spread-mark.tsx`, a port of `mockups/mark.js`, with `state: "stopped" | "paper" | "live"` and `size`. Derive the state from runtime data: not running is `stopped`; running in `live` is `live`; running in `paper` or `observe` is `paper`. Animate capsule positions over 240 ms (instant under reduced motion).
- Replace `app/icon.svg` with the stopped mark. Optionally swap the favicon by state on the client. Change metadata to title `Maker`, with a description that does not name a venue.

Accept: a token-only screenshot diff shows the new palette and type everywhere with no layout breakage. No request leaves localhost for fonts (check the network log). Contrast holds: Tide text `#0A7C75`, Ember text `#C42A20`, and Amber text `#9A5B00` on white are all ≥ 4.5:1.

### Step 2: Venue descriptor (1–2 days)

- Add `apps/web/lib/venues.ts` exporting a `VenueDescriptor` type (`id`, `name`, `glyph`, `network`, `collateral`, `feeModel` text, `gasUnit`, `accountRoles`, `explorerTxUrl(digest)`) and one entry for Aftermath built from facts already in the code.
- Replace the hardcoded "Aftermath" strings in `maker-dashboard.tsx` (about 15) and the `suiscan.xyz` links with descriptor fields. Add a `VenueChip` component: monochrome glyph on `--fill`, never venue brand colors.
- Copy renames: agent capability → "trading key"; builder fee → "venue fee" (keep "1 bp on filled orders"); "gas on Sui" only where the network matters.

Accept: `grep -n "Aftermath" apps/web/components` finds nothing outside the descriptor. The public page names Aftermath once ("Live on Aftermath. More venues on the way.").

### Step 3: Primitives (2–3 days)

- Build, in light and dark: Button (primary graphite, quiet, stop/Ember, sizes), Pill (live, paper, neutral), segmented Tabs, Input with unit suffix and inline error, Toggle, Card, List row (52 px, hairline inset 24 px, no vertical rules), Meter (graphite fill, Amber within 30% of a limit, Ember at the limit), Sheet (30 px radius, scrim plus 10 px blur), and Toast (material, bottom center, `aria-live="polite"`; errors use `role="alert"`).
- Add number helpers in `apps/web/lib/format.ts`: signed money with a true minus (−); no negative zero and no colored zero; $ at 2 decimals from $1 up and 4 significant figures below; prices at the market's tick; relative time under a minute, clock time after.
- Add unit tests for `format.ts` (vitest is already in the repo).

Accept: a primitives page or story-like fixture renders all states in both themes. Format tests cover −0, sub-cent values, and BTC prices.

### Step 4: Shell (2 days)

- A frosted nav (`--material` plus a 22 px blur) holds the mark and "Maker" on the left, the tabs Desk, Strategy, Markets, Performance, and Venues, and the mode pill and account on the right. Keep a single page and sync the active view to the URL hash (`#desk` and so on). Do not add server routes.
- The Live rail is a 2 px Ember line fixed at the top while anything is live. State shows only in the mark, the rail, and the pill. Remove the Live and Paper banners.
- Split `maker-dashboard.tsx` into view components (`views/desk.tsx`, `views/strategy.tsx`, and so on). Keep data loading, polling, and handlers where they are or in a hook. Move markup, not logic, and keep every handler's body unchanged.
- Operator-only tools (whitelist confirms, integrator inspector) move to an operator section under Venues or Settings. They stay reachable and only render for operators, as today.

Accept: all tabs reachable by keyboard; each view renders from fixtures; no handler diff beyond moved lines (call this out in the PR).

### Step 5: Desk (4–5 days)

Target `mockups/desk.html` and `renders/desk-light.png` / `desk-dark.png`.

- The hero is PnL across all venues, in expanded numerals. Use the window the API actually has (likely run or known result) and label it truthfully. Beside it: equity, exposure, and last fill.
- The ladder card shows our bid and ask capsules around index or fair value, with the spread in bps and a venue chip. Use a venue switcher in the card header if more than one venue is quoting.
- Risk meters: gross exposure, worst-case inventory, run drawdown, and gas runway as "x of limit" bars.
- Markets list: one row per market with a venue chip, status, inventory, and PnL.
- Fills, and a PnL line only if a series exists. Otherwise, omit the line and log the gap.
- **Stop** (Ember, filled) is top right and always enabled while running, per constraint 5. **Flatten…** is a quiet pill that opens the existing two-step confirm, restyled as a sheet.
- Each live card shows "Updated 2 s ago" in `--ink-3`, which turns Amber after two missed polls.
- Move the reward-ranking table off the desk (it goes to Markets in step 7).

Accept: matches the renders in structure and tokens at 1440×900 in both themes. Stop is enabled in the fixture where `busy` is set mid-action. There is no page-level horizontal scroll.

### Step 6: Sign-in, Venues, Go-Live sheet (3 days)

- **Sign-in:** follow `mockups/signin.html`. Use one graphite "Connect wallet" call to action; drop the duplicate in the header. Add the three trust facts, the spread illustration, and the risk line. A wallet that signs but is not on the list lands on a calm "You're not on the list yet" screen with Request access, not a 403 banner. If no request-access endpoint exists, use a `mailto:` or a link the operator configures, and log it.
- **Venues:** follow `mockups/venues.html`. The venue card shows network, collateral, trading key, venue fee, gas, markets selected, and accounts with their roles. Add an "Add another venue" card with the three steps, and an "Exposure by venue" table with an "All venues" row. Use real values from setup and config. Only wire Manage and Revoke to existing flows; if there is no flow, hide the button.
- **Go-Live sheet:** follow `desk.html?sheet=1`. Listing order: venues, markets, size per side, maximum exposure, worst case at limits, hedge, fees, how to stop, then one deliberate confirm. When `liveGates` blocks Live, the Live option is disabled with the plain reason "Live trading is off on this server". Never show env var names to members.

Accept: the three screens match their renders. The not-on-list state is covered by a fixture. Live cannot be selected in any fixture, because gates are false.

### Step 7: Strategy and Markets (4–5 days)

- **Strategy:** grouped lists titled Capital, Risk profile, Markets, Hedging, and Advanced (collapsed). Show Cautious, Balanced, and Active as three cards, each listing the values it sets. Group the market picker by venue, with a filter chip row. Put units inside fields. Validate inline. Show a Discard/Save bar only when the config is dirty. The same `api/config` payload must be sent; only the form layout changes. Add glossary tooltips for bps, OI capacity, Q-score share, reduce-only, skew, and divergence.
- **Markets:** the reward ranking moves here. Show one row per market per venue, with a venue filter and sortable columns. Rank bars are graphite.

Accept: saving the same inputs produces a byte-identical request body to the baseline. Prove it in a test that captures the routed request.

### Step 8: Phone (3 days)

Target `mockups/phone.html` and `renders/phone-light.png` / `phone-dark.png` at 390×844.

- Show a large title with the lit mark and the mode pill, then cards for PnL, ladder, risk, and markets.
- Tabs become a horizontally scrollable pill row under the title.
- A material dock above the home indicator holds Flatten… and Stop while anything is running.
- Fix the control-log overlap and truncation. Each event shows date, time, severity, and a one-line human sentence.
- Strategy edits open as a full-height sheet.

Accept: no horizontal scroll at 390 px, all text ≥ 12 px, and tap targets ≥ 44 px.

### Step 9: Finish (2 days)

- Under `prefers-reduced-motion`, all motion is instant.
- Add visible focus rings (2 px graphite, offset 2 px).
- Screen-reader labels on the ladder ("Your bid 0.021393, ask 0.021484, spread 42 bps") and on meters (`role="meter"` with value text).
- Add `aria-pressed` on mode buttons.
- Do a contrast pass in both themes.
- Optional: hotkeys for Stop (`Shift+S`), Flatten (`Shift+F`, which opens the confirm), and Refresh (`R`). Disable them while typing in inputs.

Accept: the full screenshot set is green. Run an axe pass if you add `@axe-core/playwright` as a devDependency; it is optional, and `npm audit` must stay at zero. Fix or justify every reported issue.

---

## 4. Verification for every step

```bash
npm ci
npm run format            # then commit the formatting
npm run check             # format:check + typecheck + tests + build, must pass
npm audit --omit=dev      # must report 0 vulnerabilities
node apps/web/e2e/shots.mjs   # your harness: 1440x900 + 390x844, light + dark, reduced motion
```

- Compare each new screenshot with the matching file in `mockups/renders/`. Match structure, tokens, type roles, and spacing. Pixel equality is not expected, because real data differs.
- Zero console errors. No horizontal overflow. No network request leaves `localhost`.
- Mocks are browser-level only. Never point the harness at `maker.permanentupperclass.com` or any production API.

Out of scope, but please check and report: the design review notes that `https://maker.permanentupperclass.com/` answered with a 302 to `http://`. Run `curl -sI` against it. If it still downgrades, say so in the report. Do not edit `deploy/` in this branch.

---

## 5. Data gaps

Create `docs/design/maker-ui-handoff/DATA_GAPS.md` and add one line per gap: the design element, the field it needs, what you rendered instead, and the suggested API change. Likely candidates:

- a "today" PnL window
- a PnL time series
- gas runway in days
- markouts at 1 s, 10 s, and 60 s
- maker/taker and fee sign on fills
- a request-access endpoint
- per-venue rollups once a second venue exists

These are proposals for a later, separately reviewed server change.

---

## 6. Copy rules

- Sentence case everywhere. No uppercase labels above titles. One title per card.
- Maker's nouns are desk, market, venue, and trading key. A venue's name comes only from the descriptor.
- Write numbers with a true minus (−). Never print "−$0.00", and never color a zero.
- An error says what failed, names the venue when relevant, and says what to do next. Never show env var names, stack traces, or raw event IDs to members.
- An empty state has one sentence and one button ("Pick markets to start", "Add a venue").
- Keep the honest framing that exists today ("Net known result", "not total profit").

---

## 7. Definition of done

- All nine steps are committed on `ui/spread-identity`, each passing `npm run check`, with `npm audit --omit=dev` at 0.
- The screenshot set matches the renders for desk (light and dark), sign-in, venues, the Go-Live sheet, and phone (light and dark).
- The diff touches nothing outside `apps/web/**`, `docs/design/**`, and the root `package.json`/`package-lock.json`. Run `git diff --stat external-audit-remediation-v1...HEAD -- . ':!apps/web' ':!docs/design' ':!package.json' ':!package-lock.json'` and confirm the output is empty.
- No handler, request path, or request body changed. The Strategy save test proves the body is identical.
- Stop is enabled while running, even with an action in flight.
- Live gates are untouched. No transactions were signed. Nothing was deployed.

## 8. Report back

Open a PR to `main` titled "UI: spread identity and venue-neutral desk". Also write the same content to `docs/design/maker-ui-handoff/IMPLEMENTATION_REPORT.md`:

1. A summary in three sentences.
2. A table of steps 0–9, with the commit SHA, what changed, and the check result for each.
3. Screenshot paths, before and after, for each target render.
4. Deviations from the mockups, and why.
5. Stop behavior observed when pressed mid-action (server response).
6. The `DATA_GAPS.md` contents.
7. The HTTPS redirect check result.
8. The final `npm run check` and `npm audit --omit=dev` output tail.

If you are blocked by a constraint, stop at the end of the current step, commit what passes, and report the blocker. Do not work around a constraint.
