# Iteration 5: long rotation, cost controls, and automatic rebalance

Date: 2026-10-27  
Network: Sui mainnet  
Owner: `0xf1dd50b692e6e74d17f4032dd67c6f4ce8165055aecddd874b7cd69dd2cba488`  
Maker account: 1745  
Hedge account: 1746

## Purpose

This iteration tested the mechanics needed for a continuous N-market strategy:

- select up to 64 markets;
- poll risk more often than paid quote replacement;
- keep only one Maker pair live at a time;
- reconcile fills globally before moving to another market;
- hedge independently attributed Maker fills;
- bound the gross positions that a same-venue hedge leaves on both accounts; and
- recover both dedicated accounts to flat without relying on a separate operator script.

This remains an execution audit. It does not establish profitable market making or reward farming.

## Forty-five-action rotation suite

The first completed suite ran 15 bounded batches of three confirmed quote actions. It visited 20 distinct markets between 16:08:30 and 16:18:48 UTC.

| Observation                            |         Result |
| -------------------------------------- | -------------: |
| Confirmed quote actions                |             45 |
| Distinct markets                       |             20 |
| Attributed Maker fills during suite    |             14 |
| Confirmed hedge orders                 |              7 |
| Reduce-only recovery transactions      |             18 |
| Post-only crossing retries             |              8 |
| Post-cancel index waits                | 7 / 7 resolved |
| Post-hedge index waits                 | 7 / 7 resolved |
| Fill-before-position attribution waits | 2 / 2 resolved |
| Cycle errors                           |              0 |
| Watchdog trips                         |              0 |

The run exposed several eventual-consistency and lifecycle defects before the final clean suite:

1. Agent gas counted only one SUI coin object. The balance check now includes all coin objects and the address balance.
2. Aftermath post-only abort code 47 was treated as fatal. Maker now recognizes the no-effect crossing race, refreshes the book, and retries with post-only still enabled.
3. A successful hedge could be followed by a stale account read. The runtime now polls the actual combined delta before deciding whether the hedge made progress.
4. Position state could become visible before fill history, and fill history could become visible before position state. Both directions now pause for a bounded reconciliation window.
5. Rotation reconciled only the selected market. It now sweeps every pending current-run Maker fill before switching.
6. A watchdog compared age against an observation made before a slow hedge. One-live-pair mode now measures active quote age from successful placement.
7. Restarted runs could see old tracked orders. Hedge attribution is restricted to orders posted in the current run.

Every failed attempt stopped quoting and was recovered flat before another attempt. The final 45-action suite used bounded batches because same-venue hedging removes directional delta but leaves offsetting gross positions and collateral usage on the two accounts.

### Cost evidence

The agent balance moved from `3.065059881 SUI` to `3.005048525 SUI`, a net change of `-0.060011356 SUI`. Persisted transaction fields separately recorded:

- quote transactions: `0.054140875 SUI`;
- hedge transactions: `0.017447835 SUI`; and
- flatten transactions: `0.001647526 SUI`.

Those fields should not be added and called wallet spend because Sui storage charges and rebates alter the final balance change. The account pair's reported equity moved by about `-$0.0409`; this is not complete PnL.

## Automatic paired-account rebalance

Auto-rebalance is optional. When Maker gross exposure plus the next quote would reach the configured threshold, it:

1. stops quote placement;
2. cancels and confirms all Maker-tagged orders;
3. submits reduce-only market orders on the Maker and hedge accounts;
4. verifies three consecutive flat account reads;
5. marks any already-observed current-run fills as resolved by the rebalance; and
6. resumes the market rotation.

The first mainnet canary correctly triggered after two independent fills and confirmed two automatic flatten transactions:

