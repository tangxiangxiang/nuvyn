# Ledger L0 — Foundation Implementation Plan

> [!IMPORTANT]
> **Historical Planning Baseline / Implemented and evolved.** 本文记录当时的实施计划与评审状态，不是当前运行时说明，也不代表仍待实施。当前行为请参阅 [Ledger 用户指南](../user-guide/ledger.md)、[Ledger Architecture](../architecture/ledger.md) 和 [Ledger UI Language](ledger-ui-language.md)。

## 1. Status / baseline

- **Implementation Plan status:** **Historical Planning Baseline / Implemented and evolved**
- **Plan date:** 2026-09-03
- **Implementation baseline / audited `main` HEAD:** `693dccf46638094cd54a369770f782d820df22f9`
- **Ledger v1 PRD:** `docs/design/ledger-v1-prd.md`
  - blob SHA: `56539463ee5a1dc946ac029232b3eaa7e728b861`
  - status: **Product Review: Accepted**
- **Ledger L0 Foundation PRD:** `docs/design/ledger-l0-foundation-prd.md`
  - blob SHA: `83a95afd2e08e4cf2bb8fa42ae5a906cd1049165`
  - status: **Architecture Review: Accepted**
- **Latest SQLite migration at baseline:** `0012_diary_migration_ledger.sql`
- **Ledger Foundation migration reserved by this plan:** `0013_ledger_foundation.sql`
- **Runtime/CI Node support matrix at baseline:** Node 22 and Node 24; Ubuntu, macOS, and Windows are authoritative CI platforms.
- **Primary existing verification commands:** `npm run typecheck`, `npm run build`, `npm test`, `npm run test:tags-scale`, `npm run test:e2e`, `npm run test:e2e:draft-store`, `npm run test:e2e:auth`, `npm run test:deployment-auth`.
- **Repository cleanliness:** remote `main` was confirmed to point exactly at the audited HEAD before this planning round. A local working-tree status cannot be proven through the GitHub repository API and is therefore not claimed as clean.

This document is an implementation plan only. It does **not** authorize production implementation and does not change any Accepted Ledger financial or lifecycle semantics.

### 1.1 Decision closure

The Accepted Product PRD already freezes the v1 default Category catalog. This
plan carries that catalog into the runtime seed constant in §20.3; it must not
be inferred from `billsMockData`, screenshots, translations, or developer
preference. IDs remain server-generated opaque IDs and are not product
semantics.

No unresolved P0/P1 implementation decision remains in this plan. The status
is **Implementation Plan: Accepted / Ready for Implementation**. L0.1 may begin
implementation against the frozen contracts below; this document itself still
contains no production implementation.

### 1.2 Plan Review remediation

This revision closes the four findings from the Plan Review of `cad870d`:

- timezone validation has a named-IANA guard before Temporal calculation;
- Account PATCH has an explicit state/history whitelist that preserves the
  archived zero-balance invariant;
- Category PATCH has an explicit state/history/kind matrix and archived
  restore-before-edit rule;
- checked-in ISO metadata has a post-release compatibility policy that blocks
  silent exponent reinterpretation or removal of a used currency code.

---

## 2. Accepted source-of-truth documents

Implementation must follow, in order:

1. `docs/design/ledger-v1-prd.md` — product/domain source of truth.
2. `docs/design/ledger-l0-foundation-prd.md` — L0 architecture/schema/API/lifecycle/test contract.
3. This Implementation Plan — repository landing, mechanisms, file layout, sequencing, and evidence.

If code reality makes an Accepted contract impossible, implementation stops and records `PRD conflict / architecture blocker`; it must not substitute new financial semantics in code or in an implementation commit.

The old `554091b...` and `fbab19b...` review baselines remain historical review references inside the PRDs only. They are **not** the implementation baseline. The implementation audit baseline is `693dccf...`.

---

## 3. Repository audit

### 3.1 Database and migrations

`server/db.ts` currently:

- opens the single Nuvyn SQLite database (`data/nuvyn.db`, with test injection support);
- enables WAL and `foreign_keys=ON`;
- discovers numbered SQL migrations under `server/migrations/`;
- applies each migration in a `better-sqlite3` transaction and advances `schema_version` atomically;
- exposes test DB injection/reset seams.

The migration sequence currently ends at `0012_diary_migration_ledger.sql`, so L0 is assigned `0013_ledger_foundation.sql`. Published migrations are append-only and are not edited.

### 3.2 Server composition and auth

`server/index.ts` is the Hono composition root. `authBoundary` is applied to `/api/*` before feature routes are registered. Protected responses already receive `Cache-Control: no-store`, and unsafe requests inherit the current owner-session/CSRF/content-type boundary.

Ledger therefore registers under the existing composition root and does **not** create a second login, finance password, Ledger token, session table, or auth middleware.

### 3.3 Existing route/service/error patterns

Existing server code uses route modules that delegate to domain/service code rather than placing all logic in `server/index.ts`. `server/tagManagement.ts` also provides useful local precedent for:

- exact-key request validation;
- `Number.isSafeInteger` guards;
- SHA-256 fingerprints via `node:crypto`;
- explicit domain error classes;
- narrow test-only failure hooks;
- deterministic fingerprint inputs.

Ledger follows those repository conventions while keeping its own canonical Ledger domain boundary.

### 3.4 `better-sqlite3` transaction semantics

Baseline dependency: `better-sqlite3@12.11.1`.

That version supports `db.transaction(fn).immediate(...)`, which executes `BEGIN IMMEDIATE`. The library also documents that manually managed `BEGIN`/`COMMIT` should not be mixed with its transaction wrapper. Therefore Ledger gets exactly one write-transaction helper based on `.immediate()`; routes and repositories must not independently start transactions.

The `Database` constructor's current lock wait default is 5000 ms. L0 will make that value explicit rather than depend on an implicit library default.

### 3.5 Validation, shared types, and TypeScript

Both server and app TypeScript projects include `shared/**/*.ts`, and Nuvyn already keeps shared protocol contracts in `shared/`. Ledger will therefore place only transport-safe/shared pure contracts there; persistence and domain authority stay under `server/ledger/`.

No cross-project refactor is part of L0.

### 3.6 Test architecture

Vitest defaults to Node for server tests, while client tests have jsdom overrides. `server/__tests__/db.test.ts` already proves migration behavior using an in-memory database, and `server/__tests__/helpers/auth.ts` provides owner-auth test utilities.

Concurrency/persistence tests need a new temporary **file-backed** Ledger DB helper because two independent SQLite connections cannot test locking or reopen semantics with a single in-memory connection.

### 3.7 UI compatibility surfaces that remain untouched

The current Ledger-facing prototype is still Bills-named and mock-backed:

- `src/features/bills/**`
- `src/components/bills/**`
- `src/views/BillsView.vue`
- `src/views/BillsTransactionsView.vue`
- `/bills` and `/bills/transactions` in `src/router/index.ts`
- `e2e/ledger-workspace.spec.ts`

`BillsView.vue` and `BillsTransactionsView.vue` still read `billsMockData`. This is intentional during L0. The new server foundation uses canonical `Ledger*` / `ledger_*` naming while the legacy prototype stays unchanged until a later UI migration.

---

## 4. Scope

L0 implementation includes:

