# Maker mainnet audit - 2026-10-27

## Purpose

Validate Maker from a clean, dedicated owner through account creation, funding, agent authorization, Observe, Paper, bounded Live quoting, cancellation, fill attribution, flattening, revocation, and recovery. The audit measures behavior; it does not treat generated volume as success.

## Public test identity

- Owner address: `0xf1dd50b692e6e74d17f4032dd67c6f4ce8165055aecddd874b7cd69dd2cba488`
- Network: Sui mainnet
- Intended funding: 20 USDC plus SUI for gas
- Private key: encrypted outside the repository; never included in evidence or logs

## Invariants

1. The owner key creates accounts, deposits and withdraws collateral, grants and revokes the agent, and approves the exact builder-fee ceiling.
2. The encrypted agent can quote, cancel, allocate and deallocate, but cannot withdraw collateral or delegate authority.
3. Every write is simulated before signing and produces a recorded digest or an explicit ambiguous-broadcast recovery state.
4. Maker only cancels its tagged orders.
5. Observe and Paper never submit transactions.
6. Live cannot start unless both deployment gates, authorization, market freshness and all configured risk checks pass.
7. Stop cancels quotes but does not flatten. Flatten is separate, reduce-only, and carries no builder fee.
8. Tenant data, sessions, signers, order attribution and audit events cannot cross owner boundaries.
9. Reward reporting distinguishes protocol facts, account metrics and Maker's heuristic. It does not recommend self-trading or volume churn.
10. The test ends with no resting Maker orders, no unintended positions, a reconciled balance, and the agent revoked or intentionally retained with a documented reason.

## First Live canary limits

- Capital deposited: 7.50 USDC to the maker account and 7.50 USDC to a separate hedge account; retain 5 USDC in the owner wallet until recovery is proven
- Accounts: two independently created and authorized Aftermath accounts, assigned distinct Maker and Hedge roles in the interface
- Markets: one liquid, continuously open market selected from live evidence
- Quote size: 1 USDC per side
- Maximum inventory: 5 USDC
- Maximum gross exposure: 5 USDC
- Maximum unrealized loss: 1 USDC
- Maximum run equity drawdown: 1 USDC
- Maximum book/index divergence: 50 bps
- Leverage: 1x
- Spread: conservative and post-only
- Hedge: disabled only long enough to prove maker-fill attribution, then enabled on the second account with a 1 USDC threshold and a 5 USDC maximum hedge; combined delta is reconciled after every attributed fill
- Duration: enough cycles to prove replacement and watchdog behavior, not artificial reward farming

## Evidence

Store only public or non-secret evidence under this directory:

- transaction digests and explorer links
- timestamps and software commit
- sanitized API responses and runtime snapshots
- account, capability and builder-fee configuration IDs
- quote/cancel/fill/flatten reconciliation
- gas, protocol fee, builder fee, funding and reward observations
- screenshots at desktop and mobile widths
- findings, fixes and regression results

## Current status

Static remediation is recorded in [FINDINGS.md](FINDINGS.md) and deployed. Unit, type, build, container-hardening, public-header, proxy, and authenticated desktop/mobile browser checks pass. The dedicated owner remained unfunded and outside the three-member registry at 2026-10-27T02:03:02Z, so no mainnet transaction has been executed and no live claim is yet proven. Both deployment gates remain disabled.

Funding precondition:

- 20 USDC
- at least 0.25 SUI to cover account creation, owner transaction gas, and the 0.1 SUI agent seed
- on-chain Maker whitelist membership for the audit owner
