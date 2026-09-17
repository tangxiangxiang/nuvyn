# Installation

## Prerequisites

- Node.js 22 is the production-parity runtime used by the Docker image. CI also verifies Node.js 24 compatibility.
- npm, using the committed `package-lock.json`.
- Git, if you want the History feature. Nuvyn can edit notes without Git, but History reports Git as unavailable.

`better-sqlite3` is a native dependency. `npm ci` normally uses a compatible binary and otherwise needs the platform's standard C/C++ build toolchain.

## Install from Source

```bash
git clone https://github.com/tangxiangxiang/nuvyn.git
cd nuvyn
npm ci
```

The development server expects the vault root to exist. For the default vault, create the three protocol directories once:

```bash
mkdir -p src/content/inbox src/content/literature src/content/archive
```

On Windows, create the same three directories in File Explorer or PowerShell before running the development server.

Then follow the [Quick Start](quick-start.md).

The first start is also the Authentication v1 bootstrap. Nuvyn does not create
a default account: after the server starts, the browser will use `/api/auth/status`
to determine whether it should show `/setup` for the one owner or `/login` for
an existing owner. Read [Configuration](configuration.md) before setup if you
want to provide an explicit `NUVYN_SETUP_TOKEN`.

## Docker Alternative

Docker packages the Vue build, Hono server, Git, and the native SQLite dependency into one image:

```bash
docker compose up -d --build
```

See [Docker Deployment](../deployment/docker.md) before putting real notes into the deployment so the vault bind mount and backup plan are intentional.
