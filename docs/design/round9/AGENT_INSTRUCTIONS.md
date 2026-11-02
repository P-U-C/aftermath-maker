round 9. save it to the repo first like it says. A and B are quick and unblock testing, do them first. no deploys - I'll deploy control myself.

# Agent instructions: Maker round 9

Round 9 has four parts plus round 8b leftovers. Branch `ui/round9` from `origin/main` (`e92e9e2` or later). Save this message as `docs/design/round9/AGENT_INSTRUCTIONS.md` and commit it first.

- **A.** Wallets that sign with zkLogin can't sign in.
- **B.** Bundles may share markets.
- **C.** Venues funds and fixes accounts in place.
- **D.** Bundles and accounts show their stage and say when they're ready.

The owner's canvas, "Maker round 9", has a board for B, C and D. You can't open it, so every value you need is here.

## 0. Hard constraints

These are the same as before:

- Live stays off.
- Never sign or broadcast. The owner's wallet signs everything in the app, and your tests use the mock wallet.
- No production API calls, database changes or deploys.
- Server changes only where this file names them.
- Mark a line done only when its Accept check passes.
- Commit evidence to `docs/design/round9/evidence/`.

**The owner deploys, not you.** Production still runs control `a8cce9f`, so nothing server-side from rounds 8 or 8b is live, and neither will A–D be until control is deployed. In the PR body, write the exact deploy steps for web and control from the same commit, taken from the repo's `docker-compose.yml` and `deploy/`. Don't run them.

---

## A. zkLogin and multisig wallets can't sign in

**Most likely cause.** Your 8b log read found 4 of 6 `POST /api/auth/verify` calls failing with an invalid signature. The logs don't record the signature scheme, but this is the one path in the code that fails that way for a valid wallet.

- `auth.verify` calls `verifyPersonalMessageSignature(message, signature, { address })` (`apps/control/src/auth.ts:208`) without a `client`.
- In `@mysten/sui` 2.38, a zkLogin signature is checked through the chain, so with no client the SDK throws "A Sui Client … is required to verify zkLogin signatures". The same goes for a multisig that includes a zkLogin member.
- The `catch` turns that into "Your wallet's signature didn't verify."
- Slush accounts created with Google or Apple sign this way.

**A1.** Pass the `SuiGrpcClient` that `server.ts` already builds for the allowlist (`server.ts:163`) into `WalletAuth`, and on into `verifyPersonalMessageSignature(…, { address, client })`.

**A2.** Tell the two failures apart:
- **An invalid signature** stays a 401 `signature-invalid`.
- **A failed chain check** (RPC error or timeout during zkLogin verification) becomes a 503 `signature-check-unavailable`: "Maker couldn't check your wallet's signature right now. Try again in a minute."

**A3. Tests:**
- An Ed25519 sign-in still verifies with no network.
- A zkLogin-scheme signature calls `client.core.verifyZkLoginSignature` with intent scope `PersonalMessage` and the owner address.
- A fake client that rejects gives the 503.
- A fake client that returns `success: false` gives the 401.

**Accept:** the A3 tests pass, and `e2e/wallet-preauth.mjs` gains a 503 signature-check scenario with its visible message.

---

## B. Bundles may share markets

**The owner's decision.** Several running bundles may quote the same market, as long as at most one of them is Live. This amends RFC 0002's amendment ("Only one running bundle per owner may quote a market").

**Why it's safe today.**
- Paper never places orders, so two Paper bundles can't trade with each other.
- Live is limited to Core, so the Live-versus-Live case can't happen yet.
- Two Live bundles on one market would need self-trade protection: one bundle's taker hedge could fill the other's resting quote. That's out of scope; it needs its own RFC.

**B1. The rule.**
- Change the three `market-taken` checks in `apps/control/src/store.ts` (about lines 2963, 3418 and 3445) so they reject only when a market would end up in more than one running **Live** bundle.
- The message becomes "{SYMBOL} is already quoted live by {bundle}. Only one Live bundle can quote a market." with `fix: { kind: "strategy" }`.
- Add `docs/rfc/0002-strategies-markets-amendment-2.md`, recording the decision, the reason above and the Live condition.

