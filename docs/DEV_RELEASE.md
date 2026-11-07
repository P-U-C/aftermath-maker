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
- SQLite volume: `aftermath-maker-dev_maker-dev-shadow-data`
- Loopback port: `127.0.0.1:8789`
- Local image: `puc/aftermath-maker:dev`
- `control` network: `maker-dev-internal`, plus a dedicated Mainnet public-data
  egress bridge. It receives no Mainnet signing key.
- Web edge: `maker-dev-edge`, used only for Nginx's loopback listener
- `LIVE_TRADING_ENABLED=false` and `ALLOW_MAINNET=false` are Compose literals
- `SUI_NETWORK=mainnet` is a Compose literal for market-data Paper/shadow.
  Both Mainnet Live gates remain Compose literals set to `false`.

The dev image retains its build-only dependencies to avoid a slow Docker
snapshot on this host. Release images keep the Dockerfile default and prune
those dependencies.

The deploy service force-recreates web and control after a changed commit. The
local `puc/aftermath-maker:dev` tag is mutable by design, so this is what makes
the running containers advance to the just-built, SHA-labelled image.

The Mainnet Paper/shadow environment file is
`/etc/aftermath-maker/dev-shadow.env` (mode `0600`), not the repository `.env`.
It needs only non-production values for
`CONTROL_TOKEN`, `PUBLIC_ORIGIN=https://maker-dev.permanentupperclass.com`,
`WEB_BIND_ADDRESS=127.0.0.1`, `DEV_WEB_PORT=8789`, and
`WALLET_AUTH_BOOTSTRAP=true`. The bootstrap setting is valid only because the
Compose file pins `SHADOW_PAPER_MODE=true`, both Live gates off, and supplies no
Mainnet signing key. On a fresh shadow database, the first wallet that signs in
becomes the sole dev operator; no on-chain access-list deployment or transaction
is required. Do not copy a production master key, account setting, whitelist
object, or RPC endpoint into it.

The shadow lane gets a fresh database volume and its environment contains no
`MAKER_MASTER_KEY`, Testnet key, account cap, or allowlist object. The prior
Testnet and fixture volumes are retained but never mounted. A future Mainnet
canary uses a separate, explicitly enabled host configuration and dedicated
wallet; it is not part of this Compose file.

## Bounded Mainnet canary

The separate canary is a manual, root-only single-lifecycle test for the
dedicated disposable account pair. It never runs during deployment, from the
browser, or from a timer. It accepts one market and a maximum $5 quote/hedge,
simulates first, then cancels before any hedge or flatten. Its durable
checkpoint resumes recovery after an interruption rather than quoting again.

See [the live-canary audit](../audits/2026-11-07-live-canary-framework.md) for
the exact command shape, evidence boundary, and remaining Mainnet proof.

## Testnet diagnostic

Aftermath has advised that Perpetuals Testnet is not a reliable execution
staging surface. The Testnet preflight remains a manual diagnostic only; it is
not run by dev deploys and cannot authorize execution.

It never signs, broadcasts, creates an account, or requests faucet funds.

Mainnet execution remains gated by both `LIVE_TRADING_ENABLED` and
`ALLOW_MAINNET`; the shadow Compose file pins both to `false`.

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

If a later merged change updates `deploy/maker-dev-deploy.sh`, reinstall that
single host-side launcher before relying on it for the next release:

```bash
sudo install -m 0755 deploy/maker-dev-deploy.sh /usr/local/sbin/maker-dev-deploy
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
  --env-file /etc/aftermath-maker/dev-shadow.env \
  -f /home/ubuntu/aftermath-maker-dev/docker-compose.dev.yml ps
```