1. SQLite Ledger schema.
2. Ledger domain and API types.
3. Request/domain validation.
4. money/currency utilities.
5. timezone/period utilities.
6. natural-balance / transaction-effect authority.
7. Ledger repositories/persistence.
8. Ledger service/domain orchestration.
9. persistent idempotency response replay.
10. owner-authenticated `/api/ledger` routes.
11. live Overview/read projections.
12. expected-version and write-concurrency handling.
13. migration/schema/domain/API tests.
14. focused integration, persistence, auth, and two-connection tests.
15. full regression verification.

## 5. Non-goals

L0 does **not** include:

- Ledger UI or Accounts/Categories pages;
- Transaction Sheet;
- Dashboard cutover to real data;
- Bills → Ledger component/file rename;
- `/bills` → `/ledger` UI route migration;
- CSV import/export;
- AI finance features;
- budgets;
- bank sync;
- balance/materialized-summary caches;
- mock-data migration or fallback;
- CI workflow redesign.

---

## 6. Architecture and dependency graph

Canonical authority flow:

```text
Hono /api/ledger routes
        ↓
request parsing + canonical DTOs
        ↓
Ledger service/domain authority
        ↓
BEGIN IMMEDIATE write helper (mutations)
        ↓
repository / SQLite
```

Read projections follow:

```text
route → projection service → repository rows → shared balance engine → response DTO
```

Implementation dependency graph:

```text
0013 migration
      ↓
shared protocol / normalization / currency metadata
      ↓
domain validation + time + checked money arithmetic
      ↓
natural-balance engine
      ↓
repository
      ↓
BEGIN IMMEDIATE write infrastructure
      ↓
persistent idempotency replay
      ↓
service/domain mutations
      ↓
API routes
      ↓
live projections / cursor / search
      ↓
integration + concurrency + reopen + regression evidence
```

Constraints:

- Overview cannot introduce a second balance algorithm.
- Adjustment cannot be implemented before the `BEGIN IMMEDIATE` helper exists.
- HTTP routes do not contain scattered SQL.
- repositories do not decide financial semantics.
- the frontend never becomes the authority for balance, normalized Category identity, or retry semantics.

---

## 7. File-by-file map

### 7.1 Existing files to modify during the future L0 implementation

| File | Reason / responsibility |
| --- | --- |
| `package.json` | Add exact server-side timezone dependency `@js-temporal/polyfill@0.5.1`; no other Ledger dependency is planned. |
| `package-lock.json` | Lock the Temporal dependency deterministically. |
| `server/db.ts` | Make SQLite 5000 ms lock timeout explicit and expose/reuse the connection setting needed by Ledger file-backed tests; retain existing WAL, FK, migration, and injection behavior. |
| `server/index.ts` | Register the Ledger router at `/api/ledger` after the existing `/api/*` owner auth boundary. |
| `docs/architecture/storage.md` | After L0 is implemented, document `ledger_*` as SQLite-owned financial data and projection authority. |
| `docs/deployment/backup-and-restore.md` | After implementation, state that Ledger lives in `data/nuvyn.db` and must be backed up consistently with WAL/SHM and the vault procedure. |

No production file above is modified in this planning round.

### 7.2 New production files to create during future implementation

```text
server/migrations/
  0013_ledger_foundation.sql

shared/
  ledgerProtocol.ts
  ledgerNormalization.ts
  ledgerCurrency.ts

server/ledger/
  domain.ts
  errors.ts
  money.ts
  time.ts
  validation.ts
  balance.ts
  repository.ts
  writeTransaction.ts
  idempotency.ts
  defaultCategories.ts
  service.ts
  projections.ts
  routes/
    index.ts
    settings.ts
    accounts.ts
    categories.ts
    transactions.ts
    projections.ts
```

Responsibilities:

- `shared/ledgerProtocol.ts` — API DTOs, discriminated transaction wire types, query/cursor response contracts; no persistence logic.
- `shared/ledgerNormalization.ts` — exact Category identity helper: `trim()` then locale-independent `toLowerCase()`.
- `shared/ledgerCurrency.ts` — checked-in, versioned ISO 4217 alphabetic-code → numeric minor-unit exponent metadata plus pure decimal/minor formatting/parsing helpers. It is shared so a later UI cannot create a conflicting exponent table; L0 client code does not import it.
- `domain.ts` — type-safe Ledger entities and discriminated transaction forms; DB nullable row shapes never leak as the primary domain model.
- `errors.ts` — centralized `LedgerError` and safe HTTP mapping metadata.
- `money.ts` — server financial integer validation and checked add/subtract/sum.
- `time.ts` — IANA validation, UTC-ms validation, local-date/opening boundary, period ranges, DST-safe calendar arithmetic, injectable clock.
- `validation.ts` — exact request-key parsers, expectedVersion parser, per-type mutation/patch validators, cross-field validation helpers.
- `balance.ts` — single transaction-effect and current-balance authority.
- `repository.ts` — prepared SQL/read/write methods; no HTTP and no independent transaction starts.
- `writeTransaction.ts` — the only Ledger `BEGIN IMMEDIATE` wrapper and `SQLITE_BUSY` translation boundary.
- `idempotency.ts` — operation scopes, stable canonical serialization, SHA-256 fingerprint, response snapshot persistence/replay.
- `defaultCategories.ts` — the exact ordered `DEFAULT_LEDGER_CATEGORIES_V1` constant from the Accepted Product PRD and its idempotent seed function; it must never auto-unarchive an archived identity.
- `service.ts` — lifecycle, expectedVersion, cross-row validation, mutation orchestration.
- `projections.ts` — Account projections, Overview, period/trend/recent, movement summary, cursor/search query composition.
- `routes/*` — thin Hono route modules grouped by API area; shared error/response helpers are reused rather than copied.

### 7.3 New test files

```text
server/ledger/
  money.test.ts
  time.test.ts
  validation.test.ts
  balance.test.ts
  idempotency.test.ts
  service.test.ts
  projections.test.ts

server/__tests__/
  ledger-migration.test.ts
  ledger-api.test.ts
  ledger-auth.test.ts
  ledger-concurrency.test.ts
  ledger-persistence.test.ts
  helpers/
    ledgerDb.ts
```

`helpers/ledgerDb.ts` creates temporary file databases, applies migrations, opens two independent `Database` connections with foreign keys/WAL/timeout configured, closes every handle before cleanup, and never assumes Unix unlink semantics.

### 7.4 Files explicitly not modified by L0

```text
src/features/bills/**
src/components/bills/**
src/views/BillsView.vue
src/views/BillsTransactionsView.vue
src/router/index.ts
e2e/ledger-workspace.spec.ts
.github/workflows/**
```

The existing Bills mock data and `/bills` UI remain characterization/prototype surfaces. `e2e/ledger-workspace.spec.ts` is run as regression evidence, not rewritten to pretend the real Ledger UI exists.

---

## 8. SQLite migration plan — `0013_ledger_foundation.sql`

Migration scope is **schema only**. It must not insert owner-selected timezone/currency, migrate `billsMockData`, create demo transactions, or run startup-time category replacement.

### 8.1 `ledger_settings`

Planned invariants:

- `singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1)`.
- `base_currency TEXT NOT NULL`.
- `timezone TEXT NOT NULL`.
- `has_created_account INTEGER NOT NULL DEFAULT 0 CHECK (has_created_account IN (0, 1))`.
- `version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1)`.
- `created_at INTEGER NOT NULL` and `updated_at INTEGER NOT NULL`, with integer-type CHECKs.
- migration inserts **no** settings row.

The first Account insert and `has_created_account: 0 → 1` update occur in the same Ledger write transaction. No code path ever writes `1 → 0`. Deleting a no-history Account does not unlock timezone/baseCurrency.