**B2. Limits and attribution stay correct.**
- Wallet-limit admission counts each bundle's quotes on a shared market. Add a test: two Paper bundles on NEAR with $10 quotes count $20 of resting quotes.
- Performance attributes fills by account, so bundles sharing a market keep separate results. Add a test with fills on NEAR from both bundles' accounts.

**B3. Markets table** (board "One market, several bundles"):
- **The parent row:** a market used by more than one bundle keeps its market columns (price, open interest, volume, funding). Bundle shows "2 bundles", State shows a combined phrase ("1 waiting", or "All quoting"), and Policy shows "Per bundle".
- **Child rows:** one per bundle, 52 px tall on a `rgba(22,24,29,.02)` background. Each has:
    - an L-shaped 1.5 px connector;
    - the bundle name and mode tag;
    - its own state;
    - its policy: "Strategy" or "{n} custom";
    - its position;
    - an Edit that opens the policy sheet for that bundle's strategy, with `aria-label` "Edit {SYMBOL} policy in {bundle}".
- **The card sub:** "Several Paper bundles can quote the same market. Only one Live bundle can."

**Accept:**
- A second Paper bundle starts with a strategy that shares NEAR with a running bundle.
- A Live overlap is still rejected (unit test).
- The B2 tests pass.
- The table is captured at 1440 and 390.

---

## C. Venues funds and fixes accounts in place

The owner hit "Paper is waiting on account 1796… needs $300.00" and had no way to fix it in Maker:

- the server has `POST /api/accounts/deposit-transaction` and `withdraw-transaction`, but no screen uses them;
- both refuse whenever Core's runtime runs (`server.ts:1327` and `1353`, "Stop the engine before changing collateral"), whichever account is involved;
- there is no way to top up a trading key's gas after the first grant (0.1 SUI).

**C1. Accounts card** (board "Venues").
- **Header:** title "Aftermath accounts" with a "Connected" status chip, and a sub line: "Each account needs a trading key, gas for that key, and enough free collateral for its bundle's strategy." On the right, a secondary "New account" (the existing create flow).
- **Owner wallet balances** go top right of the page header, in a small white card: "Your wallet 0x64b…4d53" over "1,250.00 USDC and 4.20 SUI". Read them with dapp-kit in the browser.
- **Group rows by bundle.** Each group has:
    - a header row with the name, mode tag and a summary ("Ready" in tide-text, or "Needs $300.00 collateral" in amber-text);
    - when it's short, a 32 px secondary "Fund {bundle}".

  Accounts not in any bundle get a last group, "Not in a bundle".
- **Columns:**

  | Column | Content |
  | --- | --- |
  | Account | label, with the number under it |
  | Role | Maker or Taker |
  | Free collateral | right-aligned; amber-text when short |
  | Trading key | a check and "Authorized", or "Not authorized" plus "Authorize" |
  | Key gas | SUI, right-aligned |
  | Stage | chip: "Ready" (tide-soft), or "Needs $X" / "Needs gas" / "Needs trading key" (amber-soft) |
  | Actions | see below |

- **Actions:**
    - When the account is short, a primary 32 px "Deposit $X"; otherwise a secondary "Deposit".
    - A 32 px "⋯" menu button holds Withdraw, Add gas, Rename and Revoke trading key.
- **The venue facts** become a one-row, 4-column strip under the accounts card: Network, Collateral, Trading keys, Venue fee.

**C2. Blocked banner.**
- **When it shows:** whenever a bundle is waiting on collateral. It's a white card with an inset 1 px `rgba(232,162,0,.45)` ring and an amber dot.
- **Text:** "{bundle} can't quote yet", then "Account 1796 has $0.00 free. Quoting 15 markets at $10.00 a side needs $300.00."
- **Actions:**
    - a secondary "Quote one market at a time", which opens Strategy in edit mode at Size and limits;
    - a primary "Deposit $300.00", which opens C3 prefilled.
