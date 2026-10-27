# Security model

Maker controls real perpetuals positions. It reduces custody and automation risk; it does not remove market, smart-contract, oracle, liquidation, or validator risk.

## Identity and access

Public access is gated by the `maker_access::access::Registry` shared object on Sui mainnet.

- Login uses a readable, origin-bound personal message.
- Challenges are random, expire after five minutes, and are single-use.
- The server verifies the signature against the claimed Sui address.
- Session tokens are random, stored only as SHA-256 hashes, and delivered in `HttpOnly`, `Secure`, `SameSite=Strict` cookies.
- Sessions expire after 12 hours.
- Membership is re-read from chain at most 30 seconds after a change.
- Each wallet has separate settings, agent ciphertext, runtime, executions, and audit events.

The bootstrap operator wallet must also be the registry deployment signer and the on-chain `AdminCap` owner. Only its signed session can access membership APIs, and only it receives the membership management view. Member wallets receive HTTP 403. Keep the `AdminCap` in that operator wallet. The API also refuses to build a transaction that removes the operator's own membership.

Bootstrap mode accepts the first signed wallet only while no registry is configured. It must remain behind Basic Auth and be disabled immediately after deployment. Never expose bootstrap mode directly to the public internet.

## Trading authority

The owner wallet remains the Aftermath account administrator. Its local agent capability can trade but cannot:

- withdraw account collateral;
- grant another agent; or
- revoke or replace the administrator.

Keep enough SUI in the owner wallet for emergency revocation.

## Secret handling

- `MAKER_MASTER_KEY` encrypts agent private keys with AES-256-GCM.
- A unique salt, IV, and authenticated account context are stored with each ciphertext.
- Plaintext agent keys are never returned by the API or dashboard.
- Only the internal control container receives `MAKER_MASTER_KEY`. The public web container receives one internal control token and cannot decrypt signers.
- `.env`, SQLite, and backups are separate required assets. The master key plus database can recover every tenant agent.
- Logs redact control tokens, session tokens, signatures, and encrypted signer fields.
- `CONTROL_TOKEN` exists only between the Next.js proxy and the internal control service.

Keep `.env` mode `0600` and store an offline copy separately from database backups.

## Builder fee

Aftermath assigns the service a numeric integrator ID. The default order fee is 1 bp (0.01%) of filled notional.

The account owner approves the exact fee ceiling during setup. Runtime policy rejects:

- a different integrator ID;
- a higher or lower fee than configured;
- builder fields outside the expected `builderCode` object; or
- a builder code when no integrator is configured.

Aftermath's current builder code applies to both maker and taker fills. The dashboard discloses the rate before the owner signs. The owner can revoke the approval through Aftermath.

## Live-trading gates

A live strategy requires all of the following:

- `LIVE_TRADING_ENABLED=true`;
- `ALLOW_MAINNET=true`;
- a confirmed trading-only agent capability;
- an encrypted signer;
- fresh two-sided orderbook data;
- quote, inventory, loss, spread, and leverage checks; and
- book/index divergence, worst next-fill exposure, two-sided collateral, agent gas, unrealized loss, and run equity drawdown checks; and
- successful Sui transaction simulation.

Any failed live cycle stops that wallet's engine. A separate watchdog monitors every live quote: all selected markets in portfolio mode and only the active market in one-live-pair mode. It invalidates a stalled cycle and cancels Maker-tagged orders with retries without waiting for the blocked market RPC. Manual stop has a bounded wait. If a transaction may already have been broadcast, both paths cancel again after that cycle resolves. Fill-driven hedging waits through bounded account-index consistency windows after both cancellation and hedge execution, and refuses to trade while either account reports a resting order. Optional automatic rebalance cancels quotes, executes reduce-only sweeps on both dedicated accounts, and requires three consecutive flat reads before quoting resumes. Delayed position indexing can trigger up to three sweeps; every retry is logged, and an in-progress risk unwind is not interrupted by a Stop request. Gas runway excludes the configured worst-case transaction reserve; reaching that reserve blocks the next quote before signing.