`has_created_account` is an internal monotonic lifecycle marker; setting it during Account creation does **not** independently bump `ledger_settings.version`. `version` advances on successful Settings commands. Lock checks run before Settings version comparison, so a post-Account timezone/baseCurrency PATCH receives the Accepted lock error rather than an incidental version error.

### 8.2 `ledger_accounts`

Accepted columns:

- `id TEXT PRIMARY KEY` — generated server-side with `crypto.randomUUID()`.
- `name TEXT NOT NULL`.
- `type TEXT NOT NULL CHECK (type IN ('cash','bank','wallet','credit_card','loan','other'))`.
- `nature TEXT NOT NULL CHECK (nature IN ('asset','liability'))`.
- `opening_balance_minor INTEGER NOT NULL` with integer-type CHECK.
- `opening_date TEXT NOT NULL`.
- `currency TEXT NOT NULL`.
- `note TEXT NOT NULL DEFAULT ''`.
- `archived_at INTEGER NULL` with null-or-integer CHECK.
- `version INTEGER NOT NULL DEFAULT 1` with integer/`>=1` CHECK.
- integer UTC-ms `created_at`, `updated_at`.

There is **no** Account-name UNIQUE constraint, current-balance column, opening UTC instant column, or Dashboard summary column.

Known type/nature combinations are service-level invariants:

- `cash`, `bank`, `wallet` → `asset`;
- `credit_card`, `loan` → `liability`;
- `other` → explicit owner-selected `asset|liability`.

### 8.3 `ledger_categories`

- `id TEXT PRIMARY KEY`, server-generated.
- `kind TEXT NOT NULL CHECK (kind IN ('income','expense'))`.
- `name TEXT NOT NULL`.
- `normalized_name TEXT NOT NULL`.
- `archived_at INTEGER NULL`.
- `version INTEGER NOT NULL DEFAULT 1`.
- integer UTC-ms `created_at`, `updated_at`.
- `UNIQUE(kind, normalized_name)`.

No `parent_id` exists. Archive does not modify `kind` or `normalized_name`, so identity remains reserved. Restore reuses the stable ID.

### 8.4 `ledger_transactions`

Accepted columns are created with FK `ON DELETE RESTRICT` to Account/Category tables and integer checks for all monetary/timestamp/version fields.

The migration contains row-shape CHECKs equivalent to the Accepted union:

- income/expense: one `account_id`, one `category_id`, no transfer IDs, positive `amount_minor`, adjustment fields null;
- transfer: `from_account_id` + `to_account_id`, distinct IDs, no `account_id`/category, positive amount, adjustment fields null;
- adjustment: one `account_id`, no transfer/category IDs, signed non-zero amount, integer calculated/target fields;
- adjustment requires `amount_minor = adjustment_target_balance_minor - adjustment_calculated_balance_minor`.

`payee` and `note` are `TEXT NOT NULL DEFAULT ''`. Transfer and Adjustment rows additionally require `payee = ''`, matching the discriminated domain model rather than silently persisting a meaningless field.

A Transfer is always one transaction row. The system never creates two physical rows for its two account effects.

### 8.5 `ledger_idempotency`

Planned schema:

- `operation_scope TEXT NOT NULL`.
- `idempotency_key TEXT NOT NULL`.
- `request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64)`.
- `response_status INTEGER NOT NULL`.
- `response_body_json TEXT NOT NULL`.
- `result_status TEXT NOT NULL CHECK (result_status IN ('committed','no-op'))`.
- `result_type TEXT NULL`.
- `result_id TEXT NULL`.
- `created_at INTEGER NOT NULL`.
- composite `PRIMARY KEY(operation_scope, idempotency_key)`.

There is deliberately no FK from `result_id` to mutable business rows. A later physical Account/Category delete cannot destroy replay history.

L0 has no TTL/retention delete. Replay records are retained indefinitely; future compaction requires a separate contract.

### 8.6 Direct-SQL defense in depth

Migration tests bypass the service and attempt invalid SQL rows. SQLite must reject malformed type shapes, same-account Transfer, Transfer with Category, inconsistent Adjustment delta, invalid FKs, and Account/Category deletion while any active or soft-deleted transaction row still references them.

---

## 9. Index and query plan

Indexes are chosen from actual L0 query patterns:

```text
idx_ledger_accounts_archived_updated
  ON ledger_accounts(archived_at, updated_at DESC, id DESC)

idx_ledger_categories_kind_archived_name
  ON ledger_categories(kind, archived_at, normalized_name, id)

idx_ledger_transactions_active_order
  ON ledger_transactions(deleted_at, occurred_at DESC, created_at DESC, id DESC)

idx_ledger_transactions_account
  ON ledger_transactions(account_id, deleted_at, occurred_at DESC, created_at DESC, id DESC)

idx_ledger_transactions_from_account
  ON ledger_transactions(from_account_id, deleted_at, occurred_at DESC, created_at DESC, id DESC)

idx_ledger_transactions_to_account
  ON ledger_transactions(to_account_id, deleted_at, occurred_at DESC, created_at DESC, id DESC)

idx_ledger_transactions_category
  ON ledger_transactions(category_id, deleted_at, occurred_at DESC, created_at DESC, id DESC)
```

The idempotency composite primary key provides its lookup index.

These indexes serve Account history/detail filters, Category history, active/recent order, and period queries. No `ledger_monthly_summary`, `ledger_account_balance_cache`, or equivalent source-of-truth-ish table is created.

---

## 10. Money and currency implementation

### 10.1 Authoritative exponent source

No current Nuvyn dependency provides an appropriate ISO 4217 minor-unit table. L0 will **not** add a currency package.

`shared/ledgerCurrency.ts` will contain a checked-in, deterministic metadata snapshot generated/reviewed from **SIX, the ISO 4217 Maintenance Agency's current List One**, including alphabetic code and official numeric minor-unit exponent. The file header records source, retrieval date/list revision, and update instructions.

Rules:

- runtime never fetches currency metadata from the network;
- no CNY/JPY/KWD `if` chain;
- active codes with a numeric official minor-unit value are supported;
- an ISO entry whose official minor unit is `N.A.` cannot satisfy the integer-minor-unit exponent contract and is rejected as unsupported rather than guessed;
- Settings responses derive `currencyExponent`;
- clients cannot submit `currencyExponent`;
- future ISO refresh is a reviewed metadata update, not a runtime dependency;
- after a Ledger release, a SIX snapshot update must not silently remove a
  currency code already used by a Ledger or change its exponent. Either change
  requires an explicit compatibility/migration review before the metadata can
  be merged; historical `amountMinor` values must never be reinterpreted by a
  routine metadata refresh.

The shared pure module can later be imported by UI without duplicating metadata; L0 does not wire the UI.

### 10.2 Exact integer authority

SQLite/API authority remains integer minor units. No authoritative path uses SQLite `REAL`, `parseFloat` for persistence, decimal JS numbers for balance, or implicit rounding.

`server/ledger/money.ts` exposes:

```text
assertSafeMinor(value)
assertPositiveMinor(value)
assertNonNegativeSafeInteger(value)
checkedAddMinor(a, b)
checkedSubMinor(a, b)
checkedSumMinor(values)
```

Every external minor-unit number must satisfy `Number.isSafeInteger`. Field rules then apply `> 0`, `>= 0`, signed non-zero, or signed-safe as required.

Every **result** of add/subtract is checked too. A projection cannot accept individually safe values and silently produce an unsafe aggregate.