- **The same Deposit button** appears in the run status row and in the bundle card (D2).

**C3. Deposit sheet** (the interactive board). It's a 440 px right sheet over a `rgba(16,18,22,.14)` scrim.
- **Header:** "Deposit to account {id}", with the sub "{bundle}'s {role} account on Aftermath."
- **Amount:** a 48 px field, 20/620, with a "USDC" suffix. Under it: "Your wallet has {balance} USDC."
- **Quick picks** (32 px): "Cover {bundle} ({short})" only when the account is short, then $100.00, $500.00 and Max. The selected pick is tide-soft.
- **A soft summary panel:**
    - "Free in account {id} now";
    - "After this deposit" (650);
    - "{bundle} needs, for 15 markets at $10.00";
    - a verdict: "Enough for {bundle} to quote" in tide-text, or "Still $X short" in amber-text.
- **Note:** "Your wallet signs one transaction and pays a small SUI gas fee. Deposits are allowed while bundles run."
- **Footer:** Cancel, and a primary "Deposit {amount}" that's disabled until the amount is >0 and ≤ the wallet balance.
- **Signing:** a spinner, "Approve the deposit in your wallet", and "{amount} from 0x64b…4d53 to account {id}."
- **Done:**
    - a check in a tide-soft circle;
    - "Deposited {amount}";
    - "Account {id} now has {free} free. {bundle} can start." (the last sentence only when ready);
    - "View transaction" and "Done".
- **Afterwards,** re-read the accounts so the row and stage update.
- **Signing path:** use the existing `POST /api/accounts/deposit-transaction`, checked with `verifiedOwnerTransaction` (`maker-dashboard.tsx`: kind, sender and amount must match).

