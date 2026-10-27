# External Audit Remediation Ledger

Baseline: `external-audit-v1` at `89936982284c82fb41e4ee0b645aa21bec8d54d8`  
Audit date: 2026-10-27  
Status owner: P-U-C

The baseline tag is immutable. Remediation lands on `main`; “Fixed” means the implementation and local regression pass, not that the external reviewer has retested it.

| ID        | Severity | Finding                                                            | Status                    | Verification                                                                                                                                                                             |
| --------- | -------- | ------------------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AM-EXT-01 | High     | API-built transactions signed without returned-intent verification | Fixed; retest pending     | Exact package/function/command/object/argument/result-flow checks plus simulation effects; moved-price, builder-field, transfer, and extra-session regressions reject before signing     |
| AM-EXT-02 | High     | Simultaneous portfolio fills can exceed gross exposure             | Fixed; retest pending     | Server sums every resting pair's worst side, account-wide positions, and hedge gross; 10-market regression blocks the next quote                                                         |
| AM-EXT-03 | Medium   | Gas reserve cannot fund cancellation                               | Fixed; retest pending     | Quotes require three gas budgets, UI reserves two, and signing selects explicit sufficient gas objects inside the agent queue                                                            |
| AM-EXT-04 | Medium   | Removed members keep trading; no kill switch                       | Fixed; retest pending     | Membership failure stops/cancels the tenant; operator can stop one/all; emergency Stop/Flatten tolerate registry RPC failure for a recently valid session                                |
| AM-EXT-05 | Medium   | Stop does nothing after restart                                    | Fixed; retest pending     | Stop sweeps Maker namespace orders in any mode even when idle; every Live start performs startup reconciliation/cancellation                                                             |
| AM-EXT-06 | Medium   | Agent transactions are not serialized                              | Fixed; retest pending     | One priority mutation queue per agent, urgent cancellation/flatten, explicit gas selection, bounded cycle wait, and flatten deduplication                                                |
| AM-EXT-07 | Medium   | Deselected markets disappear from risk and flatten                 | Fixed; retest pending     | Account snapshots include every open position; risk and flatten are account-wide; deselected-position regression remains in gross exposure                                               |
| AM-EXT-08 | Medium   | Hedge account is outside risk gates                                | Fixed; retest pending     | Combined equity/gross/PnL drawdown plus independent margin-ratio and liquidation-distance gates for both accounts                                                                        |
| AM-EXT-09 | Medium   | Lagging index can quote one tick inside adverse touch              | Fixed; retest pending     | Divergence is capped at the smaller of policy and half-spread; fixed-horizon markouts remain a measurement roadmap item                                                                  |
| AM-EXT-10 | Medium   | Rate limit bypass/shared login bucket                              | Fixed; retest pending     | Validated-session owner key, trusted proxy IP fallback, five-open-challenge cap, client-IP forwarding, and Nginx auth-route limit                                                        |
| AM-EXT-11 | Medium   | One illiquid market blocks all flattening                          | Fixed; retest pending     | Abort 46 triggers per-market retries; successful closes and residual markets are returned separately                                                                                     |
| AM-EXT-12 | Medium   | Browser signs host-built owner transactions unchecked              | Mitigated; retest pending | Browser independently decodes the returned transaction and checks local action/sender/amount/recipient/agent/cap. Host-served JavaScript remains in the documented trusted-host boundary |
| AM-EXT-13 | Medium   | Master-key rotation is unavailable                                 | Fixed; retest pending     | Versioned key-ID envelope, owner/agent/account AAD, atomic re-encryption CLI, address verification, and rotation regression                                                              |
| AM-EXT-14 | Low      | 4xx becomes 500 and 5xx leaks internals                            | Fixed; retest pending     | Pure classifier regressions preserve 400/429 and return generic 500/503 messages                                                                                                         |
| AM-EXT-15 | Low      | Backup stops every Live engine                                     | Fixed; retest pending     | SQLite online backup API plus `quick_check`; no container stop in `scripts/backup.sh`                                                                                                    |
| AM-EXT-16 | Low      | Builder registration trusts API transaction and ID                 | Mitigated; retest pending | Exact pinned registration intent, effect policy, timeout, and ID decoded from Sui simulation. Aftermath emits no ID event, so post-confirmation address lookup remains an API dependency |
| AM-EXT-17 | Low      | Flatten waits forever and duplicates                               | Fixed; retest pending     | Ten-second cycle bound and one shared in-flight flatten promise                                                                                                                          |
| AM-EXT-18 | Low      | 24h stats joined by response index                                 | Fixed; retest pending     | Stats map is keyed from requested market IDs before joining returned market objects                                                                                                      |
| AM-EXT-19 | Low      | BigInt reviver mutates user strings                                | Fixed; retest pending     | Exact tagged-object encoding; `100n` market-symbol regression                                                                                                                            |
| AM-EXT-20 | Low      | No Origin check; variable-time token compare                       | Fixed; retest pending     | Same-origin/fetch-site enforcement and `timingSafeEqual`                                                                                                                                 |
| AM-EXT-21 | Low      | Runtime tables unbounded; 2,000-order cap hidden                   | Fixed; retest pending     | Per-tenant pruning and documented limits for events, executions, orders, hedges, and processed fills                                                                                     |
| AM-EXT-22 | Low      | Inventory may be cost basis                                        | Fixed; retest pending     | Signed base size times timestamped current market index; missing marks fail closed                                                                                                       |
| AM-EXT-23 | Info     | Registry authority/upgrade policy weakly tested                    | Fixed; retest pending     | `AdminCap` lost `store`, package identity is exact, three Move tests pass, retained `UpgradeCap` policy is documented                                                                    |
| AM-EXT-24 | Info     | Missing risk inputs default to infinity                            | Fixed; retest pending     | Collateral and gas are required at type and runtime boundaries                                                                                                                           |
| AM-EXT-25 | Info     | Trial watchdog misleading; endpoint fixed at boot                  | Fixed; retest pending     | Trial reports idle without a timer; endpoints re-probe every five minutes and idle runtimes adopt recovered preferred endpoint                                                           |

## Verification

Completed locally on 2026-10-27:

- `packages/core`: 40 tests passed.
- `packages/aftermath`: 36 tests passed.
- `apps/control`: 62 tests passed.
- Move package: 3 tests passed.
- Web TypeScript check passed.
- Production dependency audit: 0 vulnerabilities.
- Live gates remained disabled; no transaction was signed or broadcast during remediation.

The release record must add the final production build, image digest/SBOM, isolated backup/restore and key-rotation drills, browser checks, deployed health result, remediation commit, and immutable remediation tag.

## Residual Trust

- A hostile host can serve altered browser code and decrypt agent signers. Client-side intent verification protects against malformed upstream/server responses, not root compromise.
- Aftermath's registration transaction returns the integrator ID in simulation but emits no registration event. The final owner-to-ID lookup still uses Aftermath's API.
- Agent-capability semantics remain dependent on Aftermath's deployed Move packages; obtain written protocol confirmation or independently review those packages.
- No profitability, reward-efficiency, or capital-scaling claim is created by these fixes.

## Release Gate

No increase beyond canary capital until AM-EXT-01 through AM-EXT-06 are independently retested. Production `LIVE_TRADING_ENABLED` and `ALLOW_MAINNET` remain disabled during remediation and deployment.
