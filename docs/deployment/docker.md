# Docker Deployment

## Prepare the Vault

Compose bind-mounts the host's `./src/content` at `/app/src/content`. On Linux or NAS hosts, make it writable by UID/GID 1000, which is the container user:

```bash
mkdir -p src/content/inbox src/content/literature src/content/archive
sudo chown -R 1000:1000 src/content
```

Do not treat this directory as disposable application state. It is the note vault and contains its own `.git/` history after History is used.

## Start

```bash
docker compose up -d --build
docker compose ps
```

Open `http://127.0.0.1:3000`. The host binding defaults to loopback even though the process inside the container must listen on `0.0.0.0`; the container listener is not the browser-facing authentication origin.

The Docker build context excludes `src/content/`, `backups/`, and `data/`.
Those directories are runtime data and must remain outside the image build; the
Vault is supplied through the Compose bind mount and application data through
the persistent `nuvyn-data` volume.

On the first visit, Nuvyn opens `/setup`. Provide an explicit strong
`NUVYN_SETUP_TOKEN` through an
untracked `.env`/secret mechanism, or read the one-time fallback token from
`docker compose logs nuvyn`. Explicit values must
contain at least 32 UTF-8 bytes and must not be committed. The fallback exists
only in the current process memory and is printed once; it is not stored in the
database or the Docker volume. After setup, the single owner uses `/login`.

For a custom loopback port, keep the browser URL and origin aligned:

```bash
NUVYN_PORT=8088
NUVYN_PUBLIC_ORIGIN=http://127.0.0.1:8088
docker compose up -d --build
```

`NUVYN_BIND_ADDRESS` changes only the host
interface used by Docker's port publication. It does not change
`NUVYN_PUBLIC_ORIGIN`. Do not use
`http://0.0.0.0:3000` as the public origin.

## Data Mounts

| Container path | Compose source | Contents |
| --- | --- | --- |
| `/app/src/content` | Host bind mount `./src/content` | Markdown bodies, vault `.git/`, vault `.nuvyn/`, and vault-local ignore files. |
| `/app/data` | Named volume `nuvyn-data` | `nuvyn.db`, SQLite WAL/SHM files, and `.nuvyn-master-key`. |
| `/tmp` | tmpfs | Ephemeral process scratch space. |

The root filesystem is read-only. Only the two data mounts and `/tmp` are writable.

## Logs and Health

```bash
docker compose logs -f nuvyn
docker inspect --format '{{.State.Health.Status}}' nuvyn
curl --fail http://127.0.0.1:3000/api/health
```

Compose uses the `json-file` logging driver with a 10 MiB file limit and three rotated files.

`/api/health` is intentionally anonymous and returns only `{ "ok": true }` for
liveness. It does not disclose `vaultId`; an authenticated owner obtains the
stable identity from `/api/vault/identity`. Authentication status, setup, login,
logout, and protected API responses use `Cache-Control: no-store`.

## HTTPS Reverse Proxy

For remote access, publish Nuvyn behind an HTTPS reverse proxy and set the
external browser origin explicitly:

```bash
NUVYN_PUBLIC_ORIGIN=https://nuvyn.example.com
```

Forward `/`, `/login`, `/setup`, `/api/auth/*`, and all other `/api/*` paths to
the same container port. HTTPS selects the `__Host-nuvyn_session` cookie
(`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`). Nuvyn does not infer this
profile from Docker's `0.0.0.0` listener or arbitrary forwarded headers; the
proxy should preserve the browser's `Origin` header.

### Production Browser Origin

For the production instance, put the actual browser-facing origin in the
`.env` file beside `docker-compose.yml` (replace the placeholder below):

```dotenv
NUVYN_PUBLIC_ORIGIN=https://your-nuvyn.example.com
```

Do not leave the loopback default when accessing this deployment through its
public URL. The value controls the authentication cookie profile and
same-origin mutation checks. If the public URL changes, update `.env` to match
the URL users open, then recreate the service:

```bash
docker compose up -d --force-recreate nuvyn
```

## Upgrade

Back up both persistent stores first, then rebuild and replace the container:

```bash
docker compose build
docker compose up -d
docker compose ps
```

Image replacement does not remove the bind mount or named volume. Check the startup log for authentication, crash-recovery, and metadata-migration failures before declaring the upgrade complete. If the deployment is restored from an older or untrusted database backup, set `NUVYN_AUTH_REVOKE_SESSIONS_ON_START=1` for the first startup so restored sessions cannot be reused.

### Vault Writer Lifecycle

Normal `docker stop`, `docker compose down`, and Compose replacement send
`SIGTERM` to the Nuvyn server. The server stops accepting work, closes the HTTP
listener, and nonce-safely removes `src/content/.nuvyn/vault-writer.json` before
it exits. A replacement container can therefore use its normal new Docker
hostname; no fixed `hostname:` setting is required.

`SIGKILL`, host crashes, and power loss cannot run that cleanup. If one of those
events leaves an ownership record from another container hostname, Nuvyn
intentionally refuses startup instead of guessing that the previous writer is
dead. This preserves the single-writer guarantee.

Only after proving that no Nuvyn process or container is using the Vault, move
the stale record aside as a recoverable operator action, then start the service:

```bash
mv src/content/.nuvyn/vault-writer.json \
  src/content/.nuvyn/vault-writer.json.stale
docker compose up -d nuvyn
```

Keep the moved record until the replacement is healthy. Never perform this
recovery while another Nuvyn instance may still have the Vault mounted.

## Common Problems

- **Permission denied under `/app/src/content`:** correct the host directory ownership or ACL for UID/GID 1000.
- **Port already in use:** change `NUVYN_PORT` in `.env`.
- **History unavailable:** the image includes Git; inspect the vault's `.git/` permissions and the History initialization error.
- **AI key cannot be decrypted:** restore the matching master key or clear and re-enter the provider credential.
- **SPA route returns 404 behind a proxy:** forward both `/api/*` and all other paths to the same Nuvyn port; the Nuvyn production server owns the SPA fallback.