**C4. Fund a bundle in one signature** (board "Deposit to both").
- **The sheet** "Fund {bundle}" has one amount row per account: the label, the "Has $X, needs $Y" note, and a field prefilled with the shortfall (0 if ready).
- **Summary:** "Total from your wallet", "Left in your wallet", and the verdict.
- **Server:** `POST /api/accounts/deposit-transaction` also accepts `{ deposits: [{ accountId, amountUsdc }] }` (1–2 entries, owner's accounts only, each amount >0). It builds one transaction.
- **The intent check** covers every account and amount.

**C5. Withdraw.**
- **The server guard changes:**
    - deposits are always allowed;
    - a withdrawal is refused only when a bundle using that account is running or starting, or the account has open Maker orders. The refusal is 409 `account-in-use`: "Pause {bundle} before you withdraw from account {id}." with `fix: { kind: "bundles" }`;
    - the amount must not exceed what the venue reports as withdrawable.
- **The sheet** (board "Withdraw, while the bundle using it runs"):
    - **Blocked:** an amber-soft note, "{bundle} is quoting from this account. Pause {bundle} before you withdraw, so no open order is left without collateral.", with a "Pause {bundle}" button. The field and Withdraw are disabled.
    - **Summary:** Equity, "Withdrawable now", and "{bundle} needs to keep $X".
    - **Below the requirement:** if the amount would leave less than that, show "Withdrawing below $X leaves {bundle} unable to quote until you deposit again." The button stays enabled; this is information, not a block.
- **Signing:** the existing `withdraw-transaction`, with the recipient checked.

**C6. Add gas** (board "Add gas to a trading key").
- **Server:** a new `POST /api/setup/gas-transaction { accountId, gasMist }`.
    - It builds a SUI transfer from the owner to that account's trading-key address.
    - Owner's accounts only.
    - `gasMist` between 0.01 and 10 SUI.
    - A new intent kind, checked with `verifiedOwnerTransaction` (`agentAddress` and `gasMist` must match).
- **The sheet:**
    - an amount field (SUI) and the line "Your wallet has 4.20 SUI.";
    - picks of 0.25, 0.50 and 1.00 SUI;
    - a summary: key holds now, after this, Paper needs, Live needs.
- **The Paper and Live figures** come from the same functions the start guard uses (B1 of round 8). Don't hard-code them.

**Accept:**
- With the mock wallet, these each go through signing and show their done state, and the account row updates:
    - a single deposit;
    - a bundle deposit to two accounts;
    - a withdrawal blocked by a running bundle, then allowed after it's paused;
    - a gas top-up.
- Intent-mismatch tests cover each new kind.
- A deposit while Core runs is accepted (route test).
- Captures at 1440 and 390.

---

## D. Stages and Ready

**D1. One readiness model (server).**
- **`GET /api/bundles` returns `readiness` per bundle:** five ordered stages, each with `status: "done" | "todo" | "waiting"` and numeric detail, plus `ready: boolean`. The stages are:
    - `strategy`;
    - `accounts`;
    - `tradingKeys`;
    - `gas`;
    - `collateral`.
- **The Maker account's collateral requirement** is `aggregatePortfolioQuoteRisk` (`packages/core/src/risk.ts`) over the strategy's concurrent markets:
    - all of them in portfolio rotation, one in single-slot;
    - using each market's quote-size and leverage overrides.
- **Share this with the runtime's Paper blocker** (`paperSimulationBlocker` in `runtime.ts`), so the two can never disagree.
- **The hedge account:** propose a requirement from the strategy's hedge limits in the PR. Until it's agreed, the hedge account is `done` when it has any free collateral.
- **Gas:** Paper needs one simulation budget, Live the Live reserve. Use the same function as the start guard.

**D2. Bundle cards** (board "Bundles show their stage").
- **Grid:** cards in a 3-column grid at ≥1100, one column below that.
- **Each card:**
    - **Top:** the name (18/650) with its mode tag, the strategy line ("Wide strategy, 15 markets"), and a stage chip on the right:
        - "Quoting" (dot, fill);
        - "Ready to start" (tide-soft);
        - "{n} steps left" or "1 step left" (amber-soft);
        - "Draft" (hollow dot).
    - **An ordered checklist of the five stages,** each row 52 px tall with a hairline above it:
        - a done stage gets a tide check;
        - a to-do stage gets an amber dot, detail in amber-text, and a 32 px primary fix button on the right ("Deposit $300.00", "Choose strategy", "Assign accounts", "Authorize", "Add gas");
        - a waiting stage gets a hollow ring, with label and detail in ink-3 ("After accounts are assigned").
    - **Footer:** a note ("Running since 9:51 AM", "Can start after the deposit", "2 steps before it can start"), a secondary "Edit", and either "Pause" (secondary) or "Start" (primary). Start is disabled with the note as its reason until `ready`.
- **Fix buttons** open the matching sheet from C, or the right view.

**D3.** Each Venues account row shows its stage (C1).

**D4. Run status.** A stopped bundle that isn't ready shows its next step in its row, e.g. "Deposit $300.00 to start" with the fix button. Its play button is disabled, and its `aria-label` names the reason.

**D5. The start route** rejects a not-ready bundle with the first unfinished stage as a 409. The message and `fix` match the card.

**Accept:**
- A table test for `readiness`: all done; short on collateral; no strategy; key not authorized; gas short for Paper and for Live.
- The card, the run status and the start rejection agree in a fixture with Bundy short by $300.
- Captures at 1440 and 390.

---

## E. Round 8b leftovers

- One route-level test per error `code`. This was still missing in 8b.
- After the owner deploys control, read the logs once (read-only) to see whether the 40-hour account-read stall recurs, and report it. Keep the stale-data warning.

## Report

In the PR body:
- the Accept table;
- the deploy steps (not run);
- the hedge-collateral proposal;
- anything you decided that this file didn't cover.

Don't merge or deploy.
