# Round 8 acceptance ledger

Baseline: `origin/main` at `521f567`. The owner spec was committed verbatim first as `docs/design/round8/AGENT_INSTRUCTIONS.md` (`58c8b53`). All screenshots use local browser fixtures and mocked control reads; none use the production API or funded wallets. Live gates, the production database and deployment have not been touched.

| Part | Status | Evidence and remaining work |
| --- | --- | --- |
| A. Actionable errors and audit | **Partly done** | The [109-conversion source table](A1_CONVERSIONS.md), typed 4xx/fix responses, seven isolated route scenarios plus Live-gas route scenario, owner-scoped throttled SQLite event tests, narration catalogue, 409 [fix-link](evidence/r8-fixable-run-error-phone.png), 5xx [Desk log](evidence/r8-control-log-error-phone.png), and [390](evidence/r8-landing-pending-390.png)/[1440](evidence/r8-landing-pending-1440.png) sign-in captures pass. Missing: executable route-level cases for *every* converted precondition; the catalogue/classifier test covers all constructor signatures, not every Fastify route branch. |
| B. Paper gas | **Done** | Paper low-gas start and trial (including a stopped Core saved in Live mode), Live low-gas rejection with code/address/figures, and mixed Live+Paper reserve tests pass. [Gateway analysis](A1_CONVERSIONS.md#b1-finding) confirms simulation selects a gas coin with a `maxGasMist` budget. No Core deletion/reset. |
| C. Strategy summary and edit | **Done** | Saved [desktop](evidence/r8-strategy-summary-desktop-light.png) and [390](evidence/r8-strategy-summary-header-phone-dark.png) summaries, [New on Goal](evidence/r8-new-strategy-goal-desktop-light.png), unique first-unused name, focused/selected field, 2×2 policy summary, one numbered edit flow, and sentence-based Review tested. |
| D. Markets and policy | **Done** | [Clean table](evidence/r8-markets-clean-desktop-light.png); [inherited](evidence/r8-policy-inherited-desktop-light.png), [invalid](evidence/r8-policy-invalid-desktop-light.png), [blocked](evidence/r8-policy-blocked-desktop-light.png), and [mobile](evidence/r8-policy-inherited-phone-dark.png) editor captures. One spread-field PATCH-body unit test, row-height check and 390 sort/Edit hit-area checks pass. Save and focus-return browser checks pass. |
| E. Shared Kit | **Partly done** | Shared page header, card/button/segmented/table primitives, aligned headers, responsive table scrolling, a plain tour, desk and bundle cleanup, result breakdown, separate performance cards and venue/account layout. [Before](evidence/before/) and [after](evidence/after/) captures cover the six requested views at 1440, 1024 and 390 in both themes. The control account read exposes equity and position count but **not per-account exposure or unrealized P&L** (`packages/aftermath/src/gateway.ts:listOwnerAccounts`), and server changes outside A/B are prohibited. The Accounts table therefore shows honest dashes and an explanation, not invented numbers. This blocks full E acceptance until the allowed server scope is expanded. |

## Tested revision

- `MAKER_AUDIT_PORT=8898 npm run check`: format, typecheck, 40 core + 52 aftermath + 135 control + 80 web tests, production build, stateful browser journey. Port 8899 was occupied by an unrelated Next process; nothing was stopped there.
- `shots.mjs --view all`: all 600 captures across the fixture matrix and every configured size passed on the local production build with **all checks enabled**. Final paper-running captures after the last CSS change passed at all eight sizes; see `evidence/after/`.
- `contrast-audit.mjs`: all 72 fixture/theme/viewport combinations passed; six paper-running/theme/viewport combinations passed again after the final CSS change. Capture logs are in the PR body.
- The six-view header x-coordinate check passes at 1440, 1180 and 1024.
- `rg -n 'eyebrow' apps/web/components` and `rg -n 'dashed' apps/web/app/globals.css` return nothing. All rendered tables use `KitTable`.

No bundles were started, no Live gate was enabled, no wallet signed, no funds moved, and nothing was deployed or merged.
