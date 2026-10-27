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

## MON replacement and fill iteration

The second iteration moved to MON and proved sustained atomic replacement with unique Maker-owned client IDs. Three initial quote transactions and two replacements completed without the previous HTTP 409:

- [Initial MON quote](https://suiscan.xyz/mainnet/tx/2eRwMvYNTpasK5QszX3PEDuv22giLqCyeAN71U21GAjh)
- [First atomic replacement](https://suiscan.xyz/mainnet/tx/NF8Um4pmCpXKDrNE4hFS8d6iJ9DkYwuNbHvfcFvDjq4)
- [Second atomic replacement](https://suiscan.xyz/mainnet/tx/6Xy9sUNfYDWT5gRXqTb6YUgYv17xvEmVb13aat4KHPb4)
- [Final pair cancellation](https://suiscan.xyz/mainnet/tx/FtJPNqxtqitsRxLUzsreLYcufDZVTcM2ss47GESFc8uf)

An independent taker then filled one 48.1 MON Maker ask for $1.0309273 in [HETLEy...](https://suiscan.xyz/mainnet/tx/HETLEyv5HkfH819CNLuCX11Soe1XTHHaYL6wW7xEWPVd). The order ID matched Maker's ledger, giving 100% attribution coverage for reported Maker volume. Known fill economics were a $0.000051546365 base maker rebate and a $0.00010309273 builder fee.

That fill exposed a hedge-ordering defect: quote-entry safety halted the cycle before fill reconciliation. The position was closed through the product's reduce-only flatten action in [8gjkdG...](https://suiscan.xyz/mainnet/tx/8gjkdGLMkJWK25aiaSEXfA3dW4CfMvxX4G6WTKhx2kTK). The fix now runs defensive fill reconciliation before quote-entry safety and flattens both configured account roles. A post-fix 10-minute run completed 41 consecutive replacements without an error or second fill, then cancelled its final pair in [Ag91ka...](https://suiscan.xyz/mainnet/tx/Ag91kaEac4VH2sRiqS1fHa8rzjLfr9uvP2fYEqAMcMVc).

See [ITERATION-2.md](ITERATION-2.md) for the full trace, defect analysis, and evidence boundary.

## Fill-driven hedge iteration

Three further independent MON fills exercised the corrected hedge path. The final successful fill was [`BUSKk3...`](https://suiscan.xyz/mainnet/tx/BUSKk3Pky8uSy86Ti1zkmhMXxc9d93wxSzEqcsZSp9oS), a 47.9 MON Maker ask worth `$1.0389989`.

The runtime cancelled the remaining Maker quote in [`6RkujP...`](https://suiscan.xyz/mainnet/tx/6RkujPD5ZmdaXXW5hwYyfLQr1VZ3iW9BSF2DzX3axwSc). The first account read still reported one pending order; the bounded reconciliation loop waited 750 ms and confirmed both accounts clear before proceeding. Hedge account 1746 then submitted the opposite public-book market order in [`8ARc5A...`](https://suiscan.xyz/mainnet/tx/8ARc5AYa8QPJgqSqcijYpJS6zt9KkvpJuvtsePWcLjj4). Fresh account state measured `$0.0015328` combined residual delta, inside the `$0.020779978` completion tolerance.

A 75 bps attempt had previously failed simulation with Aftermath `execute_limit_order` abort code 46. The successful run used an explicitly configured 500 bps ceiling; Maker never raised the cap automatically. Recovery then flattened both account roles separately:

- Maker account 1745: [`5CBCNk...`](https://suiscan.xyz/mainnet/tx/5CBCNkgYPTJwp9Qd9gjPMcyBcnxXX8h8nDR8zjFzUDrt)
- Hedge account 1746: [`4kMHLp...`](https://suiscan.xyz/mainnet/tx/4kMHLpYPdhmK833Jx2BKc4RztUfTYC1CKW8EyEfJFEYm)

See [ITERATION-3.md](ITERATION-3.md) for the failure sequence, fixes, and full hedge evidence.

## Objective and cross-market rotation

The bounded three-objective Live canary confirmed one MON quote transaction for each policy, cancelled between policy changes, then recovered both accounts and restored the prior configuration:

- Farming: [`E2pH2F...FDF9`](https://suiscan.xyz/mainnet/tx/E2pH2F3gKBVDLvyYj5PqPywZsHGvY9CnRtdVPWVFDF9)
- Profit: [`J8CvTE...zfZP`](https://suiscan.xyz/mainnet/tx/J8CvTEXiiX6oq12Ybupr88VfsdJ8dQUpNYYWL47FzfZP)
- Both: [`9P4PWt...heab`](https://suiscan.xyz/mainnet/tx/9P4PWtFRHebedqo36Q5uTLEe9QbBgAcXSEEX9dbUheab)

A corrected 15-market one-live-pair canary counted persisted confirmed transactions rather than calculated cycles. It proved three consecutive markets and the atomic cross-market switch path:

- MON: [`V1zMTh...jqo9`](https://suiscan.xyz/mainnet/tx/V1zMThjmDWSzA3KY6m4KDe7jV32Y4TW6BM9qWMbjqo9)
- CHIP: [`Bg1Nia...bEFH`](https://suiscan.xyz/mainnet/tx/Bg1NiaqFs7Sv4QYNzHouDQGQAuoN37LLPBuYM1FcbEFH)
- ETH: [`8LtBjo...toHd`](https://suiscan.xyz/mainnet/tx/8LtBjoTxaSrC7xK5Kd1CDAEee7CSxrnUszgf9TJXtoHd)

Both bounded runs ended stopped, restored the saved Paper strategy, and reported zero positions on accounts 1745 and 1746. See [ITERATION-4.md](ITERATION-4.md) for the 15-market set, first observer defect, measured gas economics, and unattended-operation boundary.

## Long rotation and automatic rebalance

A 45-action suite ran 15 bounded batches across 20 distinct markets. It produced 14 newly attributed Maker fills, seven confirmed hedges, and 18 recovery transactions without a cycle error or watchdog trip. Every one of seven post-cancel and seven post-hedge index waits resolved; two fill/position ordering mismatches also resolved inside the bounded reconciliation window. Eight post-only crossing races were retried without relaxing post-only.

A first automatic-rebalance canary confirmed a paired flatten but failed closed when an earlier market's position remained visible. Its recovery completed a second reduce-only pass and restored both accounts flat. Maker now performs up to three bounded paired sweeps itself and records residual state before each retry.

The corrected 15-market Live canary completed 15 confirmed quote actions, four real fill-driven hedges, and four automatic paired-account rebalances. It continued rotation after each rebalance, reported 12 avoided paid replacements, then stopped and found both accounts already flat. The final recovery therefore submitted no market order. Representative evidence:

- First hedge: [`99iS76...r7RD`](https://suiscan.xyz/mainnet/tx/99iS766VX5s6Tx2x5o8F4LVKD532RBBC673JVNBcr7RD)
- First paired flatten: [Maker `F8JY8L...sjdn`](https://suiscan.xyz/mainnet/tx/F8JY8LtgXMPmCE2nTFxCWFvUzN8T1rQKLqSDnFAmsjdn), [hedge `DBmVm3...WDFJ`](https://suiscan.xyz/mainnet/tx/DBmVm3k5gfD1bdrREbRv4vqWEg1aq7BZmHWcRM3LWDFJ)
- Fourth hedge: [`FF3k4C...redE`](https://suiscan.xyz/mainnet/tx/FF3k4CkAvSMxvNRuNnp3eCeoiwmr1Q6AM4eFHmVdredE)
- Fourth paired flatten: [Maker `CrEiqX...AKpH`](https://suiscan.xyz/mainnet/tx/CrEiqXGLH4wHwwWKdMvoWgX9u4cqctqLdtooN7ySAKpH), [hedge `2afyyw...uRoy`](https://suiscan.xyz/mainnet/tx/2afyywkcTLEqTSezBkVaiHkCDHzUcZ4AP5Bf4uCwuRoy)

The corrected run's observed agent balance changed by `-0.008615794 SUI`. Reported account-pair equity changed by about `-$0.015608`. These are balance movements, not complete PnL. See [ITERATION-5.md](ITERATION-5.md) for the failure sequence, all four rebalance epochs, measured costs, and evidence boundary.

## Browser evidence

- [Final desktop reconciliation](member-reconcile-paper.png)
- [Authenticated 390 px account and strategy view](member-mobile.png)
- [Fail-closed Live gate](member-test-live-gate.png)
- [Post-canary control state](member-live-canary.png)
- [Staged MON headroom and performance attribution](member-staged-headroom.png)
- [Funded readiness immediately after a fresh-container restart](member-restart-readiness.png)
- [Strategy objectives, rotation controls, and canary on desktop](strategy-desktop.png)
- [Strategy controls at 390 px](strategy-mobile.png)

## Final state

At the final read:

- Account 1745 equity: about $7.44242
- Account 1746 equity: about $7.44930
- Saved mode: Paper
- Rotation: one live pair across 15 staged markets, with 5-second polls and 60-second turns
- Engine: stopped
- Confirmed quote actions in the long bounded suite: 45 across 20 distinct markets
- Confirmed quote actions in the corrected automatic-rebalance canary: 15 across 15 selected markets
- Confirmed automatic paired-account rebalance epochs: 4
- Both accounts: zero positions; the final canary recovery found nothing left to flatten
- Live gates: both disabled
- Agent gas: 2.985289723 SUI
- Root response: private, no-cache, no-store
- Desktop and 390 px authenticated layouts: no page-level horizontal overflow or browser errors
- Membership management: hidden from the member wallet; its operator status request returned HTTP 403
- Final state backup: `backups/aftermath-maker-20261027T165125Z.tar.gz` on the deployment host

The agent capabilities remain intentionally authorized on both accounts for further testing. They were not revoked because this is the retained audit setup.

## What remains unproven

Mainnet now proves fill ingestion, exact current-run order attribution, known fee reporting, repeated atomic replacement, a three-policy canary, N-market one-pair rotation, global fill reconciliation before switching, protective halt, bidirectional fill/position index-lag reconciliation, fill-triggered hedging from the second account, actual combined-delta verification, automatic paired-account rebalance, continuation after rebalance, and reduce-only recovery of both accounts. Withdrawal and final capability revocation were not executed because the two-account setup is being retained. Independent external fair value, cross-venue hedging, long-duration economics, restart recovery after a hard host failure, and complete net PnL attribution remain outside this bounded audit.