Authoritative financial projections do not use SQLite `SUM(amount_minor)` as final money authority because a SQLite 64-bit integer may exceed JavaScript's safe range when converted. SQL filters/orders rows; TypeScript performs checked financial arithmetic.

### 10.3 Decimal conversion utilities

The shared currency module provides strict string-based decimal ↔ minor-unit conversion for contract tests and later UI reuse:

- too many fractional digits → validation error;
- no fixed exponent assumption;
- output must be a safe minor-unit integer;
- formatting reconstructs from integer/exponent without floating point.

Representative tests include CNY/USD exponent 2, JPY exponent 0, KWD exponent 3, and an exponent-4 current entry if present in the checked ISO list.

---

## 11. Time and period implementation

### 11.1 Dependency decision

The current dependency tree has no Temporal, Luxon, or date-fns-tz capability. L0 will add exactly:

```text
@js-temporal/polyfill@0.5.1
```

Rationale:

- DST-safe local calendar boundaries are required;
- hand-written offset math is unacceptable;
- the package has TypeScript declarations, supports Node versions below Nuvyn's Node 22/24 floor, and has a small dependency surface;
- it is imported **server-side only** in L0, so the current Bills browser bundle does not pay for it;
- one focused timezone/calendar dependency is safer than maintaining DST logic in Nuvyn.

### 11.2 Validation and boundaries

`server/ledger/time.ts` uses Temporal:

- UTC ms: `Number.isSafeInteger` + `Temporal.Instant.fromEpochMilliseconds`;
- timezone: `assertIanaTimeZoneId(candidateZone)` first requires a string with
  no surrounding whitespace and applies this named-zone grammar before any
  Temporal parsing:

  ```text
  /^[A-Za-z_][A-Za-z0-9_.+-]*(?:\/[A-Za-z0-9_.+-]+)*$/
  ```

  It therefore accepts named single-component and slash-separated candidates
  (`UTC`, `CET`, `PST8PDT`, `Asia/Shanghai`, `America/Los_Angeles`) while
  rejecting offset-only values, ISO date-time expressions, and bracketed
  date-time/zone expressions rather than treating Temporal's broader accepted
  input grammar as an IANA validator;
- after the named-IANA guard, validate the identifier by converting a fixed
  Instant with `toZonedDateTimeISO(candidateZone)`; Temporal remains the
  authority for the actual zone/calendar/DST calculations;
- `openingDate`: exact `YYYY-MM-DD`, then `Temporal.PlainDate.from(..., { overflow:'reject' })`;
- opening boundary: local date start-of-day → Instant;
- today: local start-of-day → **next local day** start-of-day;
- week: local Monday start-of-day → next Monday;
- month: local first day → next local month first day;
- year: local Jan 1 → next local Jan 1;
- all ranges are `[start,end)`.

No code computes day end as `start + 86_400_000`.

### 11.3 Future-record tolerance

The implementation freezes:

```text
LEDGER_FUTURE_SKEW_MS = 60_000
```

A new/edited `occurredAt` is allowed only when `occurredAt <= nowMs + 60_000`. The clock is injected for deterministic tests.

Transfer `occurredAt` must satisfy both Account opening boundaries. Income/expense/adjustment must satisfy the referenced Account opening boundary.

Tests cover `America/Los_Angeles` spring-forward and fall-back plus `Asia/Shanghai`.

---

## 12. Domain model and conversion boundaries

`server/ledger/domain.ts` defines discriminated transaction forms:

```text
IncomeTransaction
ExpenseTransaction
TransferTransaction
AdjustmentTransaction
```

The shared API contract mirrors this with camelCase DTOs.

Two conversion boundaries exist:

1. **DB row → domain object**
   - verifies type discriminator and nullable-column shape;
   - validates safe integers before financial arithmetic;
   - fails closed on persisted invariant violations.
2. **request → canonical normalized mutation**
   - exact-key parsing;
   - type-specific defaults/normalization;
   - stateless field validation;
   - service-level lifecycle/cross-row checks later inside the write transaction.

`normalizedName`, IDs, current balances, adjustment calculated/delta fields, archived/deleted timestamps, and versions are never client-authoritative except explicit expected values.

### 12.1 Validation constants

L0 freezes deterministic implementation limits:

- Account/Category `name`: 1..120 UTF-16 code units after required trimming.
- `payee`: 0..200 UTF-16 code units.
- `note`: 0..2000 UTF-16 code units.
- `Idempotency-Key`: non-empty opaque header value, max 200 UTF-16 code units; not parsed as UUID and not normalized into a new identity.
- list `limit`: default 50, max 200.

Unknown request keys are rejected with `ledger-validation-failed`. Category create/patch rejects client `normalizedName`.

---

## 13. Natural-balance engine

`server/ledger/balance.ts` is the only financial-effect authority, centered on:

```text
transactionEffectForAccount(transaction, account) -> signed minor-unit delta
```

It covers:

- asset income/expense;
- liability income/expense;
- asset → asset;
- asset → liability;
- liability → asset;
- liability → liability;
- signed Adjustment delta.

`deriveCurrentBalance(account, activeTransactions)` is:

```text
openingBalanceMinor + checkedSum(transactionEffectForAccount(...))
```

Deleted transactions are excluded. A Transfer remains one row but produces from/to effects when each Account projection is evaluated.

Account responses, archive checks, Overview totals, Account detail, and tests all call this engine. No service/route re-codes the matrix.

---

## 14. Persistence / repository boundary

`server/ledger/repository.ts` owns prepared SQL and DB row mapping. It may read/write Ledger rows and expose history/filter primitives. It does **not** begin transactions, map HTTP errors, decide natural-balance semantics, accept Hono request objects, or build mock fallback data.

### 14.1 Account history

Physical Account delete checks all transaction rows, including soft-deleted rows:

```text
account_id = :id
OR from_account_id = :id
OR to_account_id = :id
```

There is no `deleted_at IS NULL` in the history predicate.

### 14.2 Category history

Physical Category delete checks every row with `category_id=:id`, including deleted transactions. An archived Category's explicit ID remains usable for historical active-transaction reads.

---

## 15. The one Ledger write transaction helper

`server/ledger/writeTransaction.ts` owns the single mutation primitive:

```text
runLedgerWrite(db, synchronousCallback)
  → db.transaction(synchronousCallback).immediate()
```

Rules:

- callback is synchronous; no `await`;
- no route/repository issues raw `BEGIN`, `COMMIT`, or `ROLLBACK`;
- no manual `BEGIN IMMEDIATE` is nested around `db.transaction()`;
- nested helpers reuse the ambient transaction and never start their own;
- SQLite errors are rethrown; code does not continue after a possible forced rollback.

### 15.1 Busy behavior

L0 makes the connection timeout explicitly **5000 ms**, matching the baseline library default while removing version-dependent ambiguity.

There is no infinite retry. Exhausted `SQLITE_BUSY` maps outside the transaction to:

```text
503 ledger-write-busy
```

No SQLite message, SQL, stack, or file path is returned. POST retry remains safe through Idempotency-Key.

---

## 16. Version concurrency and deterministic error priority

`validation.ts` provides one `requireExpectedVersion` / `assertExpectedVersion`. External versions are positive safe integers.

Locations:

- Settings PATCH: JSON body.
- Account PATCH/DELETE/archive/restore: JSON body.
- Category PATCH/DELETE/archive/restore: JSON body.
- Transaction PATCH/DELETE: JSON body.

Successful mutable operations increment version by exactly one. Active Account/Category restore is a 200 no-op and leaves version unchanged.

