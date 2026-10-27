# Mainnet audit iteration 3: fill-driven hedge

Date: 2026-10-27  
Network: Sui mainnet  
Market: MON  
Accounts: Maker 1745, hedge 1746

## Purpose

Close the remaining mainnet evidence gap: receive an independent fill, cancel the Maker quote, hedge from the second account through the public book, verify the resulting combined delta from fresh account state, and recover both accounts to flat.

This was a bounded functional test. It was not a profitability test and it did not use self-matched volume.

## Findings and fixes

### Venue-tick quote rounding

The first run stopped at `Safety gate failed: spread`. The strategy had constrained a post-only quote with `Number.EPSILON`, then decimal rounding could move the price back onto the opposite best price.

The strategy now accepts the venue tick size, floors bids, ceils asks, and reserves one full tick behind the opposite side. Regression coverage includes index fair values above and below a one-tick MON spread.

### Confirmed cancellation can precede indexed account state

An independent fill at 10:40 UTC triggered a confirmed quote cancellation in [`Bd3LXa...`](https://suiscan.xyz/mainnet/tx/Bd3LXaJ9vFojWBjhoNy3vJye6iAXc73mAgEdKe7w38uF). The immediate account read 437 ms later still reported one pending order, so the hedge correctly failed closed.

The runtime now polls both accounts for up to 10 reads over 6.75 seconds after confirmed cancellation. It never hedges while either read reports an order. The successful run observed one stale read, then confirmed both accounts clear on read two.

### Requested hedge size is not execution proof

The old accounting projected residual delta from requested order size. It could mark fills processed without proving what the market order actually changed.

The runtime now reloads both accounts after every hedge transaction and calculates actual combined delta. Fills are marked processed only inside a completion tolerance of the smaller of the trigger, $0.05, or 2% of attributed fill delta, with a $0.01 floor. Partial progress suppresses new quotes and retries; no progress and material over-hedging stop fail-closed.

### Thin-book slippage

A 75 bps hedge reached transaction simulation but Aftermath rejected `execute_limit_order` with abort code 46. A recovery attempt at the same cap failed identically. A 500 bps cap succeeded on the same thin MON book.

The product does not silently increase the user's limit. It now explains this venue failure as a market order that could not execute within the configured slippage cap. Operators must review visible depth before raising the hedge or flatten cap.

## Successful trace

An independent taker filled the Maker ask in [`BUSKk3...`](https://suiscan.xyz/mainnet/tx/BUSKk3Pky8uSy86Ti1zkmhMXxc9d93wxSzEqcsZSp9oS):

- Side: Maker ask
- Price: `0.021691`
- Size: `47.9 MON`
- Notional: `$1.0389989`
- Attribution: exact recorded Maker order ID

The hedge sequence was:

1. Cancel the remaining Maker quote in [`6RkujP...`](https://suiscan.xyz/mainnet/tx/6RkujPD5ZmdaXXW5hwYyfLQr1VZ3iW9BSF2DzX3axwSc).
2. First post-cancel account read: Maker pending orders `1`, hedge pending orders `0`.
3. Second read after 750 ms: both pending-order counts `0`.
4. Buy the offset from hedge account 1746 in [`8ARc5A...`](https://suiscan.xyz/mainnet/tx/8ARc5AYa8QPJgqSqcijYpJS6zt9KkvpJuvtsePWcLjj4).
5. Reload both accounts and measure actual combined delta at `$0.0015328`, inside the `$0.020779978` completion tolerance.

The runtime then stopped at `Safety gate failed: inventory`. This was expected under the deliberately tight `$1.05` Maker-account inventory cap: the hedge neutralized wallet-level delta, but did not erase the Maker account's own filled position before another two-sided quote.

## Two-account recovery

The guarded audit monitor stopped the runtime, kept the saved strategy in Paper, and submitted separate reduce-only transactions:

- Maker account 1745: [`5CBCNk...`](https://suiscan.xyz/mainnet/tx/5CBCNkgYPTJwp9Qd9gjPMcyBcnxXX8h8nDR8zjFzUDrt)
- Hedge account 1746: [`4kMHLp...`](https://suiscan.xyz/mainnet/tx/4kMHLpYPdhmK833Jx2BKc4RztUfTYC1CKW8EyEfJFEYm)

A fresh authenticated production read after container recreation reported:

- saved mode: Paper
- runtime: stopped
- Live trading gate: disabled
- mainnet gate: disabled
- account 1745 positions: 0
- account 1746 positions: 0
- attributed Maker fills: 4
- confirmed hedge executions: 1

The audit setup remains authorized for further testing. Withdrawal, builder-approval removal, and final capability revocation were not exercised.
