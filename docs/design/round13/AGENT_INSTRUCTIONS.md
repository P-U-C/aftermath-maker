# Round 13: agent instructions

Two features and a Live fix.

- **Part A** integrates the reward-share ranker from the owner's package into Maker.
- **Part B** is discovery only. It looks at the Post Fiat research bundles for a possible strategy input.
- **Part C** fixes the Go live sheet: confusing copy, and the server operator being told to "Ask the operator".

Base your work on `main` (d033c37, round 12 merged).

## How to work

- Every part ends Done, with a ✓ and proof (test name, harness output or capture) for each Accept line.
- Nothing is done until it's pushed and the PR is open.
- If something is truly blocked by a hard constraint, finish the rest. Then report three things: the blocker, what you tried, and the smallest owner action that unblocks it.
- Runtime tests use `cycle({ executeLive: true })`. A bare `cycle()` is read-only.

## Part A. Reward-share ranking

### A0. Source and what it models

- The package is at `~/Downloads/Aftermath_pair_share_algorithm.zip`. Extract it, read `README.txt`, read `pair_ranker.mjs`, and run `test_ranker.mjs`, which passes.
- **Don't commit `snapshot_2026-11-03.json` or `rankings_2026-11-03.json`.** They hold real account volumes, and the repo is public. Tests use synthetic fixtures. The two account IDs in the snapshot are sample data and must never appear in code, fixtures or copy.
- The model is a **taker-pool** model:
  - `u` is our **taker** notional: `FilledTakerOrder` fills only.
  - `V` is protocol volume with each matched trade counted once (taker side).
  - Maker fills are not in `u`. They feed the maker Q-score pool, which this round doesn't model.
  - If two of the owner's accounts ever trade with each other, the trade still counts once.
- The core formula is `R × x × (V − u) / (V × (V + x))`. It adds the proposed volume `x` to both our volume and the market's total. Keep it exactly.

#### Two allocation scenarios

The payout rule is unverified, so ship both as scenarios.

- **S1: per market (reference).**
  - pool ÷ `rewardMarketCount`, with each market's share paid by taker-volume share inside that market.
  - This is the package's model. Its epoch-to-date sum on the sample equals the README's volume-only figure exactly (checked by recomputing Σ own/total × pool/65).
- **S2: cross-market (Aftermath distribution API).**
  - The SDK documents taker rewards as "Volume-share-based rewards from the taker reward pool", measured on "Cross-market taker volume" and "Share of total taker volume across all eligible accounts".
  - It also has a `takerOiCoefficient`.
  - Under S2 the marginal reward per dollar is the same in every market, so the ranking comes down to cost.
  - On the sample, S2 epoch-to-date is about 45% of S1, before any OI weighting.
  - That gap plausibly explains part of the unreconciled difference the README describes. Treat this as a lead, not a conclusion.
- **Reconciliation line.**
  - Call `Rewards().getDistribution` for the selected accounts with:
    - `totalTakerRewards` = pool × volume fraction;
    - `totalMakerRewards: 0`;
    - `takerVolumeCoefficient: 1`, `takerOiCoefficient: 0`, and the other coefficients 1.
  - Show its taker rewards next to S1 and S2 epoch-to-date, with the differences.
  - Don't pick a winner in code. The owner picks the active scenario, and the default is S1, labelled "Scenario".
- Don't model maker-quality (Q-score) or open-interest rewards. No formula has been verified for either.

### A1. Ranking service (TypeScript)

- Port `incrementalReward`, the forecast, `score`, `rankPairs` and `allocateVolume` to `packages/core/src/reward-share.ts`, with types.
  - The maths stays identical.
  - S2 is a second scoring function over cross-market totals.
- **Pool divisor.**
  - The divisor is `rewardMarketCount`: every reward market, whatever trading universe the user selects.
  - Markets where our volume is zero stay in.
  - Default `rewardMarketCount` = all listed USDC markets. The owner can override it in settings, because eligibility is unconfirmed.
  - Markets listed during the epoch are flagged "eligibility unconfirmed".
- **Forecast.**
  - Keep the reference forecast: 70% of the other traders' hourly rate over the last 24h, plus 30% over the previous 48h, with our own volume excluded in the same hours.
  - A market observed for less than 72h uses only its observed hours.
  - `forecast: "none"` gives the snapshot-only result.
