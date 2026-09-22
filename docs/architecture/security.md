# Security Model

Nuvyn Authentication v1 protects one self-hosted Nuvyn instance with one owner
and server-side sessions. It answers who may operate the instance; it does not
add multi-user ownership, roles, permissions, workspace sharing, or per-user
vault data. The existing Markdown vault, SQLite metadata, AI settings and
credentials, History, Git state, and Draft Store remain instance-scoped.

## Trust Boundaries

- The browser is an untrusted client. Vue route guards and client auth state are navigation aids, not an authorization boundary.
- The Hono `/api/*` middleware is the server authorization boundary and runs before protected route handlers.
- The server is trusted with the configured vault, SQLite database, and provider calls; host users who can read process memory, the data directory, logs, or the browser profile are outside this model.
- Reverse proxies terminate transport TLS, but Nuvyn uses an explicit browser-facing `NUVYN_PUBLIC_ORIGIN` and does not trust arbitrary forwarded headers for security decisions.

## API Boundary and Health Identity Split

Only this exact method/path allowlist is public:

- `GET /api/health` — liveness only, `{ "ok": true }`.
- `GET /api/auth/status` — auth hydration.
- `POST /api/auth/setup` — first-owner bootstrap, protected by a setup token.
- `POST /api/auth/login` — credential verification and session creation.
- `POST /api/auth/logout` — idempotent session revoke/cleanup.

Every other `/api/*` endpoint is protected by default, including Vault, file,
folder, metadata, link, AI, History, recovery, and `GET /api/vault/identity`.
Unknown future `/api/*` paths fail closed for anonymous requests. A missing,
expired, revoked, or disabled-owner session receives JSON `401` with the
top-level code `auth-session-required`; the sensitive handler does not run.

Public health intentionally does not disclose the stable `vaultId`. The
authenticated `/api/vault/identity` endpoint supplies that instance identity
to the frontend after auth hydration and before VaultView, tab persistence, or
Draft Store recovery mounts.

## Bootstrap and Account Boundary

First-run `/setup` is owner bootstrap, not public registration. The operator
must supply `NUVYN_SETUP_TOKEN`; if it is absent, Nuvyn generates a random
process-local fallback and prints it once to the private server log. Explicit
tokens must contain at least 32 UTF-8 bytes. The fallback is not stored in
SQLite, `.env`, Git, or a normal response, is not the owner password, and is
cleared after the owner transaction commits. Setup closes permanently after the
first owner exists.

The production input rules are:

- Username: 3–32 ASCII characters, canonicalized to lowercase, from `[a-z0-9._-]`, with alphanumeric boundaries.
- Password: 12–256 Unicode code points, with no mandatory composition classes.

There is no browser password-reset flow in v1. Operator recovery must use the
documented supported operational controls; it must not rely on hand-editing
authentication rows.

## Sessions and Cookies

The server generates a fresh cryptographically random 32-byte opaque session
token after successful setup or login. The raw token is sent only in a cookie;
SQLite stores only its SHA-256 hash in `auth_sessions`. Sessions have a fixed
7-day absolute expiry. Logout revokes the current session, and expired,
revoked, or disabled-owner sessions do not authorize requests. The optional
`NUVYN_AUTH_REVOKE_SESSIONS_ON_START=1` startup control revokes existing rows
before requests are accepted; normal restarts leave valid sessions alone.

The cookie profile is selected only from the resolved `NUVYN_PUBLIC_ORIGIN`:

| Origin | Cookie contract |
| --- | --- |
| HTTPS | `__Host-nuvyn_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain` |
| Loopback HTTP | `nuvyn_session`, `HttpOnly`, `SameSite=Lax`, `Path=/` |

The middleware reads only the selected cookie name; the alternate secure/local
name is never an authentication fallback. The browser does not store an auth
token in `localStorage`.

## Public Origin and Deployment Policy

`NUVYN_PUBLIC_ORIGIN` is the browser-facing security origin, not `HOST`, a
Docker bind address, or a forwarded request header. `http://0.0.0.0:3000` is a
listener address and must not be presented as the public origin. Plain HTTP is
accepted only for `localhost`, `127.0.0.1`, and `[::1]`; non-loopback browser
access should use an HTTPS reverse proxy with an explicit `https://` origin.

