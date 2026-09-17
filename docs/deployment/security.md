# Deployment Security

## Authentication Boundary

Nuvyn Authentication v1 is a single-owner access boundary for one Nuvyn
instance. It provides first-run owner setup, login, logout, and protected
application APIs through server-side sessions. It does not provide public
registration, multi-user accounts, team/collaboration accounts, RBAC, roles,
permissions, workspace sharing, or per-user vault ownership.

The exact public API allowlist is:

- `GET /api/health` — anonymous liveness only, returning `{ "ok": true }`.
- `GET /api/auth/status` — anonymous auth hydration.
- `POST /api/auth/setup` — anonymous transport endpoint, but bootstrap-token protected and usable only before the first owner.
- `POST /api/auth/login` — anonymous credential endpoint.
- `POST /api/auth/logout` — anonymous and idempotent so stale cookies can be cleared.

Every other `/api/*` route, including Vault, files, folders, metadata, links,
AI, History, recovery, and `GET /api/vault/identity`, requires the owner session.
Unknown `/api/*` paths are protected by default. Anonymous callers receive a
JSON `401` with `code: "auth-session-required"` before a sensitive handler runs;
there is no HTML login redirect at the API boundary.

## Default Network Exposure and Public Origin

Bare-metal production listens on `127.0.0.1` unless `HOST` is set. Docker
listens on `0.0.0.0` inside the container, but Compose publishes the port at
`127.0.0.1:3000` by default. `NUVYN_PUBLIC_ORIGIN` is the browser-facing
security authority; it is not derived from `HOST`, Docker's internal bind
address, or arbitrary forwarded headers.

Plain HTTP is valid only for `localhost`, `127.0.0.1`, and `[::1]`. A
non-loopback deployment should use an HTTPS reverse proxy, explicit
`NUVYN_PUBLIC_ORIGIN=https://...`, and suitable firewall rules. Do not treat
`http://0.0.0.0:3000` or `NUVYN_BIND_ADDRESS=0.0.0.0` as a public origin. The
container listener and the browser-facing origin are separate concepts.

## Bootstrap Secret and Account Rules

On first run, the operator supplies `NUVYN_SETUP_TOKEN` or the random fallback
printed once to the private server log. Explicit setup tokens must contain at
least 32 UTF-8 bytes. A fallback token is process-local, is not persisted in
SQLite or `.env`, is not an owner password, and is cleared after the owner
transaction commits. Explicit values and submitted credentials must never be
logged or committed.

Owner usernames are 3–32 ASCII characters, canonicalized to lowercase, from
`[a-z0-9._-]` with alphanumeric boundaries. Passwords are 12–256 Unicode code
points, without a composition requirement. There is no browser password-reset
or public registration flow in v1.

## Sessions and Cookies

Sessions are opaque, cryptographically random 32-byte tokens sent only in an
`HttpOnly` cookie. SQLite stores only the SHA-256 token hash in `auth_sessions`,
not the raw token. The server checks the owner, disabled state, revocation, and
fixed absolute expiry before protected access. The default lifetime is 30 days;
`last_seen_at` is observability metadata and does not extend that expiry.

The profile is selected only from the resolved `NUVYN_PUBLIC_ORIGIN`:

| Browser origin | Cookie contract |
| --- | --- |
| HTTPS | `__Host-nuvyn_session`; `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain` |
| Loopback HTTP | `nuvyn_session`; `HttpOnly`, `SameSite=Lax`, `Path=/` |

The middleware accepts only the selected cookie name; the alternate name is
never an authentication fallback. Logout revokes the current server session
and clears both cookie names. `NUVYN_AUTH_REVOKE_SESSIONS_ON_START=1` is an
explicit operator control that revokes existing rows before startup requests;
normal restarts leave still-valid sessions alone.

## Same-Origin and CSRF Protections

Nuvyn uses layered same-origin protections for authenticated mutations:

- `SameSite=Lax` limits cross-site cookie delivery.
- `POST`, `PUT`, `PATCH`, and `DELETE` reject a present `Origin` that does not exactly match the resolved `NUVYN_PUBLIC_ORIGIN` and reject known `Sec-Fetch-Site: cross-site` requests.
- Body-bearing mutation endpoints require `Content-Type: application/json`; bodyless `DELETE` remains supported.
- The same policy applies to setup, login, and logout mutations where applicable. CORS is not opened as an authentication mechanism.

Missing browser metadata is allowed for compatible server-to-server callers,
but protected callers still need a valid selected session cookie.

## Password Hashing and KDF Protection

