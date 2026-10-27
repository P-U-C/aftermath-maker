# Mainnet audit evidence

Audit date: 2026-10-27

Network: Sui mainnet

Product: https://maker.permanentupperclass.com

## Identities

| Role                    | Address                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| Dedicated owner         | `0xf1dd50b692e6e74d17f4032dd67c6f4ce8165055aecddd874b7cd69dd2cba488` |
| Encrypted trading agent | `0x00a4489c1ec3b85c2694e70d776eb0c9ad2a5d8fd50f3ed70ff8df7298e07060` |

Private key material was generated and encrypted outside the repository. It is not included in screenshots, logs, or this report.

## Account lifecycle

The public product interface created, funded, and authorized two independent Aftermath USDC accounts.

| Action                       | Account | Transaction                                                                                      |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| Create                       | 1745    | [`9tdFvHx5...tQ`](https://suiscan.xyz/mainnet/tx/9tdFvHx5t9R8b6sBCizKRzxJQsuzgHFh2rdQYHGk7tkQ)   |
| Create                       | 1746    | [`6n7rAQtV...bVY`](https://suiscan.xyz/mainnet/tx/6n7rAQtVMUQuqWbjtAHZnyoJmbsZXuR12h4SnSWHVBvY)  |
| Grant agent and seed 0.1 SUI | 1745    | [`H1fkqo9R...hNGC`](https://suiscan.xyz/mainnet/tx/H1fkqo9R4PJ1trVJxCjNq2CdAaKZ9ppZ5C4ACRjhnNGC) |
| Grant agent and seed 0.1 SUI | 1746    | [`CrFfE3xQ...M4q4`](https://suiscan.xyz/mainnet/tx/CrFfE3xQqW95KjgS6AhmhLKATCTiBFWWMuP6sWFeM4q4) |
| Deposit 7.50 USDC            | 1745    | [`6RhrLDeF...shWS`](https://suiscan.xyz/mainnet/tx/6RhrLDeFzE9pxBpFfTL1LMfqusS6VmUGYjq1bnrYshWS) |
| Deposit 7.50 USDC            | 1746    | [`HSy3h1FL...bvQR`](https://suiscan.xyz/mainnet/tx/HSy3h1FLKitcxwtfxL99Jjn3YeFj9AGLTzvx1KpFbvQR) |

The owner retained exactly 5 USDC after both deposits. The account roles are:

- Maker: account 1745
- Hedge: account 1746
- Agent capability for 1745: `0x805aa2b660d7ceb978313652b3c5163c21f566bbbd52e9716a055005ed913870`
- Agent capability for 1746: `0x2883f9500e37b6c73c04b7799d7dbd0ef10b6d350ca1484392bf360dd04e66dc`

The interface reported about $7.50 equity, $7.50 free collateral, and zero open positions on each account after reconciliation.

## Tested policy

| Control                        | Value               |
| ------------------------------ | ------------------- |
| Market                         | BTC                 |
| Quote size                     | $1 per side         |
| Spread                         | 50 bps              |
| Per-market inventory limit     | $3                  |
| Portfolio gross exposure limit | $3                  |
| Unrealized loss limit          | $1                  |
| Run drawdown limit             | $1                  |
| Book/index divergence limit    | 50 bps              |
| Leverage                       | 1x                  |
| Refresh                        | 15 seconds          |
| Stale quote cutoff             | 120 seconds         |
| Hedge trigger                  | $1                  |
| Maximum hedge order            | $5                  |
| Hedge slippage limit           | 75 bps              |
| Builder code                   | Integrator 15, 1 bp |

Observe completed three cycles without a write. Paper completed three simulated quote cycles without a write. All 13 preflight checks passed during the final Paper reconciliation.

## Bounded Live canary

Maker submitted one atomic, post-only BTC quote cycle from the encrypted agent.

- Quote transaction: [`65SL7GwD...FzQ3`](https://suiscan.xyz/mainnet/tx/65SL7GwDgijeBWJkpuGCJSXvQGqyU5Le2xCFdi4fFzQ3)
- Recorded intent: bid `79422.07995756`, ask `79820.18562150`, $1 per side
- On-chain account: 1745
- Integrator: 15
- Integrator fee rate: 1 bp
- Bid client order ID: `5788606895309848577`
- Ask client order ID: `5788606895309848578`
- Bid order ID: `340280901842173348503096362828416784169`
- Ask order ID: `1472422543057894119965720598124330`
- Actual quote gas balance change: `-4,085,570 MIST`

No order filled. Manual stop canceled both exact order IDs:

- Cancel transaction: [`3L7AJSaF...6QDZqM`](https://suiscan.xyz/mainnet/tx/3L7AJSaF4SkHGziUjaKqc2bGLJnisqwCfFNEG26QDZqM)
- Cancellation events: 2
- Cancel net SUI balance change: `+687,094 MIST` because the storage rebate exceeded the new charge
- Subsequent agent transactions: none
- Attributed fills: 0
- Maker and hedge positions: 0
- Combined known result: $0.00

The first audit build added the non-refundable storage fee twice when displaying paid gas. The chain balance change exposed the discrepancy. The release now uses Sui's SDK formula: computation cost plus storage cost minus storage rebate.

## Browser evidence

- [Final desktop reconciliation](member-reconcile-paper.png)
- [Authenticated 390 px account and strategy view](member-mobile.png)
- [Fail-closed Live gate](member-test-live-gate.png)
- [Post-canary control state](member-live-canary.png)

## Final state

At the final read:

- Owner wallet: 5 USDC and 0.758343458 SUI
- Agent wallet: 0 USDC and 0.196601524 SUI
- Saved mode: Paper
- Engine: stopped
- Live quote count: 1
- Maker fills: 0
- Hedge executions: 0
- Live gates: both disabled
- Root response: private, no-cache, no-store
- Desktop and 390 px authenticated layouts: no page-level horizontal overflow
- Membership management: hidden from the member wallet; its operator status request returned HTTP 403
- Post-canary state backup: `backups/aftermath-maker-20261027T030843Z.tar.gz` on the deployment host

The agent capabilities remain intentionally authorized on both accounts for the next fill-driven hedge test. They were not revoked because this is the retained audit setup.

## What remains unproven

A zero-fill canary cannot prove fill ingestion, realized spread, fee attribution, the fill-triggered hedge, reduce-only flattening, or hedge slippage. Withdrawal and final capability revocation were also not executed because the two-account setup is being retained. Those paths have local regressions, but they remain mainnet verification items.
