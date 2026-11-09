# Strategy corpus

This corpus is the durable research record for Maker strategies. It is not a
configuration source and it cannot start, attach, fund, or change a bundle.
Saved, versioned strategies remain the execution authority.

## Buckets

| Bucket     | Meaning                                            | Execution rule                                   |
| ---------- | -------------------------------------------------- | ------------------------------------------------ |
| `research` | Hypothesis or external evidence only               | No execution claim                               |
| `observe`  | Read-only data collection                          | No orders or Paper fills                         |
| `paper`    | Deterministic or market-data Paper evaluation      | Simulated fills and costs are labelled estimates |
| `review`   | Paper evidence is complete enough for human review | No automatic Live transition                     |
| `retired`  | Invalidated or superseded hypothesis               | Kept for comparison; never selected              |

Every entry must record its objective, evidence, no-reward result, reward
attribution status, data coverage, safety invariants, owner-approved limits,
and explicit next evidence. Rewards paid at the wallet level are never
allocated to a strategy without a verified allocation source.

The corpus holds no signer material, wallet routing, account capabilities,
private payloads, or production order history.

## Current strategies

| Strategy               | Bucket  | Objective                                                                    | Record                                                 |
| ---------------------- | ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Inventory recycling v2 | `paper` | Independently filled, inventory-aware quoting with a positive no-reward edge | [inventory-recycling-v2.md](inventory-recycling-v2.md) |