- **Allocation.**
  - Greedy, one increment at a time: update the numerator and denominator, re-rank, and respect per-market caps (A5).
  - Stop when the best modeled net benefit is ≤ 0, and report the unallocated budget.
- **Costs per market.** The reference flat 4 bps is history, not Maker's cost. It is kept only as a named "historical 4 bps" option and is never the default.

  costUsd(x) = x × (takerFeeBps + builderFeeBps + slippageBps(fillSize)) / 10,000 + fills × gasUsdPerFill + fundingUsd

  - `takerFeeBps`: from `marketParams.takerFee`. Add `takerFee` to the market summary next to `makerFee`.
  - `builderFeeBps`: the configured integrator fee (`AFTERMATH_INTEGRATOR_FEE_BPS`), as the builder code already reports.
  - `slippageBps(fillSize)`: walk the current order book for one fill of `fillSize`, buy and sell, average them, and measure against mid. If the book can't fill it, flag the market "insufficient depth".
  - `fills = x / fillSize`. `fillSize` defaults to the strategy's quote size, because hedge and close legs use it.
  - `gasUsdPerFill`: `maxGasMist` converted at the SUI index price.
  - `fundingUsd`: 0 for a delta-neutral loop (Volume strategy, hedge on), since the two legs offset. Otherwise: hold time × hourly funding rate × notional.
  - Fee-tier refunds are not credited by default. Show the distribution API's current refund rate for information only.

### A2. Live data service (control)

- Add `GET /api/rewards/share`. It's tenant-scoped and takes the selected accounts, the scenario and the settings. It returns the snapshot inputs, the rankings, the reconciliation and the flags.
- **One epoch boundary.**
  - The source is `rewardEpochWindow` in core: fixed 05:00 UTC, 14-day epochs.
  - It matches the sample snapshot.
  - Unresolved: whether Aftermath's boundary follows US Eastern midnight, which would shift it by 1h across DST. Show "Epoch boundary: fixed 05:00 UTC (unconfirmed)" until confirmed.
- **One as-of.**
  - The last completed UTC hour.
  - Every read (market volume, own volume, the external windows) uses that cutoff, so numerator and denominator always match.
- **Market volume `V`.**
  - Hourly candles (`getMarketCandleHistory`, 1h) from the epoch start to the as-of, for every reward market.
  - USD = base volume × (high + low + close) / 3.
  - Cross-check full UTC days against `getMarketsDailyStats`. If a market differs by more than 2%, flag it "volume sources disagree" and show both.
- **Own taker volume `u`.**
  - The selected owner accounts' `FilledTakerOrder` fills from the epoch start to the as-of. Notional = price × size.
  - Read through the existing `AccountFillHistoryCache`, with its pagination and dedup key.
  - When `historyComplete` is false for the window, flag the market "own history incomplete".
  - Read with the owner's account caps (`requireAgent: false`). No trading key is needed to read.
- **Accounts.**
  - Resolve them from `listOwnerAccounts` / `getOwnedAccountCaps` for the session owner. The default is every owned USDC account.
  - The owner can untick accounts, and the choice is saved per owner.
  - Aggregate `u` as the sum over the selected accounts.
  - No account ID is ever hardcoded.
- **External windows.** `last24h` and `previous48h` = candle volume minus our taker volume in the same hours. `observedHours` counts only hours since listing.
- **Prior liquidation.**
  - Derive it per market from the owner's `LiquidatedPosition` history events, with the date.
  - It's a review note, never an exclusion. Don't special-case any symbol: the sample's USDBRL flag must come out of history, not a list.
- **Cache and concurrency.**
  - Completed hours are cached for good. The current hour refreshes at most every 5 minutes.
  - Fetch at most 4 market reads at a time.
  - Cache keys include the owner wherever account data is involved.
  - New fills for the owner invalidate their `u`, so rankings re-score after a trade cycle.
- **Freshness.**
  - The response carries `asOf`, `fetchedAt`, `stale` (as-of older than 90 minutes) and `incomplete` (markets and accounts with gaps).
  - Nothing stale or incomplete is shown without its mark.

### A3. Strategy and Markets UI

- **Strategy > Markets > Suggest markets.**
  - Focus gets a third option, "Reward share". Name it that, not "Rewards", so it doesn't collide with the existing "Best for rewards" preset.
  - With Reward share selected:
    - the preset row is replaced by the scenario picker (Per market / Cross-market);
    - the list is ranked by modeled benefit after costs per $1 of volume.
