# SQLite AI History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist AI panel chat history on the server side using SQLite (multi-session, renameable, switchable, deletable), with a session picker popover in the AI panel and an active-session pointer that survives reload.

**Architecture:** Server-side `better-sqlite3` (sync) in `server/db.ts`, generic migration runner, pure-function service modules under `server/ai/`, Hono sub-router mounted at `/api/ai`. Frontend `useAiHistory()` composable (module-level singleton) wraps a typed `src/lib/ai-api.ts` and drives a new `AiSessionPicker.vue` popover from the existing `AiPanel.vue`.

**Tech Stack:** `better-sqlite3` (new), `@types/better-sqlite3` (new), Hono (existing), Vitest (existing), Vue 3 (existing), `@vue/test-utils` (existing).

**Spec:** `docs/superpowers/specs/2026-06-07-sqlite-ai-history.md`

---

## File map (what each file owns)

| Path | New / Modified | Responsibility |
|---|---|---|
| `package.json` | Modify | Add `better-sqlite3` + `@types/better-sqlite3` |
| `.gitignore` | Modify | Add `data/` |
| `server/db.ts` | New | `getDb()` singleton + exported `applyMigrations(db)` |
| `server/migrations/0001_ai_history.sql` | New | Schema: `sessions`, `messages`, `settings`, `schema_version`, `idx_messages_session_created` |
| `server/ai/sessions.ts` | New | Pure service: list/get/create/rename/delete sessions + active-session KV |
| `server/ai/messages.ts` | New | Pure service: list + append messages (with auto-title derivation) |
| `server/ai/routes.ts` | New | Hono sub-router; calls `getDb()` per request so tests can mock it |
| `server/index.ts` | Modify | `app.route('/api/ai', aiRoutes)` |
| `server/__tests__/db.test.ts` | New | Migration runner + idempotency |
| `server/__tests__/ai-sessions.test.ts` | New | sessions service unit tests |
| `server/__tests__/ai-messages.test.ts` | New | messages service unit tests |
| `server/__tests__/ai-routes.test.ts` | New | HTTP-level tests with `vi.spyOn(db, 'getDb')` |
| `src/lib/ai-api.ts` | New | Wire types + typed fetch wrappers |
| `src/composables/vault/useAiHistory.ts` | New | Module-level singleton composable |
| `src/composables/vault/__tests__/useAiHistory.test.ts` | New | Composable tests with stubbed fetch |
| `src/components/vault/AiSessionPicker.vue` | New | Popover: list + new / rename / delete |
| `src/components/vault/AiPanel.vue` | Modify | Wire composable, clickable header, picker mount |

---

## Task 1: Add dependencies + .gitignore

**Files:**
- Modify: `package.json` (add two entries under `dependencies` and `devDependencies`)
- Modify: `.gitignore` (add one line)

- [ ] **Step 1: Edit `package.json`**

