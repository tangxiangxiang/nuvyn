# Docker Release Deployment

Nuvyn release images are published to GitHub Container Registry (GHCR):

```text
ghcr.io/tangxiangxiang/nuvyn:<version>
```

The release workflow runs only for a valid `vMAJOR.MINOR.PATCH` tag (with an
optional prerelease), verifies that the tagged commit is on `main`, runs the
packaged Docker smoke tests, and publishes `linux/amd64` and `linux/arm64`
images. It also publishes a `sha-<short-sha>` tag. Stable SemVer releases may
update `latest`; prereleases never do.

Production hosts use [`compose.production.yml`](../../compose.production.yml)
and do not need the Nuvyn source tree, Node.js, npm, or a Docker build toolchain.
The production Compose file requires `NUVYN_IMAGE`; it never silently falls
back to `latest`.

## Persistent Volume Isolation

The default persistent Docker volume is `nuvyn-data`, preserving the normal
single-instance production behavior. Compose accepts `NUVYN_DATA_VOLUME` as an
override for staging, smoke tests, and parallel instances; those environments
must use a distinct volume name (for example, `nuvyn-alpha1-smoke-data`) and
must never reuse the production volume.

## First Deploy

Create a small deployment directory and place the tracked production Compose
file and a copied, untracked `.env` there:

```bash
sudo mkdir -p /opt/nuvyn/content
cd /opt/nuvyn

cp /path/to/compose.production.yml .
cp /path/to/deploy/.env.example .env
```

Edit `.env` and set the release image, browser-facing origin, and any explicit
setup or master-key secrets. Do not commit or paste the real `.env` into the
source repository. On Linux hosts, make the content directory writable by the
container user:

```bash
sudo chown -R 1000:1000 /opt/nuvyn/content
```

If the GHCR package is private, authenticate the Docker client using the
operator's registry credentials before pulling. Do not put a registry token in
`.env` or in this repository.

```bash
docker compose -f compose.production.yml pull
docker compose -f compose.production.yml up -d
docker compose -f compose.production.yml ps
curl --fail http://127.0.0.1:3000/api/health
```

Adjust the health URL when `NUVYN_BIND_ADDRESS` or `NUVYN_PORT` is changed.
The application still listens inside the container on `0.0.0.0:3000`.

## Upgrade

Back up both persistent stores before changing the image. Then change only the
`NUVYN_IMAGE` value in `.env` to the next exact release tag:

```dotenv
NUVYN_IMAGE=ghcr.io/tangxiangxiang/nuvyn:0.1.0-alpha.2
```

Apply the upgrade without a source checkout, npm install, or Docker build:

```bash
docker compose -f compose.production.yml pull
docker compose -f compose.production.yml up -d
docker compose -f compose.production.yml ps
curl --fail http://127.0.0.1:3000/api/health
```

Review container logs and the health status before treating the upgrade as
complete. The named `nuvyn-data` volume and the content bind mount are reused.

## Rollback

For a release that did not perform an incompatible or irreversible database
migration, restore the previous exact image tag in `.env` and apply it:

```dotenv
NUVYN_IMAGE=ghcr.io/tangxiangxiang/nuvyn:0.1.0-alpha.1
```

```bash
docker compose -f compose.production.yml pull
docker compose -f compose.production.yml up -d
```

An image rollback is not automatically safe after an irreversible SQLite
schema or data migration. In that case, stop the service and restore the
pre-upgrade `nuvyn-data` volume backup together with the matching content
backup before starting the older image. Do not assume that every release can
be rolled back by changing only the image tag.

## Backup Before Upgrade

Back up both of these assets:

1. `/opt/nuvyn/content`, including hidden files, the vault `.git` history, and
   `.nuvyn` state.
2. The complete `nuvyn-data` named volume, including SQLite, WAL/SHM files,
   and the managed master-key file.

For a consistent backup, stop Nuvyn first. Stopping the Compose service does
not delete the named volume:

```bash
cd /opt/nuvyn
docker compose -f compose.production.yml down

mkdir -p backups
tar czf "backups/nuvyn-content-$(date +%F-%H%M%S).tgz" -C content .
docker run --rm \
  -v nuvyn-data:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf "/backup/nuvyn-data-$(date +%F-%H%M%S).tgz" -C /source .

docker compose -f compose.production.yml up -d
```

Do not copy only `nuvyn.db` while SQLite is live. Keep the content and volume
archives from the same stopped point in time. If `NUVYN_MASTER_KEY` or
`NUVYN_MASTER_KEY_FILE` is supplied from an external secret store, preserve
that secret separately as part of the host's secret-backup policy; never place
it in Git.
