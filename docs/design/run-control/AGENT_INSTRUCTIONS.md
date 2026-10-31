# Agent instructions: one run control

You are continuing Maker (`P-U-C/aftermath-maker`). This round replaces every run control in the web app with one control in the nav. It shows what Maker is doing and is the only place to start, pause, resume and stop.

The design is on the owner's canvas, "Maker run control". You can't open it, so every size, color and line of copy you need is written into this file. First, save this whole message as docs/design/run-control/AGENT_INSTRUCTIONS.md and commit it.

Same rules as last round:

- Mark a line done only when its Accept check passes. If it partly passes, say "partly done" and list what's missing.
- Commit the screenshots you use as evidence (section 9). Paths under /tmp can't be reviewed.

---

## 0. Context and setup

| Item | Value |
| --- | --- |
| Repo | ~/aftermath-maker |
| Base | origin/main (`a8cce9f` or later) |
| Branch to create | ui/run-control |
| This spec | docs/design/run-control/AGENT_INSTRUCTIONS.md (save this message there) |
| Main files | apps/web/components/maker-shell.tsx, components/maker-dashboard.tsx, components/views/desk.tsx, components/views/bundles.tsx, components/views/strategy.tsx, app/globals.css |
| New files | apps/web/lib/run-state.ts, apps/web/test/run-state.test.ts, apps/web/components/run-control.tsx |
| Harnesses | apps/web/e2e/shots.mjs, e2e/user-journey.mjs, e2e/contrast-audit.mjs, e2e/fixtures/ |

Treat this machine as shared with other services. Don't run docker, systemctl or nginx. Don't edit anything outside the checkout. Run your server on port 8899; check that it's free with ss -ltn first.
cd ~/aftermath-maker
git fetch origin
git status --porcelain     # must be empty; if not, stop and report
git checkout -b ui/run-control origin/main
mkdir -p docs/design/run-control   # save this message as AGENT_INSTRUCTIONS.md in it, then:
git add docs/design/run-control && git commit -m "docs: add run control spec"

---

## 1. Hard constraints (these override everything else)

1. Live stays off.
    - Never set or change LIVE_TRADING_ENABLED or ALLOW_MAINNET.
    - Never edit .env* files or the master key.
    - Never sign or broadcast a transaction.
    - Never call the production control API.
    - Don't test Live against the retained audit accounts or the production deployment.
