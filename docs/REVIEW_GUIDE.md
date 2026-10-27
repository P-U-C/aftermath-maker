# Review guide

This document maps product claims to inspectable source, tests, and the bounded mainnet traces in [`EVIDENCE.md`](../audits/2026-10-27-mainnet/EVIDENCE.md). The audit now includes independent fills, a fill-driven second-account hedge, actual residual-delta reconciliation, and two-account reduce-only recovery. Withdrawal and capability revocation traces remain outstanding.

## Claim map

| Claim                              | Implementation                                                                                                                                                                                                                              | Regression evidence                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet-scoped tenancy              | `apps/control/src/server.ts` resolves the signed owner into a `TenantStore`; tenant tables key every setting, signer, event, execution, and tracked order by normalized owner address.                                                      | `apps/control/test/store.test.ts` writes two wallets and verifies no cross-tenant setup, events, orders, or gas statistics.                                                           |
| Operator-only membership           | Every membership route requires `operatorAuth`; deployment confirmation binds the bootstrap operator to the transaction sender and on-chain `AdminCap` owner.                                                                               | Allowlist regressions plus a production member-wallet HTTP 403; the member view omits the operator panel.                                                                             |
| Trading-only agent                 | `packages/aftermath/src/gateway.ts` uses Aftermath's grant-agent transaction, binds confirmation to the created cap, and combines cap plus fee-approval removal on revoke.                                                                  | Two grants are confirmed on mainnet; revocation still requires a representative trace. The app never holds the owner key.                                                             |
| Multiple account capabilities      | One encrypted signer is retained per tenant while setup and grant records are scoped by Aftermath account ID. Maker and hedge roles must use distinct authorized accounts.                                                                  | Store tests verify two isolated grants remain decryptable through the original signer context.                                                                                        |
| Fill-driven paired hedge           | The runtime accepts only unprocessed fills from recorded Maker order IDs, cancels quotes, polls until both accounts report no resting orders, caps the opposite market order, then verifies actual combined delta from fresh account state. | Runtime tests cover stale post-cancel reads, partial and no-progress hedges, and unrelated orders. Mainnet iteration 3 confirms cancel, hedge, residual reconciliation, and recovery. |
| Exact builder authorization        | The grant transaction sets the integrator ID and maximum fee; confirmation re-reads the on-chain approval. Transaction policy rejects missing, moved, or changed builder fields.                                                            | `packages/core/test/core.test.ts` covers exact-fee and forbidden-field cases.                                                                                                         |
| Maker-only cancellation            | Each quote uses fresh IDs in Maker's reserved namespace. Cancellation combines confirmed ledger IDs with matching live pending IDs and excludes unrelated orders.                                                                           | Gateway and runtime regressions verify unique replacement IDs, exact cancellation, and post-only construction.                                                                        |
| Atomic requotes                    | Live execution uses Aftermath `getCancelAndPlaceOrdersTx` for one bid and one ask.                                                                                                                                                          | The canary posted two order IDs in one transaction, then canceled both exact IDs in a second transaction.                                                                             |
| Independent stale-order protection | A timer separate from the rotation loop invalidates execution and cancels with retries. Manual stop has a bounded wait and both paths reconcile after an ambiguous cycle.                                                                   | Runtime tests stall the market RPC and reproduce an uncertain broadcast.                                                                                                              |
| Reduce-only flatten                | Flatten builds market orders opposite live position deltas with `reduceOnly: true`, after stopping and cancelling tagged quotes. Builder fields are forbidden.                                                                              | Runtime regressions cover both roles; mainnet iteration 3 confirms separate reduce-only transactions for accounts 1745 and 1746.                                                      |
| OI definition                      | The gateway reads absolute one-sided `marketState.openInterest`. USD is base OI multiplied by current index price; capacity divides base OI by the protocol maximum.                                                                        | The UI labels base units, USD estimate, and timestamp. Source is in `packages/aftermath/src/gateway.ts`.                                                                              |
| Fill attribution                   | Confirmed post events provide order IDs. The ledger accepts only maker fills matching IDs recorded for the signed tenant.                                                                                                                   | Store and runtime tests verify tenant isolation and exclusion of another client's maker fill.                                                                                         |
| Gas runway                         | Paid gas is computation plus storage cost minus storage rebate; average confirmed quote gas is divided into agent SUI.                                                                                                                      | Gateway/store regressions and the canary's exact agent balance delta.                                                                                                                 |
| Reconfiguration safety             | The runtime stops and cancels the previous market set before saving or starting a replacement configuration.                                                                                                                                | Runtime regression records the exact old market IDs sent to cancellation.                                                                                                             |
| Fair-value and loss gates          | Quotes anchor to the protocol index; book divergence, worst next-fill exposure, collateral, gas, unrealized loss, and run equity drawdown are checked before signing.                                                                       | Core and runtime risk regressions.                                                                                                                                                    |
| Objective-specific staging         | Farming ranks capital-efficient turnover, Profit ranks pre-risk fill economics, and Both uses their harmonic mean while requiring positive half-spread after known fees.                                                                    | Core tests verify high turnover can win Farming, stable depth can win Profit, negative known edge fails Both, and staged Farming/Profit policies differ.                              |
| Secret isolation                   | Only the internal control container receives `MAKER_MASTER_KEY`; the public web container receives one internal token and runs read-only without Linux capabilities.                                                                        | Compose inspection plus deployed container inspection.                                                                                                                                |

