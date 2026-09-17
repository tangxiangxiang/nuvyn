# SQLite AI History — Design

**Date:** 2026-06-07
**Status:** Approved
**Scope:** Persist AI panel chat history on the server side using SQLite, with multi-session support, naming, and switching. Filesystem storage of notes is **not** touched. The SQLite + migration infrastructure laid down here is the foundation for the next two planned features (revision history, link graph) — they will share the same `db.ts` and migration runner.

## 1. Problem & Goal

The AI panel today is UI-only: pressing Enter logs to `console.debug` and clears the textarea. The conversation evaporates the moment the panel is closed. Users have no way to:

- Pick up yesterday's question
- Distinguish between several parallel "threads" (one about deployment, one about a specific note)
- Rename a thread so they can find it later

**Goal:** Persist AI panel conversations on the server with multi-session support, and surface the session list inside the panel so users can switch, rename, create, and delete sessions. Infrastructure (DB, migration runner, service-layer pattern) is built generically so version-history and link-graph features can plug in next.

## 2. Behavior (UX contract)

| # | Action | Result |
|---|---|---|
| 1 | First time the AI panel is opened | No active session; panel shows the welcome bubble only. Header reads "Claude" (no session title). |
| 2 | Click the title ("Claude") in the AI panel header | Session picker popover opens below the header, listing all sessions newest-first, with the active one marked. |
| 3 | Click `+` in the picker popover | New empty session is created and set as active; popover closes; messages area shows the welcome bubble. |
| 4 | Click a session row in the picker | That session becomes active; popover closes; messages reload. |
| 5 | Click `✎` on a session row | The row becomes an inline input; Enter/blur saves the new title; Esc cancels. |
| 6 | Click `×` on a session row | Confirm dialog ("Delete this session and its N messages?"); on confirm, session + its messages are deleted. If it was the active session, the panel reverts to the no-active-session state. |
| 7 | Press Enter in the composer with an empty title | If no active session exists, a new session is created first. The user message is appended (optimistic) and persisted. After the first user message lands, the server auto-derives a title (first 30 Unicode code points of the trimmed message, with `…` appended if longer). The title appears in the header on the next picker open. |
| 8 | Press Enter in the composer with an active session | The user message is appended to the active session. No LLM reply yet (still UI-only; assistant responses are a future spec). |
| 9 | Send Shift+Enter in the composer | Inserts a newline; no message is sent. |
| 10 | Close and reopen the panel | The previously active session (and its messages) reload. Active session is stored server-side, so the choice survives reload + is shared across tabs. |
| 11 | Reload the page | Same as #10. |
| 12 | Click `×` in the panel header | Panel closes; active session ID is preserved for next open. |

## 3. Architecture

```
                ┌──────────────────────────────────┐
                │  src/components/vault/           │
                │    AiPanel.vue   (改)             │
                │    AiSessionPicker.vue (新)      │
                └──────────┬───────────────────────┘
                           │ composable
                ┌──────────▼───────────────────────┐
                │  src/composables/vault/          │
                │    useAiHistory.ts  (新)         │
                └──────────┬───────────────────────┘
                           │ fetch /api/ai/*
                ┌──────────▼───────────────────────┐
                │  src/lib/ai-api.ts  (新)         │  ← wire-shape + typed fetch
                └──────────┬───────────────────────┘
                           │ HTTP
                ┌──────────▼───────────────────────┐
                │  server/index.ts                 │
                │    .route('/api/ai', aiRoutes)   │
                └──────────┬───────────────────────┘
                           │
                ┌──────────▼───────────────────────┐
                │  server/ai/                      │
                │    routes.ts    (新)              │  ← Hono handlers (thin)
                │    sessions.ts  (新)              │  ← pure-function service
                │    messages.ts  (新)              │
                └──────────┬───────────────────────┘
                           │ better-sqlite3 (sync)
                ┌──────────▼───────────────────────┐
                │  server/db.ts  (新)              │  ← Database singleton + migrate()
                │  server/migrations/              │
                │    0001_ai_history.sql            │
                └──────────────────────────────────┘
                           │
                       data/nuvyn.db (gitignored)
```

Wire shapes are defined once in `src/lib/ai-api.ts`; server modules import them via `from '../../src/lib/ai-api.js'` (the existing pattern, see `server/index.ts` lines 6–7). The server uses SQL snake_case (`created_at`) and TypeScript uses camelCase (`createdAt`); the service layer does the mapping.

### 3.1 Server layout

