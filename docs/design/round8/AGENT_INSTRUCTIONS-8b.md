round 8b, follow-up to PR 44. save it to the repo first like it says. parts 1-4 first, they block my testing. read-only on prod (logs + container labels only), no prod api calls, no db changes, no deploys.

# Agent instructions: Maker round 8b

Round 8 follow-up. Build on `ui/round8-kit` (PR #44) and update that PR, so it reviews as one. First, save this message as `docs/design/round8/AGENT_INSTRUCTIONS-8b.md` and commit it.

The same hard constraints as round 8 apply:

- Live stays off.
- No production API calls, database changes or deploys.
- Server changes only where named below.
- Mark a line done only when its Accept check passes.

Order of work:

1. **Part 1** (version skew), **Part 2** (Paper blocked), **Part 3** (control log) and **Part 4** (landing access) block the owner's testing. Do them first.
2. **Part 5** finishes round 8.

---

## Part 1. Show which build each side is running

Your round 8 report found web at `29aa9ea` and control still at `a8cce9f`. If that's still true in production, none of the round 8 server work is live:

- typed errors;
- the request-error log;
- the Paper gas fix.

That would explain most of what the owner sees. Deploying is the owner's call, so make the skew visible:

- **1.1** `GET /health` and `GET /api/status` return `{ commit, builtAt }`. Bake these in at build time, e.g. `GIT_COMMIT` in the Dockerfile. The web reads its own commit the same way.
- **1.2** The wallet menu shows "Web 29aa9ea, control a8cce9f" in 12.5 ink-3 at the bottom.
    - When the two commits differ, operators see an amber line in the wallet menu: "Web and control are on different builds. Deploy both from the same commit."
    - Other users don't see the warning.
- **1.3** Read-only: report the commit of each running container now. Use the same label inspection you used before.

**Accept:**
- The 1.1 fields exist and have a test.
- Captures show the wallet menu with matching and with mismatched builds.
- The report states the production commits.

---

## Part 2. A blocked Paper bundle says why, briefly, and the message is current

On production Desk a bundle card shows:

> "Paper can't simulate: account 1757 has $0.00 available collateral; $100.00 required for 5 concurrent markets, including a $10.00 quote per side at 1x. Account read recorded 2026-10-31T01:11:55.005Z. Deposit collateral into account 1757; smaller positive orders cannot run with zero available. Maker will keep reading the market."

**The figure is correct:** 5 markets × 2 sides × $10 at 1x is $100. Paper simulates the real order, and the chain refuses orders the account can't fund. The problems are elsewhere:

- the message is long;
- it shows a raw ISO timestamp;
- the account read was about 40 hours old when the owner saw it;
- it wasn't in the control log the owner checked.

**2.1 Structured detail, short words.**
- `paperSimulationBlocker` (`apps/control/src/runtime.ts:335`) returns `code` plus structured fields: `accountId`, `availableUsd`, `requiredUsd`, `concurrentMarkets`, `quoteSizeUsd`, `leverage`, `observedAt`, and, for gas, `agentAddress` and `requiredGasSui`.
- Keep `message` as a fallback, rewritten. For collateral:
    - "Paper is waiting on account 1757. It has $0.00 free collateral, and quoting 5 markets at $10.00 a side needs $100.00."
    - Then the fix: "Deposit at least $100.00, or quote one market at a time (needs $20.00)."
- Compute the one-market figure the same way, with `concurrentMarkets` = 1. Leave it out when the strategy already rotates one market at a time.
- **The web formats the sentence from the fields**, with:
    - links: "Open Venues" for a deposit, "Edit strategy" for rotation and size, and for gas "Copy trading key address";
    - a relative time, "Checked 5 min ago", never ISO.
- **Gas:** "Paper is waiting on gas. The trading key for account 1757 needs {requiredGasSui} SUI to simulate." Then "Copy trading key address".

**2.2 One state, shown everywhere.**
- **Run status:** a blocked bundle is in the `attention` phase (amber dot, "{name} needs attention"), and its row shows the 2.1 sentence and fix links.
- **The Desk lane and the bundle card** show the same sentence, truncated to two lines with the full text in the run status row.
- **A stopped bundle shows no blocker.** Clear `lastError` and the market row errors on stop and on start. If a stopped bundle's last run ended blocked, the card may show "Last run stopped while waiting on collateral" in ink-3, with the time.

**2.3 Log it once per change, then remind.**
- The dedupe key today includes the message, and the message includes the account-read timestamp. So the event logs on every fresh read, or only once when reads stall.
- Key it on `trialId`, `marketId`, `code` and the rounded required amount instead.
- Log again at most every 15 minutes while the block lasts.
- When the block clears, log `paper:simulation:cleared`, narrated "Paper on {bundle} is simulating again."

**2.4 Find out why the account read was 40 hours old** while the bundle showed as running. Report the cause and fix it if it's in this repo. If a running bundle's account read is older than 3 × its cycle interval, the card says "Account data is stale, last read {relative time}" in amber.

**Accept:**
- With a fixture of $0 collateral and 5 markets at $10:
    - the run status shows "{name} needs attention" with the 2.1 sentence and links;
    - the lane and card match it;
    - the log has exactly one blocked event, and one reminder after 15 minutes of simulated time;
    - stopping the bundle clears the card.
- The 2.4 cause is reported.

---

## Part 3. The control log shows bundle problems

The owner saw the blocker on Desk but not in the control log. Here's why:

- Desk fetches only `api/events?limit=12`.
- The blocker is logged once.
- Rejected starts are only logged by the round 8 control build, which may not be deployed (Part 1).

**3.1** Desk fetches 50 events and shows the newest 12, with "Show more" (secondary, 32 px) that reveals the rest.

**3.2** "Problems" asks the server, so it isn't limited to what's loaded:
- `GET /api/events?problems=1&limit=50` returns events whose outcome is one of:
    - `blocked`;
    - `error`;
    - `rejected`;
    - `partial`;
    - `timeout`;
    - `tripped`;
    - `retry`.
- Keep this list in one exported constant, next to `AUDIT_EVENT_KINDS`.
- Server change allowed.

**3.3** Each problem row names the bundle and links to the fix, the same way the run status does.

**Accept:**
- With 30 info events logged after a blocker, "Problems" still shows the blocker.
- "Show more" reveals events 13 to 50.

---

## Part 4. Landing: checking access and requesting it

The owner reports that checking a wallet against the access list and requesting access don't work on the landing page. Against local mocks both paths work: connect, sign, "not on the list", form, "Request received". So the failure is environment-specific, and the UI hides it behind a generic banner.

**4.1 Diagnose read-only.** Read the control and web container logs for the last 72 hours for:
- `POST /api/auth/challenge`;
- `POST /api/auth/verify`;
- `POST /api/access-requests`.

Report each one's status codes and messages.

The likely causes, from the code:
- the on-chain registry read in `allowlist.isAllowed` failing: the RPC fails, or `whitelist_package_id` is unset. It throws "Whitelist package ID is not configured", which `classifyHttpError` turns into a 503 "Service unavailable";
- the 15-minute access-request token expiring;
- the 3 per hour rate limit on access requests.

Don't change production settings. Report what's missing.

**4.2 Typed errors on the access path** (server change allowed):

| Case | Status and code | Message |
| --- | --- | --- |
| Registry read failed | 503 `access-list-unavailable` | "Maker couldn't check the access list right now. Try again in a minute." |
| Registry or package id not set | 503 `access-list-not-configured` | "The access list isn't set up yet. The operator needs to finish setup." |
| Signature didn't verify | 401 `signature-invalid` | "Your wallet's signature didn't verify. Sign again." |
| Access-request token expired | 410 `access-check-expired` | "That check expired. Sign again to request access." |
| Rate limited | 429 `access-request-limit` | "You've sent 3 requests this hour. Try again later." |

**4.3 Clearer flow.**
- **Not connected:** "Request access" opens the wallet picker. The notice reads "Connect the wallet you want to use. You'll sign a free message so Maker can check the access list." Today it says "Connect your owner wallet to sign in".
- **After connecting,** verification continues by itself.
- **Between signing and the answer,** the button shows a spinner and "Checking the access list…".
- **Errors show inline** under the button, with "Try again". They don't show in the top banner.
- **A 403 without a token** (no token secret configured) shows "Requests are closed right now." It must not loop back into signing.

**4.4** Extend `e2e/wallet-preauth.mjs` with these scenarios. Each asserts its visible message:
- not connected, then request;
- denied, with the form submitted;
- registry 503;
- 410 expired;
- 429.

**Accept:**
- The 4.1 report is in the PR.
- The 4.4 scenarios pass at 1440 and 390.

---

## Part 5. Finish round 8

**5.1 Part A route tests.** Add one route-level case per error `code` (not per constructor) that asserts the status, `code` and message.

**5.2 Venues per-account data.**
- Extend `listOwnerAccounts` in `packages/aftermath/src/gateway.ts` read-only to return per-account exposure and unrealized result from the venue's account state.
- This read is authorized. No signing, no new transaction paths.
- The Venues table then fills Exposure and Unrealized. Until then, hide those two columns rather than showing dashes.

**5.3 Number rule correction.** Round 8 said "under $1 with up to 4 significant digits". That was wrong for amounts.
- Results, balances, fees and exposure always use 2 decimals.
- Only prices use significant digits or the tick size.
- The Desk hero shows "−$0.02", with the exact value in its `title`. Today it shows −$0.01541.
- Apply `tabular-nums` to every money cell, or to none. Today the Desk hero, Bundles card results, Performance stats and Markets funding use it, and the rows beside them don't.

**5.4 Kit leftovers seen at 1440 on `7265924`.**
- **Performance:**
    - The four stats are still boxed tiles, flush to the card edge. Make them unboxed stats.
    - "Maker side" and "Hedge side" each span the full width, with values about 900 px from their labels. Put them in two columns side by side.
    - "All bundles" is a native select. Use the kit menu button.
- **Bundles:**
    - "2 active bundles; 2 slots available." is a pill. Make it plain 13.5 ink-2 text.
    - Wallet limits are grey tiles. Make them unboxed stats.
    - The card result is a 28 px monospace-looking number. Use the stat style.
    - Edit and Archive look disabled while enabled. Use the kit's secondary style, with real disabled states only when disabled.
- **Desk:**
    - Lanes are still about 400 px tall with a small book in the middle. Fit the lane to its content: the book area is at most 200 px when sparse.
    - The facts row still reads "Maker equity · Core". Write "Core maker equity".
    - Flatten is a grey pill, offset from the facts row. Make it a secondary button aligned to the facts row.
- **Markets:**
    - BTC and ETH (used by Rewards) show "—" for Policy and have no Edit. Resolve their strategy from the bundle, so every in-use row shows "Strategy" or "{n} custom" and has Edit.
    - An override equal to the strategy's value isn't custom. Drop it on save. MON shows "6 custom" in the fixture with values equal to the strategy.
    - The Bundle cell wraps for Rewards but not for Core. Keep it on one line.
- **Strategy:**
    - "{n} strategies ⌄" sits 9 px right of the title edge, and its chevron is oversized. Align it and use the 14 px chevron.
    - "New strategy" is a quiet link. Make it a secondary button.
    - Omit "Last saved …" when there's no date. Never print "time unavailable".
    - Capitalize the risk profile ("Balanced").
- **Venues:** "Connected, quoting" uses the kit's status chip.

**Accept:**
- Captures of each 5.4 view at 1440 and 390 are committed, before and after.
- `shots.mjs --view all` and `contrast-audit.mjs` still pass with no checks disabled.

---

## Report

In the PR body:
- the Accept table for Parts 1 to 5;
- the 1.3 and 4.1 production findings;
- the 2.4 cause;
- anything you decided that this file didn't cover.

Don't merge or deploy.
