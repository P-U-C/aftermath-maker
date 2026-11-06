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
- SQLite volume: `aftermath-maker-dev_maker-dev-data`
- Loopback port: `127.0.0.1:8789`
- Local image: `puc/aftermath-maker:dev`
- `control` network: `maker-dev-internal`, with no external egress
- Web edge: `maker-dev-edge`, used only for Nginx's loopback listener
- `LIVE_TRADING_ENABLED=false` and `ALLOW_MAINNET=false` are Compose literals

The dev image retains its build-only dependencies to avoid a slow Docker
snapshot on this host. Release images keep the Dockerfile default and prune
those dependencies.

The dev environment file is `/etc/aftermath-maker/dev.env` (mode `0600`), not
the repository `.env`. It needs only non-production values for
`CONTROL_TOKEN`, `PUBLIC_ORIGIN=https://maker-dev.permanentupperclass.com`,
`WEB_BIND_ADDRESS=127.0.0.1`, and `DEV_WEB_PORT=8789`. Do not copy a production
master key, account setting, whitelist object, or RPC endpoint into it.

The control runtime network prevents venue egress. Until the fixture control
profile lands, this release is for UI/authentication and
unavailable-dependency paths; it is not a funding/Paper execution environment.

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

Create the DNS record for `maker-dev.permanentupperclass.com` to this host
before external verification. Keep the existing Basic Auth file in place.

Use these diagnostics after a merge:

```bash
systemctl status aftermath-maker-dev-deploy.service
journalctl -u aftermath-maker-dev-deploy.service -n 100 --no-pager
sudo docker compose --project-name aftermath-maker-dev \
  --env-file /etc/aftermath-maker/dev.env \
  -f /home/ubuntu/aftermath-maker-dev/docker-compose.dev.yml ps
```