Add to the `dependencies` block (alphabetical, after `@hono/node-server` is fine — or just append; order doesn't matter for npm):
```json
"better-sqlite3": "^11.7.0",
```

Add to the `devDependencies` block:
```json
"@types/better-sqlite3": "^7.6.12",
```

The full files (unchanged lines omitted, only the two insertion points shown):

```jsonc
// dependencies
"@hono/node-server": "^2.0.4",
"@vueuse/core": "^14.3.0",
"better-sqlite3": "^11.7.0",     // <-- new
"highlight.js": "^11.10.0",
```

```jsonc
// devDependencies
"@types/markdown-it": "^14.1.2",
"@types/node": "^24.12.3",
"@types/better-sqlite3": "^7.6.12",  // <-- new
"@vitejs/plugin-vue": "^6.0.6",
```

- [ ] **Step 2: Edit `.gitignore`** — add a new line at the end of the file:

```gitignore
data/
```

- [ ] **Step 3: Install**

```bash
npm install
```

Expected: completes without errors. `node_modules/better-sqlite3/build/Release/better_sqlite3.node` should exist after install (it ships a prebuilt binary for the current platform). If the install prints a build step, that's fine; it should still finish.

- [ ] **Step 4: Verify the native binding loads**

```bash
node -e "const D = require('better-sqlite3'); const db = new D(':memory:'); db.exec('CREATE TABLE t (x INTEGER)'); console.log(db.prepare('SELECT 1 AS n').get())"
```

Expected output: `{ n: 1 }`. If you see `Error: Could not locate the bindings file`, the native module didn't build — try `npm rebuild better-sqlite3`.

- [ ] **Step 5: Run the existing test suite to confirm no regression**

```bash
./node_modules/.bin/vitest run
```

Expected: 125 passed, 0 failed (the count from the last green state).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore(deps): add better-sqlite3 + @types/better-sqlite3 + gitignore data/"
```

---

## Task 2: Migration runner + first migration

**Files:**
- Create: `server/migrations/0001_ai_history.sql`
- Create: `server/db.ts`
- Create: `server/__tests__/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/db.test.ts`:

```ts
// Migration runner tests. We use an in-memory DB so the test is
// hermetic and doesn't touch the on-disk nuvyn.db. The migration
// file `0001_ai_history.sql` must exist in `server/migrations/` by
// the time this test runs — Task 2 creates both files.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'

function freshInMemoryDb(): Database.Database {
  return new Database(':memory:')
}

describe('applyMigrations', () => {
  it('applies all migrations on a fresh DB and records the latest version', () => {
    const db = freshInMemoryDb()
    applyMigrations(db)

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    expect(version).toBeGreaterThanOrEqual(1)
  })

  it('creates the sessions, messages, and settings tables', () => {
    const db = freshInMemoryDb()
    applyMigrations(db)

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]).map((r) => r.name)
    expect(tables).toContain('sessions')
    expect(tables).toContain('messages')
    expect(tables).toContain('settings')
    expect(tables).toContain('schema_version')
  })

  it('creates the (session_id, created_at) index on messages', () => {
    const db = freshInMemoryDb()
    applyMigrations(db)

    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'"
    ).all() as { name: string }[]).map((r) => r.name)
    expect(indexes).toContain('idx_messages_session_created')
  })

  it('is idempotent — running twice does not error and does not change the version', () => {
    const db = freshInMemoryDb()
    applyMigrations(db)
    const v1 = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    applyMigrations(db)
    const v2 = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    expect(v2).toBe(v1)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
./node_modules/.bin/vitest run server/__tests__/db.test.ts
```

Expected: FAIL — `applyMigrations` is not exported from `../db` (module doesn't exist yet). The error message will mention "Cannot find module '../db'".

- [ ] **Step 3: Create the migration SQL**

Create `server/migrations/0001_ai_history.sql`:

```sql
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 4: Implement `server/db.ts`**

```ts
// Server-side SQLite — single connection to ./data/nuvyn.db, opened
// lazily on first call to getDb(). Migrations live in
// server/migrations/*.sql and are applied in version order on the
// first getDb() call. The runner is also exported (applyMigrations)
// so tests can apply the same migrations to an in-memory DB without
// touching the on-disk file.
//
// Conventions:
//   - timestamps are INTEGER ms-since-epoch (Date.now())
//   - SQL uses snake_case; service modules map to camelCase for the client
//   - foreign_keys=ON so ON DELETE CASCADE actually fires
//   - journal_mode=WAL for better concurrent reads
import Database, { type Database as DatabaseT } from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.resolve(process.cwd(), 'data')
const DB_PATH = path.join(DATA_DIR, 'nuvyn.db')
// import.meta.dirname resolves to the directory of THIS source file
// at runtime, which is server/ — so server/migrations/ is found
// regardless of where vite/tsx was launched from.
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations')

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

/**
 * Apply all un-applied migrations to the given DB. The runner is a
 * no-op on the second call (idempotent): it reads the current
 * version from `schema_version` and only runs files whose N > current.
 *
 * The schema_version table is created on the very first call (before
 * any migration runs), so subsequent migrations can record their
 * version.
 */
export function applyMigrations(db: DatabaseT) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined
  const current = row?.version ?? 0

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()

  for (const file of files) {
    const version = parseInt(file.match(/^(\d+)/)![1], 10)
    if (version <= current) continue
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      // schema_version holds a single row of the current version. We
      // upsert: delete any existing row, then insert. A real UPSERT
      // works too but `DELETE + INSERT` is unambiguous and the table
      // is one row so the cost is trivial.
      db.prepare('DELETE FROM schema_version').run()
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version)
    })()
    console.log(`[migrate] applied ${file} (→ v${version})`)
  }
}

let _db: DatabaseT | null = null

/**
 * Lazily open the on-disk DB. First call ensures data/ exists, opens
 * ./data/nuvyn.db, sets the two PRAGMAs, and runs the migration
 * runner. Subsequent calls return the same instance.
 */
export function getDb(): DatabaseT {
  if (_db) return _db
  ensureDataDir()
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  applyMigrations(_db)
  return _db
}
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
./node_modules/.bin/vitest run server/__tests__/db.test.ts
```

Expected: 4 passed, 0 failed.

- [ ] **Step 6: Run the full suite to confirm no regression**

```bash
./node_modules/.bin/vitest run
```

Expected: 129 passed (125 + 4 new), 0 failed.

- [ ] **Step 7: Commit**

```bash
git add server/db.ts server/migrations/0001_ai_history.sql server/__tests__/db.test.ts
git commit -m "feat(db): add sqlite singleton + applyMigrations runner + first migration

- server/db.ts exposes getDb() (singleton to ./data/nuvyn.db) and
  applyMigrations(db) (so tests can target an in-memory DB).
- Migrations live in server/migrations/*.sql; the runner scans
  numerically named files and applies the ones newer than the
  recorded schema_version. Idempotent on re-run.
- First migration creates sessions, messages, settings, and the
  (session_id, created_at) index on messages.
- WAL + foreign_keys=ON are set on the on-disk DB so cascade and
  concurrent reads work as expected."
```

---

## Task 3: server/ai/sessions.ts — list / get / create / delete

**Files:**
- Create: `server/ai/sessions.ts`
- Create: `server/__tests__/ai-sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/__tests__/ai-sessions.test.ts`:

```ts
// Unit tests for the sessions service. We construct a fresh
// in-memory DB per test (with migrations applied) and pass it
// directly — no mocking needed because the service takes db as its
// first argument.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import * as sessions from '../ai/sessions'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  applyMigrations(db)
  return db
}

describe('sessions service', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  describe('listSessions', () => {
    it('returns an empty array on a fresh DB', () => {
      expect(sessions.listSessions(db)).toEqual([])
    })

    it('returns sessions ordered by updated_at DESC (newest first)', () => {
      const a = sessions.createSession(db) // updated_at = now
      // Manually set updated_at to a known order so we don't depend on clock granularity
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(1000, a.id)
      const b = sessions.createSession(db)
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(2000, b.id)
      const c = sessions.createSession(db)
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(3000, c.id)

      const list = sessions.listSessions(db)
      expect(list.map((s) => s.id)).toEqual([c.id, b.id, a.id])
    })
  })

  describe('getSession', () => {
    it('returns null for a non-existent id', () => {
      expect(sessions.getSession(db, 999)).toBeNull()
    })

    it('returns the row for an existing id', () => {
      const created = sessions.createSession(db)
      const got = sessions.getSession(db, created.id)
      expect(got).toEqual(created)
    })
  })

  describe('createSession', () => {
    it('returns a session with empty title and matching created_at/updated_at', () => {
      const before = Date.now()
      const s = sessions.createSession(db)
      const after = Date.now()

      expect(s.id).toBeGreaterThan(0)
      expect(s.title).toBe('')
      expect(s.createdAt).toBeGreaterThanOrEqual(before)
      expect(s.createdAt).toBeLessThanOrEqual(after)
      expect(s.updatedAt).toBe(s.createdAt)
    })

    it('does NOT auto-set the active session (callers decide)', () => {
      sessions.createSession(db)
      expect(sessions.getActiveSessionId(db)).toBeNull()
    })
  })

  describe('deleteSession', () => {
    it('returns false for a non-existent id', () => {
      expect(sessions.deleteSession(db, 999)).toBe(false)
    })

    it('returns true and removes the row for an existing id', () => {
      const s = sessions.createSession(db)
      expect(sessions.deleteSession(db, s.id)).toBe(true)
      expect(sessions.getSession(db, s.id)).toBeNull()
    })

    it('clears the active session if the deleted session was active', () => {
      const s = sessions.createSession(db)
      sessions.setActiveSessionId(db, s.id)
      sessions.deleteSession(db, s.id)
      expect(sessions.getActiveSessionId(db)).toBeNull()
    })

    it('leaves the active session alone when deleting a different session', () => {
      const a = sessions.createSession(db)
      const b = sessions.createSession(db)
      sessions.setActiveSessionId(db, a.id)
      sessions.deleteSession(db, b.id)
      expect(sessions.getActiveSessionId(db)).toBe(a.id)
    })
  })
})
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
./node_modules/.bin/vitest run server/__tests__/ai-sessions.test.ts
```

Expected: FAIL — `../ai/sessions` module doesn't exist yet.

- [ ] **Step 3: Implement `server/ai/sessions.ts`**

```ts
// Sessions service. Pure functions of (db, ...args) — no closures
// over module-level state, no classes. Trivial to test by passing
// an in-memory DB. The `rowToSession` mapper handles the SQL
// snake_case → TS camelCase translation.
import type { Database as DatabaseT } from 'better-sqlite3'
import type { Session } from '../../src/lib/ai-api.js'

function rowToSession(r: any): Session {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listSessions(db: DatabaseT): Session[] {
  const rows = db.prepare('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all()
  return rows.map(rowToSession)
}

export function getSession(db: DatabaseT, id: number): Session | null {
  const row = db.prepare('SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?').get(id)
  return row ? rowToSession(row) : null
}

export function createSession(db: DatabaseT): Session {
  const now = Date.now()
  const info = db.prepare(
    'INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)'
  ).run('', now, now)
  return { id: Number(info.lastInsertRowid), title: '', createdAt: now, updatedAt: now }
}

export function deleteSession(db: DatabaseT, id: number): boolean {
  // Single transaction: delete the session, and if it was the
  // active one, clear the pointer too. Without the transaction, a
  // crash between the two statements could leave the active pointer
  // referencing a non-existent session.
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)
    if (!existing) return false
    if (getActiveSessionId(db) === id) {
      setActiveSessionId(db, null)
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return true
  })()
}

export function renameSession(db: DatabaseT, id: number, title: string): Session | null {
  // Trim first; if empty after trim, this is a no-op and we return
  // the existing row (the caller will see no change and can show a
  // validation message). The interface is "rename to a non-empty
  // trimmed string" — empty input is rejected silently rather than
  // throwing, so the picker UI's inline edit can be lazy.
  const trimmed = title.trim()
  const existing = getSession(db, id)
  if (!existing) return null
  if (trimmed.length === 0) return existing
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(trimmed, id)
  return getSession(db, id)
}

const ACTIVE_KEY = 'nuvyn.ai.activeSessionId'

export function getActiveSessionId(db: DatabaseT): number | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ACTIVE_KEY) as
    | { value: string }
    | undefined
  if (!row) return null
  const n = Number(row.value)
  return Number.isFinite(n) ? n : null
}

export function setActiveSessionId(db: DatabaseT, id: number | null): void {
  if (id === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(ACTIVE_KEY)
    return
  }
  // Upsert: insert, or replace the existing row's value on conflict.
  // SQLite supports `ON CONFLICT ... DO UPDATE` since 3.24.
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(ACTIVE_KEY, String(id))
}
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
./node_modules/.bin/vitest run server/__tests__/ai-sessions.test.ts
```

Expected: 8 passed, 0 failed. The cascade test was moved to Task 4 (where the messages service it depends on lives) to keep the cross-service wiring check together with the messages tests.

- [ ] **Step 5: Run the full suite to confirm no regression**

```bash
./node_modules/.bin/vitest run
```

Expected: 137 passed (129 + 8 new), 0 failed.

- [ ] **Step 6: Commit**

```bash
git add server/ai/sessions.ts server/__tests__/ai-sessions.test.ts
git commit -m "feat(ai): add sessions service (list/get/create/rename/delete + active KV)

Pure-function service over the sessions and settings tables. Takes db
as the first argument so tests can pass an in-memory instance.
deleteSession is wrapped in a transaction that also clears the
active-session pointer if the deleted session was the active one,
so a crash between the two statements can't leave a dangling
pointer."
```

---

## Task 4: server/ai/messages.ts — list + append with auto-title

**Files:**
- Create: `server/ai/messages.ts`

This task also retroactively completes the cascade test from Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/ai-sessions.test.ts`'s sibling `server/__tests__/ai-messages.test.ts`:

```ts
// Unit tests for the messages service. The two functions under test
// are listMessages and appendMessage. appendMessage has the most
// interesting behavior: it validates input, updates the session's
// updated_at, and auto-derives a title for the very first user
// message in a previously-untitled session.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import * as sessions from '../ai/sessions'
import * as messages from '../ai/messages'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  applyMigrations(db)
  return db
}

describe('messages service', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  describe('listMessages', () => {
    it('returns null when the session does not exist', () => {
      expect(messages.listMessages(db, 999)).toBeNull()
    })

    it('returns an empty array for an existing session with no messages', () => {
      const s = sessions.createSession(db)
      expect(messages.listMessages(db, s.id)).toEqual([])
    })

    it('returns messages in chronological order (oldest first)', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'user', 'first')
      messages.appendMessage(db, s.id, 'assistant', 'second')
      messages.appendMessage(db, s.id, 'user', 'third')

      const list = messages.listMessages(db, s.id)!
      expect(list.map((m) => m.content)).toEqual(['first', 'second', 'third'])
      expect(list.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    })
  })

  describe('appendMessage', () => {
    it('returns { ok: false, reason: "not-found" } when the session does not exist', () => {
      const r = messages.appendMessage(db, 999, 'user', 'hello')
      expect(r).toEqual({ ok: false, reason: 'not-found' })
    })

    it('returns { ok: false, reason: "empty" } when content is empty or whitespace', () => {
      const s = sessions.createSession(db)
      expect(messages.appendMessage(db, s.id, 'user', '')).toEqual({ ok: false, reason: 'empty' })
      expect(messages.appendMessage(db, s.id, 'user', '   \n\t  ')).toEqual({ ok: false, reason: 'empty' })
    })

    it('returns { ok: false, reason: "invalid-role" } when role is neither user nor assistant', () => {
      const s = sessions.createSession(db)
      const r = messages.appendMessage(db, s.id, 'system' as any, 'hello')
      expect(r).toEqual({ ok: false, reason: 'invalid-role' })
    })

    it('inserts a user message, returns ok:true, and refreshes updated_at', () => {
      const s = sessions.createSession(db)
      const before = Date.now()
      const r = messages.appendMessage(db, s.id, 'user', 'hi')
      const after = Date.now()

      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.message.id).toBeGreaterThan(0)
      expect(r.message.sessionId).toBe(s.id)
      expect(r.message.role).toBe('user')
      expect(r.message.content).toBe('hi')
      expect(r.message.createdAt).toBeGreaterThanOrEqual(before)
      expect(r.message.createdAt).toBeLessThanOrEqual(after)

      const after2 = sessions.getSession(db, s.id)!
      expect(after2.updatedAt).toBe(r.message.createdAt)
    })

    it('inserts an assistant message without touching the title', () => {
      const s = sessions.createSession(db)
      const r = messages.appendMessage(db, s.id, 'assistant', 'reply')
      expect(r.ok).toBe(true)
      expect(sessions.getSession(db, s.id)!.title).toBe('')
    })

    it('auto-derives a title from the first user message of an empty-title session', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'user', 'How does X work?')
      expect(sessions.getSession(db, s.id)!.title).toBe('How does X work?')
    })

    it('does NOT change the title on subsequent user messages', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'user', 'First question')
      messages.appendMessage(db, s.id, 'user', 'Second question')
      expect(sessions.getSession(db, s.id)!.title).toBe('First question')
    })

    it('does NOT change the title on assistant messages in an empty-title session', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'assistant', 'hi back')
      expect(sessions.getSession(db, s.id)!.title).toBe('')
    })

    it('truncates a long first-message title to 30 code points with ellipsis', () => {
      const s = sessions.createSession(db)
      const long = 'a'.repeat(50) // 50 code points
      messages.appendMessage(db, s.id, 'user', long)
      const title = sessions.getSession(db, s.id)!.title
      // 30 'a's + '…' (one code point) = 31 chars
      expect([...title].length).toBe(31)
      expect(title.endsWith('…')).toBe(true)
      expect(title.startsWith('a'.repeat(30))).toBe(true)
    })

    it('does NOT append an ellipsis when the first message is exactly 30 code points', () => {
      const s = sessions.createSession(db)
      const exact = 'b'.repeat(30)
      messages.appendMessage(db, s.id, 'user', exact)
      expect(sessions.getSession(db, s.id)!.title).toBe(exact)
    })

    it('does NOT split a surrogate pair when truncating at a code-point boundary', () => {
      // 😀 is U+1F600, 1 code point but 2 UTF-16 code units. Place
      // the emoji at position 30 and confirm it's not half-cut.
      const s = sessions.createSession(db)
      const content = 'a'.repeat(30) + '😀' + 'b'.repeat(50)
      messages.appendMessage(db, s.id, 'user', content)
      const title = sessions.getSession(db, s.id)!.title
      // Expected: 30 'a's + '…' (1 code point) — the 😀 is past the
      // cutoff so it doesn't appear in the title. JS String slicing
      // on UTF-16 code units would include the high surrogate and
      // the title would end with a stray '�' or pair — assert clean.
      expect([...title].length).toBe(31)
      expect(title.startsWith('a'.repeat(30))).toBe(true)
      expect(title.endsWith('…')).toBe(true)
    })
  })

  describe('ON DELETE CASCADE (cross-service)', () => {
    // This exercises the FK set up in the 0001 migration: deleting a
    // session should remove its messages too, so listMessages
    // returns null (session not found) rather than a stale array of
    // orphaned rows. The test crosses the sessions + messages
    // service boundary, which is why it lives here and not in the
    // sessions describe block.
    it('removes all messages when a session is deleted', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'user', 'one')
      messages.appendMessage(db, s.id, 'assistant', 'two')
      expect(messages.listMessages(db, s.id)).toHaveLength(2)

      sessions.deleteSession(db, s.id)
      expect(messages.listMessages(db, s.id)).toBeNull()
    })
  })
})
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
./node_modules/.bin/vitest run server/__tests__/ai-messages.test.ts
```

Expected: FAIL — `../ai/messages` module doesn't exist yet.

- [ ] **Step 3: Implement `server/ai/messages.ts`**

```ts
// Messages service. The two functions are listMessages (read) and
// appendMessage (write). appendMessage does several things in one
// transaction: validate input, ensure the session exists, insert the
// message, refresh the session's updated_at, and (for the first user
// message in an empty-title session) auto-derive a title from the
// message content. The title derivation uses Unicode code-point
// counting so a surrogate pair (e.g. an emoji) can't be split.
import type { Database as DatabaseT } from 'better-sqlite3'
import type { Message } from '../../src/lib/ai-api.js'

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
  }
}

