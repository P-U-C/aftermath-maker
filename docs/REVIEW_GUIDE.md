# Review guide

This document maps product claims to inspectable source and tests. It is not a substitute for a mainnet trace review.

## Claim map

| Claim                              | Implementation                                                                                                                                                                         | Regression evidence                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet-scoped tenancy              | `apps/control/src/server.ts` resolves the signed owner into a `TenantStore`; tenant tables key every setting, signer, event, execution, and tracked order by normalized owner address. | `apps/control/test/store.test.ts` writes two wallets and verifies no cross-tenant setup, events, orders, or gas statistics.                                    |
| Trading-only agent                 | `packages/aftermath/src/gateway.ts` uses Aftermath's official grant-agent transaction, then re-discovers an `isAgent` account capability owned by the generated signer.                | Requires representative owner grant and revoke traces on mainnet; the app never holds the owner key.                                                           |
| Multiple account capabilities      | One encrypted signer is retained per tenant while setup and grant records are scoped by Aftermath account ID. Maker and hedge roles must use distinct authorized accounts.             | Store tests verify two isolated grants remain decryptable through the original signer context.                                                                 |
| Fill-driven paired hedge           | The runtime accepts only unprocessed fills from recorded Maker order IDs, cancels quotes, verifies both accounts have zero resting orders, and caps the opposite market order.         | Runtime tests verify cancel-then-hedge-then-quote ordering and fail-closed behavior when the hedge account has an unrelated order.                             |
| Exact builder authorization        | The grant transaction sets the integrator ID and maximum fee; confirmation re-reads the on-chain approval. Transaction policy rejects missing, moved, or changed builder fields.       | `packages/core/test/core.test.ts` covers exact-fee and forbidden-field cases.                                                                                  |
| Maker-only cancellation            | Quote transactions use two fixed client order IDs. Cancellation fetches pending orders and selects only those IDs.                                                                     | `packages/aftermath/test/keystore.test.ts` verifies replacement IDs and post-only order construction.                                                          |
| Atomic requotes                    | Live execution uses Aftermath `getCancelAndPlaceOrdersTx` for one bid and one ask.                                                                                                     | Source inspection plus a representative quote trace is required for end-to-end confirmation.                                                                   |
| Independent stale-order protection | A timer separate from the rotation loop invalidates execution and cancels immediately. It retries cancellation after an ambiguous in-flight transaction resolves.                      | `apps/control/test/runtime.test.ts` stalls the market RPC and verifies the watchdog still stops and cancels.                                                   |
| Reduce-only flatten                | Flatten builds market orders opposite live position deltas with `reduceOnly: true`, after stopping and cancelling tagged quotes. Builder fields are forbidden.                         | `apps/control/test/runtime.test.ts` verifies one cancellation followed by the separate flatten path. A trace is still required to validate protocol execution. |
| OI definition                      | The gateway reads absolute one-sided `marketState.openInterest`. USD is base OI multiplied by current index price; capacity divides base OI by the protocol maximum.                   | The UI labels base units, USD estimate, and timestamp. Source is in `packages/aftermath/src/gateway.ts`.                                                       |
| Fill attribution                   | Confirmed post events provide order IDs. The ledger accepts only maker fills matching IDs recorded for the signed tenant.                                                              | Store and runtime tests verify tenant isolation and exclusion of another client's maker fill.                                                                  |
| Gas runway                         | Paid gas is calculated from execution effects net of storage rebate; average confirmed quote gas is divided into agent SUI.                                                            | `packages/aftermath/test/gateway.test.ts` and `apps/control/test/store.test.ts`.                                                                               |

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

- The current reference price is Aftermath's local order book. Multi-venue fair value is not implemented.
- Paired-account hedge fills and known fees are reconciled, but markouts, attributed funding, gas in USD, explicit slippage decomposition, and inventory carry are not yet in net performance.
- Both hedge legs use Aftermath. This reduces bot-attributed direction but is not a venue-diversified or spot delta hedge.
- Fill attribution starts after tracked-order deployment; it cannot retroactively identify old client orders.
- Builder fees are estimated deterministically from filled notional. Confirm the actual collateral effects in the mainnet trace.
- Public gRPC is the default. A private validator endpoint improves operational control but does not remove protocol or oracle risk.