SIGINT and SIGTERM stop instantiated runtimes and attempt cancellation before exit. No process can execute cleanup during a hard host failure. Maker therefore does not auto-resume Live after restart. One-live-pair startup performs an all-market Maker-order sweep before placing a new quote, but the operator must first inspect account state and deliberately start the engine.

The bounded Live canary adds an exact confirmation phrase, requires both accounts to start flat, places exactly three short policy rounds, confirms cancellation between rounds, and invokes reduce-only recovery before restoring the prior strategy. If recovery is uncertain, Maker preserves the final Live configuration and reports the recovery error.

## Transaction policy

Orders are post-only, rounded to the venue tick away from the opposite side, and replaced atomically with cancel-and-place. Fresh client order IDs in Maker's reserved namespace restrict cancellation to Maker's own bid and ask. In one-live-pair rotation, cheap polls can retain an unchanged resting quote; a material move or maximum resting age triggers an atomic same-market replacement, while a clean cross-market switch composes prior-market cancellation and next-market placement in one transaction. A simulated post-only crossing race is known to have no transaction effect and is retried from a fresh book; it does not relax the quote price or disable post-only. A failed cross-market switch explicitly cancels the prior pair before retrying so an old quote cannot outlive the watchdog window. Every other transaction failure remains fail-closed. Recorded order IDs are checked against the current account snapshot; invisible prior state blocks the switch instead of allowing overlapping quotes. Manual refresh is read-only in live mode. Stop and reconfigure invalidate an in-flight cycle before signing. Gas has an explicit maximum.

Stopping and flattening are separate. Stop only cancels Maker-tagged orders. Flatten additionally uses reduce-only market orders for selected-market positions, requires an explicit second confirmation, and forbids a builder fee. Hedge and flatten market orders can incur slippage and do not guarantee a particular execution price. A venue slippage failure is reported without automatically raising the configured cap.

Automatic rebalance is opt-in and intended only for a dedicated Maker/hedge account pair. It converts passive positions into taker orders and can realize adverse selection, cross the spread, consume gas, or fail at the user's slippage ceiling. Its threshold must remain below the hard gross-exposure cap, but neither limit prevents losses that occur inside one transaction or during a venue, network, or oracle failure.

Owner account creation, deposit, withdrawal, agent grant, agent revocation, fee approval, and whitelist membership transactions are simulated before being returned to the wallet. Grant and revoke confirmation verifies the supplied digest, sender, and exact capability-object effect before local authority state changes. Revocation removes the configured builder-fee approval in the same transaction.

Transactions are built by the official Aftermath SDK/API. That is an external trust dependency. Simulation detects execution failures but is not a semantic proof of every Move call. Pin and review SDK upgrades, especially changes to agent permissions, order builders, order event shapes, or builder-code fields.

## Performance evidence

Maker records order IDs emitted by confirmed quote transactions and attributes fills only when Aftermath history returns a matching maker order for that wallet. The ledger is intentionally incomplete for activity before order tracking was deployed.

“Net known result” is not total account profit. It includes attributed Maker and confirmed hedge fills, but excludes markouts, attributed funding, gas converted to USD, explicit hedge-slippage decomposition, and inventory carry. Builder fees are estimated from filled notional and must be confirmed against representative mainnet transaction effects.

## Network exposure

The control API is reachable only on the internal Docker network. The web service binds to `127.0.0.1` by default and is published through Cloudflare Tunnel and Nginx. Both containers run as a non-root user with a read-only root filesystem, all Linux capabilities dropped, and no-new-privileges.

During bootstrap, Nginx uses Basic Auth. After the registry is confirmed, deploy `deploy/nginx-public.conf`; wallet authentication and on-chain membership then become the public gate.

## Incident response

1. Stop the affected engine in the dashboard.
2. Revoke that agent capability with the owner wallet.
3. Remove the wallet from the on-chain registry if access is compromised.
4. Preserve control logs and a database backup.
5. Rotate `CONTROL_TOKEN` and `MAKER_MASTER_KEY` when exposure is possible.
6. Provision a new agent only after reconciling on-chain state.

Never delete an encrypted signer during an uncertain broadcast. Reconcile the transaction digest and capability state first.