| Path | Responsibility |
|---|---|
| `server/db.ts` (new) | Exports `getDb()` returning a singleton `Database`. On first call: ensures `data/` exists, opens `./data/nuvyn.db`, sets `journal_mode=WAL` and `foreign_keys=ON`, runs `applyMigrations()`. |
| `server/migrations/0001_ai_history.sql` (new) | First migration: creates `sessions`, `messages`, `settings`, and `schema_version` tables plus the `idx_messages_session_created` index. |
| `server/ai/sessions.ts` (new) | Pure functions: `listSessions`, `getSession`, `createSession`, `renameSession`, `deleteSession`, `getActiveSessionId`, `setActiveSessionId`. All take `db: Database` as the first argument. |
| `server/ai/messages.ts` (new) | Pure functions: `listMessages`, `appendMessage`. Same shape: `db` first. |
| `server/ai/routes.ts` (new) | Hono sub-app with all `/api/ai/*` handlers. Each handler is a 5–15 line arrow that parses → calls service → returns JSON / `bad()`. |
| `server/index.ts` (modify) | Add `app.route('/api/ai', aiRoutes)`. |
| `data/` (new) | Holds `nuvyn.db` + `nuvyn.db-wal` + `nuvyn.db-shm` once the server has been started. Created at runtime by `db.ts`. |
| `.gitignore` (modify) | Add `data/`. |

### 3.2 Migration runner (inside `server/db.ts`)

- The DB has a single-row `schema_version(version INTEGER NOT NULL)` table created on first run.
- On startup, `applyMigrations(db)` reads the current version (default 0), lists `server/migrations/*.sql` whose name matches `/^(\d+)_.*\.sql$/`, and for each file with `N > current`:
  1. Read the file
  2. Run the entire SQL inside a `db.transaction(...)()` (so a bad migration rolls back cleanly)
  3. Update `schema_version` to `N`
- No up/down. Reverting a bad migration is `UPDATE schema_version SET version = N-1` + fix the SQL + restart.
- Logs each applied file to stdout (`[migrate] applied 0001_ai_history.sql (→ v1)`).

### 3.3 Service layer

All services are plain functions of `(db, ...args) → result`. No class state, no closures over `db`. This makes them trivial to test by passing an in-memory `:memory:` `Database` with migrations applied.

**`server/ai/sessions.ts`**

| Function | Returns | Notes |
|---|---|---|
| `listSessions(db)` | `Session[]` | `ORDER BY updated_at DESC` |
| `getSession(db, id)` | `Session \| null` | — |
| `createSession(db)` | `Session` | `INSERT` with empty title, `created_at = updated_at = Date.now()`; **does not** auto-set active (callers can do that explicitly if they want) |
| `renameSession(db, id, title)` | `Session \| null` | `null` if not found; trims title; rejects empty after trim (no-op, returns current row) |
| `deleteSession(db, id)` | `boolean` | `false` if not found; **inside a transaction**: `DELETE FROM sessions WHERE id = ?` then `if id === activeSessionId → setActiveSessionId(null)` |
| `getActiveSessionId(db)` | `number \| null` | Reads `settings.value` for key `'nuvyn.ai.activeSessionId'`, `Number()` + `Number.isFinite` check; missing/invalid → `null` |
| `setActiveSessionId(db, id)` | `void` | `id === null` → `DELETE FROM settings WHERE key = ?`; else `INSERT ... ON CONFLICT(key) DO UPDATE` |

**`server/ai/messages.ts`**

| Function | Returns | Notes |
|---|---|---|
| `listMessages(db, sessionId)` | `Message[] \| null` | `null` if session not found; `ORDER BY created_at ASC` |
| `appendMessage(db, sessionId, role, content)` | `{ ok: true; message: Message } \| { ok: false; reason: 'not-found' \| 'empty' \| 'invalid-role' }` | All in one transaction (see below) |

`appendMessage` transaction body, in order:
1. If `role !== 'user' && role !== 'assistant'` → return `{ ok: false, reason: 'invalid-role' }` (no DB write).
2. If `content.trim().length === 0` → return `{ ok: false, reason: 'empty' }` (no DB write).
3. `SELECT id, title FROM sessions WHERE id = ?`; if not found → `{ ok: false, reason: 'not-found' }`.
4. `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`.
5. `UPDATE sessions SET updated_at = ? WHERE id = ?`.
6. If `role === 'user'` **and** `title === ''`: derive title from the trimmed content, capped at 30 **Unicode code points** (not UTF-16 code units) — code-point counting avoids splitting a surrogate pair mid-emoji. Implementation: `[...content.trim()].slice(0, 30).join('')`, then append `'…'` only if the trimmed content is longer than 30 code points. `UPDATE sessions SET title = ? WHERE id = ?`.
7. Return `{ ok: true, message: <row> }`.

