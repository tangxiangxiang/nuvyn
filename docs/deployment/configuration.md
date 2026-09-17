# Runtime Configuration

Create a local `.env` file only when an override is needed. `.env` files are excluded from both Git and the Docker build context.

## Bare-Metal Server

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Set an explicit interface only when remote exposure is intentional. |
| `PORT` | `3000` | HTTP port for `npm run start`. |
| `VAULT_DIR` | `<cwd>/src/content` | Absolute or working-directory-relative vault path. |
| `GIT_AUTHOR_NAME` | `nuvyn` if the vault lacks `user.name` | Existing vault-local Git configuration is preserved. |
| `GIT_AUTHOR_EMAIL` | `nuvyn@localhost` if the vault lacks `user.email` | Existing vault-local Git configuration is preserved. |

## Docker Compose Host Mapping

| Variable | Default | Notes |
| --- | --- | --- |
| `NUVYN_BIND_ADDRESS` | `127.0.0.1` | Host interface used by the Compose `ports` mapping. |
| `NUVYN_PORT` | `3000` | Host port mapped to container port 3000. |

Compose sets the container's `HOST=0.0.0.0` and `PORT=3000`. Do not use those container values to infer host exposure; the `ports` mapping is the boundary that defaults to loopback.

The supplied Compose file does not expose `VAULT_DIR` because it always mounts the vault at the default `/app/src/content`. Change the volume mapping, not the in-container path, unless you also update the service configuration coherently.

## Browser-facing Authentication Origin

`NUVYN_PUBLIC_ORIGIN` is the canonical origin that a browser uses to access
Nuvyn. It controls the session cookie profile and the Origin check for unsafe
mutations. It is separate from both the bare-metal `HOST` listener and Docker's
internal `HOST=0.0.0.0`.

| Variable | Default / example | Notes |
| --- | --- | --- |
| `NUVYN_PUBLIC_ORIGIN` | Bare-metal loopback: `http://127.0.0.1:<PORT>`; Docker: `http://127.0.0.1:<NUVYN_PORT>` | Must match the browser URL exactly, with no path, query, or fragment. |
| `NUVYN_BIND_ADDRESS` | `127.0.0.1` | Host interface for Docker port publication only. It is not the public origin. |
| `NUVYN_PORT` | `3000` | Host port mapped to container port 3000; the default origin follows it. |

For example, when Docker publishes `NUVYN_PORT=8088`, open
`http://127.0.0.1:8088` and use:

```bash
NUVYN_PORT=8088
NUVYN_PUBLIC_ORIGIN=http://127.0.0.1:8088
```

For an HTTPS reverse proxy, use the external URL instead:

```bash
NUVYN_PUBLIC_ORIGIN=https://nuvyn.example.com
```

Do not use `http://0.0.0.0:3000` as a browser-facing origin. Plain HTTP is
accepted only for `localhost`, `127.0.0.1`, and `[::1]`; a non-loopback HTTP
origin fails validation. A non-loopback bare-metal `HOST` therefore requires
an explicit HTTPS public origin. Nuvyn does not trust `Host` or arbitrary
`X-Forwarded-Proto`/`X-Forwarded-Host` values for this decision.

## Owner Setup and Startup Session Revocation

| Variable | Default | Notes |
| --- | --- | --- |
| `NUVYN_SETUP_TOKEN` | Process-local random fallback when setup is required and the variable is unset | Explicit values need at least 32 UTF-8 bytes. The fallback is printed once to the private startup log, retained only in memory, and is not written to SQLite, `.env`, or Git. |
| `NUVYN_AUTH_REVOKE_SESSIONS_ON_START` | `0` | Set to `1` for security incidents, trusted restore, or operator-forced global reauthentication. Existing sessions are revoked before requests are accepted. |

The setup token is only for first-run owner bootstrap; it is not the owner
password and does not become a long-term login credential. After the owner
transaction commits, setup is permanently closed. Leave startup revocation at
`0` for ordinary restarts; do not modify `auth_sessions` by hand.

## AI Master Key

| Variable | Default | Notes |
| --- | --- | --- |
| `NUVYN_MASTER_KEY` | none | 32 bytes encoded as 64 hex characters or canonical base64. Highest precedence. |
| `NUVYN_MASTER_KEY_FILE` | none | Path to a readable file containing the same encoded key. |

If neither is set, Nuvyn creates `data/.nuvyn-master-key` on the first API-key save with restrictive file permissions. The key is outside SQLite and, in Docker, inside the persistent `nuvyn-data` volume.

That automatic creation applies only to first setup. If credentials encrypted
with the fallback key already exist and
the fallback file is missing, Nuvyn returns `master-key-required` without
creating a new file or changing any AI setting. Restore the original fallback
file or provide the matching key through an explicit source. An explicitly
configured but unreadable `NUVYN_MASTER_KEY_FILE` is an error and never falls back to the auto-managed
path.

Changing the master-key source does not re-encrypt existing credentials automatically to an unrelated key. Preserve the original key until all stored provider credentials have been cleared or successfully read and re-saved.

If the original master key is permanently lost, the encrypted credential is
not recoverable. Use the Settings recovery action to explicitly forget one
provider credential at a time; this does not decrypt, rewrite, or delete the
other provider's row, and it never deletes either master-key file. After the
unrecoverable rows have been explicitly cleared, save a new API key to create
and use a new fallback key. The forget action is permanent.

## AI Provider Configuration

Provider, API key, model, and base URL belong in the Settings UI and SQLite. The current server does not read `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, or OpenAI equivalents from the environment.

For OpenAI-compatible providers, configure the API root, for example
`https://api.openai.com/v1` or `https://gateway.example/openai/v1`. Do not enter
`/chat/completions`; the server uses streaming Chat Completions and appends that
path. Full workspace chat also requires function/tool calling support. A
provider that only supports plain text may reject Nuvyn requests; Nuvyn keeps
the failure visible rather than silently dropping tools or changing workspace
mutation semantics.
