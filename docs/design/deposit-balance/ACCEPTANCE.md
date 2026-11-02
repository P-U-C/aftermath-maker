# Deposit-sheet balance recovery

Scope: client-side UX only, built on merged Round 10. No production API call, database write, deployment, Live gate change, real-wallet signing or broadcast occurred.

**Observed failure mode in code:** the Venues balance effect awaited USDC and SUI together with `Promise.all`, clearing both balances if either RPC failed. The deposit sheet required a known owner-wallet USDC balance; it silently disabled its action when the combined read failed or when the prefilled shortfall exceeded the wallet balance. The legacy Accounts Deposit used a separate direct action instead of the guided Venues sheet. Read-only control logs during investigation contained no POST to the deposit-transaction route, consistent with a browser-side block, but do not prove the owner's exact cause without a screenshot.

**Change:** independently read each owner-wallet asset with a bounded 10-second request; USDC remains usable when the unrelated SUI read fails. Show loading, unavailable/retry and insufficient-balance/partial-deposit guidance, and never let an unknown balance authorize a transaction. Accounts Deposit opens the same Venues sheet; withdrawals retain their existing path. Owner-verified transaction intent, backend routes, Live switches and risk rules did not change.

**Mock-wallet checks:** `user-journey.mjs --deposit-balance-only` at 1440/390 covers a failed SUI read plus $100 USDC against a $300 prefill (disabled with explanation, then $50 partial deposit succeeds); a failed USDC read (disabled, retry then succeeds); two-account partial funding; and Accounts Deposit opening the Venues sheet. All signatures are local mock-wallet transactions. `npm run check` runs the same scenarios in its full browser journey.

| Local fixture state | Phone evidence | Desktop evidence |
| --- | --- | --- |
| Owner wallet has less than the prefilled shortfall | [single-account 390](evidence/deposit-low-balance-390.png) | [single-account 1440](evidence/deposit-low-balance-1440.png) |
| USDC RPC fails; retry is offered | [retry 390](evidence/deposit-read-failed-390.png) | [retry 1440](evidence/deposit-read-failed-1440.png) |
| Both bundle accounts need funds; partial deposit still allowed | [two-account 390](evidence/bundle-deposit-low-balance-390.png) | — |

Phone browser checks also assert that the deposit action remains fully inside the viewport after the sheet entrance animation. No screenshot uses a real wallet or production service.
