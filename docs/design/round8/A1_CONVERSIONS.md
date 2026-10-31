# Round 8 A1 — user-facing precondition conversions

Current `ui/round8` source locations; the server keeps unknown errors generic 5xx. Template expressions interpolate the named market or bundle and observed gas figures, never request bodies or secrets.

| File:line | Code | Public message expression |
| --- | --- | --- |
| `apps/control/src/server.ts:345` | `account-not-authorized` | "Authorize the selected Maker account in Venues before continuing." |
| `apps/control/src/server.ts:355` | `account-not-authorized` | "Authorize the selected hedge account in Venues before continuing." |
| `apps/control/src/server.ts:368` | `mode-required` | "Choose Paper or Live mode before saving." |
| `apps/control/src/server.ts:379` | `live-unavailable` | "Live mode is unavailable. Keep this bundle in Paper until the operator enables Live." |
| `apps/control/src/server.ts:490` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:506` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:517` | `strategy-not-found` | "This strategy is no longer available. Choose a strategy in Strategy." |
| `apps/control/src/server.ts:530` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:558` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:590` | `strategy-conflict` | error.message |
| `apps/control/src/server.ts:614` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:643` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:665` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:680` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:691` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:703` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:729` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:776` | `account-required` | "Select an authorized Maker account in Venues before creating this bundle." |
| `apps/control/src/server.ts:792` | `hedge-account-required` | "Authorize a separate hedge account in Venues before creating this bundle." |
| `apps/control/src/server.ts:804` | `account-not-authorized` | "Authorize the selected account in Venues before continuing." |
| `apps/control/src/server.ts:833` | `bundle-precondition` | expected.message |
| `apps/control/src/server.ts:857` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:876` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:884` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/server.ts:914` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:943` | `account-not-authorized` | "Authorize the selected account in Venues before continuing." |
| `apps/control/src/server.ts:982` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:993` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1001` | `needs-strategy` | "Attach a strategy in Bundles before starting this bundle." |
| `apps/control/src/server.ts:1009` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1026` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:1037` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1045` | `needs-strategy` | "Attach a strategy in Bundles before starting this bundle." |
| `apps/control/src/server.ts:1053` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1069` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:1087` | `bundles-rolled-back` | "Bundles rolled back. Refresh Bundles before continuing." |
| `apps/control/src/server.ts:1116` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/server.ts:1434` | `account-setup-required` | "Provision this account in Venues before continuing." |
| `apps/control/src/server.ts:1442` | `builder-registration-required` | "Venue fee registration is not complete. Ask the operator to complete setup before continuing." |
| `apps/control/src/server.ts:1475` | `account-setup-required` | "Provision this account in Venues before continuing." |
| `apps/control/src/server.ts:1483` | `builder-registration-required` | "Venue fee registration is not complete. Ask the operator to complete setup before continuing." |
| `apps/control/src/server.ts:1535` | `account-not-authorized` | "Authorize the trading key for this account in Venues before continuing." |
| `apps/control/src/server.ts:1556` | `orders-open` | 'Cancel ${taggedOrders} open Maker order${taggedOrders === 1 ? "" : "s"} before revoking the trading key.' |
| `apps/control/src/server.ts:1586` | `account-not-authorized` | "Authorize the trading key for this account in Venues before continuing." |
| `apps/control/src/store.ts:1918` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:2579` | `strategy-not-found` | "The attached strategy is no longer available. Choose a strategy in Bundles." |
| `apps/control/src/store.ts:2664` | `shared-strategy` | "This bundle uses a shared strategy. Edit it in Strategy instead." |
| `apps/control/src/store.ts:2832` | `wallet-limit` | '${overLimit[0]} limit exceeds this wallet's confirmed envelope. Raise the wallet limit in Bundles or lower the strategy limit.' |
| `apps/control/src/store.ts:2890` | `accounts-not-distinct` | "Choose separate Maker and hedge accounts in Venues." |
| `apps/control/src/store.ts:2911` | `account-role-taken` | "This account is already assigned to a bundle. Select an unused account in Bundles." |
| `apps/control/src/store.ts:2928` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:2935` | `needs-strategy` | "Attach a strategy in Bundles before starting this bundle." |
| `apps/control/src/store.ts:2961` | `market-taken` | '${market.symbol} is already quoted by ${existing.name}. Duplicate the strategy and change its markets.' |
| `apps/control/src/store.ts:2986` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:2994` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/store.ts:3003` | `core-required` | "Configure Core in Bundles before creating another bundle." |
| `apps/control/src/store.ts:3193` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:3203` | `bundle-version-conflict` | "Bundle changed elsewhere; refresh before saving. Compare your changes with the current bundle." |
| `apps/control/src/store.ts:3304` | `strategy-name-invalid` | "Use a strategy name between 1 and 80 characters." |
| `apps/control/src/store.ts:3317` | `strategy-name-taken` | "Another strategy already uses this name. Choose a different name." |
| `apps/control/src/store.ts:3354` | `strategy-name-invalid` | "Use a strategy name between 1 and 80 characters." |
| `apps/control/src/store.ts:3366` | `strategy-not-found` | "This strategy is no longer available. Choose a strategy in Strategy." |
| `apps/control/src/store.ts:3373` | `strategy-version-conflict` | "Strategy changed elsewhere; refresh before saving. Compare your draft with the latest version." |
| `apps/control/src/store.ts:3391` | `strategy-name-taken` | "Another strategy already uses this name. Choose a different name." |
| `apps/control/src/store.ts:3416` | `market-taken` | '${markets[0]!.symbol} is already quoted by ${running[0]!.bundle.name}. Duplicate the strategy and change its markets.' |
| `apps/control/src/store.ts:3443` | `market-taken` | '${market.symbol} is already quoted by ${existing.name}. Duplicate the strategy and change its markets.' |
| `apps/control/src/store.ts:3536` | `strategy-not-found` | "This strategy is no longer available. Choose a strategy in Strategy." |
| `apps/control/src/store.ts:3555` | `strategy-not-found` | "This strategy is no longer available. Choose a strategy in Strategy." |
| `apps/control/src/store.ts:3563` | `strategy-in-use` | "This strategy is used by a bundle. Detach it in Bundles before deleting it." |
| `apps/control/src/store.ts:3617` | `core-required` | "Configure Core in Bundles before confirming wallet limits." |
| `apps/control/src/store.ts:3732` | `bundle-name-invalid` | "Use a bundle name between 1 and 80 characters." |
| `apps/control/src/store.ts:3740` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/store.ts:3754` | `bundle-limit` | "A wallet can have at most four active bundles. Archive an unused bundle before creating another." |
| `apps/control/src/store.ts:3763` | `core-required` | "Configure Core in Bundles before creating another bundle." |
| `apps/control/src/store.ts:3772` | `wallet-limits-unconfirmed` | "Confirm wallet limits in Bundles before creating a second bundle." |
| `apps/control/src/store.ts:3833` | `bundle-name-invalid` | "Use a bundle name between 1 and 80 characters." |
| `apps/control/src/store.ts:3847` | `bundle-name-taken` | "A bundle already uses that name. Choose a different bundle name." |
| `apps/control/src/store.ts:3855` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/store.ts:3869` | `bundle-limit` | "A wallet can have at most four active bundles. Archive an unused bundle before creating another." |
| `apps/control/src/store.ts:3880` | `strategy-not-found` | "This strategy is no longer available. Choose an active strategy in Strategy." |
| `apps/control/src/store.ts:3894` | `needs-markets` | "Choose a strategy with at least one market before creating this bundle." |
| `apps/control/src/store.ts:3923` | `wallet-limits-required` | "Set Core wallet limits in Bundles before creating this bundle." |
| `apps/control/src/store.ts:3933` | `wallet-limits-unconfirmed` | "Confirm wallet limits in Bundles before creating a second bundle." |
| `apps/control/src/store.ts:3987` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:3997` | `bundle-version-conflict` | "Bundle changed elsewhere; refresh before saving. Compare your changes with the current bundle." |
| `apps/control/src/store.ts:4014` | `live-core-only` | "Only Core can use Live mode. Switch this bundle to Paper." |
| `apps/control/src/store.ts:4026` | `markets-on-strategy` | "Edit markets in Strategy, then return to Bundles." |
| `apps/control/src/store.ts:4038` | `strategy-not-found` | "This strategy is no longer available. Choose an active strategy in Strategy." |
| `apps/control/src/store.ts:4046` | `needs-markets` | "Select at least one market in Strategy before attaching it to a bundle." |
| `apps/control/src/store.ts:4144` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:4162` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and select an active bundle." |
| `apps/control/src/store.ts:4169` | `core-required` | "Core cannot be archived. Keep it as the wallet control bundle." |
| `apps/control/src/store.ts:4312` | `account-owner-mismatch` | "Connect the wallet that owns this account before setting it up." |
| `apps/control/src/store.ts:4428` | `account-not-found` | "This account setup is no longer available. Select an account in Venues." |
| `apps/control/src/store.ts:4452` | `account-not-found` | "This account setup is no longer available. Select an account in Venues." |
| `apps/control/src/runtime-manager.ts:122` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:163` | `core-required` | "Save a Core bundle before starting a Paper test run." |
| `apps/control/src/runtime-manager.ts:172` | `core-not-found` | "Core is unavailable. Open Bundles and check its setup before testing." |
| `apps/control/src/runtime-manager.ts:185` | `trial-already-running` | "A Paper test run is already in progress. Wait for it to finish before trying again." |
| `apps/control/src/runtime-manager.ts:279` | `needs-strategy` | "Attach a strategy in Bundles before starting this bundle." |
| `apps/control/src/runtime-manager.ts:287` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:294` | `bundle-archived` | "This bundle was archived. Choose an active bundle in Bundles." |
| `apps/control/src/runtime-manager.ts:303` | `live-core-only` | "Only Core can use Live mode. Select Paper for any other bundle." |
| `apps/control/src/runtime-manager.ts:318` | `live-core-only` | "Core must be the only Live bundle. Switch other bundles to Paper first." |
| `apps/control/src/runtime-manager.ts:403` | `gas-reserve-low` | 'Couldn't start ${candidate.name} ${candidateConfig.mode}. Its trading key has ${(availableGasMist / 1_000_000_000).toFixed(2)} SUI for gas and needs at least ${(requiredGasMist / 1_000_000_000).toFixed(2)} SUI ${purpose |
| `apps/control/src/runtime-manager.ts:468` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:502` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:524` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |
| `apps/control/src/runtime-manager.ts:582` | `bundle-not-found` | "This bundle is no longer available. Refresh Bundles and choose an active bundle." |

`WalletLimitError` in `apps/control/src/store.ts` is a typed `wallet-limit` precondition for missing Core limits and limits below running use. It reports the used amount and directs the owner to Bundles.

## B1 finding

The Paper simulation path in `packages/aftermath/src/gateway.ts` sets a gas budget of `config.maxGasMist`, selects a gas coin with `setAgentGasPayment`, and then calls `simulateTransaction`. Paper therefore needs one `maxGasMist` budget; it does not need the Live cancellation, hedge, or multi-bundle safety reserve. The admission guard now computes the Live reserve from Live configs and their resting-order maxima only, and requires the maximum of that reserve and the Paper candidate simulation budget. The Live-only calculation is unchanged; the same guard covers the Strategy Paper test run. No production database, Live setting or trading flow was touched.