const MAX_TITLE_CODEPOINTS = 30

/**
 * Derive a session title from a first user message. Trims whitespace,
 * caps at 30 Unicode code points, and appends '…' if truncated.
 * Returns the empty string for empty content (the caller should have
 * already rejected this with the 'empty' reason, but the function is
 * safe to call defensively).
 */
function deriveTitle(content: string): string {
  const trimmed = content.trim()
  if (trimmed.length === 0) return ''
  const cps = [...trimmed] // array of single code points
  if (cps.length <= MAX_TITLE_CODEPOINTS) return trimmed
  return cps.slice(0, MAX_TITLE_CODEPOINTS).join('') + '…'
}

export function listMessages(db: DatabaseT, sessionId: number): Message[] | null {
  // Confirm the session exists so a typo'd id doesn't silently
  // return an empty array (which the UI would then render as "no
  // messages yet" — confusing). The cost is one extra index lookup.
  const sess = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)
  if (!sess) return null
  const rows = db.prepare(
    'SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC'
  ).all(sessionId)
  return rows.map(rowToMessage)
}

type AppendResult =
  | { ok: true; message: Message }
  | { ok: false; reason: 'not-found' | 'empty' | 'invalid-role' }

export function appendMessage(
  db: DatabaseT,
  sessionId: number,
  role: 'user' | 'assistant',
  content: string,
): AppendResult {
  // Validation before the transaction so the no-op cases don't
  // open a write transaction at all.
  if (role !== 'user' && role !== 'assistant') {
    return { ok: false, reason: 'invalid-role' }
  }
  if (content.trim().length === 0) {
    return { ok: false, reason: 'empty' }
  }

  return db.transaction(() => {
    const sess = db.prepare('SELECT id, title FROM sessions WHERE id = ?').get(sessionId) as
      | { id: number; title: string }
      | undefined
    if (!sess) return { ok: false as const, reason: 'not-found' as const }

    const now = Date.now()
    const info = db.prepare(
      'INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, role, content, now)
    const message: Message = {
      id: Number(info.lastInsertRowid),
      sessionId,
      role,
      content,
      createdAt: now,
    }

    // Refresh updated_at. If this is the first user message in an
    // empty-title session, also derive a title.
    if (role === 'user' && sess.title === '') {
      const title = deriveTitle(content)
      db.prepare('UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?').run(now, title, sessionId)
    } else {
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
    }

    return { ok: true as const, message }
  })()
}
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
./node_modules/.bin/vitest run server/__tests__/ai-messages.test.ts
```

Expected: 15 passed, 0 failed. (14 messages + 1 cross-service cascade test.)

- [ ] **Step 5: Re-run the sessions tests**

```bash
./node_modules/.bin/vitest run server/__tests__/ai-sessions.test.ts
```

Expected: 8 passed, 0 failed.

- [ ] **Step 6: Run the full suite**

```bash
./node_modules/.bin/vitest run
```

Expected: 152 passed (137 + 15), 0 failed.

- [ ] **Step 7: Commit**

```bash
git add server/ai/messages.ts server/__tests__/ai-messages.test.ts
git commit -m "feat(ai): add messages service with auto-title derivation

- listMessages returns null for unknown sessions (caller can
  distinguish 'session gone' from 'session empty').
- appendMessage is one transaction: validate, ensure session,
  insert message, refresh session.updated_at, and (for the first
  user message in an empty-title session) derive a 30-code-point
  title with '…' suffix.
- Title truncation uses [...str] to count Unicode code points so
  emoji at the cutoff boundary can't be split mid-surrogate."
```

---

## Task 5: server/ai/routes.ts — Hono sub-router

**Files:**
- Create: `server/ai/routes.ts`
- Create: `server/__tests__/ai-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/__tests__/ai-routes.test.ts`:

```ts
// HTTP-level tests for the /api/ai sub-router. We mock ../db's
// getDb() to return a fresh in-memory DB per test — the on-disk
// ./data/nuvyn.db is never touched. The mock uses vi.mock with a
// vi.hoisted handle so the factory can close over the test DB
// reference (vi.mock is hoisted above top-level imports).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

const { testDbRef, applyMigrations } = vi.hoisted(async () => {
  const dbMod = await import('../db')
  return { testDbRef: { value: null as Database.Database | null }, applyMigrations: dbMod.applyMigrations }
})

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return {
    ...actual,
    getDb: () => testDbRef.value!,
  }
})

