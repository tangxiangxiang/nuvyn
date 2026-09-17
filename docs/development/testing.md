# Testing

Nuvyn uses Vitest for client and server tests and Playwright for browser workflows. Authentication v1 is tested through the same real owner/session boundary used by the application; there is no test-only authentication bypass.

## Local verification

```bash
npm run typecheck
npm run build
npm test
```

For UI work, also run the relevant browser suite:

```bash
npm run test:e2e
npm run test:e2e:draft-store
npm run test:e2e:auth
npm run test:deployment-auth
```

Playwright starts isolated test servers according to the selected config. The general suite uses port 4174, the draft-store suite uses 4175, and the dedicated authentication browser suite uses its own isolated database/vault configuration.

## Vitest lanes

`npm test` runs the three application test lanes in sequence:

1. `npm run test:unit`
2. `npm run test:history-integration`
3. `npm run test:recovery-integration`

The lanes keep ordinary fast tests on the normal short Vitest failure boundary
while giving real filesystem and process integration their own scheduling and
timeout boundaries. The unit lane contains the usual client/server behavior
tests and excludes the heavy History and Crash Recovery suites.

### Unit lane

`test:unit` is the fast feedback lane for ordinary JavaScript/TypeScript,
server-route, storage, and component tests. It keeps the default unit-test
timeout and does not include the real-Git or crash-recovery stress suites.

### History integration lane

`test:history-integration` runs tests that create real Git repositories and
exercise Git plus filesystem behavior. It has a lane-specific timeout boundary.
On Windows, files are run serially with a constrained worker so concurrent
`git.exe` processes and temporary repositories do not create avoidable timing
or file-handle contention. This does not widen the global unit-test timeout.

### Recovery integration lane

`test:recovery-integration` covers real filesystem operations, SQLite state,
process/fault boundaries, and crash-recovery behavior. It includes the
crash-recovery state-machine/stress coverage. Windows runs this lane with
serialized file execution for filesystem stability; the state-machine tests
have a larger timeout within this lane because they intentionally exercise many
recovery seeds. The larger boundary is local to Recovery integration and does
not change ordinary unit-test timing.

### Platform compatibility smoke

`test:platform-smoke` is the short cross-platform lane. It imports the server
runtime/configuration, exercises safe path and symlink handling, applies the
SQLite migrations, verifies basic API route mounting, covers the create-only
file/directory move protocol, and pins the cross-platform slice of the atomic
text-write contract (atomic replace / create / rollback, conflict, missing
target, managed Diary rejection). The lane reuses existing tests rather than
duplicating a reduced copy of the application suite. The full POSIX-mode and
file-symlink race coverage stays in the Linux unit suite where the platform
behavior is exercised; Windows and macOS get the slice that is safe across all
three runners. CI runs this lane on Ubuntu with Node.js 22, Windows with
Node.js 24, and macOS with Node.js 24.

OpenAI-compatible protocol tests use a local fake HTTP server and, where
practical, the real provider SDK path. They never access the public internet.
This real-wire coverage verifies request paths, authorization headers, request
bodies, streaming, Settings connection probes, tool compatibility, and the
`max_tokens`/`max_completion_tokens` compatibility behavior.

### Authentication server tests

Authentication tests live with the server/client tests under `server/__tests__/`,
`src/lib/__tests__/`, and the auth view/coordinator suites. They cover the real
owner setup, login/logout/status routes, session expiry/revocation, selected
cookie profiles, Origin/Fetch-Metadata and JSON-body policy, KDF bounds/queue,
rate limiting, generic credential failures, the 16 KiB setup/login body limit,
the liveness/identity split, and default-protected unknown `/api/*` paths.

`npm test` runs the unit lane containing these authentication tests, then the
real History and Recovery integration lanes. The authentication tests use
isolated in-memory or temporary SQLite databases and local/fake providers; they
do not access the public internet.

### Real authenticated fixtures

Server route fixtures create a real `users` row, `auth_instance` singleton, and
`auth_sessions` row, then send the selected session cookie through the actual
Hono middleware. The Playwright fixture performs the real setup request against
an isolated server and passes its resulting cookie through `storageState`.
Tests do not use `NODE_ENV=test`, `skipAuth`, a localStorage token, a middleware
mock bypass, or an anonymous default owner. The HttpOnly cookie is not readable
by browser JavaScript; fixture tests also verify credentials do not appear in
browser storage.

## Test organization

- `src/**/__tests__/`: Vue components, composables, rendering, search, and browser-state units.
- `server/__tests__/` and `server/routes/*.test.ts`: APIs, authentication, storage, history, mutation policy, and transaction integration.
- `server/__tests__/fixtures/`: child processes used to terminate operations at controlled fault points.
- `e2e/`: end-to-end authentication, editor, AI context, draft, view-mode, and visual behavior.

Crash recovery tests intentionally exercise real process boundaries and should remain deterministic when repeated. Visual baselines are maintained on macOS; the cross-platform suite excludes platform-sensitive visual assertions.

## Icon policy

Run `npm run lint:icons` after changing UI icon usage. `npm run lint:icons:strict` is available when auditing the whole icon system. The current baseline has a documented brand-constellation classification finding; do not treat it as permission for new violations. See [Icon Usage](../design/icon-usage.md) and [Known lint debt](../design/icon-system.md#known-lint-debt).

## Packaged Docker Authentication Smoke

`npm run test:deployment-auth` runs `scripts/docker-auth-smoke.mjs` against the
packaged image. It is a focused deployment smoke, not the complete auth security
suite. The script verifies:

- container startup and anonymous minimal `/api/health`;
- setup-required status, `Cache-Control: no-store`, token-protected setup, and no credential in the setup response;
- loopback `nuvyn_session` cookie attributes and protected identity/tree access;
- anonymous identity failure and unknown-API fail-closed behavior;
- wrong-origin logout rejection;
- session survival across a restart without revocation;
- `NUVYN_AUTH_REVOKE_SESSIONS_ON_START=1` invalidation, followed by a real login; and
- absence of the setup token, password, and captured session cookies in container logs.

The CI Docker job also checks default/custom `NUVYN_PORT` (legacy `NUVYN_PORT`), loopback host
publication, container `0.0.0.0` listener wiring, and explicit HTTPS public
origin interpolation before running the packaged smoke.

## CI Lanes

The workflow runs static checks, unit tests, History integration, Recovery
integration, the Draft Store browser suite, and the `e2e-application`
application-level browser suite once on Ubuntu with Node.js 24. The application
browser suite is split into two Playwright shards; its config keeps
`workers: 1` because the tests share one server generation, Vault, and browser
persistence within a shard.

An independent compatibility matrix runs only `test:platform-smoke` on Ubuntu
Node.js 22, Windows Node.js 24, and macOS Node.js 24. Dedicated authentication,
macOS visual, tags-scale, and Docker smoke jobs remain separate. No critical
lane disables checks, widens global timeouts, or uses `continue-on-error`.

## Before opening a change

Use `npm ci` when validating lockfile reproducibility. Run the narrowest relevant tests during development, then the full typecheck, build, and unit/integration suite before handoff.