Repeated DELETE of an already-DELETED transaction is the Accepted special case: `expectedVersion` must be present and valid, but is not compared to the terminal row; return the current deleted representation without incrementing.

### 16.1 Error ordering

Create POST:

```text
parse exact request shape + canonical stateless normalization
→ BEGIN IMMEDIATE
→ idempotency lookup
→ replay/conflict if existing
→ current-state/domain validation
→ mutation/no-op
→ response snapshot
→ idempotency insert
→ commit
```

Existing-resource mutations:

```text
resource lookup
→ terminal/lifecycle gate
→ expectedVersion
→ payload/type-specific + cross-row validation
→ mutation
```

Specific rules:

- DELETED Transaction PATCH → `ledger-transaction-deleted` before PATCH field/type validation.
- transaction mutation resolves archived eligibility across **all** referenced Accounts before expectedVersion.
- Account archive checks version before balance gate.
- Settings lock checks precede expectedVersion.
- active restore validates expectedVersion, then returns no-op.

---

## 17. Persistent idempotency replay

### 17.1 Canonical request fingerprint

Raw body bytes are never hashed.

```text
exact-key parse
→ type-specific stateless validation
→ canonical normalized mutation DTO
→ stable recursive JSON serialization
→ SHA-256 via node:crypto
→ 64-char lowercase hex
```

Stable serialization sorts object keys lexicographically, preserves arrays, represents null deterministically, and rejects undefined/non-finite numbers.

Normalization:

- omitted `note` and `note:""` → canonical `note:""`;
- omitted applicable `payee` and `payee:""` → canonical `payee:""`;
- currency → uppercase;
- Category name → trimmed; normalized identity stays server-derived.

Canonical POST fields:

- Settings: `{baseCurrency, timezone}`.
- Account: `{name,type,nature,openingBalanceMinor,openingDate,currency,note}`.
- Category: `{kind,name}`.
- Income/Expense: `{type,amountMinor,accountId,categoryId,occurredAt,payee,note}`.
- Transfer: `{type,amountMinor,fromAccountId,toAccountId,occurredAt,note}`.
- Adjustment: `{targetBalanceMinor,occurredAt,note,expectedCalculatedBalanceMinor}`.

### 17.2 `operation_scope`

```text
POST:/api/ledger/settings
POST:/api/ledger/accounts
POST:/api/ledger/categories
POST:/api/ledger/transactions
POST:/api/ledger/accounts/{accountId}/adjust
```

Adjustment embeds canonical Account ID in scope.

### 17.3 Replay algorithm

Inside one `BEGIN IMMEDIATE`:

```text
lookup(scope,key)

existing + same fingerprint
  → return stored response_status + response_body_json
  → no current mutable validation/read

existing + different fingerprint
  → 409 ledger-idempotency-conflict

not existing
  → domain validation
  → mutation/no-op
  → typed safe response DTO
  → canonical response JSON
  → insert replay snapshot
  → commit
```

Validation/version/balance conflicts do not consume the key.

### 17.4 Snapshot safety

`serializeLedgerReplayResponse(...)` accepts only typed Ledger success/no-op DTOs. It cannot receive Hono Response/request/header/session/error objects.

Only canonical JSON body text + HTTP status are stored. `result_id` is diagnostic only and never replay authority.

Never snapshot/log cookies, Authorization/session, request headers, SQL error, stack, filesystem path, raw request body, or financial response dumps.

### 17.5 Atomicity seam

A narrow test-only hook can throw **after domain mutation but before idempotency insert**, while still inside the transaction wrapper. The test proves both domain row and replay row rolled back. The seam is not exposed to HTTP/production APIs.

### 17.6 Reopen persistence

A file-backed test performs POST, closes handles, reopens the same file, runs migrations, retries the key, and asserts original status/body plus no duplicate business row.

---

## 18. Settings initialization

### 18.1 Uninitialized behavior

This plan freezes the presentation detail not otherwise specified by the Accepted PRD:

- `GET /api/ledger/settings` with no settings row → `404 ledger-not-found`.
- all Ledger endpoints except `POST /api/ledger/settings` fail closed with `404 ledger-not-found` until initialization.
- no mock fallback.

### 18.2 Explicit initialization

`POST /api/ledger/settings` requires explicit:

```text
baseCurrency
timezone
```

No server timezone, browser timezone, USD, or other irreversible default is selected.

The write transaction atomically performs:

```text
idempotency lookup
→ validate supported baseCurrency + IANA timezone
→ insert singleton settings version 1
→ idempotently seed accepted v1 default Categories
→ build settings response
→ persist replay snapshot
→ commit
```

Default seed runs only during first initialization. Startup never uses `INSERT OR REPLACE` or auto-unarchive. The exact ordered catalog is the
`DEFAULT_LEDGER_CATEGORIES_V1` constant frozen in §20.3.

---

## 19. Accounts

### 19.1 Create

Validate initialized settings, exact currency, type/nature matrix, name/note limits, signed safe opening balance, strict opening date, and idempotency. First Account + `has_created_account=1` commit in one immediate transaction.

### 19.2 PATCH

Per-field validators only; no `Object.assign`. `hasHistory` means that any
`ledger_transactions` row references the Account through `account_id`,
`from_account_id`, or `to_account_id`; soft-deleted rows count as history.
The implementation uses this complete PATCH matrix:

| Account state | History | PATCH whitelist | Required behavior |
| --- | --- | --- | --- |
| ACTIVE | none | `name`, `note`, `type`, `nature`, `openingBalanceMinor`, `openingDate` | validate the final `type`/`nature` pair and the opening boundary; all changes are one optimistic mutation |
| ACTIVE | exists | `name`, `note` | reject fields that reinterpret history; balance corrections use Adjustment |
| ARCHIVED | none or exists | `name`, `note` | reject every financial/interpretation field; restore first |

`currency` is a create-time validated field and is not in any PATCH whitelist;
it must continue to equal the frozen Ledger `baseCurrency`. `archivedAt`,
`currentBalanceMinor`, `version`, IDs, and timestamps are never PATCH fields.
An archived Account PATCH containing anything outside `name`/`note` returns
`409 ledger-archived-account`; the caller must restore before changing
`openingBalanceMinor`, `openingDate`, `nature`, `type`, or `currency`. An active
Account with history rejects the same interpretation-changing fields with the
deterministic field validation error. This state gate is evaluated before the
mutation and is covered by the service/API tests, so an archived Account that
passed the zero-balance archive gate cannot be made non-zero by PATCH.

### 19.3 Archive race

```text
BEGIN IMMEDIATE
  read Account/lifecycle
  check expectedVersion
  read active related transactions
  deriveCurrentBalance via shared engine
  require currentBalanceMinor === 0
  set archived_at, version += 1
COMMIT
```

The zero-balance read and archive mutation cannot be separated by a competing transaction insert. After archive, the Account PATCH whitelist above is the only direct edit path: `name` and `note` are harmless display/text changes, while every balance-affecting or history-reinterpreting change requires restore first.

### 19.4 Restore

Archived restore preserves ID, clears `archived_at`, increments version. Active restore with matching expectedVersion returns authoritative Account and no version bump.

### 19.5 Physical delete

Check history across `account_id`, `from_account_id`, `to_account_id`, including deleted rows. Any match → `ledger-account-has-history`. No-history delete never resets the settings freeze marker.

---

## 20. Categories

### 20.1 Normalized identity

`shared/ledgerNormalization.ts` implements exactly:

```text
name.trim().toLowerCase()
```