- Maker: [`DNp26m...9EsS`](https://suiscan.xyz/mainnet/tx/DNp26mwMsxYXpcSikcis6LMnQxbjzdBVb7oC8NSA9EsS)
- Hedge: [`67h41c...zvtx`](https://suiscan.xyz/mainnet/tx/67h41c4fAPsv4LPJD4NoytwUwh7sphXQcLUuKAATzvtx)

It then failed closed because an earlier market's position remained visible and three flat reads could not be confirmed. The canary's recovery path made a second reduce-only pass:

- Maker: [`8uefQY...TPdw`](https://suiscan.xyz/mainnet/tx/8uefQYdfrmu9F3aDMU8j5Huv83mjyQcFcH3a3y2FTPdw)
- Hedge: [`DPDLcA...5b4`](https://suiscan.xyz/mainnet/tx/DPDLcAjmHAVMWFCR3GgKas9EEFukTaPbLJQhn1ZdG5b4)

The product path now applies the same bounded multi-pass behavior automatically. It performs at most three paired reduce-only sweeps, records residual account and market state before a retry, and never lets a Stop interrupt a risk unwind that has already begun. Unit coverage reproduces the delayed-position case.

## Corrected 15-market live canary

The corrected canary ran from 16:39:05 to 16:43:09 UTC with:

- 15 selected markets;
- a 2-second off-chain poll;
- a 10-second dwell and maximum resting age;
- a 5 bps movement threshold;
- $1 minimum quote sizes;
- a deliberately low $1.50 rebalance threshold for the $15 audit account; and
- automatic paired-account rebalance enabled.

It completed 15 confirmed quote actions and reported 12 avoided paid replacements. Four independent Maker fills each triggered a hedge and a successful automatic paired-account rebalance. The engine continued into later markets after every rebalance.

| Epoch | Hedge                                                                                          | Maker flatten                                                                                  | Hedge flatten                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1     | [`99iS76...r7RD`](https://suiscan.xyz/mainnet/tx/99iS766VX5s6Tx2x5o8F4LVKD532RBBC673JVNBcr7RD) | [`F8JY8L...sjdn`](https://suiscan.xyz/mainnet/tx/F8JY8LtgXMPmCE2nTFxCWFvUzN8T1rQKLqSDnFAmsjdn) | [`DBmVm3...WDFJ`](https://suiscan.xyz/mainnet/tx/DBmVm3k5gfD1bdrREbRv4vqWEg1aq7BZmHWcRM3LWDFJ) |
| 2     | [`FQDNtp...QNMP`](https://suiscan.xyz/mainnet/tx/FQDNtpoNx2WDQF7dV1SPX19hHBgyhrcJZAXU9joAQNMP) | [`Ew3Khp...NwCr`](https://suiscan.xyz/mainnet/tx/Ew3Khp7fJBtuRcFw6PET9kmq6hQcDDB44AJTJydTNwCr) | [`4yxCHh...mpyN`](https://suiscan.xyz/mainnet/tx/4yxCHhDAzULYxY5kriAqc97QQTVzmW29vNqbg6jfmpyN) |
| 3     | [`HTZyCW...7DPX`](https://suiscan.xyz/mainnet/tx/HTZyCWkLe4Ju2BbUDbgRyx7ouRERhXKHWKBz9oVG7DPX) | [`13MCoq...xfg2`](https://suiscan.xyz/mainnet/tx/13MCoqdV6P2xEtMxFmzQChajrrCZGv7Tz5K4GuFpxfg2) | [`Aa5RHr...mEqU`](https://suiscan.xyz/mainnet/tx/Aa5RHry3sHiQC6j1BWhkC25P7zmoWbpTwvuG1M9mmEqU) |
| 4     | [`FF3k4C...redE`](https://suiscan.xyz/mainnet/tx/FF3k4CkAvSMxvNRuNnp3eCeoiwmr1Q6AM4eFHmVdredE) | [`CrEiqX...AKpH`](https://suiscan.xyz/mainnet/tx/CrEiqXGLH4wHwwWKdMvoWgX9u4cqctqLdtooN7ySAKpH) | [`2afyyw...uRoy`](https://suiscan.xyz/mainnet/tx/2afyywkcTLEqTSezBkVaiHkCDHzUcZ4AP5Bf4uCwuRoy) |

The final canary recovery found no remaining positions, so it submitted no additional market order. Both accounts then reported zero positions and the saved Paper configuration was restored.

Persisted transaction fields recorded `0.007115521 SUI` for quote transactions, `0.004596585 SUI` for hedges, and `0.000819185 SUI` for automatic flatten transactions. The agent's observed balance moved from `2.993905517 SUI` before the corrected run to `2.985289723 SUI` after it, a net change of `-0.008615794 SUI`. Reported pair equity moved from `$14.90740728` to `$14.89179928`, about `-$0.015608`. Neither balance movement is a complete strategy PnL calculation.

## Final state

- Engine stopped
- Saved mode Paper
- Live deployment gates disabled
- Account 1745: zero positions, about $7.44246 equity
- Account 1746: zero positions, about $7.44934 equity
- Agent gas: 2.985289723 SUI
- Agent capabilities retained intentionally for continued testing

## Boundary

The evidence now proves repeated N-market quote rotation, global current-run fill reconciliation, real fill-driven hedging, automatic paired-account rebalance, continuation after rebalance, and final flat recovery. It does not prove long-duration uptime, reward eligibility or value, profitability, complete PnL attribution, hard-host recovery, external fair value, or cross-venue hedging.