Docker may listen on `0.0.0.0` inside the container while Compose publishes a
loopback host port. A proxy must forward the SPA and `/api/*` to the same Nuvyn
listener, preserve the browser `Origin`, and avoid caching authenticated JSON.

## Same-Origin and CSRF Protections

Nuvyn uses layered same-origin protections for authenticated mutations:

- `SameSite=Lax` limits cross-site cookie delivery.
- Unsafe `POST`, `PUT`, `PATCH`, and `DELETE` requests reject a present `Origin` that does not exactly match the resolved `NUVYN_PUBLIC_ORIGIN`.
- Known `Sec-Fetch-Site: cross-site` mutations are rejected.
- Body-bearing JSON mutations require `Content-Type: application/json`; existing bodyless `DELETE` calls remain compatible.
- The same appropriate policy applies to setup, login, and logout mutations. CORS is not the authentication boundary.

Missing browser metadata remains compatible with server-to-server callers, but
protected calls still require a valid session.

## Password Hashing, KDF, and Throttling

Password hashes use the versioned `scrypt$v1` format with `N=32768`, `r=8`,
`p=1`, a 16-byte random salt, a 32-byte derived key, and a 64 MiB maximum
memory setting. Malformed or unsupported stored hashes fail safely as invalid
credentials rather than becoming server errors.

Setup, known-user login, and unknown-user dummy verification share a process-wide
KDF guard. The current guard allows 3 concurrent jobs, 24 queued jobs, and a
5-second queue wait. Login rejects non-string or out-of-bounds password input
before scheduling expensive scrypt. Malformed request shapes use request
validation, while abnormally sized string passwords keep the generic credential
failure contract and never reach the KDF. Unknown users with valid-length
candidates use dummy verification to reduce timing-based account enumeration.
These are mitigations and bounds, not claims of perfect constant time or
immunity to brute force.

Login failure throttling is bounded, failure-based, and in-memory. It is not a
distributed global limiter or a permanent account lockout; process restart
clears the limiter, and a valid credential is not rejected solely because a
failure bucket is hot.

## Request Size and Response Caching

Credential payloads are intentionally bounded independently of document APIs:
`POST /api/auth/setup` and `POST /api/auth/login` each have a 16 KiB request
body limit. Oversized bodies fail fast with `413` and code
`auth-request-too-large`, before JSON parsing and expensive authentication work.
This limit does not constrain Markdown bodies submitted through `/api/posts`.

Authentication responses and protected API responses set
`Cache-Control: no-store`, including success and error JSON. The public health
probe is a liveness endpoint and has its own minimal response contract.

## Frontend Session Classification and Recovery

The frontend treats a response as Nuvyn session expiry only when it is `401`
and its top-level code is exactly `auth-session-required`. A provider `401`,
such as `ai-authentication-failed`, remains a provider/domain error and does
not trigger Nuvyn logout.

Active Logout coordinates the existing workspace save barrier, performs a legal
final server save when possible, flushes browser recovery storage, revokes the
session, and navigates to Login. Expiry or external revocation never attempts
another authenticated server save; it flushes and preserves the Draft Store,
redirects to Login with a validated internal route, and lets normal recovery
discovery run after re-login. Authentication transitions never silently clear
primary or conflict draft records.

## Secret and Content Handling

Passwords, raw session tokens, token hashes, explicit/submitted setup tokens,
AI credentials, master keys, and full credential request bodies must not be
logged or exposed in responses. The generated fallback setup token is the one
intentional private bootstrap log output and is printed once only. Logs,
SQLite, the vault, and backups are sensitive operational assets.

User Markdown is parsed with raw HTML support, then sanitized with a restrictive
DOMPurify allowlist. Script-capable elements, event handlers, and inline styles
are removed. Mermaid runs with `securityLevel: 'strict'`. Sanitization reduces
document-content risk; it does not replace authentication or deployment access
control.

Server routes validate vault-relative paths, archive rules, and the Diary date
identity contract. Writes use compare bases, locks, atomic replacement, and
durable recovery. These mechanisms protect integrity; they do not stop an
authorized host user from editing files directly.