No NFKC, locale argument, frontend authority, or SQLite `lower()` identity logic.

Create/PATCH accept `name`, not `normalizedName`. Duplicate `(kind,normalized_name)` maps to `ledger-duplicate-category`.

### 20.2 Archive/restore/history

`hasHistory` means any transaction row references the Category through
`category_id`, including soft-deleted rows. The Category mutation matrix is:

| Category state | History | PATCH whitelist | Required behavior |
| --- | --- | --- | --- |
| ACTIVE | none | `kind`, `name` | validate the final kind/name and `(kind, normalized_name)` uniqueness atomically |
| ACTIVE | exists | `name` | `kind` is immutable after the first historical reference; rename keeps the stable ID and rechecks uniqueness |
| ARCHIVED | none or exists | none | return `409 ledger-archived-category`; restore before any edit |

Archive leaves the current `(kind, normalized_name)` identity reserved. In
particular, an archived Category cannot be renamed to release that identity or
change kind. New transactions reject archived Categories; explicit historical
query by archived ID remains allowed. Restore preserves stable ID and
increments version; active restore no-ops. Archive/restore are explicit
lifecycle endpoints, never a PATCH of `archivedAt`.

Physical delete requires no Category history, including deleted transaction rows.

### 20.3 Default seed

`defaultCategories.ts` declares the following versioned constant, in this exact
order, copied from the Accepted Product PRD:

```ts
const DEFAULT_LEDGER_CATEGORIES_V1 = [
  { kind: 'expense', name: '餐饮' },
  { kind: 'expense', name: '交通' },
  { kind: 'expense', name: '购物' },
  { kind: 'expense', name: '住房' },
  { kind: 'expense', name: '日用' },
  { kind: 'expense', name: '娱乐' },
  { kind: 'expense', name: '医疗' },
  { kind: 'expense', name: '教育' },
  { kind: 'expense', name: '旅行' },
  { kind: 'expense', name: '人情' },
  { kind: 'expense', name: '其他' },
  { kind: 'income', name: '工资' },
  { kind: 'income', name: '奖金' },
  { kind: 'income', name: '投资收益' },
  { kind: 'income', name: '兼职' },
  { kind: 'income', name: '退款' },
  { kind: 'income', name: '红包' },
  { kind: 'income', name: '其他' },
] as const
```

The order is deterministic seed order, not a new product ranking. For each
`{kind,name}`:

- derive normalized name with the authority helper;
- if identity absent, insert with server-generated ID;
- if present, preserve existing display name, ID, version, and archived state;
- never auto-unarchive.

No normal-startup seed.

The exact catalog is covered by the seed test so a later implementation cannot
silently drift from the Accepted PRD.

---

## 21. Transactions

### 21.1 Create

Create parses directly to a discriminated type. Unknown/type-inapplicable keys are rejected.

Inside the same immediate write transaction, validate active Account(s), Category kind/state, currency, opening boundary, future tolerance, and safe integers before insert.

### 21.2 PATCH fields

Income / Expense:

```text
amountMinor
accountId
categoryId
occurredAt
payee
note
```

Transfer:

```text
amountMinor
fromAccountId
toAccountId
occurredAt
note
```

Adjustment:

```text
note
```

`type` is immutable. Adjustment financial fields are immutable.

An edit from Account A/Category X/100 to B/Y/150 validates all new references and updates the single transaction row; it does not mutate balance caches.

### 21.3 Archived Account eligibility

Resolve all referenced Accounts:

- income/expense/adjustment → `account_id`;
- transfer → **both** from/to.

If any is archived, PATCH is limited to non-financial text fields applicable to the type (`note`, plus `payee` for income/expense). Financial changes and DELETE are blocked until every involved archived Account is restored. This transaction rule is separate from the Account PATCH matrix in §19.2; both enforce restore-before-financial-mutation.

### 21.4 Soft delete

DELETE writes `deleted_at`, increments version once, and leaves row/FKs. Balance projection ignores it afterward.

Adjustment delete is only soft delete: no compensating Adjustment and no physical delete.

---

## 22. Adjustment

Inside one immediate transaction:

```text
canonical request/fingerprint
→ idempotency lookup
→ Account active eligibility
→ actualCalculated = deriveCurrentBalance(Account)
→ compare expectedCalculatedBalanceMinor
→ mismatch: 409 ledger-balance-conflict, key not consumed
→ delta = checkedSubMinor(targetBalanceMinor, actualCalculated)
→ delta == 0: canonical 200 no-op + replay snapshot
→ else insert one Adjustment
→ authoritative Account projection
→ canonical success response + replay snapshot
→ commit
```

The server never recomputes a different delta after observing a stale target and then continues successfully.

---

## 23. Transaction query, cursor, and search

### 23.1 Cursor

L0 implements the cursor rather than advertising and ignoring it.

Canonical sort:

```text
occurredAt DESC, createdAt DESC, id DESC
```

Opaque payload before base64url encoding:

```json
{"v":1,"occurredAt":0,"createdAt":0,"id":"..."}
```

Decoder requires exact keys, v1, safe timestamps, non-empty ID.

Keyset predicate:

```text
occurred_at < O
OR (occurred_at = O AND created_at < C)
OR (occurred_at = O AND created_at = C AND id < I)
```

Fetch `limit+1`; default 50, max 200. Account list and general list share the implementation. Recent uses same order with fixed 5.

### 23.2 Filters

- `accountId=X` matches account/from/to.
- `categoryId=X` matches income/expense only; archived Category ID remains readable.
- `includeDeleted=false` excludes soft-deleted rows.
- `from`/`to` are safe UTC-ms and use `[from,to)`.
- `type=all` includes Adjustment.

### 23.3 Search

Search matches `payee` + `note`.

Trim search; empty means no filter. Escape literal `\`, `%`, `_` and use parameterized `LIKE ... ESCAPE '\' COLLATE NOCASE`. L0 promises SQLite's deterministic ASCII case-insensitive behavior, not locale-aware Unicode folding or wildcard query syntax.

No Ledger FTS table is added.

---

## 24. Live projections / Overview

`server/ledger/projections.ts` computes read models from live rows and the shared balance engine.

SQL filters/orders rows; TypeScript applies effects and checked arithmetic. Current Account balance is always opening balance + active effects.

`scope=today|week|month|year|all` affects only:

- `cashflow`;
- `categoryBreakdown`.

It does not periodize current asset total, liability total, net worth, Account balances, fixed periods, trend, or recent transactions.

`periods` always returns today/week/month/year in Ledger timezone. `trend?months=6` uses calendar months including current month, never rolling 180 days. `recentTransactions` is the five latest active records.

Transfers and Adjustments do not enter income/expense/category totals.

Account movement uses `transactionEffectForAccount`, includes Transfer effects, and excludes Adjustment from ordinary movement summary where the Accepted contract requires that distinction.

Correctness outranks materialization. Future optimizations must prove equivalence before adoption.

---

## 25. API routes, registration, auth, responses, errors

### 25.1 Registration

`server/ledger/routes/index.ts` composes routes. `server/index.ts` adds:

```text
app.route('/api/ledger', ledgerRoutes)
```

under the existing `/api/*` owner boundary. Ledger adds no second auth. Protected responses inherit `Cache-Control:no-store`.

### 25.2 Route grouping

- `settings.ts`
- `accounts.ts`
- `categories.ts`
- `transactions.ts`
- `projections.ts`

Routes parse HTTP and delegate; they do not own SQL/domain logic.

### 25.3 Response status conventions

