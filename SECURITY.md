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

The operator's `AdminCap` is the authority for membership changes. Keep it in the intended operator wallet. The API refuses to build a transaction that removes the operator's own membership.

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
- successful Sui transaction simulation.

Any failed live cycle stops that wallet's engine.

## Transaction policy

Orders are post-only and replaced atomically with cancel-and-place. Stable client order IDs restrict cancellation to Maker's own bid and ask. Manual refresh is read-only in live mode. Stop and reconfigure invalidate an in-flight cycle before signing. Gas has an explicit maximum.

Transactions are built by the official Aftermath SDK/API. That is an external trust dependency. Simulation detects execution failures but is not a semantic proof of every Move call. Pin and review SDK upgrades, especially changes to agent permissions, order builders, or builder-code fields.

## Network exposure

The control API is reachable only on the internal Docker network. The web service binds to `127.0.0.1` by default and is published through Cloudflare Tunnel and Nginx.

During bootstrap, Nginx uses Basic Auth. After the registry is confirmed, deploy `deploy/nginx-public.conf`; wallet authentication and on-chain membership then become the public gate.

## Incident response

1. Stop the affected engine in the dashboard.
2. Revoke that agent capability with the owner wallet.
3. Remove the wallet from the on-chain registry if access is compromised.
4. Preserve control logs and a database backup.
5. Rotate `CONTROL_TOKEN` and `MAKER_MASTER_KEY` when exposure is possible.
6. Provision a new agent only after reconciling on-chain state.

Never delete an encrypted signer during an uncertain broadcast. Reconcile the transaction digest and capability state first.