The whole sequence runs inside one `db.transaction(...)()` so a partial failure can't leave a message without `updated_at` refresh.

### 3.4 HTTP API

Mounted at `/api/ai` via `app.route('/api/ai', aiRoutes)`. All bodies are JSON. Errors use the existing `bad(c, msg, code)` helper from `server/index.ts:19`.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `GET` | `/sessions` | — | `Session[]` | — |
| `POST` | `/sessions` | — | `Session` (201) | — |
| `PATCH` | `/sessions/:id` | `{ title: string }` | `Session` | 400, 404 |
| `DELETE` | `/sessions/:id` | — | `{ ok: true }` | 404 |
| `GET` | `/sessions/:id/messages` | — | `Message[]` | 404 |
| `POST` | `/sessions/:id/messages` | `{ role: 'user' \| 'assistant', content: string }` | `Message` | 400, 404 |
| `GET` | `/active` | — | `{ sessionId: number \| null }` | — |
| `PUT` | `/active` | `{ sessionId: number \| null }` | `{ sessionId: number \| null }` | 400, 404 |

Error semantics:
- **400** — body missing, required field missing/wrong type, `role` not in enum, `title` is empty string after trim, `sessionId` is not a number or `null`
- **404** — session id does not exist (for `PATCH` / `DELETE` / `GET .../messages` / `POST .../messages` / `PUT /active` with non-null id)

`POST /sessions/:id/messages` specifically maps the `appendMessage` reasons to HTTP codes: `not-found` → 404, `empty` or `invalid-role` → 400.

### 3.5 Frontend API client (`src/lib/ai-api.ts`, new)

Sits next to `src/lib/api.ts`. Same `jsonOrThrow` pattern; the same import style (`from './api.js'` for self).

```ts
export interface Session { id: number; title: string; createdAt: number; updatedAt: number }
export interface Message  { id: number; sessionId: number; role: 'user' | 'assistant'; content: string; createdAt: number }

export async function listSessions(): Promise<Session[]>
export async function createSession(): Promise<Session>
export async function renameSession(id: number, title: string): Promise<Session>
export async function deleteSession(id: number): Promise<{ ok: true }>
export async function listMessages(sessionId: number): Promise<Message[]>
export async function appendMessage(sessionId: number, role: 'user' | 'assistant', content: string): Promise<Message>
export async function getActiveSessionId(): Promise<number | null>
export async function setActiveSessionId(sessionId: number | null): Promise<number | null>
```

### 3.6 Frontend composable (`src/composables/vault/useAiHistory.ts`, new)

Module-level singleton (same pattern as `useVaultLayout`). Owns the live state + the action functions; the components just render and call.

```ts
export function useAiHistory(): {
  // state
  activeSession: Ref<Session | null>
  messages: Ref<Message[]>
  sessions: Ref<Session[]>         // refilled on demand when picker opens
  isLoading: Ref<boolean>

  // actions
  loadActive(): Promise<void>      // open-panel entry point
  refreshSessions(): Promise<void> // open-picker entry point

  createSession(): Promise<Session>
  switchSession(id: number): Promise<void>
  renameSession(id: number, title: string): Promise<void>
  deleteSession(id: number): Promise<void>

  sendMessage(content: string): Promise<void>  // auto-creates session if none
}
```

`sendMessage` body, in order:
1. If `activeSession.value == null`: `const s = await createSession(); activeSession.value = s; messages.value = []`.
2. Trim content; if empty, no-op (matches the existing `onSend` early-return).
3. Optimistic push: `messages.value.push({ id: 0, sessionId: activeSession.value.id, role: 'user', content, createdAt: Date.now() })`. `id: 0` is the temporary marker.
4. `const saved = await appendMessage(activeSession.value.id, 'user', content)`.
5. Replace the optimistic message: `messages.value[i] = saved`.
6. UI-only: keep `console.debug('[ai] would send', content)` for parity with the existing component. No assistant response is generated.
7. If this was the first user message in a previously-empty-title session, the server has updated the title; the composable does not eagerly refresh `sessions` here (the picker will refresh on open). The header shows the session id, not the title, so no live update is needed.

