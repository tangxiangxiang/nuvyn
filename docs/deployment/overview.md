# Deployment Overview

Nuvyn runs as one Node.js process: Hono serves `/api/*`, the built Vue application is served from `dist/`, and non-API paths fall back to `index.html` for client-side routing. Authentication v1 adds a single-owner, server-side session boundary around the existing instance; it does not turn the vault into a multi-user service.

## Recommended: Docker Compose

```bash
docker compose up -d --build
```

The supplied Compose service:

- exposes container port 3000 at `127.0.0.1:3000` by default;
- bind-mounts `./src/content` as the Markdown vault;
- stores `data/` in the `nuvyn-data` named volume;
- runs as UID/GID 1000 with a read-only root filesystem, `no-new-privileges`, and a `/tmp` tmpfs;
- checks the public liveness-only `/api/health` every 30 seconds;
- uses `http://127.0.0.1:<published-port>` as the default browser-facing `NUVYN_PUBLIC_ORIGIN`.

Continue with [Docker](docker.md), [Security](security.md), and [Backup and Restore](backup-and-restore.md).

## Bare-Metal Production

Use Node.js 22 for production parity:

```bash
npm ci
npm run build
NODE_ENV=production npm run start
```

The production server defaults to `127.0.0.1:3000`. Set `VAULT_DIR` if the vault is not `<working-directory>/src/content`. The process creates the protected root folders, initializes authentication, runs server-side crash recovery, migrates document metadata, then starts accepting requests.

Run the process under a service manager. Direct HTTP is intended for loopback only; for remote access, put an HTTPS reverse proxy in front of Nuvyn and set `NUVYN_PUBLIC_ORIGIN` to the URL that browsers actually open. Nuvyn provides owner authentication but does not terminate TLS.

## Health Check

```bash
curl --fail http://127.0.0.1:3000/api/health
```

A healthy response is the anonymous liveness-only JSON `{ "ok": true }`. It does not contain the stable vault identity. An authenticated owner receives that identity separately from `GET /api/vault/identity`, after auth hydration and before the workspace mounts.

## First-run Authentication

On a fresh or upgraded database, `GET /api/auth/status` reports
`setupRequired=true` and the browser opens `/setup`. The operator must provide
the explicit `NUVYN_SETUP_TOKEN`, or read the one-time process-local fallback
token from the private startup log, before creating the only owner. The setup
request creates the owner and first server-side session; it is not public
registration. Once an owner exists, `/setup` is closed and normal access uses
`/login`.

See [Runtime Configuration](configuration.md) for origin, token, and startup
session-revocation settings, and [Security](security.md) for the API boundary
and cookie contract.

## Reverse Proxy Boundary

Forward the SPA and every `/api/*` path to the same Nuvyn listener. Set an
explicit browser-facing origin such as:

```bash
NUVYN_PUBLIC_ORIGIN=https://nuvyn.example.com
```

Nuvyn selects the secure `__Host-nuvyn_session` profile from that origin. It
does not infer the profile from `HOST`, Docker's internal listener, or
`X-Forwarded-*` headers. The proxy should preserve the browser's `Origin` header
and must not cache authenticated JSON responses.
