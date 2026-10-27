# Mainnet audit iteration 4: objective and 15-market rotation

Date: 2026-10-27

Network: Sui mainnet

Accounts: Maker 1745, hedge 1746

## Purpose

Prove two new execution paths with deliberately small exposure:

1. run Farming, Profit, and Both as three bounded policy rounds; and
2. rotate one live Maker pair across a ranked 15-market set without leaving the prior market quoted.

These were functional and recovery tests. They do not establish profitable trading or reward eligibility.

## Product changes

Maker now supports up to 15 selected markets in two modes:

- **Portfolio:** each selected market retains a pair until its next lap.
- **One live pair:** only one market may retain Maker orders. A clean switch checks the prior market for attributed fills, then combines cancellation of the old pair and placement of the new pair in one Sui transaction.

The single-slot startup path first sweeps every configured market for Maker-owned orders. A missing prior-market order, delayed account read, fill requiring reconciliation, RPC error, or failed safety gate stops scheduling and invokes all-market cancellation. Exact order IDs and Maker's reserved client-ID namespace constrain the cancellation set.

A separate three-cycle canary applies the current Farming, Profit, and Both recommendations for two seconds each. It never raises the saved quote, inventory, gross-exposure, leverage, or hedge-slippage limits. Live mode cancels between policy changes and flattens both configured accounts before restoring the saved strategy.

## Three-objective Live canary

The Live canary started at 2026-10-27 12:28:11 UTC and completed at 12:28:32 UTC on MON.

| Round | Objective | Spread | Quote | Transaction                                                                                    |
| ----- | --------- | ------ | ----- | ---------------------------------------------------------------------------------------------- |
| 1     | Farming   | 29 bps | $1.04 | [`E2pH2F...FDF9`](https://suiscan.xyz/mainnet/tx/E2pH2F3gKBVDLvyYj5PqPywZsHGvY9CnRtdVPWVFDF9)  |
| 2     | Profit    | 41 bps | $1.04 | [`J8CvTE...zfZP`](https://suiscan.xyz/mainnet/tx/J8CvTEXiiX6oq12Ybupr88VfsdJ8dQUpNYYWL47FzfZP) |
| 3     | Both      | 35 bps | $1.04 | [`9P4PWt...heab`](https://suiscan.xyz/mainnet/tx/9P4PWtFRHebedqo36Q5uTLEe9QbBgAcXSEEX9dbUheab) |

All three quote transactions confirmed. No orders filled. Recovery found no position to flatten, cancellation completed, and the saved Paper configuration was restored byte-for-byte.

## 15-market rotation

A Paper run completed three turns over a ranked set of 15 objective-eligible markets with no errors and restored the original configuration.

The first Live observer incorrectly treated the in-memory cycle counter as proof of transaction completion. That counter advances after quote calculation, before a signed transaction confirms. The script reported three cycles although only two transactions had confirmed:

- MON: [`62GQn5...Mpce`](https://suiscan.xyz/mainnet/tx/62GQn5EZDvW5Q9XPaMtzHfKcFstBsye3647FSxdkMpce)
- CHIP: [`7shqWJ...nNZV`](https://suiscan.xyz/mainnet/tx/7shqWJ2BX9yTWHXgmmkrYuVU1fjDrbuGWSKbZedunNZV)

The observer was corrected to use the persisted `confirmedLiveQuotes` counter. A fresh run then proved exactly three confirmed cross-market transactions:

| Turn | Market | Transaction                                                                                    |
| ---- | ------ | ---------------------------------------------------------------------------------------------- |
| 1    | MON    | [`V1zMTh...jqo9`](https://suiscan.xyz/mainnet/tx/V1zMThjmDWSzA3KY6m4KDe7jV32Y4TW6BM9qWMbjqo9)  |
| 2    | CHIP   | [`Bg1Nia...bEFH`](https://suiscan.xyz/mainnet/tx/Bg1NiaqFs7Sv4QYNzHouDQGQAuoN37LLPBuYM1FcbEFH) |
| 3    | ETH    | [`8LtBjo...toHd`](https://suiscan.xyz/mainnet/tx/8LtBjoTxaSrC7xK5Kd1CDAEee7CSxrnUszgf9TJXtoHd) |

The eligible rotation at execution time was MON, CHIP, ETH, LIT, HYPE, ZEC, PUMP, CRV, NEAR, BRENT, XMR, XRP, SOL, BTC, and XAUT. The test stopped after the third confirmed transaction, cancelled Maker orders, ran two-account recovery, restored the prior configuration, and reported zero positions on accounts 1745 and 1746.

## Efficiency and unattended-operation notes

One live pair allows a small account to inspect 15 markets without reserving collateral for 30 simultaneous orders, but each market receives only about one-fifteenth of the active quote time. That may reduce market-level qualifying uptime and must be measured against actual rewards.

The post-deploy average across confirmed quote transactions was 482,008 MIST, or about 0.000482 SUI. At that measured rate:

| Turn cadence | Transactions/day | Approximate SUI/day |
| ------------ | ---------------- | ------------------- |
| 2 seconds    | 43,200           | 20.82               |
| 15 seconds   | 5,760            | 2.78                |
| 60 seconds   | 1,440            | 0.69                |
| 5 minutes    | 288              | 0.14                |

Two seconds is therefore a canary cadence, not an unattended default. The control desk now shows runway as both transactions and elapsed time, projects 24-hour SUI use from measured transactions, and excludes the configured worst-case transaction reserve from usable runway. When the reserve is reached, the pre-signing gas gate halts Live quoting and the runtime attempts all-market cancellation.

A normal SIGTERM or SIGINT stops every active runtime and cancels Maker orders before process exit. A hard host failure cannot execute that handler; Live does not auto-resume after restart. The operator must inspect account state and deliberately restart, which begins with an all-market Maker-order sweep in one-live-pair mode.

## Result

The objective canary, same-market replacement, and cross-market switch paths are all proven on mainnet. The engine ended stopped, the deployment gates were disabled, the saved mode was Paper, and both accounts were flat.

The final staged strategy uses one-live-pair rotation, 15-second turns, and 15 currently eligible markets: MON, NEAR, LIT, ETH, HYPE, PUMP, SOL, BTC, XMR, BRENT, UNI, QNT, CHIP, FLUID, and CARDS. It is deliberately stopped. The deployed read reported 0.167713058 SUI in the agent wallet and 244 usable quote transactions after the 0.05 SUI reserve, or about 61 minutes at that cadence. Long-duration reward efficiency, profitability, and restart behavior under an actual host failure remain unproven.