- create Settings/Account/Category/Transaction → `201` + authoritative representation;
- Adjustment insert → `201 {adjustment,account,noOp:false}`;
- Adjustment zero delta → `200 {adjustment:null,account,noOp:true}`;
- PATCH/archive/restore → `200`;
- physical Account/Category DELETE → `200 {deleted:true,id}`;
- Transaction soft DELETE/repeated terminal DELETE → `200` current deleted representation.

### 25.4 Central error mapping

`LedgerError`:

```text
code
status
message
details?
```

One mapper produces Nuvyn envelope:

```json
{"error":"...","code":"ledger-...","details":{}}
```

Policy:

- validation → 400;
- missing Ledger/resource → 404;
- lifecycle/version/idempotency/balance conflicts → 409;
- exhausted SQLite lock → 503 `ledger-write-busy`;
- unknown internal → generic 500.

No raw SQL, stack, SQLite internals, or file paths.

### 25.5 Logging/privacy

Logs may contain route, stable error code, and an existing correlation ID if available. They must not log amount, payee, note, Account balance, raw mutation body, or `response_body_json` by default.

---

## 26. Migration/runtime seed separation

Migration creates schema only.

Runtime first initialization creates:

```text
settings
+ accepted default Categories
+ idempotency response snapshot
```

in one immediate transaction.

This keeps migration independent of owner currency/timezone and prevents startup from reviving archived Categories.

No implementation may substitute `billsMockData` for missing default Category product input.

---

## 27. Test architecture

### Migration/schema — `server/__tests__/ledger-migration.test.ts`

Prove fresh/current upgrade, migration idempotence, tables/FKs/RESTRICT/CHECK/default/index/singleton, absence of caches/parent/name uniqueness, direct invalid SQL rejection, idempotency composite identity.

### Money/time/validation

- `money.test.ts` — safe boundaries, aggregate overflow, exponents, strict decimal conversion.
- `time.test.ts` — named-IANA validation (`UTC`, `CET`, `PST8PDT`, `Asia/Shanghai`, `America/Los_Angeles`), rejection of `+08:00`, `-05`, ISO date-time strings, and bracketed date-time/zone expressions, Gregorian date, Monday week, `[start,end)`, DST, opening boundary, future tolerance.
- `validation.test.ts` — exact keys, discriminated DTOs, expectedVersion, normalization, limits.

### Balance — `balance.test.ts`

Full natural-balance matrix, Transfer net-worth invariant, opening+active records, deleted exclusion, Adjustment, overflow.

### Service/replay/projections

- `service.test.ts` — lifecycle/history/edit/freeze marker; the full Account PATCH matrix; an archived zero-balance Account with no history must reject `openingBalanceMinor`, `openingDate`, `nature`, `type`, and `currency` PATCHes while still allowing `name`/`note`; the full Category PATCH/kind/archive matrix; and restore-before-edit behavior.
- `idempotency.test.ts` — property order/default equivalence/conflict/snapshot/failure rollback.
- `projections.test.ts` — filters/cursor/search/Overview/trend/recent/movement.

The currency metadata tests also pin the checked-in snapshot policy: a
simulated post-release refresh may add supported entries, but cannot silently
remove a previously used code or alter its exponent; either change must fail
the compatibility check and require explicit migration review.

### API/auth

- `ledger-api.test.ts` — Hono contract, camelCase, status/error, no mock fallback.
- `ledger-auth.test.ts` — existing auth utilities, anonymous rejection, owner allowed.

### Two-connection concurrency — `ledger-concurrency.test.ts`

Use one temporary SQLite file and two independent `better-sqlite3` connections A/B, both with FK/WAL/finite timeout. Do not claim `Promise.all` against one in-memory service is sufficient.

Adjustment evidence:

1. both clients start from same calculated balance;
2. one immediate write commits;
3. second request uses same file and stale expected calculated balance;
4. exactly one accepts that stale expectation; the other returns `ledger-balance-conflict`;
5. final DB has only accepted effect.

Separate lock test holds A's immediate transaction and uses a short test timeout on B to prove safe busy mapping; production remains 5000 ms.

Archive race proves final invariant: either transaction insertion wins and archive sees nonzero, or archive wins and later transaction sees archived Account; never archived+nonzero.

### Persistence/reopen — `ledger-persistence.test.ts`

Write mutation, capture snapshot, close all handles, reopen same file, apply migrations, retry same key, assert original snapshot and exactly one business row/replay identity.

Cleanup closes every DB handle before deleting temp files, which is Windows-safe.

---

## 28. Implementation slices

### L0.1 — Schema & shared primitives

**Inputs:** Accepted PRDs, migration runner, shared TS convention.
**Files:** migration, shared protocol/normalization/currency, errors/money/time/validation, package dependency files.
**Implementation:** schema/check/indexes, ISO metadata, Temporal, safe arithmetic, base validators.
**Tests:** migration/money/time/validation.
**Exit criteria:** deterministic 0013 + direct SQL constraints + tested money/time primitives.
**Dependencies:** default Category catalog does not block schema/primitives.

### L0.2 — Domain validation & balance engine

**Inputs:** L0.1 + Accepted matrix.
**Files:** `domain.ts`, `balance.ts`, tests.
**Implementation:** union, row conversion, one effect authority.
**Tests:** full matrix, overflow, deleted rows.
**Exit criteria:** later layers need no second algorithm.
**Dependencies:** L0.1.

### L0.3 — Repository + write infrastructure

**Inputs:** schema/domain/balance.
**Files:** `repository.ts`, `writeTransaction.ts`, `server/db.ts`, service foundations, temp DB helper.
**Implementation:** prepared SQL, history predicates, `.immediate()`, timeout/busy mapping.
**Tests:** rollback/history/two-connection lock.
**Exit criteria:** no route SQL or nested/manual transaction ownership.
**Dependencies:** L0.1–L0.2.

### L0.4 — Persistent idempotency replay

**Inputs:** write helper/schema.
**Files:** `idempotency.ts`, service integration, replay/persistence tests.
**Implementation:** normalized stable SHA-256, scopes, snapshots, failure seam.
**Tests:** order/default equivalence, conflict, mutable-result replay, physical-delete replay, no-op, rollback, reopen.
**Exit criteria:** snapshot is sole replay authority and commits atomically.
**Dependencies:** L0.3.

### L0.5 — Settings / Accounts / Categories API

**Inputs:** L0.1–L0.4 + the exact Accepted Product PRD default Category catalog in §20.3.
**Files:** `defaultCategories.ts`, service, settings/accounts/categories routes, API/auth tests.
**Implementation:** init/freeze marker/version/archive/restore/delete/history/normalized identity/seed.
**Tests:** locks, marker monotonicity, seed no-unarchive, archive race, auth/errors.
**Exit criteria:** Accepted Settings/Account/Category contract complete.
**Dependencies:** L0.1–L0.4 and the Accepted Product PRD catalog in §20.3.

### L0.6 — Transactions / Adjustment API

**Inputs:** balance/write/idempotency/account/category services.
**Files:** transaction service/routes, Adjustment account route, concurrency tests.
**Implementation:** create/per-type patch/soft delete, archived eligibility, one-row Transfer, stale Adjustment/no-op.
**Tests:** edit atomicity, archived Transfer combinations, immutability, soft delete, Adjustment race.
**Exit criteria:** transaction mutation preserves Accepted semantics under concurrency.
**Dependencies:** L0.5.

### L0.7 — Overview / query projections

