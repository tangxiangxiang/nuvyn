# Configuration

Nuvyn has two configuration surfaces: runtime environment variables for the server and Settings in the application for AI and metadata operations.

## Vault, Listener, and Browser Origin

| Setting | Default | Purpose |
| --- | --- | --- |
| `VAULT_DIR` | `<working-directory>/src/content` | Markdown vault root; relative values resolve from the process working directory. |
| `HOST` | `127.0.0.1` in the production server | Listener address for `npm run start`. |
| `PORT` | `3000` | Listener port for `npm run start`. |
| `GIT_AUTHOR_NAME` | `nuvyn` when the vault has no local identity | Author name for Nuvyn-created versions. |
| `GIT_AUTHOR_EMAIL` | `nuvyn@localhost` when the vault has no local identity | Author email for Nuvyn-created versions. |

The Docker Compose deployment uses the canonical host-side variables `NUVYN_BIND_ADDRESS` and `NUVYN_PORT`. See [Runtime Configuration](../deployment/configuration.md).

`NUVYN_PUBLIC_ORIGIN` is the origin that the browser actually opens. It is the
security authority for cookie selection and Origin validation; it is not the
Node listener address and it is not inferred from `HOST`, Docker's internal
`0.0.0.0`, or forwarded proxy headers.

Examples:

```bash
# Vite development, if an explicit value is needed
NUVYN_PUBLIC_ORIGIN=http://localhost:5173

# Docker published on a custom loopback port
NUVYN_PORT=8088
NUVYN_PUBLIC_ORIGIN=http://127.0.0.1:8088

# Browser-facing HTTPS reverse proxy
NUVYN_PUBLIC_ORIGIN=https://nuvyn.example.com
```

`http://0.0.0.0:3000` is a bind/listener address, not a valid browser-facing
origin. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `[::1]`;
non-loopback browser access should use an HTTPS reverse proxy and an explicit
`https://` origin. A bare-metal production process with a loopback `HOST` can
derive `http://127.0.0.1:<PORT>` when the variable is omitted; a non-loopback
`HOST` requires an explicit public origin.

## Authentication Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `NUVYN_PUBLIC_ORIGIN` | Vite: `http://localhost:5173`; bare-metal loopback: `http://127.0.0.1:<PORT>`; Docker: `http://127.0.0.1:<NUVYN_PORT>` | Browser-facing origin, cookie profile, and same-origin mutation policy. |
| `NUVYN_SETUP_TOKEN` | A process-local random fallback when unset and setup is required | First-run owner bootstrap secret. Explicit values must contain at least 32 UTF-8 bytes. |
| `NUVYN_AUTH_REVOKE_SESSIONS_ON_START` | `0` | Set to `1` to revoke all existing sessions before accepting requests. |

Setup requires the token even on local HTTP. The fallback token is generated
once per process, printed once to the private operator log, retained only in
memory until owner creation, and never written to SQLite, `.env`, Git, or a
normal response. Restarting before setup creates a new fallback token. Once the
owner exists, setup is closed.

Authentication v1 accepts one owner only. Username input is 3–32 ASCII
characters, canonicalized to lowercase, from `[a-z0-9._-]` with alphanumeric
boundaries; password input is 12–256 Unicode code points. Passwords are not
trimmed or normalized.

The startup revocation control is an explicit operator action for incidents,
trusted restore, or forced global reauthentication. Leave it at `0` for normal
restarts. It revokes existing sessions; the owner then signs in again. Do not
edit `auth_sessions` directly.

## AI Provider Settings

Configure these in Settings, not as provider environment variables:

- Provider: Anthropic or OpenAI.
- API key.
- Model.
- Optional HTTP(S) base URL.

Each provider keeps its own saved configuration in SQLite. The active provider determines which slot is used.

## AI Master Key

Provider credentials are encrypted before SQLite storage. The encryption master key is resolved in this order:

1. `NUVYN_MASTER_KEY`.
2. The file named by `NUVYN_MASTER_KEY_FILE`.
3. The auto-managed `data/.nuvyn-master-key` file, created on the first API-key save.

An explicit key must encode exactly 32 bytes as either 64 hexadecimal characters or canonical base64. Do not store a real key in the repository.

Reading an empty AI configuration does not create the auto-managed file. If
SQLite contains provider credentials encrypted with that fallback key and
`data/.nuvyn-master-key` is missing, Nuvyn reports `master-key-required` and
leaves both the credentials and all other AI settings unchanged. It does not
create an unrelated replacement key. In fallback mode, back up and restore
`data/nuvyn.db` and the matching master-key file together. The runtime accepts only the canonical Nuvyn database and key paths.

If the original key is permanently unavailable, explicitly forget the affected
provider credential in Settings before configuring a replacement. This is a
permanent, provider-scoped action; Nuvyn never clears the credential during a
failed read.

See [Deployment Security](../deployment/security.md) and [Backup and Restore](../deployment/backup-and-restore.md) before changing an existing instance's key.