`loadActive` is the canonical open-panel entry: it fetches `getActiveSessionId()`, then if non-null fetches the messages. If null, `messages` stays empty and the welcome bubble is rendered (existing template branch handles that).

`switchSession` calls `setActiveSessionId(id)` then `listMessages(id)` then assigns both. Errors are logged to `console.error` and re-thrown so the caller can show a toast (the existing `useToast()` composable) — the spec doesn't define a specific UX for failures, it just sets the hook point.

### 3.7 Frontend components

**`AiPanel.vue` (modified)**

Stays structurally close to the current implementation. The render body is unchanged (header, messages area, composer). Two script-level changes:
- Import + destructure `useAiHistory()`.
- On `onMounted`, call `loadActive()`.
- The composer's `onSend` becomes: `const text = draft.value.trim(); if (!text) return; await sendMessage(text); draft.value = ''`.
- The header title becomes a clickable element. When `activeSession?.title` is non-empty, it shows `Claude · ${title}` (the dot is a quiet separator, not a slash). When `activeSession` is null or title is empty, it shows just `Claude` and the click still opens the picker.
- The picker is rendered as `<AiSessionPicker v-if="pickerOpen" @close="pickerOpen = false" />` inside the panel.

**`AiSessionPicker.vue` (new)**

- Props: none. State owned by the composable.
- Renders as a popover positioned `absolute` directly below the header (top: 36px), full width of the AI panel, max-height ~280px, `overflow-y: auto`.
- Header: "Sessions" label on the left, `[+]` button on the right.
- Body: list of `sessions` (newest first). Each row:
  - Small left indicator (a 4px dot) for the active session
  - Title text (or "New session" fallback when title is empty)
  - Hover: reveals `×` and `✎` buttons on the right
  - `✎` switches the row into edit mode (an inline `<input>` that auto-focuses); Enter / blur saves via `renameSession(id, trimmed)`, Esc cancels
  - `×` calls `window.confirm(...)` then `deleteSession(id)`
- Footer / outside-click: a global `pointerdown` listener on document closes the popover when the click target is outside the popover element. Esc also closes.
- Emits: `close` (the parent sets `pickerOpen = false`).

## 4. Data model

### 4.1 `server/migrations/0001_ai_history.sql`

```sql
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,  -- ms since epoch
  updated_at  INTEGER NOT NULL
);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Pulls the message timeline for a session in chronological order in one
-- index seek. The composite (session_id, created_at) covers the
-- WHERE + ORDER BY without a sort step.
CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

The `schema_version` table is created by the runner itself (one row, single column), not by the migration SQL — it has to exist before any migration can record its version.

### 4.2 Row → TS mapping

```ts
// snake_case (SQL) → camelCase (TS)
const rowToSession = (r: any): Session => ({
  id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at,
})
const rowToMessage = (r: any): Message => ({
  id: r.id, sessionId: r.session_id, role: r.role, content: r.content, createdAt: r.created_at,
})
```

These two helpers live at the top of their respective service files; they're not exported.

### 4.3 Time format

- Stored: `INTEGER` ms-since-epoch (`Date.now()`).
- Read: sent to client as a `number`; UI formats with `Intl.DateTimeFormat` (or just `new Date(n).toLocaleString()` — the spec doesn't pin a format).
- No timezone math on the server; the client renders in the browser's local zone.

### 4.4 Active session encoding

`settings.value` is always `TEXT`. The key `'nuvyn.ai.activeSessionId'` stores the integer id as a string. `getActiveSessionId` does:

```ts
const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('nuvyn.ai.activeSessionId') as { value: string } | undefined
if (!row) return null
const n = Number(row.value)
return Number.isFinite(n) ? n : null
```

This guards against a corrupted row (non-numeric value) by falling back to `null` (no active session).

## 5. State summary

| Ref / value | Type | Default | Persisted? | Owner |
|---|---|---|---|---|
| `sessions` (DB) | rows of `sessions` | (empty) | yes (SQLite) | `db.ts` |
| `messages` (DB) | rows of `messages` | (empty) | yes (SQLite, cascading) | `db.ts` |
| `settings[nuvyn.ai.activeSessionId]` | integer id or `null` | `null` | yes (SQLite) | `db.ts` |
| `activeSession` (client) | `Ref<Session \| null>` | `null` | mirrored from server | `useAiHistory` |
| `messages` (client) | `Ref<Message[]>` | `[]` | mirrored from server | `useAiHistory` |
| `sessions` (client) | `Ref<Session[]>` | `[]` | mirrored from server on demand | `useAiHistory` |
| `isLoading` (client) | `Ref<boolean>` | `false` | no | `useAiHistory` |
| `pickerOpen` (client) | `Ref<boolean>` | `false` | no | `AiPanel.vue` (local) |

Single source of truth on the server (`./data/nuvyn.db`); the client `Ref`s are read-through caches.

## 6. Visual / interaction details

- **AI panel header**: existing 36px row. Layout: `[✦] Claude · {title}` (the title is omitted if there's no active session or its title is empty; in that case the whole prefix is just `Claude`). The `Claude · {title}` segment is a clickable button (no border, transparent background, `cursor: pointer`, hover background `--vs-hover-bg`).
- **Session picker popover**:
  - Positioned `absolute`, `top: 36px`, `left: 0`, `right: 0`. Above everything else inside the panel (`z-index: 1`).
  - Background `--vs-bg-1`; `border-bottom: 1px solid var(--vs-border)`; box-shadow for separation from the messages area.
  - Header row: 10px / 12px padding, "Sessions" label in 0.78rem / 600 / `--vs-text-2`, `+` button on the right (same 20px square icon button used in the panel header).
  - List rows: 8px / 12px padding, 0.85rem font, `--vs-text-1` color. Active row has `background: var(--vs-active-bg)` and a 4px `--vs-accent` dot before the title. Hover row: `background: var(--vs-hover-bg)`.
  - Inline edit input: same font/size as the row text, no border, full row width; takes focus immediately when edit mode activates.
- **Welcome bubble** (no-active-session case): unchanged from the current panel — `Hi, I'm your AI assistant. Ask me anything about this vault.` with the AI avatar.
- **Message rendering**: existing styles. No new visual styles needed beyond the picker.
- **Confirm dialog for delete**: uses `window.confirm()` (no custom modal). The spec calls this out as an intentional shortcut — the existing custom `confirm` modal pattern is reserved for in-app decisions; a destructive one-tap is rare enough that the browser native dialog is fine for v1.

