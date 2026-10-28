# Agent instructions: Maker v4, finish the design, motion, Learn and bundles

You are continuing the Maker redesign (`P-U-C/aftermath-maker`). v3.1 is merged. A review found about half of it done to spec; it is in `REVIEW.md` in this bundle, with screenshots. Read it first.

This round has four parts, in this order:

- **Part F** finishes what v3.1 left undone: money and words, the strategy builder, Performance, the phone layout, and tooling.
- **Part M** adds a small motion system and the rest of the landing page.
- **Part L** rebuilds Learn and Explain so they teach and point without covering anything.
- **Part B** builds bundles in two phases, B1 and B2, following RFC 0001. **It starts only after the owner's written approval** (section 3B).

Two rules come from the last round:

- **Mark a step done only when its Accept line passes.** If it partly passes, say "partly done" and list what's missing. The last report marked every step done; the screens disagreed.
- **Commit the screenshots** you use as evidence (section 7). Paths under `/tmp` can't be reviewed.

---

## 0. Context and setup

| Item | Value |
| --- | --- |
| Repo | `~/aftermath-maker` |
| Base | `origin/main` once the PR `fix/connect-button-and-motion` has merged; until then, `origin/fix/connect-button-and-motion`. Record which in the PR. |
| Branch to create | `ui/v4` |
| This bundle | `docs/design/maker-ui-handoff-v4/`, on the branch `handoff/ui-v4` |
| Design reference | `docs/design/maker-ui-handoff-v3/mockups/`: `maker3.css`, `mark.js`, `motion.js`, `coach.js` and the `*.html` pages. They are still the design. |
| Bundles design | `docs/rfc/0001-bundles.md`, and `bundles.html` in the v3 mockups |
| Main UI files | `apps/web/components/maker-dashboard.tsx`, `components/views/*.tsx`, `components/ui/primitives.tsx`, `app/globals.css`, `lib/format.ts` |
| Motion engine | `apps/web/lib/market-motion-engine.js` (the mockup engine mounted as-is) and `components/market-motion.tsx` (its React wrapper) |
| Harnesses | `apps/web/e2e/shots.mjs`, `apps/web/e2e/contrast-audit.mjs`, `apps/web/e2e/fixtures/` |

**Treat this machine as shared with other services.**

- Do not run `docker`, `docker compose`, `systemctl` or `nginx`.
- Do not edit anything outside the git checkout.
- Run your server on **port 8899**. Check that it is free with `ss -ltn` first.

```bash
cd ~/aftermath-maker
git fetch origin
git status --porcelain            # must be empty; if not, stop and report
git merge-base --is-ancestor origin/fix/connect-button-and-motion origin/main \
  && BASE=origin/main || BASE=origin/fix/connect-button-and-motion
git checkout -b ui/v4 "$BASE"
git checkout origin/handoff/ui-v4 -- docs/design/maker-ui-handoff-v4
git add docs/design/maker-ui-handoff-v4 && git commit -m "docs: add Maker v4 handoff"
```

---

## 1. Hard constraints (these override everything else)

1. **Live stays off.**
    - Never set or change `LIVE_TRADING_ENABLED` or `ALLOW_MAINNET`.
    - Never edit `.env*` files or the master key.
    - Never sign or broadcast a transaction.
    - Never connect a funded wallet or call the production control API.
    - Do not test Live against the retained audit accounts or the production deployment.
2. **Do not deploy.** Push the branch and open a pull request. Deploying is a human decision.
3. **Parts F, M and L are web-only** (`apps/web/**`, `docs/**`, root package files). They change no quoting, hedging, risk, rotation, signing or Stop decision.
4. **The bundles gate.**
    - Do not write bundle code until the owner has approved RFC 0001 in writing, with the decisions in section 3B. If you don't have that approval, finish F, M and L, then stop and report.
    - B2 starts only after B1 is merged.
    - Multi-bundle Live (B3) is out of scope. The server must refuse Live for any wallet that has more than one bundle that isn't stopped, unless decision 5 is approved and its test passes.