- **Each candidate shows:**
  - current market share;
  - proposed additional volume;
  - modeled additional reward;
  - estimated execution cost, expandable to taker fee, builder fee, slippage, gas and funding;
  - modeled benefit after costs;
  - flags: insufficient depth, wide spread, session closed, low margin headroom, prior liquidation (with date), own history incomplete, market volume incomplete or disagreeing, under 72h observed, eligibility unconfirmed.
- **Header line**, for example: "Scenario: per market. $70,000 pool ÷ 65 markets, 100% to volume. Data as of 18:00 UTC." The reconciliation numbers sit under it.
- **Optional "Volume budget".** It runs the allocation, shows the per-market amounts, and shows the unallocated remainder when the benefit falls below cost.
- **Selection.**
  - Tick candidates, then "Add to draft". They go through the existing Preview selection → accept → Strategy review flow.
  - This is advisory selection and Paper evaluation only. Nothing auto-starts.
- **Markets view.** Add a "Reward share" column for the epoch, and the modeled benefit of the next increment, sortable. Markets in use show it too.
- **Copy.** Say "modeled" and "scenario" everywhere. Never "expected" or "you'll earn".

### A4. Settings and assumptions

- A per-owner "Reward model" sheet, opened from the suggestion panel. It holds:
  - epoch pool (initially $70,000, labelled "from the reference model, unverified");
  - volume reward fraction (0–1, default 1);
  - increment (default $32,000 of notional, not collateral);
  - fill size (default: the strategy's quote size);
  - forecast (recent / none);
  - active scenario;
  - `rewardMarketCount` override;
  - extra cost bps;
  - fixed cost per increment.
- It's tenant-scoped and validated with typed codes, and every change logs an audit event.
- Changing these never touches a saved strategy or a running bundle.

### A5. Execution constraints (separate from ranking)

- Ranking stays pure maths. Suitability is a separate assessment that uses existing services:
  - session open;
  - spread within the strategy limit;
  - depth within 10 bps of at least 3 × the fill size on both sides;
  - free collateral of at least the initial margin for the fill at effective leverage (round 12 leverage rules);
  - room under `maxInventoryUsd`, gross exposure and venue open-interest limits.
- Each candidate gets one status: "Suitable", "Needs review" (with reasons) or "Not suitable now".
  - "Add to draft" allows "Needs review" with a warning, and blocks "Not suitable now".
- Allocation caps come from this assessment through `maxAdditionalVolumeByMarket`.
- Prior liquidation stays a "Needs review" note with its date. It never marks a market permanently unsuitable.

### A6. Accept

- **Parity.** Run the original `pair_ranker.mjs` and the TS port on the same synthetic snapshot. Rankings, rewards and allocations match within 1e-7. Record the command and output in the PR, and don't commit the original files.
- **Unit tests:**
  - incremental reward;
  - diminishing returns;
  - the pool divisor unchanged when the universe is filtered;
  - zero-own markets included;
  - forecast windows, including under 72h observed;
  - volume-fraction scaling;
  - S2 equal marginal reward across markets;
  - cost handling (fee parameters, the book walk, gas, the delta-neutral funding rule, the historical option never the default);
  - allocation caps;
  - stopping when the benefit falls below cost;
  - unused budget.
- **Data tests (FakeGateway):**
  - subaccount aggregation across two accounts;
  - pagination with overlapping pages deduped;
  - incomplete history flagged;
  - the same as-of on every read;
  - the epoch boundary;
  - candle vs daily disagreement flagged;
  - stale data marked;
  - the liquidation note from history;
  - the reconciliation call made with the documented inputs.
- **Tenant isolation.** Owner A can't read B's accounts, rankings or settings, and can't select B's account IDs. Typed 4xx.
- **e2e.** Pick Reward share, switch scenario, expand costs, set a budget, add two candidates to the draft, and review. Desktop and phone captures, both themes, and `shots.mjs` passes.
- **No regressions.** Typecheck, the full test suite and the web build pass. No existing strategy, bundle or production setting changes.

## Part B. Post Fiat research bundles (discovery only)

- The owner wants to know whether `https://tasknode.postfiat.org/api/research/bundles/ga-models/index.html` could inform a strategy. It couldn't be opened from outside: the site returned an error, so it probably needs a session or app context.
- From your machine, fetch that index and its linked files, read-only.
- Write `docs/design/round13/POSTFIAT_GA_MODELS.md` covering:
  - what each bundle or model is, and how it was produced;
  - the symbols it covers, mapped to Aftermath markets by symbol and market id, with unmapped ones listed;
  - fields, prediction horizon, update cadence, history depth and format;
  - access: auth, rate limits, stability of URLs;
  - license or terms of use.
- Then propose, in the doc only, how it could feed a strategy. For example:
  - a filter or weight in Suggest markets;
  - a quote-skew input;
  - a Paper-only experiment.
  Include one testable hypothesis using data that's actually available, and how Paper would measure it.
- No integration code this round. The owner reviews the doc first.
- Never send account data, wallet addresses or keys to that API.
- Accept: the doc is in the PR with sample responses. Redact anything that looks like a credential.

## Part C. Go live sheet: copy and operator clarity

What the owner saw in Bundles, in the Go live sheet: the line heading "Live is on for this server", with the status "Live is off on this server. Ask the operator." The owner runs this server.

Root cause, three parts:

- **Headings phrased as facts.** Every checklist heading in `GoLiveSheet` (`views/strategy.tsx` ~145–185) states the requirement as already true: "Live is on for this server", "Signing key is available on control", "This bundle is Core". Read next to a failing status, the line contradicts itself.
- **The operator gets the non-operator text.**
  - "Operator" means the wallet stored in `system_settings.operator_address` when bootstrap was first claimed (`auth.ts` `isOperator`, `store.ts` `claimBootstrapOperator`).
  - When the connected wallet isn't that one, the sheet says "Ask the operator" and nothing else. An owner signed in with a different wallet has no way to tell why.
  - The wallet menu shows "Access: Operator / Whitelisted", but the sheet doesn't connect the two.
- **Stale copy.** The sheet still says "Use Live mode?" and "after you save this strategy and press Start". Since round 12, mode belongs to the bundle.

Fix:

- Make every line a neutral requirement with a status, and show the fix only when it's needed:
  - Live enabled on this server
  - Signing key on control
  - Runs on Core
  - Core stopped
  - Live trading key
  - Live gas reserve
  - Collateral

  Status is "Done" or "Needed".
- Live enabled on this server, when Needed:
  - For the operator: the existing instruction (set `LIVE_TRADING_ENABLED=true` and `ALLOW_MAINNET=true` in control's `.env`, then `docker compose up -d --no-build --force-recreate control`).
  - For everyone else: "Live is off on this server. The operator wallet can turn it on. You're connected with 0xab…cd, which isn't this server's operator wallet. If you run this server, sign in with the wallet that first set it up."
  - Never show the operator's address to a non-operator.
- Title: "Switch Core to Live?". Description: "Core will quote with real funds after you switch and press Start Live."
- Check `isOperator` against mixed-case and unpadded addresses, and against a zkLogin address. Both sides go through `normalizeAddress`.
- The server's `live-unavailable` message (`server-app.ts` ~1117) uses the same non-operator copy, and the operator copy when `operator` is true.

Accept:

- A unit test covers `isOperator` normalization: mixed case, unpadded, zkLogin.
- e2e captures for three cases, desktop and phone: operator with gates off, non-operator with gates off, and gates on with every line Done.
- No heading in the sheet asserts a condition: a test reads the heading list.

## Hard constraints (unchanged)

- `LIVE_TRADING_ENABLED` and `ALLOW_MAINNET` stay off in `.env`, docker-compose and every default. Tests may turn them on only through `buildServer`'s injected env, with FakeGateway.
- Never sign or broadcast a transaction. Tests use FakeGateway and the mock wallet only.
- No production API calls from tests, and no deploys. The owner deploys. Don't edit `.env` or the master key.
- Don't test Live against the retained audit accounts or production without written authorization.
- Stop is never disabled while anything runs.
- The repo is public. Keep security details, real account IDs and real account volumes out of commits, fixtures, PR text and docs.

## Report

- Parts A, B and C in order. Every Accept line gets a ✓ and its proof.
- List the unresolved data and reward-rule dependencies, including the payout rule, the epoch boundary and reward eligibility.
- Say how to use the feature.
- Any blockers go last.
- End with the deploy steps for the merged SHA, so web and control ship from the same commit.