## 7. Out of scope

- LLM client / network call / real assistant responses. The AI panel's Enter handler still only does `console.debug`. Wiring an actual model is a separate spec.
- FTS5 full-text search over messages. Deferred to a later spec (the data model is migration-friendly; adding FTS is `0002_ai_messages_fts.sql`).
- Per-message edit / delete. Messages are append-only; to "fix" something, delete the session and start over.
- Bulk export / import of history.
- Multi-device realtime sync (WebSocket / SSE). The server-side `activeSessionId` already keeps two tabs roughly in sync on next open, but live updates mid-session are not in scope.
- Custom theme / colour overrides for the picker — uses the existing `--vs-*` tokens, so it follows the vault palette for free.
- Replacing the native `window.confirm` with a styled modal. See §6.

## 8. Testing

- **Migration runner**: with a fresh in-memory `Database`, run `applyMigrations` and assert `schema_version.version === 1` and that all three tables + the index exist (`sqlite_master` query).
- **Migration idempotency**: running `applyMigrations` a second time on the same in-memory DB is a no-op (`schema_version` stays at 1, no errors).
- **Service unit tests** (one file per service, vitest):
  - `sessions`: list returns empty for new DB; create then list returns one row; rename with empty string is a no-op (returns the existing row); delete cascades to messages; delete of the active session clears active.
  - `messages`: append with `role: 'user'` on a new session derives a title from the content (truncated to 30 chars, ellipsis on overflow); append with `role: 'assistant'` does not touch the title; append to a non-existent session returns `not-found`; empty content returns `empty`; invalid role returns `invalid-role`; `updated_at` is refreshed on every append; messages list returns in chronological order.
  - `active`: get returns `null` when unset; set then get round-trips; set to `null` clears; set to a corrupt (non-numeric) value resolves to `null` on next get.