2. Don't deploy. Push the branch and open a pull request.
3. Web only.
    - Change only apps/web/** and docs/**.
    - Don't touch apps/control or packages/*. Everything below can be derived from what /api/status and /api/bundles already return.
    - If you find you need a server field, stop and report.
4. Keep the request layer as it is.
    - Keep the same request() paths, methods and bodies: api/runtime/stop, and api/bundles/:id/start|resume|pause.
    - Flatten keeps its two-step Sheet. The liveGates checks stay.
5. Stop is never disabled or hidden while anything might hold orders. Section 3 defines "might": it includes data that is stale or unreachable.
6. No fake data in the product. No test backdoors. Mock at the browser level with the existing fixtures.
7. The repo is public. Security details stay out of commits, PRs and issues.

---

## 2. Why this round exists

Root causes, as of a8cce9f:

1. Stop all shows when nothing runs. canStopAll in maker-dashboard.tsx is true whenever any non-archived bundle exists. Every owner has a Core bundle, so it's always true.
2. Two sources of truth. The nav's running, markState and mode read snapshot, which /api/status fills from the Core bundle's runtime only (`runtimeManager.get()`), mixed with bundles[].status. In the live-running fixture the pill says "Paper".
3. Seven controls for one job:
    - the nav "Run controls" button;
    - the nav "Stop all";
    - the mode pill;
    - the panel's "Stop all · cancel owned orders";
    - Desk's "Run controls · choose bundle";
    - "Run controls · {name}" on every bundle card;
    - the phone dock's Flatten and Stop, plus the Strategy phone sheet's stop icon.
4. The panel isn't attached to its trigger. It's a full-width card under the nav, with nested cards, raw "PAPER · running" and fine print.
5. One mode pill can't describe mixed Live and Paper bundles.

---

## 3. The run state: one derivation, read everywhere

Create apps/web/lib/run-state.ts. It holds a pure deriveRunState(inputs): RunState and nothing else. The dashboard calls it once per render and passes the result down. Every surface reads this object. No component may read snapshot.running, bundle.status or stopState directly for run display again.

### 3.1 Inputs

- bundles: non-archived bundles from /api/bundles.
- snapshots: /api/status → bundles[] (`{ bundle, snapshot }`). Match them by bundle id.
- pending: a map from bundle id to "start" | "resume" | "pause", for requests in flight. Take it from the existing busy key bundle-${action}-${id}, or add a small state map.
- stop:
    - { phase: "idle" | "stopping" | "unconfirmed", targets: string[], startedAt, error? }.
    - It replaces stopState.
- startErrors: a map from bundle id to the server message from the last failed start or resume. Clear an entry on that bundle's next action, or after 60 s.
- configDirty: the existing flag.
- stale: controlUnavailable, or lastGoodDataAt older than 15 s.

### 3.2 Per-bundle phase

Evaluate these in order; the first match wins:

| Phase | When |
| --- | --- |
| stopping | stop.phase === "stopping", the bundle is in stop.targets, and its snapshot is still running or holds orders |
| pausing | pending[id] === "pause" |
| starting | pending[id] is "start" or "resume" |
| attention | bundle.status === "error", or the bundle is running and snapshot.lastError is set |
| running | bundle.status === "running" |
| paused | bundle.status === "paused" |
| stopped | anything else |

- `holdsOrders(b)` is true when any of these hold:
    - snapshot.running;
    - (snapshot.restingQuoteMarketIds?.length ?? 0) > 0;
    - (snapshot.paper?.openOrders ?? 0) > 0;
    - the phase is running or attention.
- `mode` is "live" when bundle.mode === "live". Anything else is "paper".

### 3.3 Summary fields

| Field | Rule |
| --- | --- |
| running | bundles in running or attention |
| liveCount | of those, mode === "live" |
| stoppable | any holdsOrders, or any starting`/`pausing`/`stopping, or (`stale` and the last known state was stoppable), or stop.phase === "unconfirmed" |
| since | the earliest snapshot.startedAt among running bundles |
| markState | "live" if liveCount > 0; "paper" if any are running or starting; else "stopped" |
| liveRail | liveCount > 0 |
| label, tone | section 4.2 |

Accept: test/run-state.test.ts has one table-driven case for every row in 4.2, plus these cases:

- paper openOrders > 0 on a stopped bundle → stoppable;
- restingQuoteMarketIds on a paused live bundle → stoppable;
- stale while running → stoppable;
- stale while stopped → not stoppable;
- Core paper with another bundle live → markState is "live".

---

## 4. The nav control (`components/run-control.tsx`)

### 4.1 Anatomy (desktop)

A split pill sits in the nav's right cluster, before the Explain and wallet controls:
[ ● 2 on paper  ⌄ | ■ ]   (?)   [ wallet 0x1111…1111 ⌄ ]

The pill as a whole:
- 38 px high, --fill background, radius 999.

Left segment (`<button>`):
- Padding 0 12px 0 14px, gap 9 px.
- Contents, in order:
    - an 8 px dot, or a 12 px spinner;
    - the label at 13px/620, ink;
    - a 14 px chevron in ink-2 that rotates 180° when open.
- aria-expanded and aria-controls="run-status".
- aria-label is a sentence, e.g. "Run status: 2 bundles on paper".
- Hover: --fill-2.

Divider: 1 × 18 px, rgba(22,24,29,.12).

Stop segment (`<button>`):
- 42 × 38, radius 0 999px 999px 0.
- An 11 px square, radius 3, --stop.
- aria-label="Stop all", title="Stop all bundles".
- Hover: --ember-soft.
- It shows only when `stoppable` and the stop phase isn't stopping.
- When it's hidden, the left segment's radius becomes 999 all round.

Focus: a 2 px --tide-text ring, offset 2, on both segments.

Dots:

| Dot | Background | Ring |
| --- | --- | --- |
| tide | --tide | 0 0 0 3px rgba(15,163,154,.18) |
| ember | --ember | 0 0 0 3px rgba(242,72,59,.18) |
| amber | --amber | 0 0 0 3px rgba(232,162,0,.22) |
| hollow | none | inset 0 0 0 1.5px var(--ink-3) |

A visually hidden aria-live="polite" region repeats the label when it changes. Throttle it to one announcement every 2 s.

### 4.2 Label and tone

Evaluate in order; the first match wins:

| State | Label | Indicator | Stop segment |
| --- | --- | --- | --- |
| stop unconfirmed | Stop not confirmed | amber dot, label in --amber-text | shown (acts as retry) |
| stopping | Stopping… | spinner | hidden |
| stale | Can't reach Maker | hollow amber ring, label in --amber-text | shown if last known stoppable |
| any attention | {name} needs attention | amber | shown |
| starting, none running | Starting {name}… | spinner | shown |
| 1 running | {name} on paper / {name} live | tide / ember | shown |
| n running, 0 live | {n} on paper | tide | shown |
| n running, all live | {n} live | ember | shown |
| n running, mixed | {n} running, {k} live | ember | shown |
| any paused | Paused | hollow | per stoppable |
| else | Stopped | hollow | per stoppable |

The live rail (the existing 2 px ember bar) shows when liveRail is true. The mark and the favicon follow markState.

### 4.3 Nav at other widths

- ≥1280: as above.
- 1024–1279:
    - nav padding becomes 0 24px, and tab links 0 12px;
    - the wallet summary collapses to a 38 px round icon button, aria-label="Wallet {address}", with the same menu;
    - nothing wraps.
- <1024: keep today's tablet layout. The tabs wrap to a second row, and the control stays in the top row.

### 4.4 Explain

- The "Explain" text button becomes a 38 px round icon button (`CircleHelp`).
- Its attributes are aria-label="Explain this page" and aria-pressed.
- It behaves the same as today.

Accept:
- At 1440 and 1024, the nav right cluster holds exactly the run control, Explain and the wallet.
- No "Run controls" text appears anywhere in the app.
- The stopped fixture shows "Stopped" with no stop segment.
- live-running shows an ember dot, the live rail, and never the word "Paper" in the nav.

---

## 5. The run status popover

### 5.1 Behavior

Structure and position:
- A non-modal disclosure: <section id="run-status" aria-label="Run status">.
- It sits 10 px under the control, right-aligned to the control's right edge.
- Width is min(400px, 100vw - 32px).

Opening:
- Opened by the left segment, or by open(bundleId?).
- Keep the existing useMakerRunControls() context name and change what it opens.
- open(bundleId) tints that bundle's row rgba(15,163,154,.09) and scrolls it into view.

Closing and focus:
- On open, focus moves to the popover heading (`tabIndex={-1}`).
- It closes on Esc (focus returns to the trigger), on an outside click, on following a link inside it, and on a view change.
- Don't add global key handlers beyond what that needs.

Motion:
- Entrance: 200 ms, --ease-out, opacity plus a 4 px rise.
- No motion under prefers-reduced-motion.

Look: surface background, radius 18, --float shadow, 1 px --hair border.

### 5.2 Content

Header, padding 18px 20px 12px:

- Title (16px/650):
    - {n} of {total} bundles running;
    - Stopping {n} bundles;
    - Starting {name};
    - Stop not confirmed for {names};
    - Nothing running.
- Subline (13px, ink-2):
    - On paper since {since};
    - Live since {since};
    - {k} live, {p} on paper;
    - Cancelling open orders;
    - Start any bundle below.
- Link "Manage bundles", top right, goes to the Bundles view.
- When `configDirty`, add one amber line under the header: "Apply or discard your Strategy changes to start or resume bundles." Follow it with an "Open Strategy" link. Every start and resume button is then disabled.

Rows:

- Order: attention, then running, starting, pausing or stopping, then paused, then stopped. Sort by name within each group.
- Row layout:
    - padding 9px 8px 9px 12px, radius 12, gap 12;
    - a 12 px indicator cell holding the dot or spinner;
    - name 14px/620, then a mode tag;
    - the detail line at 12.5px;
    - one 40 × 40 icon button, radius 12, on a fill background.
- Mode tag:
    - 20 px high, radius 6, 11.5px/620;
    - Paper: fill background, ink-2;
    - Live: ember-soft background, ember-text.

| Phase | Detail line | Button |
| --- | --- | --- |
| running | Quoting {MON and SUI}, or Quoting {n} markets when there are more than 2 (from snapshot.markets symbols); Waiting for its first quote before one exists | pause, "Pause {name}" |
| attention | the reason (`bundle.lastError ?? snapshot.lastError`) in amber-text, with a fix link only where the fix has a home: balance or account → Venues, markets or strategy → Strategy | pause, "Pause {name}" |
| starting | Starting… | spinner, disabled |
| pausing / stopping | Cancelling its orders… | spinner, disabled |
| paused | Paused. No orders open., or Paused. Cancelling its orders… while holdsOrders | play, "Resume {name}" → resume |
| stopped | Stopped, or Stopped at {time}. Its orders are cancelled. right after a Stop all | play, "Start {name}" → start |
| needsStrategy | Needs a strategy. + "Open Bundles" link, in amber | play, disabled |
| start failed | the server message from startErrors, in amber (for example, live gates off) | play, enabled |

A disabled play button's aria-label says why, for example "Start Majors, apply its strategy changes first".

Footer, with a hairline on top and padding 14px 20px 16px:

- When `stoppable`:
    - a "Stop all" button: 40 px, radius 12, ember-soft background, ember-text 13.5px/650, with an 11 px --stop square;
    - next to it, at 12.5px ink-2: "Cancels every open order. Positions stay open until you flatten them on Desk."
- While stopping:
    - a spinner and "Stopping…" (disabled);
    - the note "{done} of {total} stopped. Cancelling the rest of the orders.";
    - count a target as done when its snapshot is no longer running and holds no orders;
    - if polling can't show that in time, show "Cancelling orders for {total} bundles."
- Unconfirmed:
    - the button reads "Retry stop";
    - the note reads "Maker didn't confirm within 20 seconds. Orders may still be open on Aftermath." Also keep the existing error notice.
- When nothing is stoppable:
    - no red button;
    - a quiet text button, "Cancel any leftover Maker orders", that calls the same stop. It's the recovery path the current canStopAll comment protects.

### 5.3 Stop flow

stopRuntime() keeps its request and its notices. Change only what's around them:

- Set stop = { phase: "stopping", targets: <ids where holdsOrders or pending>, startedAt: now }.
- Race the request against a 20 s timer. If the timer wins, or the request fails, set phase: "unconfirmed" with the reason.
- If the request resolves later, finish normally.
- On success, set phase: "idle". Keep the "Stopped at…" detail on the targets until their next action.
- Retry calls stopRuntime() again.
- Stop all never waits on, or is blocked by, any bundle's pending action.

Accept:

- Every popover state in 5.2 (nothing running, needs attention, config dirty, stopping, unconfirmed) can be reproduced with fixtures (section 8) and is captured.
- Esc returns focus to the trigger.
- open("core") from Desk opens the popover with Core's row tinted.

---

## 6. Phone

- Top bar:
    - Replace maker-phone-actions ("Run" plus the stop button) and the mode text with <RunControl compact />.
    - Size: 44 px high. The stop segment is 46 × 44, with a 12 px square.
    - The compact label is short: On paper or Live for one bundle, {n} on paper, {n} live, {n} running, Stopping…, Stopped, Needs attention.
- The sheet:
    - Tapping the label opens the popover content in the existing Sheet primitive: rows 64 px minimum, 44 px buttons, a full-width 48 px "Stop all", and a 44 px close button.
    - A tap on the stop segment stops straight away, as on desktop.
- Remove `desk-phone-dock` (the sticky Flatten and Stop bar).
- Flatten moves into the Desk hero on phone as a full-width 44 px quiet button.
    - It keeps the same two-step Sheet.
- Strategy phone sheet: in strategy.tsx, replace the phoneStopAll stop icon with <RunControl compact /> whenever the sheet hides the shell's top bar. Stop must stay one tap away on every phone screen.

Accept:
- At 390 px no screen shows two stop controls.
- Every view has exactly one stop control while something runs.
- All tap targets are ≥44 px, and shots.mjs passes its own check.

---

## 7. Other surfaces read state; they don't act

- Desk hero (`desk.tsx`):
    - Remove "Run controls · choose bundle".
    - Remove the configDirty && !running note; it now lives in the popover.
    - Remove the hero stopError line; errors show in the control, the popover and the existing notice.
    - Keep "Flatten positions…" as it is.
    - "Running since" reads since, or "Not running".
- Desk lanes: each lane header gets a state chip.
    - Size: 32 px, fill background, radius 999, 12.5px/600, with a dot or spinner.
    - Words: Starting…, Quoting, Needs attention, Cancelling orders…, Paused.
    - It's a button that calls open(bundle.id). aria-label reads "{name}: {state}. Open run status".
    - The mode tag sits next to the lane name.
- Bundle cards (`bundles.tsx:502`):
    - Replace the "Run controls · {name}" button with the same chip.
    - Keep "Edit" and the others.
    - At bundles.tsx:720, replace the copy with "Accounts change only while {name} is paused." plus a "Pause in run status" text button that calls open(id).
    - At bundles.tsx:353, change "Stop all remains available from the desk navigation" to "Stop all is always in the run control at the top."
- Shell props:
    - Replace running, canStopAll, stopState, phoneDeskStopAvailable, runBundles, runActionBusy, runStartBlocked, live, mode and markState on MakerShell with a single run: RunState.
    - Keep onBundleAction and onStopAll.
    - Delete the old panel markup and its CSS (`.maker-run-control-*`, .maker-stop-all, .maker-phone-run-control, .maker-phone-stop-all, `.desk-phone-dock`).
- Narration and anything else that used anyBundleRunning or snapshot.running for display reads run.

Accept:
- rg -n "Run controls|canStopAll|anyBundleRunning|phoneDeskStopAvailable" apps/web returns nothing outside tests and this spec.
- The only elements that call start, resume, pause or stop are in run-control.tsx.

---

## 8. Fixtures and harnesses

- Add browser-level fixture states in e2e/fixtures/control.ts and api.mjs:
    - mixed-running: Core on paper, plus a second bundle live;
    - attention: one bundle with status: "error" and a lastError;
    - paused;
    - stop-timeout: api/runtime/stop never resolves;
    - config-dirty.
- Update the selectors:
    - The nav stop is getByRole("button", { name: "Stop all", exact: true }) with the popover closed.
    - The popover's button is scoped to getByRole("region", { name: "Run status" }).
    - Replace the Stop all · cancel owned orders and phone dock assertions in user-journey.mjs with the new top-bar control.
- Keep the invariant check in shots.mjs:558: Stop is never disabled while a bundle runs.
- Run `contrast-audit.mjs`. Every new text color passes 4.5:1 on its real background. The amber-text on white and ember-text on ember-soft must be checked, not assumed.

---

## 9. Evidence and report

Commit captures to docs/design/run-control/evidence/:

- nav at 1440, 1024 and 390 for every fixture state;
- the popover open for paper-running, mixed-running, attention, stopped, config-dirty, mid-stop and stop-timeout;
- the phone sheet for paper-running;
- Desk and Bundles at 1440 for paper-running.

In the PR body:
- give a table of every Accept line marked done, partly done or not done, with the evidence path for each;
- list anything you decided that this file didn't cover;
- run npm run check and the three harnesses, and paste their final lines.

---