Passwords use a versioned encoded scrypt hash (`scrypt$v1`) with the current
parameters `N=32768`, `r=8`, `p=1`, a 16-byte random salt, a 32-byte derived key,
and a 64 MiB maximum memory setting. Malformed or unsupported stored hashes fail
as authentication failures rather than crashing the request.

Setup, known-owner verification, and unknown-owner dummy verification share a
process-wide KDF guard: at most 3 KDF jobs run concurrently, at most 24 wait in
the queue, and queued work waits at most 5 seconds. Excess work receives a safe
authentication failure/temporary-busy response. Login checks password type and
12–256 code-point bounds before scheduling scrypt; abnormal-length input uses
the generic credential failure contract and never enters the expensive KDF.

Unknown usernames use a dummy scrypt verification for valid-length candidates;
wrong passwords, unknown usernames, disabled owners, and invalid username
strings use the same public credential failure message. Malformed request shapes
such as non-string fields use request validation before authentication work.
These controls reduce enumeration and timing signals; they are not a claim of
perfect constant-time behavior or immunity to brute force.

Login failure throttling is bounded, failure-based, and in-memory. It is not a
distributed global rate limiter or a permanent account lockout; a successful
credential can clear the username bucket. Process restart clears the limiter.

## Authentication Request and Response Handling

`POST /api/auth/setup` and `POST /api/auth/login` have an independent 16 KiB
request-body limit. Oversized credential payloads are rejected before JSON
parsing and expensive authentication work with HTTP `413`, code
`auth-request-too-large`. This small limit does not apply to Markdown document
APIs such as `/api/posts`.

Authentication responses and protected API responses set
`Cache-Control: no-store`, including successful responses and JSON errors. Do
not cache them in a browser or reverse proxy.

## Security Logging

Do not log passwords, password hashes, raw session tokens, token hashes,
explicit or submitted setup tokens, cookies, AI API keys, or the master key.
The generated fallback setup secret is the one intentional exception: it is
printed once for the private operator bootstrap path and never repeated. Treat
server logs and the data volume as sensitive operational assets.

## Container Hardening

The supplied Compose service runs as UID/GID 1000, sets `no-new-privileges`, makes the image root filesystem read-only, and uses a tmpfs for `/tmp`. The vault bind mount and data volume remain writable because Nuvyn cannot function without them. These controls reduce container privileges; they do not replace session, same-origin, or HTTPS deployment controls.

## Markdown Rendering

Document Markdown enables semantic raw HTML, then sanitizes the complete rendered result with DOMPurify before `v-html` insertion. The allowlist excludes scripts, styles, event handlers, forms, iframes, objects, embedded content, SVG, and unsafe URL schemes. Inline `style` and unrecognized `data-*` attributes are removed.

Mermaid uses `securityLevel: 'strict'`. Mermaid and Markmap source is URL-encoded into a sanitized placeholder and decoded only by the controlled mount component. AI chat Markdown disables raw HTML.

Sanitization is a browser rendering boundary, not a promise that arbitrary Markdown is harmless in every external application. Review untrusted vault files before opening them in other renderers with different HTML rules.

## AI Secret Storage

- API keys are accepted through Settings and encrypted with AES-256-GCM before storage in SQLite.
- A fresh 12-byte IV is generated for each credential write; the authentication tag detects tampering.
- The master key comes from `NUVYN_MASTER_KEY` / `NUVYN_MASTER_KEY_FILE`, or `data/.nuvyn-master-key`, and is never stored in SQLite.
- The browser receives only a masked credential state, not the plaintext key.
- Custom provider base URLs must use HTTP or HTTPS. Prefer HTTPS and a trusted endpoint; a malicious endpoint receives the configured API key and prompt data.

Encryption at rest does not defend against an attacker who can run code as the Nuvyn process or use an exposed, unauthenticated Nuvyn instance.

## Filesystem and AI Tool Boundaries

Logical vault paths are validated and security-sensitive reads reject symbolic-link traversal. Save and lifecycle operations use ownership checks, create-only publication, compare-and-swap behavior, and durable journals to avoid overwriting external writers.

AI file tools use the same server boundaries. Live-workspace mutation policy rejects unsafe edits to dirty, read-only, externally conflicted, stale, or identity-mismatched content. Tool calls still execute automatically once selected by the model; audit their results in the UI and History.

## Backup Confidentiality

Vault files, Git history, SQLite, chat history, and recovery copies may all contain sensitive information. Encrypt backups and restrict access. If the auto-managed master-key file is backed up with the data volume, anyone who obtains both that backup and the database can decrypt stored AI credentials.