- **HTTP route tests** (using Hono's `app.request()`, no real server): one happy-path + one error-path per route.
- **Frontend composable test** (`useAiHistory.test.ts`): mount against a stub `fetch` (or against the real server in CI). Assert that `loadActive` populates `activeSession` and `messages` from the stubbed responses; `sendMessage` calls `createSession` when no active session exists; optimistic message is replaced by the server response.
- **Visual smoke check** (Puppeteer, optional): open the panel, send a message, close & reopen, confirm the message is still there. Open the picker, confirm the session is listed, rename it, confirm the new title shows in the header.

## 9. Implementation notes

_Populated after the plan runs. Records deviations from this spec, design changes discovered during build, and any rationale the code itself doesn't explain._

### Implementation summary (filled in after the plan ran)

- 12 tasks, 67 new tests. Total: 192 tests, all green.
- `better-sqlite3` pinned at `^11.7.0`, `@types/better-sqlite3` at `^7.6.12`. Both build cleanly on macOS arm64; if a future contributor hits a binding error, `npm rebuild better-sqlite3` fixes it.
- The spec's "module-level singleton (same pattern as `useVaultLayout`)" wording was misleading — `useVaultLayout` is actually call-local refs synced through a shared `useStorage` ref. `useAiHistory` uses a true module-level singleton (the right shape for server-backed state that doesn't have a single source of truth the way the localStorage-backed layout state does).
- The `ai/routes.ts` handlers call `getDb()` at request time, not at module load — this keeps the sub-router import side-effect-free, lets the existing `app.fetch` integration test work without an on-disk DB, and lets the per-test `vi.mock('../db', ...)` pattern inject an in-memory DB cleanly.
- `renameSession` silently rejects empty / whitespace-only titles (returns the existing row, no error) so the inline edit input can be lazy — the user can press Enter with no text and nothing breaks. A stricter version could throw, but the picker UI is the only caller and the no-op is the better UX there. The HTTP layer (routes.ts) catches the empty case at the API boundary and returns 400.
- Auto-title derivation's code-point counting (vs naive `.slice(0, 30)`) caught one real test case: a 30-char message ending with a surrogate-pair emoji would have produced a `?` glyph in the title. The `[...str]` idiom fixes it.
- `AiSessionPicker` has no direct unit test. The composable tests cover the data layer, and the Vue component is a thin presentational layer on top. A future spec that needs picker-internal logic (e.g. keyboard navigation between rows) should add a component test then.
- The `useAiHistory` composable's `loadActive` populates a stub `activeSession` (`title: '', createdAt: 0, updatedAt: 0`) when the server returns just an id, so the UI has something to render before the picker opens. The full row (with title) is fetched by `refreshSessions` and patched in place.
- The `__resetForTesting()` export on the composable is a deliberate testing escape hatch: the module-level singleton would otherwise leak state between test cases. The `__` prefix is the convention for "do not call from production code". An alternative is `vi.resetModules()` in `beforeEach` with re-imports, but the escape hatch is simpler.
- **Plan-vs-build deltas (bugs caught in the plan during execution, fixed by the implementer):**
  - **Task 5:** The plan's `vi.hoisted(async () => { await import('../db') })` factory was broken — `vi.hoisted` factories are sync. The implementer made the factory sync and imported `applyMigrations` directly. The mock still works.
  - **Task 5:** The plan's PATCH `/sessions/:id` handler was missing the trim check (`b.title.trim().length === 0` → 400) — the design spec requires it but the plan's literal code didn't include it. The implementer added the check; the service `renameSession` is intentionally lenient so the API layer is the right place to validate.
  - **Task 7:** The plan's `jsonInit` helper set `method: 'POST'`, which would have silently set POST on PATCH/PUT calls. The implementer renamed it to `jsonBody` (no method) and let each call site pick its own method.
  - **Task 7:** The plan's three GET calls had no explicit method, but the test asserts `init.method === 'GET'`. The implementer added explicit `{ method: 'GET' }` to make the test pass without changing it.
  - **Task 8:** The plan's "auto-creates a session" test queued 3 fetch responses, but `sendMessage` makes 4 fetches when no active session (getActiveSessionId, createSession, setActiveSessionId, appendMessage). The implementer added the 4th response.
  - **Task 8:** The plan's test file didn't have `// @vitest-environment jsdom`, but `mount()` from `@vue/test-utils` needs a DOM. The implementer added the directive.
  - **Task 8:** The plan didn't address the singleton-state-leaks-between-tests problem. The implementer added `__resetForTesting()` to clear `_state` in `beforeEach`.
  - **Plan miscount on test totals:** The plan's running totals said "8 new tests" for Task 3 (actual: 10), "14 new" for Task 4 (actual: 15), "7 new" for Task 8 (actual: 8). The final test count is 192, not the 189 the plan estimated.

  All seven plan-vs-build deltas are documented because future revisions of the plan template should be free of these issues. The corrections themselves are correct per the design spec and the implementer's judgment.