**Inputs:** balance engine + persistent transactions.
**Files:** projections/routes/tests.
**Implementation:** filters/search/cursor/current balances/scope/periods/trend/recent/movement.
**Tests:** order/cursor boundaries, archived Category history, scope invariants, calendar periods/trend.
**Exit criteria:** complete live projection without cache or alternate balance logic.
**Dependencies:** L0.6.

### L0.8 — Concurrency / persistence / regression evidence

**Inputs:** complete server surface.
**Files:** integration/concurrency/persistence tests + post-implementation docs/evidence.
**Implementation:** hardening/privacy/cross-platform cleanup/final docs.
**Tests:** full ladder/reopen/two connections/auth/Bills characterization/full CI.
**Exit criteria:** evidence complete and UI still untouched.
**Dependencies:** L0.7.

---

## 29. Suggested implementation commit strategy

```text
feat(ledger): add foundation schema and primitives
feat(ledger): add balance domain and persistence
feat(ledger): add immediate write transactions
feat(ledger): add persistent idempotent replay
feat(ledger): add settings accounts and categories api
feat(ledger): add transactions and adjustments api
feat(ledger): add live ledger projections
test(ledger): prove concurrency persistence and regressions
docs(ledger): record l0 implementation evidence
```

Exact count may vary, but each commit is a logical, reviewable, reversible slice and no commit mixes Foundation with UI migration.

---

## 30. Verification ladder

### Focused unit/domain

```bash
npx vitest run \
  server/ledger/money.test.ts \
  server/ledger/time.test.ts \
  server/ledger/validation.test.ts \
  server/ledger/balance.test.ts
```

### Migration

```bash
npx vitest run server/__tests__/ledger-migration.test.ts
```

### Service/replay/projections

```bash
npx vitest run \
  server/ledger/service.test.ts \
  server/ledger/idempotency.test.ts \
  server/ledger/projections.test.ts
```

### API/auth

```bash
npx vitest run \
  server/__tests__/ledger-api.test.ts \
  server/__tests__/ledger-auth.test.ts
```

### Concurrency/persistence

```bash
npx vitest run \
  server/__tests__/ledger-concurrency.test.ts \
  server/__tests__/ledger-persistence.test.ts
```

### Repository-level

```bash
npm run typecheck
npm run build
npm test
npm run test:tags-scale
```

### Browser/auth/deployment regression

```bash
npm run test:e2e -- e2e/ledger-workspace.spec.ts
npm run test:e2e:draft-store
npm run test:e2e:auth
npm run test:deployment-auth
```

Before evidence is accepted, run the full authoritative browser/CI suites, not only Ledger spec.

### CI matrix

Required green evidence:

- Ubuntu / Node 24
- macOS / Node 24
- Windows / Node 24
- Ubuntu / Node 22
- authoritative browser/auth/deployment/tag-scale jobs

Timezone and SQLite tests must not depend on host local timezone or Unix-only file deletion.

---

## 31. Risk register

| Risk | Mitigation | Required evidence |
| --- | --- | --- |
| SQLite `BEGIN IMMEDIATE` | one `.transaction(fn).immediate()` helper | write-helper + two-connection tests |
| better-sqlite transaction semantics | sync callbacks, rethrow, no raw transaction mixing | rollback/failure seam |
| `SQLITE_BUSY` | explicit 5000 ms, no infinite retry, safe 503 | forced short-timeout test |
| financial integer overflow | safe inputs + checked result arithmetic; no SQL SUM authority | safe-boundary/aggregate-overflow tests |
| timezone/DST | Temporal polyfill + calendar boundaries | LA spring/fall + Monday/range tests |
| ISO exponent drift | checked-in SIX-derived versioned metadata | metadata + exponent tests |
| idempotency canonicalization | typed DTO + stable serialization + SHA-256 | property-order/default tests |
| response snapshot privacy | typed serializer; no headers/session/debug data | replay/privacy assertions |
| Account archive race | derive + archive in same immediate transaction | two-connection invariant |
| Adjustment race | expected calculated balance checked inside immediate transaction | one-winner test |
| soft-delete projection | central active filter + balance engine | delete/recalculate/Overview |
| FK history preservation | RESTRICT + all-history predicates | FK/delete tests |
| archived Transfer mutation | resolve both from/to Accounts | mixed lifecycle tests |
| cross-platform SQLite temp files | close handles before cleanup | Windows CI |
| default Category drift | checked-in ordered constant copied from the Accepted Product PRD; exact catalog and no-unarchive seed tests | seed catalog test |

---

## 32. Documentation boundary after implementation

After actual L0 implementation:

- update architecture/storage for `ledger_*`, single DB, projection authority;
- update backup/restore for `nuvyn.db` + WAL/SHM consistency;
- update developer/API docs if present;
- record L0 implementation evidence.

User-facing docs must distinguish **foundation implemented** from **product UI wired**. Do not claim Ledger is usable through the UI until later phases do the cutover.

---

## 33. Exit gate

Frozen by this plan:

- [x] exact migration number `0013_ledger_foundation.sql`
- [x] exact five-table schema plan
- [x] exact production module layout
- [x] exact service/repository/API boundary
- [x] one `.transaction(fn).immediate()` write helper
- [x] explicit finite 5000 ms busy behavior
- [x] SIX-derived checked-in ISO exponent metadata
- [x] post-release ISO metadata compatibility policy (no silent removal or exponent change for a used currency)
- [x] server-side `@js-temporal/polyfill@0.5.1`
- [x] named-IANA timezone validator distinct from Temporal's broader parser
- [x] checked input **and aggregate-result** integer arithmetic
- [x] discriminated Transaction model/conversion
- [x] single natural-balance authority
- [x] SHA-256 canonical request fingerprint
- [x] exact operation scopes including Adjustment Account ID
- [x] response snapshot replay authority
- [x] expectedVersion locations/rules/error priority
- [x] Account archive flow
- [x] Account PATCH whitelist preserves archived zero-balance invariant
- [x] Category PATCH/kind matrix and archived restore-before-edit rule
- [x] Adjustment concurrency flow
- [x] archived Transfer mutation eligibility
- [x] per-type Transaction PATCH fields
- [x] Adjustment soft-delete semantics
- [x] minimal correct cursor
- [x] literal escaped search
- [x] live Overview projection/no materialized authority
- [x] indexes/query approach
- [x] exact test files/two-connection strategy
- [x] verification commands
- [x] exact v1 default Category seed catalog copied from the Accepted Product PRD

`normalizedName` remains derived and IDs remain server-generated. Production
implementation starts only after this plan passes independent review.

---

## 34. Implementation evidence requirements

Eventual L0 evidence must record:

- implementation baseline and final HEAD;
- migration version;
- schema/direct constraint tests;
- currency/time/DST tests;
- natural-balance matrix;
- idempotency canonicalization/replay/atomicity;
- lifecycle and transaction/Adjustment tests;
- two-connection Adjustment/archive races;
- DB close/reopen replay;
- owner auth;
- API/query/cursor/search/Overview;
- `npm run typecheck`;
- `npm run build`;
- `npm test`;
- relevant browser/auth/deployment/tag-scale regressions;
- CI across Node 22/24 and Ubuntu/macOS/Windows;
- confirmation Bills UI/mock/router was not integrated;
- final working-tree clean status from the actual implementation checkout.

---

**Implementation Plan: Accepted / Ready for Implementation** — implementation mechanics are fully specified against the Accepted product and architecture contracts, including the Plan Review remediation. L0.1 implementation may begin; this document contains no production implementation.