## Run the evidence

```bash
npm ci
npm run check
npm audit --omit=dev
sudo docker run --rm \
  -v "$PWD/move/maker_access:/workspace" \
  -w /workspace mysten/sui-tools:mainnet sui move test
```

## Mainnet trace checklist

A source review cannot establish live protocol behavior by itself. Capture and inspect these transactions with a deliberately small account:

1. Create an Aftermath USDC account.
2. Grant the generated agent and approve the exact builder fee.
3. Post the first atomic bid/ask replacement.
4. Authorize the same signer on a second Aftermath account and assign it as the hedge account.
5. Fill one Maker-tagged order from an independent account and cross the hedge threshold.
6. Confirm Maker quotes are cancelled before the second account submits the opposite public-book market order.
7. Place an unrelated resting order on the hedge account and confirm the hedge fails closed without trading.
8. Stop and confirm only the two Maker client IDs are cancelled.
9. Open a small position, then confirm the separate reduce-only flatten.
10. Revoke both account capabilities from the owner wallet.

For every trace, verify sender, account ID, capability object, market ID, order type, client order ID, builder ID and rate, gas, effects, and resulting open orders or position.

## Known limits

- Fair value is anchored to Aftermath's protocol index and checked against the local book. Independent multi-venue fair value is not implemented.
- Paired-account hedge fills and known fees are reconciled, but markouts, attributed funding, gas in USD, explicit slippage decomposition, and inventory carry are not yet in net performance.
- Both hedge legs use Aftermath. This reduces bot-attributed direction but is not a venue-diversified or spot delta hedge.
- Thin markets can require a materially wider hedge or flatten slippage cap. Maker reports the venue failure and never raises the user-approved cap automatically.
- Fill attribution starts after tracked-order deployment; it cannot retroactively identify old client orders.
- Builder fees are estimated deterministically from filled notional. Confirm the actual collateral effects in the mainnet trace.
- Public gRPC is the default. A private validator endpoint improves operational control but does not remove protocol or oracle risk.
- A deliberate restart resets the run-equity drawdown baseline; daily and lifetime loss limits are not yet implemented.
- Same-venue hedge reconciliation reads the latest 200 fills and needs cursor-based ingestion before high-volume operation.
- Farming, Profit, and Both rankings are disclosed heuristics. Farming lacks the future reward-pool denominator and reward value; Profit lacks markouts, gas in USD, attributed funding, and inventory carry.
- Pre-risk edge is half the observed spread less current maker and builder fees. It is not expected or realized profit.
- Self-matched volume is not generated by Maker and is not assumed reward-eligible without explicit protocol confirmation.
