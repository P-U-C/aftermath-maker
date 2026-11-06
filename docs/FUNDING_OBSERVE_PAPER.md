# Cross-venue funding: Observe and Paper boundary

This first increment implements pure ETH/BTC candidate evaluation and a
deterministic Paper replay contract for the AF-short / Hyperliquid-long
direction. It makes no network request, signs nothing, submits no order, and
does not expose a Live mode.

## Deliberately unverified inputs

The supplied funding specification does not contain the exact current AF
instrument IDs, Hyperliquid asset identities, contract multipliers, account
fee tiers, builder applicability, or account-specific margin modes. Therefore
the built-in ETH/BTC list is research-only. A pair is ineligible until a
reviewer provides a `REVIEWED` mapping with exact, matching linear-USDC
metadata and current observations.

All scanner book quantities are normalized to underlying base before reaching
the model. This lets reviewed adapters solve the two venues' lot and multiplier
grids without pretending their raw contract quantities are identical.

Adapters must still verify at ingestion time that AF's quoted rate is a
full-period decimal (rather than annualized), that HL's is an hourly decimal,
that their signs mean longs pay shorts, and that source timestamps, book depth,
and account-specific fees are current. Any missing or stale input fails closed.

## Spec reconciliation

The shared strategy ZIP has a general `LIVE` mode, while the funding
integration spec explicitly stages this strategy through Observe and Paper
before a separately approved pilot. `FundingRunMode` intentionally permits
only `OBSERVE | PAPER`. The existing Maker Live gates remain untouched.

The older shared contract describes a builder-fee applicability field that can
be unknown, while the funding spec notes updated AF documentation can charge a
builder fee on maker fills. This model requires an explicit signed builder-bps
input; it does not assume an old taker-only rule or double-count an amount
already included in a venue execution fee.