5. **Keep every remediation fix.**
    - The CSP and security headers in `next.config.ts` stay as they are.
    - The `request()` paths, methods, bodies and `cache: "no-store"` stay as they are.
    - Every confirm flow stays: Flatten two-step, setup provision, confirm and revoke, operator whitelist confirms, and the `liveGates` checks.
    - The strategy save sends a byte-identical `POST api/config` body for the same inputs. The existing test keeps passing.
6. **Stop is never disabled while anything runs.** In B2, Stop all is never blocked by one bundle's state or by a gas check.
7. **No external requests at runtime.** No CDNs, analytics or remote images.
8. **No fake data in the product.** On the desk, the animation shows only snapshot values and real fills and hedges. The illustration runs only on the landing page and Learn, labelled "Illustration".
9. **No test backdoors.** Mock at the browser level only, with the existing fixtures.
10. **The repo is public.** Security details stay out of commits, PRs and issues. Report security findings to the owner directly.
11. **Don't rewrite the motion engine.** `lib/market-motion-engine.js` is `mockups/motion.js` mounted as-is, plus the live-mode fixes its header describes. Extend it only as step L1 says, keep its structure, and list every change in the report.
12. **One commit per step,** each passing section 4.

If the design conflicts with these constraints, the constraints win. Note the conflict in the report.

---

## 2. Sources of truth, in order

1. Section 1.
2. Existing behaviour and data. If a mockup shows something the API doesn't return, the mockup adapts.
3. `REVIEW.md`, for what is wrong now.
4. The v3 mockups and `docs/03-product-audit.md` in the v3 bundle, for tokens, structure and copy.
5. RFC 0001, for bundles.

Where a step names `renders/<name>.png`, it means `docs/design/maker-ui-handoff-v3/mockups/renders/<name>.png`.

To view the mockups, run `cd docs/design/maker-ui-handoff-v3/mockups && python3 -m http.server 8090`, then open `http://localhost:8090/landing.html`. Add `?theme=dark` for dark mode.

---

## 3. Steps

### Part F. Finish v3.1

#### F1. Money, words and time (1 day)

- **Money** goes through `lib/format.ts` everywhere.
    - Heroes and stats show 2 decimals, with the exact value in a tooltip. The desk hero reads "−$0.02".
    - Table cells may show sub-cent values to 4 decimals.
    - Use a true minus sign. Never show "−$0.00". A zero is "$0.00" and is never coloured.
- **Words never truncate.** Size the status column to its longest word, "Waiting its turn". Fill sides read "Bought" and "Sold" in full. Narrow rows wrap instead of cutting off.
- **The control log** shows date, time, severity and the sentence, with nothing clipped: "Oct 27, 5:08 PM".

**Accept:**

- Unit tests in `format.test.ts` for heroes, sub-cent values, zero and negative zero.
- A new `shots.mjs` check fails on any text element in the desk, markets, fills, log or performance tables whose `scrollWidth` is greater than its `clientWidth`.

#### F2. The strategy builder, for real (4 days)

This is v3.1 step A6, which isn't done. Build `strategy3.html`.

- **One step at a time.** Goal, Markets, Size and limits, Hedging, Review.
    - The tiles navigate, and Back and Next move between steps.
    - Each tile shows its current answer.
    - "What Maker will do" stays beside the steps, or above them on narrow screens.
- **Remove the old long form.** Every field it had must be reachable inside a step or under Advanced.
- **Size and limits** are four sentences with inline inputs: `maxRunDrawdownUsd`, `maxInventoryUsd`, `maxGrossExposureUsd` and `maxUnrealizedLossUsd`. Advanced holds refresh, staleness, divergence, leverage, requote, resting and dwell.
- **Mode** (Observe, Paper or Live) moves to Review, keeping the `liveGates` behaviour and the Go-Live sheet.
- **Move Stage rotation, the focus and count controls, and the market rank table** from Performance into the Markets step. They send the same requests as today.