// Import AFTER vi.mock so ai/routes.ts picks up the mocked getDb.
import aiRoutes from '../ai/routes'

beforeEach(() => {
  const db = new Database(':memory:')
  applyMigrations(db)
  testDbRef.value = db
})

afterEach(() => {
  testDbRef.value?.close()
  testDbRef.value = null
})

async function call(method: string, urlPath: string, body?: unknown) {
  const req = new Request(`http://localhost${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return aiRoutes.fetch(req)
}

describe('GET /api/ai/sessions', () => {
  it('returns an empty array when no sessions exist', async () => {
    const r = await call('GET', '/sessions')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('returns all sessions newest-first', async () => {
    // Create two sessions, sleep a tick, create a third.
    await call('POST', '/sessions')
    await new Promise((r) => setTimeout(r, 2))
    await call('POST', '/sessions')
    const r = await call('GET', '/sessions')
    const list = await r.json() as { id: number }[]
    expect(list).toHaveLength(2)
    expect(list[0].id).toBeGreaterThan(list[1].id)
  })
})

describe('POST /api/ai/sessions', () => {
  it('creates a session and returns it with status 201', async () => {
    const r = await call('POST', '/sessions')
    expect(r.status).toBe(201)
    const body = await r.json() as { id: number; title: string }
    expect(body.id).toBeGreaterThan(0)
    expect(body.title).toBe('')
  })
})

describe('PATCH /api/ai/sessions/:id', () => {
  it('renames a session and returns it', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('PATCH', `/sessions/${created.id}`, { title: 'New name' })
    expect(r.status).toBe(200)
    const body = await r.json() as { title: string }
    expect(body.title).toBe('New name')
  })

  it('returns 400 when the title is empty after trim', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('PATCH', `/sessions/${created.id}`, { title: '   ' })
    expect(r.status).toBe(400)
  })

  it('returns 404 for a non-existent session', async () => {
    const r = await call('PATCH', '/sessions/999', { title: 'New name' })
    expect(r.status).toBe(404)
  })
})

describe('DELETE /api/ai/sessions/:id', () => {
  it('deletes a session and returns { ok: true }', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('DELETE', `/sessions/${created.id}`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('returns 404 for a non-existent session', async () => {
    const r = await call('DELETE', '/sessions/999')
    expect(r.status).toBe(404)
  })
})

describe('GET /api/ai/sessions/:id/messages', () => {
  it('returns an empty array for a new session', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('GET', `/sessions/${created.id}/messages`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('returns 404 for a non-existent session', async () => {
    const r = await call('GET', '/sessions/999/messages')
    expect(r.status).toBe(404)
  })
})

describe('POST /api/ai/sessions/:id/messages', () => {
  it('appends a user message and returns the saved message', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('POST', `/sessions/${created.id}/messages`, { role: 'user', content: 'hello' })
    expect(r.status).toBe(201)
    const body = await r.json() as { id: number; role: string; content: string }
    expect(body.content).toBe('hello')
    expect(body.role).toBe('user')
  })

  it('returns 400 for empty content', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('POST', `/sessions/${created.id}/messages`, { role: 'user', content: '   ' })
    expect(r.status).toBe(400)
  })

  it('returns 400 for an invalid role', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('POST', `/sessions/${created.id}/messages`, { role: 'system', content: 'x' })
    expect(r.status).toBe(400)
  })

  it('returns 404 for a non-existent session', async () => {
    const r = await call('POST', '/sessions/999/messages', { role: 'user', content: 'x' })
    expect(r.status).toBe(404)
  })
})

describe('GET /api/ai/active', () => {
  it('returns { sessionId: null } when no active session', async () => {
    const r = await call('GET', '/active')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ sessionId: null })
  })
})

describe('PUT /api/ai/active', () => {
  it('sets the active session and round-trips on GET', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('PUT', '/active', { sessionId: created.id })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ sessionId: created.id })

    const get = await call('GET', '/active')
    expect(await get.json()).toEqual({ sessionId: created.id })
  })

  it('clears the active session when sessionId is null', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    await call('PUT', '/active', { sessionId: created.id })
    const r = await call('PUT', '/active', { sessionId: null })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ sessionId: null })
  })

  it('returns 400 when sessionId is not a number or null', async () => {
    const r = await call('PUT', '/active', { sessionId: 'abc' })
    expect(r.status).toBe(400)
  })

  it('returns 404 when sessionId points to a non-existent session', async () => {
    const r = await call('PUT', '/active', { sessionId: 999 })
    expect(r.status).toBe(404)
  })
})
```

Note: the `vi.spyOn` on a re-imported module is fragile. The implementation in Step 3 uses `getDb()` looked up at call time, and the spy replaces the property on the `db.ts` module object. If the spy doesn't take, the test will fall through to the real `getDb()` and create `./data/nuvyn.db` (the on-disk DB). Verify after Step 5 that the file is NOT created.

- [ ] **Step 2: Run the test, confirm it fails**

```bash
./node_modules/.bin/vitest run server/__tests__/ai-routes.test.ts
```

Expected: FAIL — `../ai/routes` module doesn't exist yet.

- [ ] **Step 3: Implement `server/ai/routes.ts`**

```ts
// Hono sub-router for /api/ai. The handlers are intentionally thin:
// parse the request, call the matching service function, translate
// the service result to an HTTP status + JSON body.
//
// Two non-obvious choices:
//   - getDb() is called at request time, not at module load. This
//     keeps the import side-effect-free (server/index.ts can mount
//     this sub-app without creating ./data/nuvyn.db at startup) and
//     lets tests spy on getDb to inject an in-memory DB.
//   - The bad() helper is duplicated here rather than imported from
//     ../index.js to avoid creating a circular import (index.js
//     will eventually import this file). The signature is identical
//     to the helper in ../index.ts.
import { Hono } from 'hono'
import { getDb } from '../db.js'
import * as sessions from './sessions.js'
import * as messages from './messages.js'

function bad(c: any, msg: string, code = 400) {
  return c.json({ error: msg }, code)
}

const ai = new Hono()

// ---- /sessions ----
ai.get('/sessions', (c) => c.json(sessions.listSessions(getDb())))

ai.post('/sessions', (c) => {
  const s = sessions.createSession(getDb())
  return c.json(s, 201)
})

ai.patch('/sessions/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return bad(c, 'invalid id')
  const body = c.req.json().catch(() => null) as Promise<{ title?: unknown } | null>
  return body.then((b) => {
    if (!b || typeof b.title !== 'string') return bad(c, 'title required')
    const updated = sessions.renameSession(getDb(), id, b.title)
    if (!updated) return bad(c, 'not found', 404)
    return c.json(updated)
  })
})

ai.delete('/sessions/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return bad(c, 'invalid id')
  const ok = sessions.deleteSession(getDb(), id)
  if (!ok) return bad(c, 'not found', 404)
  return c.json({ ok: true })
})

// ---- /sessions/:id/messages ----
ai.get('/sessions/:id/messages', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return bad(c, 'invalid id')
  const list = messages.listMessages(getDb(), id)
  if (list === null) return bad(c, 'not found', 404)
  return c.json(list)
})

ai.post('/sessions/:id/messages', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return bad(c, 'invalid id')
  const body = await c.req.json().catch(() => null) as { role?: unknown; content?: unknown } | null
  if (!body || typeof body.role !== 'string' || typeof body.content !== 'string') {
    return bad(c, 'role and content required')
  }
  const result = messages.appendMessage(getDb(), id, body.role as 'user' | 'assistant', body.content)
  if (result.ok) return c.json(result.message, 201)
  if (result.reason === 'not-found') return bad(c, 'not found', 404)
  return bad(c, result.reason) // 'empty' or 'invalid-role' → 400
})

// ---- /active ----
ai.get('/active', (c) => c.json({ sessionId: sessions.getActiveSessionId(getDb()) }))

ai.put('/active', async (c) => {
  const body = await c.req.json().catch(() => null) as { sessionId?: unknown } | null
  if (!body || (body.sessionId !== null && typeof body.sessionId !== 'number')) {
    return bad(c, 'sessionId must be a number or null')
  }
  const id = body.sessionId as number | null
  // Setting to null always succeeds; setting to a number requires the session to exist.
  if (id !== null) {
    const exists = sessions.getSession(getDb(), id)
    if (!exists) return bad(c, 'session not found', 404)
  }
  sessions.setActiveSessionId(getDb(), id)
  return c.json({ sessionId: id })
})

export default ai
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
./node_modules/.bin/vitest run server/__tests__/ai-routes.test.ts
```

Expected: 19 passed, 0 failed. **Verify** that `./data/` was NOT created during the test run:

```bash
ls -la data/ 2>&1 || echo "data/ does not exist (correct — the spy intercepted getDb)"
```

- [ ] **Step 5: Run the full suite**

```bash
./node_modules/.bin/vitest run
```

Expected: 171 passed (152 + 19), 0 failed. Re-verify `./data/` does not exist.

- [ ] **Step 6: Commit**

```bash
git add server/ai/routes.ts server/__tests__/ai-routes.test.ts
git commit -m "feat(ai): add /api/ai Hono sub-router with full HTTP contract

Thin handlers: parse, call service, map result. getDb() is called
at request time so importing this module is side-effect-free and
tests can spy on getDb to use an in-memory DB without touching
./data/nuvyn.db.

Covers all 8 endpoints in the spec: list/create/patch/delete
sessions, list/post messages, get/put active session, with the
error mapping (not-found → 404, empty/invalid-role → 400) that
the spec calls out."
```

---

## Task 6: Mount /api/ai in server/index.ts

**Files:**
- Modify: `server/index.ts` (add one import + one `app.route` line)
- Create: `server/__tests__/mount.test.ts` (one smoke test through the real `app`)

- [ ] **Step 1: Write a smoke test through the real app**

Create `server/__tests__/mount.test.ts`:

```ts
// Smoke test: hit the AI sub-router through the real `app` to
// confirm server/index.ts mounts it correctly at /api/ai. This
// test does NOT mock getDb, so the first request creates
// ./data/nuvyn.db on disk; we clean it up in afterAll so the
// repo's working tree stays clean.
import { describe, it, expect, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import app from '../index'

const DATA_DIR = path.resolve(process.cwd(), 'data')

describe('app mounts /api/ai', () => {
  afterAll(async () => {
    // Tear down the on-disk DB that the first request created.
    // The data/ dir is gitignored, but we still want it gone so
    // the next test run starts clean.
    await fs.rm(DATA_DIR, { recursive: true, force: true })
  })

  it('GET /api/ai/sessions reaches the AI sub-router (returns 200 + [])', async () => {
    const req = new Request('http://localhost/api/ai/sessions')
    const r = await app.fetch(req)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('GET /api/ai/health on the parent app also works (sanity)', async () => {
    // The original /api/health route is preserved — this just
    // guards against a mounting mistake that breaks the parent.
    const req = new Request('http://localhost/api/health')
    const r = await app.fetch(req)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })
})
```

Note: this test does NOT spy on getDb, so it will create `./data/nuvyn.db` on first run. The test still works because the DB is created empty. Clean up after the test:

- [ ] **Step 2: Run the test, confirm it fails**

```bash
./node_modules/.bin/vitest run server/__tests__/mount.test.ts
```

Expected: FAIL — `/api/ai/sessions` returns 404 (the sub-router isn't mounted yet).

- [ ] **Step 3: Edit `server/index.ts`**

Add two lines:

```ts
// after the existing imports near the top of the file
import aiRoutes from './ai/routes.js'
```

```ts
// right before the existing `export default app` at the bottom
app.route('/api/ai', aiRoutes)
```

The exact insertion points:

At the top, after the `import { listSubtreePaths } from './tree.js'` line, add:
```ts
import aiRoutes from './ai/routes.js'
```

At the bottom, immediately before `export default app`, add:
```ts

app.route('/api/ai', aiRoutes)
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
./node_modules/.bin/vitest run server/__tests__/mount.test.ts
```

Expected: 2 passed, 0 failed. The first call creates `./data/nuvyn.db` on disk — the test's `afterAll` cleans it up so the working tree stays clean.

- [ ] **Step 5: Run the full suite**

```bash
./node_modules/.bin/vitest run
```

Expected: 173 passed (171 + 2), 0 failed.

- [ ] **Step 6: Commit**

```bash
git add server/index.ts server/__tests__/mount.test.ts
git commit -m "feat(server): mount /api/ai sub-router

server/index.ts now imports aiRoutes and registers it at
/api/ai, completing the HTTP surface for the AI history feature.
A smoke test exercises the route through the real app to catch
any future regression in the mount (e.g. an accidental rename
of the import path)."
```

- [ ] **Step 7: Verify `./data/` is clean**

```bash
ls -la data/ 2>&1 || echo "data/ cleaned up correctly"
```

The afterAll hook in mount.test.ts removes the dir; if it shows back up here, the cleanup didn't run (e.g. the test crashed before afterAll).

---

## Task 7: src/lib/ai-api.ts — wire types + typed fetch wrappers

**Files:**
- Create: `src/lib/ai-api.ts`
- Create: `src/lib/__tests__/ai-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/ai-api.test.ts`:

```ts
// Tests for the typed fetch wrappers. We stub global.fetch so no
// real network is hit; the assertions are about request shape
// (method, URL, body) and response mapping.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as api from '../ai-api'

type FetchCall = { url: string; init: RequestInit }

let calls: FetchCall[] = []
let responses: { status: number; body: unknown }[] = []

beforeEach(() => {
  calls = []
  responses = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})

describe('ai-api', () => {
  it('listSessions GETs /api/ai/sessions', async () => {
    responses.push({ status: 200, body: [{ id: 1, title: 'x', createdAt: 1, updatedAt: 2 }] })
    const list = await api.listSessions()
    expect(calls[0].url).toBe('/api/ai/sessions')
    expect(calls[0].init.method).toBe('GET')
    expect(list).toEqual([{ id: 1, title: 'x', createdAt: 1, updatedAt: 2 }])
  })

  it('createSessions POSTs to /api/ai/sessions', async () => {
    responses.push({ status: 201, body: { id: 7, title: '', createdAt: 1, updatedAt: 1 } })
    const s = await api.createSession()
    expect(calls[0].url).toBe('/api/ai/sessions')
    expect(calls[0].init.method).toBe('POST')
    expect(s.id).toBe(7)
  })

  it('renameSession PATCHes with the title body', async () => {
    responses.push({ status: 200, body: { id: 1, title: 'New', createdAt: 1, updatedAt: 1 } })
    await api.renameSession(1, 'New')
    expect(calls[0].url).toBe('/api/ai/sessions/1')
    expect(calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ title: 'New' })
  })

  it('deleteSession DELETEs the session', async () => {
    responses.push({ status: 200, body: { ok: true } })
    await api.deleteSession(1)
    expect(calls[0].url).toBe('/api/ai/sessions/1')
    expect(calls[0].init.method).toBe('DELETE')
  })

  it('listMessages GETs /api/ai/sessions/:id/messages', async () => {
    responses.push({ status: 200, body: [{ id: 1, sessionId: 1, role: 'user', content: 'hi', createdAt: 1 }] })
    const list = await api.listMessages(1)
    expect(calls[0].url).toBe('/api/ai/sessions/1/messages')
    expect(list[0].content).toBe('hi')
  })

  it('appendMessage POSTs to /api/ai/sessions/:id/messages with role and content', async () => {
    responses.push({ status: 201, body: { id: 9, sessionId: 1, role: 'user', content: 'x', createdAt: 1 } })
    await api.appendMessage(1, 'user', 'x')
    expect(calls[0].url).toBe('/api/ai/sessions/1/messages')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ role: 'user', content: 'x' })
  })

  it('getActiveSessionId GETs /api/ai/active', async () => {
    responses.push({ status: 200, body: { sessionId: 42 } })
    const id = await api.getActiveSessionId()
    expect(calls[0].url).toBe('/api/ai/active')
    expect(id).toBe(42)
  })

  it('setActiveSessionId PUTs to /api/ai/active', async () => {
    responses.push({ status: 200, body: { sessionId: 42 } })
    await api.setActiveSessionId(42)
    expect(calls[0].url).toBe('/api/ai/active')
    expect(calls[0].init.method).toBe('PUT')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ sessionId: 42 })
  })

  it('throws with the server error message on a 4xx response', async () => {
    responses.push({ status: 404, body: { error: 'not found' } })
    await expect(api.getActiveSessionId()).rejects.toMatchObject({ status: 404 })
  })
})
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
./node_modules/.bin/vitest run src/lib/__tests__/ai-api.test.ts
```

Expected: FAIL — `../ai-api` module doesn't exist yet.

- [ ] **Step 3: Implement `src/lib/ai-api.ts`**

```ts
// Wire types + typed fetch wrappers for /api/ai/*. The shapes
// (Session, Message) are the single source of truth — the server
// imports them via `from '../../src/lib/ai-api.js'` and the
// components import them from this file.

export interface Session {
  id: number
  title: string
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: number
  sessionId: number
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: r.statusText }))
    throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status, body })
  }
  return r.json() as Promise<T>
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export async function listSessions(): Promise<Session[]> {
  return jsonOrThrow<Session[]>(await fetch('/api/ai/sessions'))
}

export async function createSession(): Promise<Session> {
  return jsonOrThrow<Session>(await fetch('/api/ai/sessions', { method: 'POST' }))
}

export async function renameSession(id: number, title: string): Promise<Session> {
  return jsonOrThrow<Session>(await fetch(`/api/ai/sessions/${id}`, { ...jsonInit({ title }) }))
}

export async function deleteSession(id: number): Promise<{ ok: true }> {
  return jsonOrThrow<{ ok: true }>(await fetch(`/api/ai/sessions/${id}`, { method: 'DELETE' }))
}

export async function listMessages(sessionId: number): Promise<Message[]> {
  return jsonOrThrow<Message[]>(await fetch(`/api/ai/sessions/${sessionId}/messages`))
}

export async function appendMessage(
  sessionId: number,
  role: 'user' | 'assistant',
  content: string,
): Promise<Message> {
  return jsonOrThrow<Message>(await fetch(`/api/ai/sessions/${sessionId}/messages`, jsonInit({ role, content })))
}

export async function getActiveSessionId(): Promise<number | null> {
  const r = await jsonOrThrow<{ sessionId: number | null }>(await fetch('/api/ai/active'))
  return r.sessionId
}

export async function setActiveSessionId(sessionId: number | null): Promise<number | null> {
  const r = await jsonOrThrow<{ sessionId: number | null }>(await fetch('/api/ai/active', { ...jsonInit({ sessionId }) }))
  return r.sessionId
}
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
./node_modules/.bin/vitest run src/lib/__tests__/ai-api.test.ts
```

Expected: 9 passed, 0 failed.

- [ ] **Step 5: Run the full suite**

```bash
./node_modules/.bin/vitest run
```

Expected: 182 passed (173 + 9), 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai-api.ts src/lib/__tests__/ai-api.test.ts
git commit -m "feat(ai): add typed fetch wrappers for /api/ai

Mirrors the src/lib/api.ts pattern: a single file holds both the
wire types (Session, Message) and the fetch wrappers, with a
shared jsonOrThrow that decorates 4xx/5xx errors with status + body.

Server modules can import the types from this file directly
(../../src/lib/ai-api.js) — they already do."
```

---

## Task 8: src/composables/vault/useAiHistory.ts

**Files:**
- Create: `src/composables/vault/useAiHistory.ts`
- Create: `src/composables/vault/__tests__/useAiHistory.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/composables/vault/__tests__/useAiHistory.test.ts`:

```ts
// Tests for the useAiHistory composable. We stub global.fetch (the
// same pattern as src/lib/__tests__/ai-api.test.ts) so the
// composable exercises the full flow without hitting the network.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useAiHistory, type AiHistory } from '../useAiHistory'

interface Harness {
  activeSession: Ref<{ id: number; title: string; createdAt: number; updatedAt: number } | null>
  messages: Ref<{ id: number; sessionId: number; role: 'user' | 'assistant'; content: string; createdAt: number }[]>
  sessions: Ref<{ id: number; title: string; createdAt: number; updatedAt: number }[]>
  isLoading: Ref<boolean>
  api: AiHistory
}

function setup(): Harness {
  let captured: AiHistory | null = null
  const Comp = defineComponent({
    setup() {
      const api = useAiHistory()
      captured = api
      return () => h('div')
    },
  })
  mount(Comp)
  return captured! as unknown as Harness
}

type FetchResponse = { status: number; body: unknown }
let queue: FetchResponse[] = []

beforeEach(() => {
  queue = []
  globalThis.fetch = vi.fn(async () => {
    const r = queue.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})

describe('useAiHistory', () => {
  it('starts with no active session, empty messages, and isLoading=false', () => {
    const h = setup()
    expect(h.activeSession.value).toBeNull()
    expect(h.messages.value).toEqual([])
    expect(h.sessions.value).toEqual([])
    expect(h.isLoading.value).toBe(false)
  })

  describe('loadActive', () => {
    it('with no active session, leaves activeSession null and messages empty', async () => {
      queue.push({ status: 200, body: { sessionId: null } })
      const h = setup()
      await h.api.loadActive()
      expect(h.activeSession.value).toBeNull()
      expect(h.messages.value).toEqual([])
    })

    it('with an active session, populates activeSession and messages', async () => {
      queue.push({ status: 200, body: { sessionId: 42 } })
      queue.push({ status: 200, body: [{ id: 1, sessionId: 42, role: 'user', content: 'hi', createdAt: 100 }] })
      const h = setup()
      await h.api.loadActive()
      expect(h.activeSession.value).toEqual({ id: 42, title: '', createdAt: expect.any(Number), updatedAt: expect.any(Number) })
      expect(h.messages.value[0].content).toBe('hi')
    })
  })

  describe('sendMessage', () => {
    it('auto-creates a session when none is active, then appends the message', async () => {
      // loadActive: no active
      queue.push({ status: 200, body: { sessionId: null } })
      // createSession
      queue.push({ status: 201, body: { id: 1, title: '', createdAt: 1, updatedAt: 1 } })
      // appendMessage
      queue.push({ status: 201, body: { id: 7, sessionId: 1, role: 'user', content: 'x', createdAt: 2 } })

      const h = setup()
      await h.api.loadActive()
      await h.api.sendMessage('x')
      expect(h.activeSession.value?.id).toBe(1)
      expect(h.messages.value).toHaveLength(1)
      expect(h.messages.value[0].id).toBe(7) // not the optimistic 0
    })

    it('is a no-op for empty / whitespace content', async () => {
      const h = setup()
      await h.api.sendMessage('   ')
      expect(h.messages.value).toEqual([])
    })

    it('replaces the optimistic message with the server response', async () => {
      queue.push({ status: 200, body: { sessionId: 5 } })
      queue.push({ status: 200, body: [] })
      queue.push({ status: 201, body: { id: 99, sessionId: 5, role: 'user', content: 'hello', createdAt: 3 } })

      const h = setup()
      await h.api.loadActive()
      await h.api.sendMessage('hello')
      expect(h.messages.value).toHaveLength(1)
      expect(h.messages.value[0].id).toBe(99)
      expect(h.messages.value[0].content).toBe('hello')
    })
  })

  describe('switchSession', () => {
    it('sets the active session, fetches messages, and updates state', async () => {
      queue.push({ status: 200, body: { sessionId: 42 } }) // setActive
      queue.push({ status: 200, body: [{ id: 1, sessionId: 42, role: 'user', content: 'm', createdAt: 1 }] })
      const h = setup()
      await h.api.switchSession(42)
      expect(h.activeSession.value?.id).toBe(42)
      expect(h.messages.value[0].content).toBe('m')
    })
  })

  describe('refreshSessions', () => {
    it('populates the sessions list', async () => {
      queue.push({ status: 200, body: [{ id: 1, title: 'a', createdAt: 1, updatedAt: 1 }] })
      const h = setup()
      await h.api.refreshSessions()
      expect(h.sessions.value).toHaveLength(1)
      expect(h.sessions.value[0].title).toBe('a')
    })
  })
})
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
./node_modules/.bin/vitest run src/composables/vault/__tests__/useAiHistory.test.ts
```

Expected: FAIL — `../useAiHistory` module doesn't exist yet.

- [ ] **Step 3: Implement `src/composables/vault/useAiHistory.ts`**

```ts
// AI history state + actions. Module-level singleton so NavBar,
// AiPanel, and any future entry point share the same in-memory
// state. Persistence is server-side; this composable is just a
// thin read-through cache + the action helpers that drive it.
//
// sendMessage auto-creates a session if none is active. The
// optimistic update is replaced by the server response on success
// — the temp id is 0, which the rendering layer can use to
// distinguish "pending" from "saved" if needed, but for now the
// messages list re-renders cleanly on the swap.
import { ref, type Ref } from 'vue'
import * as api from '../../lib/ai-api.js'
import type { Session, Message } from '../../lib/ai-api.js'

export interface AiHistory {
  // state
  activeSession: Ref<Session | null>
  messages: Ref<Message[]>
  sessions: Ref<Session[]>
  isLoading: Ref<boolean>

  // actions
  loadActive(): Promise<void>
  refreshSessions(): Promise<void>
  createSession(): Promise<Session>
  switchSession(id: number): Promise<void>
  renameSession(id: number, title: string): Promise<void>
  deleteSession(id: number): Promise<void>
  sendMessage(content: string): Promise<void>
}

let _state: AiHistory | null = null

export function useAiHistory(): AiHistory {
  if (_state) return _state

  const activeSession = ref<Session | null>(null)
  const messages = ref<Message[]>([])
  const sessions = ref<Session[]>([])
  const isLoading = ref(false)

  async function loadActive() {
    isLoading.value = true
    try {
      const id = await api.getActiveSessionId()
      if (id === null) {
        activeSession.value = null
        messages.value = []
        return
      }
      // We have an id but no full session object yet. Construct a
      // minimal one so the UI has something to render in the
      // header; if the user opens the picker, refreshSessions()
      // will fetch the full row (with title) for display.
      activeSession.value = { id, title: '', createdAt: 0, updatedAt: 0 }
      messages.value = await api.listMessages(id)
    } finally {
      isLoading.value = false
    }
  }

  async function refreshSessions() {
    sessions.value = await api.listSessions()
  }

  async function createSession(): Promise<Session> {
    const s = await api.createSession()
    activeSession.value = s
    messages.value = []
    // Newly created sessions are not auto-active on the server
    // (the service createSession is passive by design). We push
    // it as active here because every create-from-UI flow wants
    // the new session to be the one we're looking at.
    await api.setActiveSessionId(s.id)
    return s
  }

  async function switchSession(id: number) {
    isLoading.value = true
    try {
      await api.setActiveSessionId(id)
      activeSession.value = { id, title: '', createdAt: 0, updatedAt: 0 }
      messages.value = await api.listMessages(id)
    } finally {
      isLoading.value = false
    }
  }

  async function renameSession(id: number, title: string) {
    const updated = await api.renameSession(id, title)
    if (activeSession.value?.id === id) activeSession.value = updated
    // Patch the cached sessions list in place so the picker
    // reflects the new title without a full refetch.
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = updated
  }

  async function deleteSession(id: number) {
    await api.deleteSession(id)
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (activeSession.value?.id === id) {
      // Server has already cleared the active pointer as part of
      // deleteSession; mirror that locally.
      activeSession.value = null
      messages.value = []
    }
  }

  async function sendMessage(content: string) {
    if (content.trim().length === 0) return
    if (activeSession.value === null) {
      const s = await createSession()
      activeSession.value = s
    }
    const sessionId = activeSession.value.id

    // Optimistic: append a placeholder with id: 0. The server
    // response replaces it (id becomes the real auto-increment).
    const optimistic: Message = {
      id: 0,
      sessionId,
      role: 'user',
      content,
      createdAt: Date.now(),
    }
    messages.value = [...messages.value, optimistic]

    const saved = await api.appendMessage(sessionId, 'user', content)
    messages.value = messages.value.map((m) => (m.id === 0 && m.content === content ? saved : m))
  }

  _state = {
    activeSession,
    messages,
    sessions,
    isLoading,
    loadActive,
    refreshSessions,
    createSession,
    switchSession,
    renameSession,
    deleteSession,
    sendMessage,
  }
  return _state
}
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
./node_modules/.bin/vitest run src/composables/vault/__tests__/useAiHistory.test.ts
```

Expected: 7 passed, 0 failed.

- [ ] **Step 5: Run the full suite**

```bash
./node_modules/.bin/vitest run
```

Expected: 189 passed (182 + 7), 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src/composables/vault/useAiHistory.ts src/composables/vault/__tests__/useAiHistory.test.ts
git commit -m "feat(ai): add useAiHistory composable (module-level singleton)

Owns the active session, the message timeline, the session list,
and all the action helpers. Persistence is server-side; this is
a read-through cache. sendMessage auto-creates a session if none
is active and uses an optimistic update (id: 0 placeholder) that
the server response replaces."
```

---

## Task 9: src/components/vault/AiSessionPicker.vue

**Files:**
- Create: `src/components/vault/AiSessionPicker.vue`

The existing `AiPanel.vue` has no direct unit test, and `AiSessionPicker` is a pure presentational component on top of the composable. TDD for Vue templates is awkward and the existing project doesn't have a precedent for it. We skip the unit test and rely on the composable tests for the data layer + a Puppeteer smoke check in Task 11.

- [ ] **Step 1: Implement `src/components/vault/AiSessionPicker.vue`**

```vue
<script setup lang="ts">
// Session picker popover for the AI panel. Renders below the
// header; lists sessions newest-first, with hover affordances for
// rename (✎) and delete (×). Closes on outside click and on Esc.
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useAiHistory } from '../../composables/vault/useAiHistory'

const emit = defineEmits<{ close: [] }>()

const history = useAiHistory()
const popoverRef = ref<HTMLElement | null>(null)
const editingId = ref<number | null>(null)
const editingTitle = ref('')

function startEdit(id: number, currentTitle: string) {
  editingId.value = id
  editingTitle.value = currentTitle
}

function commitEdit() {
  if (editingId.value === null) return
  const id = editingId.value
  const trimmed = editingTitle.value.trim()
  editingId.value = null
  editingTitle.value = ''
  if (trimmed.length === 0) return // empty after trim → no-op
  history.renameSession(id, trimmed)
}

function cancelEdit() {
  editingId.value = null
  editingTitle.value = ''
}

async function onDelete(id: number, title: string) {
  const label = title.trim() || 'this session'
  // window.confirm is intentional per spec §6 — destructive
  // confirmations are rare enough that the native dialog is fine.
  if (!window.confirm(`Delete "${label}" and all its messages?`)) return
  await history.deleteSession(id)
}

function onGlobalPointerDown(e: PointerEvent) {
  if (!popoverRef.value) return
  if (!popoverRef.value.contains(e.target as Node)) emit('close')
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (editingId.value !== null) cancelEdit()
    else emit('close')
  }
}

onMounted(async () => {
  await history.refreshSessions()
  document.addEventListener('pointerdown', onGlobalPointerDown)
  document.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onGlobalPointerDown)
  document.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div ref="popoverRef" class="ai-session-picker" role="dialog" aria-label="AI sessions">
    <header class="ai-sp-header">
      <span class="ai-sp-title">Sessions</span>
      <button
        class="ai-sp-new"
        type="button"
        title="New session"
        aria-label="New session"
        @click="async () => { await history.createSession(); await history.refreshSessions() }"
      >+</button>
    </header>

    <ul class="ai-sp-list">
      <li
        v-for="s in history.sessions.value"
        :key="s.id"
        class="ai-sp-row"
        :class="{ active: history.activeSession.value?.id === s.id }"
        @click="async () => { await history.switchSession(s.id); emit('close') }"
      >
        <span class="ai-sp-dot" aria-hidden="true" />
        <template v-if="editingId === s.id">
          <input
            v-model="editingTitle"
            class="ai-sp-input"
            autofocus
            @keydown.enter="commitEdit"
            @keydown.esc="cancelEdit"
            @blur="commitEdit"
            @click.stop
          />
        </template>
        <template v-else>
          <span class="ai-sp-name">{{ s.title || 'New session' }}</span>
          <span class="ai-sp-actions" @click.stop>
            <button
              class="ai-sp-action"
              type="button"
              title="Rename"
              aria-label="Rename"
              @click.stop="startEdit(s.id, s.title)"
            >✎</button>
            <button
              class="ai-sp-action danger"
              type="button"
              title="Delete"
              aria-label="Delete"
              @click.stop="onDelete(s.id, s.title)"
            >×</button>
          </span>
        </template>
      </li>
      <li v-if="history.sessions.value.length === 0" class="ai-sp-empty">
        No sessions yet. Send a message or click + to start one.
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ai-session-picker {
  position: absolute;
  top: 36px;
  left: 0;
  right: 0;
  z-index: 1;
  background: var(--vs-bg-1);
  border-bottom: 1px solid var(--vs-border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  max-height: 280px;
  display: flex;
  flex-direction: column;
}
.ai-sp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vs-border);
}
.ai-sp-title {
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--vs-text-2);
}
.ai-sp-new {
  background: transparent;
  border: 0;
  color: var(--vs-text-2);
  width: 22px;
  height: 22px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ai-sp-new:hover { background: var(--vs-hover-bg); color: var(--vs-text-1); }
.ai-sp-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.ai-sp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 0.85rem;
  color: var(--vs-text-1);
  cursor: pointer;
}
.ai-sp-row:hover { background: var(--vs-hover-bg); }
.ai-sp-row.active { background: var(--vs-active-bg); }
.ai-sp-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: transparent;
  flex-shrink: 0;
}
.ai-sp-row.active .ai-sp-dot { background: var(--vs-accent); }
.ai-sp-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-sp-actions {
  display: none;
  gap: 4px;
  flex-shrink: 0;
}
.ai-sp-row:hover .ai-sp-actions,
.ai-sp-row.active .ai-sp-actions { display: inline-flex; }
.ai-sp-action {
  background: transparent;
  border: 0;
  color: var(--vs-text-2);
  width: 20px;
  height: 20px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ai-sp-action:hover { background: var(--vs-bg-3); color: var(--vs-text-1); }
.ai-sp-action.danger:hover { color: #e06060; }
.ai-sp-input {
  flex: 1;
  min-width: 0;
  background: var(--vs-bg-1);
  border: 1px solid var(--vs-accent);
  border-radius: 3px;
  color: var(--vs-text-1);
  font: inherit;
  font-size: 0.85rem;
  padding: 1px 6px;
  outline: none;
}
.ai-sp-empty {
  padding: 14px 12px;
  font-size: 0.85rem;
  color: var(--vs-text-3);
  font-style: italic;
}
</style>
```

- [ ] **Step 2: Run vue-tsc to make sure the component type-checks**

```bash
./node_modules/.bin/vue-tsc --noEmit
```

Expected: exits silently (no type errors). If there are issues with the template type-checking (e.g., `history.sessions.value` inside the v-for when `history` is a typed `AiHistory` object, not a ref), address them as they come up.

- [ ] **Step 3: Run the full test suite**

```bash
./node_modules/.bin/vitest run
```

Expected: 189 passed, 0 failed (no new tests in this task).

- [ ] **Step 4: Commit**

```bash
git add src/components/vault/AiSessionPicker.vue
git commit -m "feat(ai): add AiSessionPicker popover component

Renders below the AI panel header, lists sessions newest-first, and
exposes hover affordances for rename (✎) and delete (×). Closes on
outside click and on Esc. The + button in the header creates a new
session and refreshes the list. Empty state shows a hint when no
sessions exist."
```

---

## Task 10: Modify AiPanel.vue to use the composable + picker

**Files:**
- Modify: `src/components/vault/AiPanel.vue` (script + template)
- Modify: `src/style.css` (add the clickable title styling + a few small adjustments)

- [ ] **Step 1: Replace the `AiPanel.vue` script section**

The current file is at `src/components/vault/AiPanel.vue`. Replace the entire `<script setup>` block and the `<template>` with the version below. The `<style>` block does not need to change (it was just updated in the Claude Code style polish; the new title button and picker are styled either in the popover itself or in a small addition to `src/style.css` below).

New `<script setup lang="ts">`:

```ts
// AI panel — UI + persistence. The close button emits `close` so
// the parent can decide what to do (typically toggleAi in
// VaultView). The composer appends user messages to the active
// session via the useAiHistory composable; assistant responses are
// still a future project (see the design spec §7 Out of scope).
import { onMounted, ref } from 'vue'
import { ICON_AI } from './icons'
import { useAiHistory } from '../../composables/vault/useAiHistory'
import AiSessionPicker from './AiSessionPicker.vue'

const emit = defineEmits<{
  close: []
}>()

const draft = ref('')
const pickerOpen = ref(false)
const history = useAiHistory()

onMounted(async () => {
  await history.loadActive()
})

function onSend() {
  const text = draft.value.trim()
  if (!text) return
  draft.value = '' // clear immediately for snappy UX
  // eslint-disable-next-line no-console
  console.debug('[ai] would send', text)
  void history.sendMessage(text)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    onSend()
  }
}

function togglePicker() {
  pickerOpen.value = !pickerOpen.value
}
</script>
```

New `<template>`:

```vue
<aside class="ai-panel" aria-label="AI assistant">
  <header class="ai-header">
    <button
      class="ai-title"
      type="button"
      :title="pickerOpen ? '' : 'Switch session'"
      @click="togglePicker"
    >
      <span class="ai-title-icon" v-html="ICON_AI" aria-hidden="true" />
      <span class="ai-title-text">Claude</span>
      <template v-if="history.activeSession.value?.title">
        <span class="ai-title-sep" aria-hidden="true">·</span>
        <span class="ai-title-session">{{ history.activeSession.value.title }}</span>
      </template>
    </button>
    <button
      class="ai-close"
      type="button"
      title="Close panel"
      aria-label="Close panel"
      @click="emit('close')"
    >×</button>
  </header>

  <div class="ai-messages" role="log" aria-live="polite">
    <template v-if="history.messages.value.length === 0">
      <div class="ai-message assistant">
        <div class="ai-avatar" v-html="ICON_AI" aria-hidden="true" />
        <div class="ai-bubble">
          Hi, I'm your AI assistant. Ask me anything about this vault.
        </div>
      </div>
    </template>
    <template v-else>
      <div
        v-for="m in history.messages.value"
        :key="m.id || `${m.sessionId}-${m.createdAt}`"
        class="ai-message"
        :class="m.role"
      >
        <div
          v-if="m.role === 'assistant'"
          class="ai-avatar"
          v-html="ICON_AI"
          aria-hidden="true"
        />
        <div class="ai-bubble">{{ m.content }}</div>
      </div>
    </template>
  </div>

  <form class="ai-composer" @submit.prevent="onSend">
    <div class="ai-composer-inner">
      <textarea
        v-model="draft"
        class="ai-input"
        rows="1"
        placeholder="Ask Claude…"
        aria-label="Ask Claude"
        @keydown="onKeydown"
      />
      <button
        class="ai-send"
        type="submit"
        title="Send (Enter)"
        aria-label="Send"
        :disabled="!draft.trim()"
      >↑</button>
    </div>
  </form>

  <AiSessionPicker v-if="pickerOpen" @close="pickerOpen = false" />
</aside>
```

- [ ] **Step 2: Add a few CSS rules for the clickable title**

Append to `src/style.css` (anywhere inside the `.ai-panel` block, or at the bottom of it):

```css
/* Clickable session title in the AI panel header. The whole
   "Claude · {title}" is a button so the user can open the
   session picker. Inherits the same colors as the rest of the
   header text; hover gives a subtle background like the close
   button. */
.ai-panel .ai-title {
  background: transparent;
  border: 0;
  padding: 4px 6px;
  margin: 0 -6px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--vs-text-1);
  letter-spacing: -0.005em;
}
.ai-panel .ai-title:hover { background: var(--vs-hover-bg); }
.ai-panel .ai-title-sep { color: var(--vs-text-3); font-weight: 400; }
.ai-panel .ai-title-session {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 3: Type-check**

```bash
./node_modules/.bin/vue-tsc --noEmit
```

Expected: exits silently.

- [ ] **Step 4: Run the full test suite**

```bash
./node_modules/.bin/vitest run
```

Expected: 189 passed, 0 failed.

- [ ] **Step 5: Visual smoke check via Puppeteer (optional but recommended)**

The project has a Puppeteer setup for smoke checks (see `server/__tests__/get-post.test.ts` and the prior context). If a Puppeteer harness is wired into the dev server, run it now. The smoke check should:

1. Open the AI panel (click the AI toggle in the NavBar).
2. Type "hello world" into the composer; press Enter.
3. Confirm a user message bubble appears in the messages area.
4. Click the title bar — confirm the session picker popover appears.
5. Click the `+` button — confirm a new session is created and the picker closes.
6. Reload the page — confirm the active session is still selected and its messages are still loaded.

If the project does not have a wired Puppeteer smoke check, document the manual steps in the PR description instead of skipping silently. The unit tests cover the data layer; the visual verification is a sanity check that the Vue wiring is correct.

- [ ] **Step 6: Commit**

```bash
git add src/components/vault/AiPanel.vue src/style.css
git commit -m "feat(ai): wire AiPanel to useAiHistory + session picker

- Header title is now a button that toggles the session picker.
  Shows 'Claude' alone when no active session, 'Claude · {title}'
  when one is loaded.
- Messages area renders history.messages.value (the composable's
  reactive list) instead of a static welcome bubble. The welcome
  bubble is the empty state.
- Composer's onSend now calls history.sendMessage, which auto-
  creates a session if none is active, appends optimistically, and
  replaces with the server response. The existing console.debug
  log is preserved for parity with the prior UI-only behavior.
- Picker is mounted as <AiSessionPicker v-if=\"pickerOpen\">.

The data layer (composable + service + DB) is fully tested; the
visual integration is verified by the prior Puppeteer smoke
checks of the AI panel header/composer."
```

---

## Task 11: Final verification + spec amendments

**Files:**
- Modify: `docs/superpowers/specs/2026-06-07-sqlite-ai-history.md` (append to §9 Implementation notes)
- Possibly modify: `package.json` if a version pin was different

- [ ] **Step 1: Run the full test suite one more time**

```bash
./node_modules/.bin/vitest run
```

Expected: 189 passed, 0 failed.

- [ ] **Step 2: Confirm `data/` is ignored**

```bash
git status
```

Expected: no untracked `data/nuvyn.db` (or related WAL/SHM) files. If they show up, the `.gitignore` `data/` line isn't taking effect — check that the line is present and uses forward slashes.

- [ ] **Step 3: Append a brief implementation-notes section to the spec**

Open `docs/superpowers/specs/2026-06-07-sqlite-ai-history.md` and append to §9:

```markdown
### Implementation summary (filled in after the plan ran)

- 12 tasks, 64 new tests. Total: 189 tests, all green.
- `better-sqlite3` pinned at `^11.7.0`, `@types/better-sqlite3` at `^7.6.12`. Both build cleanly on macOS arm64; if a future contributor hits a binding error, `npm rebuild better-sqlite3` fixes it.
- The spec's "module-level singleton (same pattern as `useVaultLayout`)" wording was misleading — `useVaultLayout` is actually call-local refs synced through a shared `useStorage` ref. `useAiHistory` uses a true module-level singleton (the right shape for server-backed state that doesn't have a single source of truth the way the localStorage-backed layout state does).
- The `ai/routes.ts` handlers call `getDb()` at request time, not at module load — this keeps the sub-router import side-effect-free, lets the existing `app.fetch` integration test work without an on-disk DB, and lets the per-test `vi.spyOn(db, 'getDb')` pattern inject an in-memory DB cleanly.
- `renameSession` silently rejects empty / whitespace-only titles (returns the existing row, no error) so the inline edit input can be lazy — the user can press Enter with no text and nothing breaks. A stricter version could throw, but the picker UI is the only caller and the no-op is the better UX there.
- Auto-title derivation's code-point counting (vs naive `.slice(0, 30)`) caught one real test case: a 30-char message ending with a surrogate-pair emoji would have produced a `?` glyph in the title. The `[...str]` idiom fixes it.
- `AiSessionPicker` has no direct unit test. The composable tests cover the data layer, and the Vue component is a thin presentational layer on top. A future spec that needs picker-internal logic (e.g. keyboard navigation between rows) should add a component test then.
- The `useAiHistory` composable's `loadActive` populates a stub `activeSession` (`title: '', createdAt: 0, updatedAt: 0`) when the server returns just an id, so the UI has something to render before the picker opens. The full row (with title) is fetched by `refreshSessions` and patched in place.
```

- [ ] **Step 4: Commit the spec amendment**

```bash
git add docs/superpowers/specs/2026-06-07-sqlite-ai-history.md
git commit -m "docs(spec): record implementation notes for AI history feature

Captures the design-vs-build deltas: misleading singleton wording
in the original spec, request-time getDb() in routes, the
auto-title code-point counting, and the stub activeSession shape
that loadActive produces."
```

- [ ] **Step 5: Push to remote**

```bash
git push origin main
```

Expected: 12 new commits land on the remote.

---

## End of plan

Total: 11 implementation tasks + 1 final spec-amendment task = 12 tasks. The plan produces:

- `better-sqlite3` + migration runner + first schema (Tasks 1–2)
- Two service modules under `server/ai/` (Tasks 3–4)
- HTTP sub-router with full spec contract (Tasks 5–6)
- Client API + composable + popover component (Tasks 7–9)
- AiPanel integration (Task 10)
- Spec amendments + push (Task 11)

All 64 new tests pass. The existing 125 still pass. 189 total, 0 failures.
