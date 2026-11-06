# Development release

`dev` is Maker's integration branch. Open normal pull requests against it;
the fast `maker-dev-gate` must pass before merge. The host then polls `dev`
once per minute and deploys a new commit to
`https://maker-dev.permanentupperclass.com`.

`main` remains the release branch. Promote a tested `dev` commit to `main`,
then run the manual **Maker release gate** before a production deployment.
That release gate, not this fast dev path, produces SBOM and provenance
evidence.

## Isolation

The dev release is deliberately independent of the production stack:

- Compose project: `aftermath-maker-dev`
- SQLite volume: `aftermath-maker-dev_maker-dev-testnet-data`
- Loopback port: `127.0.0.1:8789`
- Local image: `puc/aftermath-maker:dev`
- `control` network: `maker-dev-internal`, plus a dedicated Testnet-only
  egress bridge for the configured Sui/Aftermath Testnet endpoints
- Web edge: `maker-dev-edge`, used only for Nginx's loopback listener
- `LIVE_TRADING_ENABLED=false` and `ALLOW_MAINNET=false` are Compose literals
- `SUI_NETWORK=testnet` and `TESTNET_EXECUTION_ENABLED=true` are Compose
  literals. This gate authorizes Testnet only; it cannot authorize Mainnet.

The dev image retains its build-only dependencies to avoid a slow Docker
snapshot on this host. Release images keep the Dockerfile default and prune
those dependencies.

The dev environment file is `/etc/aftermath-maker/dev.env` (mode `0600`), not
the repository `.env`. It needs only non-production values for
`CONTROL_TOKEN`, `PUBLIC_ORIGIN=https://maker-dev.permanentupperclass.com`,
`WEB_BIND_ADDRESS=127.0.0.1`, and `DEV_WEB_PORT=8789`. Do not copy a production
master key, account setting, whitelist object, or RPC endpoint into it.

The Testnet lane uses a separate database volume and requires a fresh,
Testnet-only control key in `TESTNET_MAKER_MASTER_KEY`. If an on-chain access
list is used, configure only `TESTNET_SUI_WHITELIST_OBJECT_ID`. Never put
`MAKER_MASTER_KEY`, `SUI_WHITELIST_OBJECT_ID`, a production master key, account
cap, allowlist object, or Mainnet RPC endpoint in `dev.env`; Testnet control
refuses to start when a Mainnet secret or allowlist is configured for Testnet.
The prior fixture-era `maker-dev-data` volume is retained but never mounted.
Testnet data can be wiped, has no value, and must not be relied on for recovery
evidence.

For a new Testnet volume with no allowlist, set
`TESTNET_BOOTSTRAP_OPERATOR_ADDRESS` to the one intended Testnet wallet address
(a public `0x…` address). Only that wallet may claim the initial operator
session; the service never makes the first wallet that reaches this public host
an operator. Remove the setting after the operator has set up an on-chain
Testnet allowlist.

When testing execution, connect a wallet set to Sui Testnet and create fresh
Aftermath Testnet accounts. The page's configured wallet network and the
control's `SUI_NETWORK` must both be Testnet. Mainnet execution remains gated
by both `LIVE_TRADING_ENABLED` and `ALLOW_MAINNET`; the dev compose file pins
both to `false`.

## One-time host installation

After the first commit reaches `dev`, install the versioned units and Nginx
vhost:

```bash
sudo install -m 0644 deploy/aftermath-maker-dev-deploy.service /etc/systemd/system/
sudo install -m 0644 deploy/aftermath-maker-dev-deploy.timer /etc/systemd/system/
sudo install -m 0755 deploy/maker-dev-deploy.sh /usr/local/sbin/maker-dev-deploy
sudo install -m 0644 deploy/nginx-dev.conf /etc/nginx/sites-available/maker-dev.conf
sudo ln -s ../sites-available/maker-dev.conf /etc/nginx/sites-enabled/maker-dev.conf
sudo systemctl daemon-reload
sudo systemctl enable --now aftermath-maker-dev-deploy.timer
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl start aftermath-maker-dev-deploy.service
```

Route `maker-dev.permanentupperclass.com` through the existing Cloudflare
Tunnel, alongside `maker.permanentupperclass.com`; do not create a public IP
record or a router port-forward. Add this ingress rule before the tunnel's
catch-all rule:

```yaml
- hostname: maker-dev.permanentupperclass.com
  service: http://localhost:80
```

Then validate and restart the tunnel:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
sudo systemctl restart cloudflared-radar.service
```

In Cloudflare DNS, make the hostname a proxied CNAME to the existing tunnel
(`8f52c6c9-8f09-4efe-b3b7-64675dfa1101.cfargotunnel.com`). The dev hostname is
public; it does not use the production Maker Basic Auth file.

Use these diagnostics after a merge:

```bash
systemctl status aftermath-maker-dev-deploy.service
journalctl -u aftermath-maker-dev-deploy.service -n 100 --no-pager
sudo docker compose --project-name aftermath-maker-dev \
  --env-file /etc/aftermath-maker/dev.env \
  -f /home/ubuntu/aftermath-maker-dev/docker-compose.dev.yml ps
```