**Accept:**

- The byte-identical config test passes.
- The quick-pick tests still pass.
- Screenshots match `renders/strategy-markets.png`, `strategy-limits.png` and `strategy-dark.png`.
- A test walks all five steps and saves without touching Advanced.

#### F3. Performance (1.5 days)

- Each market row in "Volume by market" opens to **its own** fills, filtered by market id.
- Ranks start at 1, wherever they end up after F2.
- Wide tables scroll inside their own `overflow-x: auto` container. Nothing clips, and the page never scrolls sideways.
- **"Is the goal working?"** follows `performance3.html`: one line per objective with a mark (✓, –, ?), a headline and its evidence. Remove Pass condition, Current evidence and Still unmeasured.

**Accept:** the screens match `renders/performance.png` and `performance-dark.png` with fixture values. No "−$0.00" appears anywhere.

#### F4. Markets, Venues and Accounts (1 day)

- **Markets rows:**
    - When a market isn't in the strategy, the row's action reads "Add to strategy".
    - When it is, the action is a selected "In strategy" toggle that removes it from the draft.
    - Both pass contrast and are at least 44 px tall on phone. Neither looks disabled.
- **The fee inspector** becomes an ordinary section that only operators see.
- **The inactive role toggle** on account cards passes 4.5:1.

**Accept:** the contrast audit passes, and the role-assignment path in the shots harness still passes.

#### F5. Phone (1.5 days)

- **Every tap target is at least 44 px,** including inline links such as "Size and limits". `shots.mjs` must pass its own check for every state.
- **The sticky Flatten and Stop bar reserves its height,** so it never covers content.
- **Tabs** follow `phone3.html`: pills that scroll sideways, the active pill kept in view, and a fade on the cut edge.
- Wide tables scroll inside their own container.

**Accept:** `node apps/web/e2e/shots.mjs --view all` passes in every state at 390, light and dark.

#### F6. The desk lane (0.5 day)

- Pass the engine a `height` so the animation fills the lane on desktop. About 300 at the compact width of 1000 is right; check it against `renders/desk.png`.
- The engine reads the hedge trigger at mount. A saved config change remounts it, which is expected. Don't pass props that change every poll into the mount dependencies.

**Accept:** no empty band under the animation at 1440, and `desk.png` and `desk-dark.png` match in structure.

#### F7. Tooling (0.5 day)

- Pin the time zone for web tests, for example `test.env.TZ = "UTC"` in the Vitest config, so `format.test.ts` passes anywhere.
- Make `shots.mjs --view all` skip views for states that have none, such as signed-out, instead of timing out.
- Add `"audit:ui": "node apps/web/e2e/contrast-audit.mjs"` to the root scripts, and run it in section 4.

**Accept:** `npm run check` passes with `TZ=America/Vancouver`.

### Part M. Motion and the landing page

#### M1. The motion system (2 days)

Motion has one rule: something moves only when the page first loads, when the person acts, or when real data changes. The tokens already exist in `globals.css` (`--ease-out`, `--ease-in-out`, `--dur-1` to `--dur-4`), and they are zeroed under reduced motion.

