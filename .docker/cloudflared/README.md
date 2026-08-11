# Cloudflare Tunnel — `shop.xwash.vn`

XWash publishes itself through its **own** Cloudflare Tunnel connector
(`xwash-cloudflared` in [`docker-compose.prod.yml`](../../docker-compose.prod.yml)).
It no longer depends on the dokomap stack's tunnel.

## Mode: token → **remotely managed**

The connector runs with a **connector token**, not a credentials file:

```yaml
command: tunnel --no-autoupdate run
environment:
  TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?...}
```

> [!IMPORTANT]
> Because it runs in token mode, this tunnel is **remotely managed**: Cloudflare
> pushes the ingress config from the dashboard and **ignores any local
> `config.yml`**. That is why this directory intentionally contains **no**
> `config.yml` — shipping one would look authoritative while being dead code.
>
> **To change routing you MUST edit the Cloudflare dashboard**, not this repo.

Consequences to be aware of:

- There is **no** `credentials.json` and **no** `cert.pem` — on the server or in
  this repo. `tunnel run` needs neither in token mode.
- The container is **stateless**: no volume mount, safe to recreate at will.
- Routing is **not** version-controlled. The expected state is documented below;
  keep it in sync when you change the dashboard.

## Expected ingress (Zero Trust → Networks → Tunnels → *tunnel* → Public Hostname)

| # | Subdomain | Domain | Path | Service |
|---|-----------|-----------|-----------------|--------------------------|
| 1 | `shop` | `xwash.vn` | `^/api(/.*)?$` | `HTTP` → `xwash-api:5000` |
| 2 | `shop` | `xwash.vn` | *(empty)* | `HTTP` → `xwash-web:80` |

> [!WARNING]
> **Order matters — first match wins, and a rule with no Path matches every
> path.** Rule 1 must come *before* rule 2. If they are swapped, `/api/*` is
> routed to the frontend nginx, the API returns HTML instead of JSON, and the
> whole app breaks. Verify with:
> `curl -s https://shop.xwash.vn/api/health` → must return JSON.

> [!WARNING]
> When typing a Path in the dashboard, do **not** include a leading `/`. The UI
> already prefixes the hostname, so a stored value of `/^/api(/.*)?$` never
> matches. The correct stored value is `^/api(/.*)?$`.

DNS: Cloudflare creates the proxied `CNAME shop.xwash.vn → <tunnel>.cfargotunnel.com`
automatically when the Public Hostname is added. No manual DNS record is needed.

## Where the token lives

`CLOUDFLARE_TUNNEL_TOKEN` is stored in
[`backend/.env.production`](../../backend/.env.production), which CI copies to
`/srv/xwash/.env` on the server. Compose reads that file to interpolate
`${CLOUDFLARE_TUNNEL_TOKEN}` into the container's `TUNNEL_TOKEN`.

Notes on this choice:

- The token is passed as an **env var**, not as `--token` on the command line,
  so it does not appear in `Config.Cmd` or in `ps` output. It is still visible
  via `docker inspect xwash-cloudflared` (`Config.Env`) to anyone with docker
  access on the shared host.
- `xwash-cloudflared` deliberately does **not** get `env_file: .env`, so it only
  receives `TUNNEL_TOKEN` and never sees `JWT_SECRET`, MySQL or Discord secrets.
- The reverse does **not** hold: `xwash-api` *does* use `env_file: .env`, so it
  also receives `CLOUDFLARE_TUNNEL_TOKEN` even though it never reads it. That is
  inherent to keeping the token in the shared `/srv/xwash/.env`. To scope the
  token to the connector only, move it into a separate server-only file and give
  `xwash-cloudflared` an `env_file: .env.cloudflared` instead — at the cost of
  one manually maintained file on the server.
- The token is a high-value secret: anyone holding it can run a second connector
  for this tunnel, receive a share of live `shop.xwash.vn` traffic, and serve
  arbitrary content. Treat a leak as an incident and rotate immediately.

### Rotating the token

1. Zero Trust → Networks → Tunnels → *tunnel* → **Refresh token**.
2. Update `CLOUDFLARE_TUNNEL_TOKEN` in `backend/.env.production`.
3. Redeploy. The old token stops working once refreshed, so expect a brief
   outage between refresh and redeploy — do it in a maintenance window.

## Verify a deploy

```bash
# 1. connector registered on all edge locations
docker logs xwash-cloudflared | grep -i "registered tunnel connection"    # expect 4

# 2. no auth / config errors
docker logs xwash-cloudflared | grep -iE "error|failed|unauthorized"      # expect empty

# 3. token was NOT passed on the command line
docker inspect xwash-cloudflared --format '{{.Config.Cmd}}'               # must not contain the token

# 4. ingress order is correct (JSON, not HTML)
curl -s https://shop.xwash.vn/api/health

# 5. SPA is served and deep links fall back to index.html
curl -sI https://shop.xwash.vn/
curl -sI https://shop.xwash.vn/timesheets
```

Dashboard: tunnel status should be **HEALTHY** with connector `xwash-cloudflared`.

> [!NOTE]
> After the **next** deploy, re-check that `xwash-cloudflared` still starts. CI
> overwrites `/srv/xwash/.env` from `backend/.env.production` on every deploy, so
> the token must live in that tracked file — a token added by hand on the server
> would be wiped. Compose fails fast with a clear message if it is missing.

## History: migrated off `xwash.dokomap.vn`

XWash used to be published by the **dokomap** stack's tunnel
(`f7659090-1fae-47fe-a890-593069915934`), which reached `xwash-api` /
`xwash-web` over the shared external `edge-network`. Consequences at the time:
XWash's public entry point lived in another repo, and redeploying dokomap took
XWash offline.

Migration, in the order it was carried out:

1. Stood up this stack's own connector while keeping `edge-network`, so both
   hostnames served in parallel and the old one stayed available as a rollback.
2. Verified `shop.xwash.vn` end to end — including that the connector had
   actually received the ingress config, via
   `docker logs xwash-cloudflared | grep -i configuration`.
3. Deleted the two `xwash.dokomap.vn` Public Hostnames from the dokomap tunnel
   and its `xwash` DNS record, and removed the matching rules from the dokomap
   repo's `.docker/cloudflared/config.prod.yml`.
4. Only then dropped `edge-network` from this compose file, isolating XWash from
   the shared bridge.

> [!CAUTION]
> The order of steps 3 and 4 mattered. Removing `edge-network` first would have
> broken docker DNS resolution for the dokomap connector and killed
> `xwash.dokomap.vn` immediately — the rollback path still in use at that point.
> Keep this in mind if XWash is ever attached to a shared network again.
