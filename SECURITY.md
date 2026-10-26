# Security model

This service controls real perpetuals positions. It reduces custody risk; it does not remove market, smart-contract, oracle, liquidation, or validator risk.

## Trust boundary

The owner wallet remains the account administrator. The local agent receives an Aftermath agent capability that can trade but cannot:

- withdraw account collateral;
- grant another agent; or
- revoke or replace the administrator.

The owner should keep enough SUI outside the agent for emergency revocation.

## Secret handling

- `MAKER_MASTER_KEY` encrypts the agent private key with AES-256-GCM.
- A unique salt, IV, and authenticated account context are stored with the ciphertext.
- The plaintext key is never returned by the API or dashboard.
- `.env`, the SQLite volume, and backups are separate required assets. Possession of both the master key and database is sufficient to recover the agent.
- Container logs redact the control token and encrypted signer fields.

Keep `.env` mode `0600`. Store an offline copy separately from the database backup.

## Network exposure

The control API is reachable only on the internal Docker network. The dashboard binds to `127.0.0.1` by default. The internal hosted deployment uses Cloudflare Tunnel to an Nginx virtual host protected by TLS and HTTP Basic Authentication; no application port is directly published to the internet.

The edge credential is stored at `~/.config/maker/access.env` with mode `0600`, and its password hash is stored in `/etc/nginx/htpasswd-maker`. Basic Auth is an internal-phase gate, not the eventual customer identity system.

All mutating control requests also require `CONTROL_TOKEN`. The browser never receives that token: the Next.js server-side proxy adds it.

## Live-trading gates

A live strategy requires all of the following:

- `LIVE_TRADING_ENABLED=true`;
- `ALLOW_MAINNET=true`;
- a confirmed agent capability;
- an encrypted signer;
- fresh two-sided orderbook data;
- quote, inventory, loss, and spread checks; and
- successful Sui transaction simulation.

Any failed live cycle stops the engine.

## Transaction policy

Orders are post-only and replaced atomically with cancel-and-place. Stable client order IDs restrict cancellation to this service's bid and ask. Manual refresh is read-only in live mode, and stop or reconfigure invalidates an in-flight cycle before signing. The request object is recursively rejected if it contains any builder-fee field. Gas has an explicit maximum.

The transaction itself is built by the official Aftermath API. That remains an external trust dependency. Simulation catches execution failures but is not a semantic proof of every Move call. Before a public release, add a package-and-function allowlist over the fully resolved transaction commands.

## Incident response

1. Stop the engine in the dashboard or run `docker compose stop control`.
2. Use the owner wallet to revoke the displayed agent capability.
3. Preserve `docker compose logs control` and the database backup.
4. Rotate `CONTROL_TOKEN` and `MAKER_MASTER_KEY`.
5. Provision a new agent only after the root cause is understood.

Never delete the encrypted signer during an uncertain broadcast. Reconcile the transaction digest and on-chain capability state first.