| Moment | Trigger | What moves | Timing |
| --- | --- | --- | --- |
| Landing entrance | First load | Done in the PR: headline, lede and button fade up in turn, then the stage fades in | Keep as is |
| View change | Tab click | The outgoing view fades out; the incoming view fades in with a 4 px rise; the active tab's pill slides to its new place | 160 ms out, 220 ms in. Use `document.startViewTransition` when available, with an opacity fallback |
| Number change | A poll changes a value | Old digits fade out as new ones fade in, on tabular figures | 200 ms |
| New fill or log row | A row arrives | The row opens to its height (grid rows 0fr to 1fr), then a Tide (bought) or Ember (sold) tint fades from it; log rows get a neutral tint | 200 ms, then a 1.2 s tint |
| Freshness | A poll succeeds | The "2 s ago" dot pulses once | 400 ms |
| Sheets and confirms | Go Live, Edit strategy, Stop and Flatten confirms | The backdrop fades and the sheet rises 12 px; on phone it slides up from the bottom | 320 ms in, 200 ms out |
| Strategy steps | Next, Back or a tile | The step content slides 16 px with a fade; only the changed clause of "What Maker will do" cross-fades | 240 ms |
| Explain notes | Explain on | Notes fade and scale up from 0.98 in number order; the target gets a ring | 200 ms each, 40 ms apart |
| Loading | Data slower than 300 ms | A still skeleton in the final layout, replaced by a 160 ms fade with no layout shift | Shimmer only after 1 s |
| Mark state | Paper, Live or Stopped | The capsules slide apart or into line | 240 ms ease-out (check that A1b's transition is in place) |

- Build it as a few small pieces: `components/ui/animated-number.tsx`, a `useRowEnter` hook, the view-transition styles and the sheet styles. Use no motion library.
- Animate only opacity and transform, except row height through grid rows.
- An action's result is never held back for an animation. Stop takes effect at once, and the motion follows.
- `aria-live` regions announce the final value only, never intermediate frames.

**Accept:**

- With reduced motion, `document.getAnimations()` is empty one second after any view loads.
- With no data change for 10 seconds, `document.getAnimations()` holds nothing. The market engine runs on `requestAnimationFrame` and doesn't count.
- A shots step changes a fixture value between two polls and captures the number mid-transition and after it.

#### M2. The rest of the landing page (1.5 days)

The PR built the hero, the animation stage and the entrance. Add the rest of `landing.html`:

- **Header links:** How it works, Safety and Request access, plus a Sign in button that is the secondary connect button.
    - How it works scrolls to `#how-it-works`, and Safety to `#safety`.
    - Request access opens the existing request flow.
- **"Watch how it works"** goes next to the connect button. It scrolls to the stage and replays the illustration from its opening (remount it).
- **The three moves** get their mini demos: the account pair, the quick-pick chips, and the mode switch.
- **"While you're away"**: four boxes as in the mockup. The example sentence uses the fixture values.
- **The trust row** moves to `#safety`.
- **A closing band:** "Open your desk." with a second connect button.
- **The foot line:** "Live on Aftermath", plus the risk line.
- Until B2 ships, keep today's sentence under "Set up your desk in three moves." The mockup's bundles sentence comes with B2.

Keep the connect flow, the access-request flow and the not-on-list screen unchanged.

**Accept:**

- The screens match `renders/landing.png`, `landing-dark.png` and `landing-phone.png`.
- The harness's access-request path passes.
- No page-level horizontal overflow at 390.

### Part L. Learning

#### L1. The Learn view (3 days)

Each chapter plays its own moment in the real animation.

**Engine extension** (list it in the report):

- Add a `director: false` option, so no simulated takers arrive on their own. Learn uses it.
- Add `play(name)`, which runs a script and then idles. A new `play()` cancels the one running.
- Add `pose(name)`, which sets the chapter's key frame and draws it once. It is for reduced motion.
- Emit `onEvent` for each beat, as today.

| Chapter | `play()` script | Key frame for `pose()` |
| --- | --- | --- |
| `spread` | Replay the opening: the mark holds 0.6 s, parts, and the book grows | Both quotes resting, spread marked |
| `fills` | One seller hits your bid. The capsule folds into a dot that drops into inventory, and the bid grows back | Inventory +1 fill, bid regrowing |
| `skew` | Three sells 1.4 s apart. Both quotes lean down after each one | Three fills held, quotes skewed |
| `hedge` | Fills until inventory crosses the trigger, then the Taker account's order goes into the book and the meter returns to zero | Meter at zero, hedge counter 1 |
| `rewards` | Both capsules glow while they rest near the price, and a "time qualified" counter runs | Capsules glowing, counter at 96% |

**The view:**

- The animation stays pinned (`position: sticky`) while the chapters scroll past.
- The chapter in view plays once each time it enters, using an IntersectionObserver at 0.6. Clicking a chapter replays it.
- On phone the stage is pinned at the top at no more than 40% of the screen height, with the chapters under it.
- **A glossary closes the view.** Every term in `lib/glossary.ts` appears, and its "See it" link opens `#learn/<chapter>`.
- The desk's `?` tooltips link "See it animated" to the same chapter links.
- `#learn/<chapter>` opens Learn scrolled to that chapter, and plays it.

**Accept:**

- `engine.state()` after `play("hedge")` settles shows inventory 0 and one hedge.
- With reduced motion, each chapter shows its key frame and nothing animates.
- Screenshots match `renders/learn.png` and `learn-dark.png`.

#### L2. Explain mode (2 days)

- **Desktop placement:**
    - For each note, try the right, left, below and above of its target, each with a 12 px gap.
    - Take the first side that fits in the viewport, with an 8 px margin, without touching its own target or any other note or target.
    - If no side fits, dock the note in a numbered "Notes" panel at the side of the view. A small numbered marker stays on the target.
- **Phone (under 620 px):** notes never float. They appear one at a time in a bottom sheet with "2 of 5", Back and Next. The target scrolls to the centre of the screen and gets a ring.
- **First visit:** don't switch Explain on. Show one line under the nav, "New here? Take the 30-second tour", with Start and Not now. Store the choice in `localStorage` inside try/catch, and make it work without storage.
- Esc closes Explain, and focus returns to the Explain switch.

**Accept:** a shots check measures every note's rectangle at 1440 and 390 on Desk, Strategy, Markets, Performance and Venues. It fails on any overlap between two notes, or between a note and any target.

### Part B. Bundles

#### 3B. The owner's decisions

The RFC left five decisions to the owner. These are the recommendations. The owner's written approval confirms them or replaces them; build what the approval says.

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Starting wallet limits | Copy them from today's config when Core is created. Ask the owner to confirm them once, before a second bundle can be created. |
| 2 | Old history that can't be assigned | Show it as "Before bundles" in Performance. It counts in wallet totals, and never in a bundle's totals. |
| 3 | The bundle cap | 4 for Paper and Observe. Before any Live phase, derive the cap from measured cancel gas: the largest N whose cancel-all reserve fits the gas balance. |
| 4 | A bundle that errors | Pause it, cancel its orders, show why in plain words, and wait for a manual Resume. Never resume it automatically. |
| 5 | Live Core beside Paper bundles | Allow it only if a test proves Paper and Observe bundles never put a transaction in the queue. Otherwise, Live needs exactly one bundle that isn't stopped. |

#### B1. The Core bundle, with no behaviour change (5 days, server)

Build the RFC's data model, migration, rollback, API and runtime manager for exactly one bundle per owner, named "Core".

- The migration is transactional and idempotent, and it stores the per-owner legacy backup before cutover.
- `GET /api/config` and `POST /api/config` behave byte for byte as today, and read and write Core.
- Add the new read endpoints, `GET /api/bundles` and `GET /api/bundles/:id/config`. Creating more bundles waits for B2.
- The runtime manager is keyed by owner and bundle, with one shared gateway and queue. Stop keeps its priority.
- **No check may change for one bundle.** If the RFC's gas-reserve formula with N = 1 differs from today's check, keep today's check in B1 and switch to the formula in B2. Do the same for any aggregate limit check.
- There is no new UI.

**Accept:**

- The RFC's "Migration and compatibility" tests pass: upgrade, rerun, rollback, config compatibility, and byte-identical quote intents and submitted order bytes between today's runtime and Core on the same fixtures.
- `git diff --stat` for the server shows the bundle id threaded through. Paste a summary into the report that confirms no quote, hedge, risk, rotation, signing or Stop decision changed.

#### B2. Paper and Observe bundles (6 days, server and web)

- **Server:**
    - Create (paused), configure, start, pause, resume and archive bundles, up to the cap.
    - Enforce the constraints: one role per account across bundles, Maker and Taker different, one bundle per market, limits inside the wallet envelope.
    - Apply the aggregate wallet checks, the gas reserve and the isolated-error behaviour from decision 4.
    - Stop all preempts the queue and is never blocked.
    - Enforce the Live rule from decision 5 on the server.
- **Web:** follow `bundles.html`.
    - **The Bundles view:** a card per bundle with its mode, accounts, markets and result, plus Pause, Resume and Start. Stop all sits in the nav.
    - **The desk:** one lane per running bundle, up to four, each with its own compact animation fed by that bundle's snapshot.
    - **The strategy builder** edits the selected bundle.
    - **Markets rows** say "Add to bundle", with a bundle picker.
    - **Performance** gets "By bundle" back, and shows the "Before bundles" group.
    - **First wallet-limit confirmation:** before the second bundle is created, a sheet shows the wallet limits from decision 1 and asks for confirmation.
    - **The landing page** switches to the bundles sentence under "Set up your desk in three moves."

**Accept:**

- The RFC's "Constraints, isolation, attribution" and "Aggregate risk, queue, and gas" tests pass, plus the decision 5 test if the owner approved it.
- Shots cover a fixture with two Paper bundles at 1440 and 390, light and dark.
- Stop all works while one bundle is in error.

---

## 4. Verification for every step

```bash
npm ci
npm run format && TZ=America/Vancouver npm run check   # format, typecheck, tests, build
npm audit --omit=dev                                   # 0 vulnerabilities
node apps/web/e2e/shots.mjs --base-url http://127.0.0.1:8899 --view all
npm run audit:ui -- --base-url http://127.0.0.1:8899   # 0 failures
```

The pass bar for each step:

- No console errors, no page-level horizontal overflow, and no request that leaves localhost.
- Under reduced motion, nothing animates.
- Screenshots compared with the v3 renders. Structure and tokens must match; pixel equality is not expected.

## 5. Copy rules

These carry over from v3.1:

- Use plain words for states: "Quoting now", "Up next", "Waiting its turn", "Paused" and "Paper".
- The UI says "Taker account". "Hedge" stays in code.
- Every number on the desk has a header, a label or a `?`.
- "Right now" sentences come only from templates.

Money follows F1.

## 6. Definition of done

- F1 to F7, M1, M2, L1 and L2 are committed on `ui/v4`, and each passes its Accept line.
- B1 and B2 are committed if the owner approved them in writing. Otherwise the report says Part B is waiting for approval.
- Live gates are untouched, nothing was signed or deployed, and no production service was touched.

## 7. Report back

Open a PR titled "UI v4: finish v3.1, motion, Learn, bundles". Write `docs/design/maker-ui-handoff-v4/IMPLEMENTATION_REPORT.md` with:

1. A summary in three sentences, and the base you used.
2. A step table: commit SHA, status (done, partly done or not done), what changed, and the Accept result in one line.
3. The contrast audit and shots output, before and after.
4. **The screenshots, committed** under `docs/design/maker-ui-handoff-v4/report/` as PNG at 1×. Include each view at 1440 light and dark and at 390 dark, plus the landing, the Learn chapters and the bundle views.
5. Every change to `market-motion-engine.js`, and why.
6. For B1 and B2: the diff summary and the confirmation that no trading decision changed for one bundle, and the names of the RFC tests that pass.
7. The tail of the final `npm run check` and `npm audit` output.

If a constraint blocks you, stop at the end of the current step, commit what passes, and report the blocker. Do not work around a constraint.
