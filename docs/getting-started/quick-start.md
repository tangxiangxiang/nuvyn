# Quick Start

## Run the Development Server

After [installing dependencies](installation.md) and creating the default vault directories:

```bash
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. Vite serves the Vue application and mounts the Hono API as middleware; no second server process is needed.

On startup Nuvyn opens `data/nuvyn.db`, applies pending SQL migrations, reconciles interrupted file operations, and then imports current Markdown metadata. The default note vault is `src/content/`.

## First-Run Owner Setup

Authentication v1 is single-owner and instance-scoped. On a new database:

1. Nuvyn reports `setupRequired=true` from `GET /api/auth/status` and routes the browser to `/setup`.
2. Enter the operator's `NUVYN_SETUP_TOKEN`, choose the only owner username and password, and submit **Create owner**.
3. A successful setup creates the owner and an authenticated server-side session, then opens `/vault`.
4. Setup closes permanently after the owner transaction commits; it is not public registration and a second owner cannot be created.

If `NUVYN_SETUP_TOKEN` is not configured, Nuvyn generates a random one-time setup secret in the current process and prints it once to the private server log. It is not stored in SQLite, `.env`, or Git, and it is not the owner's login password. For a managed deployment, configure an explicit strong secret before starting the process:

```bash
NUVYN_SETUP_TOKEN="<generate-a-strong-secret>" npm run dev
```

An explicit token must contain at least 32 UTF-8 bytes. Never commit the real value or paste it into public issue logs.

The setup form accepts:

- Username: 3–32 ASCII characters, canonicalized to lowercase, using letters, digits, `.`, `_`, and `-`; the first and last character must be alphanumeric.
- Password: 12–256 Unicode code points. There is no required symbol, case, or digit composition rule.

## Login, Logout, and First Use

After an owner exists, a visit to `/` or `/vault` without a valid session goes to `/login`. A successful login creates a fresh server-side session and returns to the validated internal route. Nuvyn does not store a bearer token or password in `localStorage`.

Logout revokes the current server session. Before revocation, Nuvyn coordinates any legal editor save and flushes browser-local recovery drafts; it does not silently delete unsaved drafts. If a session expires or is revoked elsewhere, Nuvyn preserves the Draft Store, redirects to login, and performs the normal recovery discovery after re-login.

There is no public registration, multi-user account, team/collaboration account, role, permission, or per-user vault in Authentication v1. The existing vault and application data remain scoped to this Nuvyn instance.

## First Use

1. Create or open a note under `inbox/` or `literature/`.
2. Edit the Markdown source. Nuvyn saves after 800 ms of inactivity; `Ctrl+S` or `Command+S` saves immediately.
3. Open Document Properties to set the display title, summary, and tags.
4. Use the History panel to create a named Git version when the change is worth keeping.
5. Configure an AI provider in Settings only if you want AI chat and file tools.

## Basic Verification

```bash
npm run typecheck
npm test
npm run build
```

For feature guidance, continue with the [User Guide](../user-guide/overview.md). For a production instance, use the [Deployment Overview](../deployment/overview.md).
