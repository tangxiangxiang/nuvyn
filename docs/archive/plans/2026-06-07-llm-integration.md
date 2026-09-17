# LLM Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `console.debug` stub in the AI panel with a real Anthropic Claude model call: server-proxied, SSE-streamed, aware of the currently open note, persisted to SQLite.

**Architecture:** Browser POSTs to `/api/ai/chat` on the Hono server. Server holds `ANTHROPIC_API_KEY` in env, opens a streaming `client.messages.stream()` call to Anthropic, pipes tokens back to the browser over SSE. The `useAiHistory` singleton grows a `sendAndStream` method that iterates the SSE event stream and updates the optimistic messages in place. A new `useCurrentNote` composable derives the active note path from the route and caches its content for system-context injection.

**Tech Stack:** `@anthropic-ai/sdk` (new), Hono `streamSSE` (existing, 4.12.23), better-sqlite3 (existing), Vue 3 + `vue-router` (existing), Vitest + `@vue/test-utils` + jsdom (existing).

**Spec:** `docs/superpowers/specs/2026-06-07-llm-integration.md`

---

## File map (what each file owns)

| Path | New / Modified | Responsibility |
|---|---|---|
| `package.json` | Modify | Add `@anthropic-ai/sdk` to dependencies |
| `server/ai/errors.ts` | New | `ChatError` class (tagged union) |
| `server/ai/llm.ts` | New | `streamClaude(opts)` wrapper around the Anthropic SDK; internal `pumpStream` helper |
| `server/ai/chat.ts` | New | `buildSystemPrompt(ctx)` + `runChat(opts)` orchestrator |
| `server/ai/routes.ts` | Modify | Add `POST /chat` (streamSSE); extend `GET /active` to return `{ sessionId, configured }` |
| `server/__tests__/chat.test.ts` | New | `buildSystemPrompt` and `runChat` unit tests |
| `server/__tests__/llm.test.ts` | New | `pumpStream` tests (mock stream + signal) |
| `server/__tests__/ai-routes.test.ts` | Modify | Update the existing `/active` test for the new shape; add `/chat` tests |
| `src/lib/ai-api.ts` | Modify | Add `ChatRequest` + `ChatEvent` types; add `streamChat(req, signal?)` async generator; update `getActiveSessionId` to return the new shape |
| `src/composables/vault/useCurrentNote.ts` | New | Module-level singleton; reads path from `useRoute()`; fetches content via `getPost` |
| `src/composables/vault/useAiHistory.ts` | Modify | Add `busy`, `errorState`, `abortRef`, `configured` refs; add `sendAndStream` method; update `loadActive` to read the new `/active` shape |
| `src/components/vault/AiPanel.vue` | Modify | Wire `useCurrentNote`; replace `console.debug`; add banner / chip / busy state / caret |
| `src/style.css` | Modify | Add styles for the no-key banner, note chip, streaming caret |
| `src/lib/__tests__/ai-api.test.ts` | Modify | Add `streamChat` SSE-parser test; update `getActiveSessionId` test for new shape |
| `src/composables/vault/__tests__/useAiHistory.test.ts` | Modify | Update `loadActive` test for new shape; add 3 `sendAndStream` tests |
| `src/composables/vault/__tests__/useCurrentNote.test.ts` | New | Path derivation + content fetch + reset on route change |
| `server/__tests__/mount.test.ts` | Modify | Add a smoke test for `POST /api/ai/chat` |
| `docs/superpowers/specs/2026-06-07-llm-integration.md` | Modify | Fill in §8 with implementation notes after the build |

Conventions (inherited from the prior specs):
- Server tests run in node mode; client tests use `// @vitest-environment jsdom`.
- `vi.hoisted` + `vi.mock('../db', ...)` is the existing pattern for swapping in an in-memory DB at the `getDb` boundary.
- `__resetForTesting()` exports clean module-level singleton state between tests.
- Server uses ESM `.js` import suffixes; client does not.
- Server code lives outside `tsc` include graph (no `tsconfig.server.json`); import direction is `server/ -> src/lib/*` so wire types have one source of truth.

---

## Task 1: Add `@anthropic-ai/sdk` dependency

**Files:**
- Modify: `package.json` (add one entry under `dependencies`)

- [ ] **Step 1: Edit `package.json`**

Add the following line to the `dependencies` block. Insert it in alphabetical order (after `@hono/node-server`, before `@vueuse/core`):

```json
"@anthropic-ai/sdk": "^0.40.0",
```

(Final version is whatever `npm view @anthropic-ai/sdk version` reports at install time. The plan uses `^0.40.0` as a placeholder; pin to whatever the registry gives you.)

- [ ] **Step 2: Install**

Run: `npm install`
Expected: a new line in `package-lock.json` for `@anthropic-ai/sdk` and its transitive deps. No new top-level dirs other than `node_modules/@anthropic-ai-sdk`.

- [ ] **Step 3: Verify the install**

Run: `node -e "const A = require('@anthropic-ai/sdk'); console.log(typeof A.default)"`
Expected: `function` (the SDK exports a default constructor).

- [ ] **Step 4: Verify nothing else broke**

Run: `npm test`
Expected: 192 passed (no change from the prior baseline).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @anthropic-ai/sdk"
```

---

## Task 2: `ChatError` + `buildSystemPrompt` in `server/ai/chat.ts`

**Files:**
- Create: `server/ai/errors.ts`
- Create: `server/ai/chat.ts`
- Create: `server/__tests__/chat.test.ts`

`buildSystemPrompt` is a pure function — easy to TDD. `ChatError` is a tiny tagged-union class with no behavior; we put it in its own file because both `llm.ts` and `chat.ts` throw it, and we don't want a circular import.

- [ ] **Step 1: Create `server/ai/errors.ts`**

```ts
// Tagged error class for the AI chat flow. Every failure surfaced
// from server/ai/{llm,chat}.ts is an instance of ChatError with a
// stable `reason` string. The route layer maps reason → HTTP status
// or SSE event type; nothing else inspects the class.
export type ChatErrorReason =
  | 'no-api-key'
  | 'not-found'
  | 'empty'
  | 'aborted'
  | 'llm-error'

export class ChatError extends Error {
  readonly reason: ChatErrorReason
  constructor(reason: ChatErrorReason, message?: string) {
    super(message ?? reason)
    this.name = 'ChatError'
    this.reason = reason
  }
}
```

- [ ] **Step 2: Write the failing test for `buildSystemPrompt`**

Create `server/__tests__/chat.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../ai/chat'

describe('buildSystemPrompt', () => {
  it('returns the base prompt when no note context is provided', () => {
    expect(buildSystemPrompt({})).toBe(
      "You're a helpful assistant for a personal knowledge base."
    )
  })

  it('appends the current note path and content when ctx has both', () => {
    const out = buildSystemPrompt({
      currentNotePath: 'archive/foo.md',
      currentNoteContent: 'hello world',
    })
    expect(out).toContain('archive/foo.md')
    expect(out).toContain('hello world')
    expect(out.startsWith("You're a helpful assistant")).toBe(true)
  })

  it('truncates content at 20_000 chars and appends a marker', () => {
    const big = 'a'.repeat(25_000)
    const out = buildSystemPrompt({
      currentNotePath: 'archive/big.md',
      currentNoteContent: big,
    })
    // The full 25_000 a's are not in the output — only the first 20_000.
    expect(out).toContain('a'.repeat(20_000))
    expect(out).not.toContain('a'.repeat(20_001))
    // Truncation marker is present, naming the file.
    expect(out).toContain('[... truncated; full file at archive/big.md ...]')
  })

  it('does not truncate when content is exactly 20_000 chars', () => {
    const exact = 'b'.repeat(20_000)
    const out = buildSystemPrompt({
      currentNotePath: 'archive/exact.md',
      currentNoteContent: exact,
    })
    expect(out).not.toContain('truncated')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run server/__tests__/chat.test.ts`
Expected: FAIL with `Cannot find module '../ai/chat'` (or similar). The file doesn't exist yet.

- [ ] **Step 4: Create `server/ai/chat.ts` with `buildSystemPrompt`**

```ts
// AI chat orchestrator. Pure functions of (db, ...args) — no
// closures over module state, no classes (ChatError is the one
// exception; it lives in ./errors.ts to avoid a circular import
// with ./llm.ts).
//
// buildSystemPrompt is a free function so the tests can exercise
// it without standing up an SDK mock. runChat is the orchestrator
// used by the /chat route handler.
import type { Database as DatabaseT } from 'better-sqlite3'
import { ChatError } from './errors.js'
import { streamClaude } from './llm.js'
import * as messages from './messages.js'
import * as sessions from './sessions.js'

const BASE_SYSTEM_PROMPT =
  "You're a helpful assistant for a personal knowledge base."

const MAX_NOTE_CODEPOINTS = 20_000

export function buildSystemPrompt(ctx: {
  currentNotePath?: string
  currentNoteContent?: string
}): string {
  if (!ctx.currentNotePath) return BASE_SYSTEM_PROMPT
  const raw = ctx.currentNoteContent ?? ''
  // Slice on code points, not UTF-16 code units, so a multi-code-unit
  // glyph at the boundary isn't corrupted.
  const cps = [...raw]
  if (cps.length <= MAX_NOTE_CODEPOINTS) {
    return `${BASE_SYSTEM_PROMPT}\n\nThe user is currently reading: ${ctx.currentNotePath}\n\n${raw}`
  }
  const truncated = cps.slice(0, MAX_NOTE_CODEPOINTS).join('')
  return `${BASE_SYSTEM_PROMPT}\n\nThe user is currently reading: ${ctx.currentNotePath}\n\n${truncated}\n\n[... truncated; full file at ${ctx.currentNotePath} ...]`
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/__tests__/chat.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add server/ai/errors.ts server/ai/chat.ts server/__tests__/chat.test.ts
git commit -m "feat(ai): add ChatError and buildSystemPrompt"
```

---

## Task 3: `pumpStream` and `streamClaude` in `server/ai/llm.ts`

**Files:**
- Create: `server/ai/llm.ts`
- Create: `server/__tests__/llm.test.ts`

`pumpStream` is the testable seam: it takes a `MessageStream`-shaped object and an `onToken` callback and returns the accumulated text. `streamClaude` is the thin SDK wrapper that opens a real stream and delegates to `pumpStream`. Tests cover `pumpStream` thoroughly (4 cases) and `streamClaude` lightly (2 cases that mock the SDK constructor).

- [ ] **Step 1: Write the failing test for `pumpStream`**

Create `server/__tests__/llm.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { pumpStream } from '../ai/llm'
import { ChatError } from '../ai/errors'

// A minimal MessageStream-shaped object: on(event, cb) registers
// handlers, finalMessage() returns a promise that resolves on demand.
function fakeStream() {
  const handlers: Record<string, (arg: any) => void> = {}
  let resolveFinal!: () => void
  const finalPromise = new Promise<void>((r) => { resolveFinal = r })
  return {
    handlers,
    stream: {
      on: (event: string, cb: (arg: any) => void) => { handlers[event] = cb },
      finalMessage: () => finalPromise,
    },
    resolveFinal: () => resolveFinal(),
  }
}

describe('pumpStream', () => {
  it('accumulates text events and resolves with the full text', async () => {
    const f = fakeStream()
    const onToken = vi.fn()
    const p = pumpStream(f.stream, onToken)
    f.handlers.text('Hello, ')
    f.handlers.text('world!')
    f.resolveFinal()
    await expect(p).resolves.toBe('Hello, world!')
    expect(onToken).toHaveBeenNthCalledWith(1, 'Hello, ')
    expect(onToken).toHaveBeenNthCalledWith(2, 'world!')
  })

  it('rejects with ChatError(aborted) when the signal is pre-aborted', async () => {
    const f = fakeStream()
    const ac = new AbortController()
    ac.abort()
    await expect(pumpStream(f.stream, () => {}, ac.signal)).rejects.toBeInstanceOf(ChatError)
    await expect(pumpStream(f.stream, () => {}, ac.signal)).rejects.toMatchObject({ reason: 'aborted' })
  })

  it('rejects with ChatError(aborted) when the signal aborts mid-stream', async () => {
    const f = fakeStream()
    const ac = new AbortController()
    const onToken = vi.fn()
    const p = pumpStream(f.stream, onToken, ac.signal)
    f.handlers.text('partial ')
    ac.abort()
    await expect(p).rejects.toMatchObject({ reason: 'aborted' })
  })

  it('rejects with ChatError(llm-error) on a stream error event', async () => {
    const f = fakeStream()
    const p = pumpStream(f.stream, () => {})
    f.handlers.error(new Error('boom'))
    await expect(p).rejects.toMatchObject({ reason: 'llm-error' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/__tests__/llm.test.ts`
Expected: FAIL with `Cannot find module '../ai/llm'`.

- [ ] **Step 3: Create `server/ai/llm.ts` with `pumpStream`**

```ts
// Thin wrapper around @anthropic-ai/sdk. Two exports:
//
//   - pumpStream(stream, onToken, signal?): testable seam. Takes a
//     MessageStream-shaped object, subscribes to its 'text' and
//     'error' events, and resolves with the accumulated text.
//   - streamClaude(opts): high-level. Reads ANTHROPIC_API_KEY from
//     process.env, opens a client.messages.stream, delegates to
//     pumpStream.
//
// The SDK type is opaque (we don't import Anthropic's TS types
// beyond the constructor), so any object with `on` and
// `finalMessage` is a valid stream — that keeps the test surface
// small.
import Anthropic from '@anthropic-ai/sdk'
import { ChatError } from './errors.js'

const MAX_TOKENS = 4096

export type StreamClaudeOpts = {
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  model: string
  onToken: (text: string) => void
  signal?: AbortSignal
}

/**
 * Process an Anthropic MessageStream and resolve with the full
 * assistant text. `onToken` is called for every text delta.
 * Throws ChatError('aborted') on signal abort, ChatError('llm-error')
 * on stream or finalization failure.
 */
export async function pumpStream(
  stream: {
    on: (event: string, cb: (arg: any) => void) => void
    finalMessage: () => Promise<unknown>
  },
  onToken: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ChatError('aborted'))
      return
    }
    let fullText = ''
    stream.on('text', (text: string) => {
      fullText += text
      onToken(text)
    })
    stream.on('error', (err: Error) => {
      reject(new ChatError('llm-error', err.message))
    })
    stream.finalMessage()
      .then(() => resolve(fullText))
      .catch((err: Error) => reject(new ChatError('llm-error', err.message)))
    signal?.addEventListener('abort', () => {
      reject(new ChatError('aborted'))
    })
  })
}

/**
 * Open a streaming Claude call and resolve with the full assistant
 * text. Throws ChatError('no-api-key') if ANTHROPIC_API_KEY is unset.
 */
export async function streamClaude(opts: StreamClaudeOpts): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new ChatError('no-api-key')
  const client = new Anthropic({ apiKey })
  const stream = client.messages.stream({
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: opts.system,
    messages: opts.messages,
  })
  return pumpStream(stream, opts.onToken, opts.signal)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/__tests__/llm.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Add a thin test for `streamClaude` (no-API-key path)**

Append to `server/__tests__/llm.test.ts`:

```ts
import { streamClaude } from '../ai/llm'

describe('streamClaude', () => {
  it('throws ChatError(no-api-key) when ANTHROPIC_API_KEY is unset', async () => {
    const prev = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await expect(
        streamClaude({ system: 's', messages: [], model: 'm', onToken: () => {} })
      ).rejects.toMatchObject({ reason: 'no-api-key' })
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev
    }
  })
})
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run server/__tests__/llm.test.ts`
Expected: 5 passed.

- [ ] **Step 7: Commit**

```bash
git add server/ai/llm.ts server/__tests__/llm.test.ts
git commit -m "feat(ai): add streamClaude wrapper around @anthropic-ai/sdk"
```

---

## Task 4: `runChat` orchestrator in `server/ai/chat.ts`

**Files:**
- Modify: `server/ai/chat.ts` (add `runChat` and the two type exports)
- Modify: `server/__tests__/chat.test.ts` (add 4 tests for `runChat`)

`runChat` is the business-logic core of `/api/ai/chat`. It is independent of HTTP, so its tests don't need a Hono context or a fetch — just a real `:memory:` DB plus a stub `streamClaude` (re-mocked via `vi.mock`).

- [ ] **Step 1: Write the failing test for `runChat`**

Append to `server/__tests__/chat.test.ts`:

```ts
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import { runChat } from '../ai/chat'
import { ChatError } from '../ai/errors'
import { vi } from 'vitest'

// Mock the SDK wrapper so tests don't hit the network. The fake
// invokes the onToken callback for each chunk, then resolves with
// the joined text.
vi.mock('../ai/llm', () => ({
  streamClaude: vi.fn(async ({ onToken }: { onToken: (t: string) => void }) => {
    onToken('hi ')
    onToken('there')
    return 'hi there'
  }),
}))

function freshDb() {
  const db = new Database(':memory:')
  applyMigrations(db)
  return db
}

function makeSession(db: ReturnType<typeof freshDb>): number {
  const s = db.prepare('INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)').run('', 1, 1)
  return Number(s.lastInsertRowid)
}

describe('runChat', () => {
  it('throws ChatError(not-found) when the session does not exist', async () => {
    const db = freshDb()
    const tokens: string[] = []
    await expect(
      runChat({
        db,
        sessionId: 999,
        userContent: 'hi',
        ctx: {},
        model: 'm',
        onUserId: () => {},
        onToken: (t) => { tokens.push(t) },
      })
    ).rejects.toMatchObject({ reason: 'not-found' })
  })

  it('throws ChatError(empty) when the user content is whitespace', async () => {
    const db = freshDb()
    const id = makeSession(db)
    await expect(
      runChat({
        db, sessionId: id, userContent: '   ', ctx: {}, model: 'm',
        onUserId: () => {}, onToken: () => {},
      })
    ).rejects.toMatchObject({ reason: 'empty' })
  })

  it('persists user then assistant message and emits tokens in order', async () => {
    const db = freshDb()
    const id = makeSession(db)
    const userIds: number[] = []
    const tokens: string[] = []
    const { userId, assistantId } = await runChat({
      db,
      sessionId: id,
      userContent: 'hi',
      ctx: {},
      model: 'm',
      onUserId: (u) => { userIds.push(u) },
      onToken: (t) => { tokens.push(t) },
    })
    expect(userIds).toEqual([userId])
    expect(tokens).toEqual(['hi ', 'there'])
    expect(assistantId).toBeGreaterThan(userId)
    const rows = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id').all(id) as { role: string; content: string }[]
    expect(rows).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hi there' },
    ])
  })

  it('passes the current note path + content into the system prompt', async () => {
    const { streamClaude } = await import('../ai/llm')
    const db = freshDb()
    const id = makeSession(db)
    await runChat({
      db, sessionId: id, userContent: 'hi',
      ctx: { currentNotePath: 'archive/note.md', currentNoteContent: 'body' },
      model: 'm', onUserId: () => {}, onToken: () => {},
    })
    expect(vi.mocked(streamClaude)).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('archive/note.md'),
      })
    )
    expect(vi.mocked(streamClaude)).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('body'),
      })
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/__tests__/chat.test.ts`
Expected: FAIL with `runChat is not a function` (or similar).

- [ ] **Step 3: Add `runChat` to `server/ai/chat.ts`**

Append to the file:

```ts
// ---- runChat ----

export type ChatContext = {
  currentNotePath?: string
  currentNoteContent?: string
}

export type RunChatDeps = {
  db: DatabaseT
  model: string
  signal?: AbortSignal
  onUserId: (id: number) => void | Promise<void>
  onToken: (text: string) => void | Promise<void>
}

export type RunChatOpts = {
  sessionId: number
  userContent: string
  ctx: ChatContext
} & RunChatDeps

export async function runChat(opts: RunChatOpts): Promise<{
  userId: number
  assistantId: number
  fullText: string
}> {
  if (opts.userContent.trim().length === 0) {
    throw new ChatError('empty')
  }
  const sess = sessions.getSession(opts.db, opts.sessionId)
  if (!sess) throw new ChatError('not-found')

  const history = messages.listMessages(opts.db, opts.sessionId) ?? []
  const system = buildSystemPrompt(opts.ctx)
  const convo = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: opts.userContent },
  ]

  // Write the user message FIRST so a crash mid-stream only loses
  // the in-flight assistant text. See spec §3.5.
  const userResult = messages.appendMessage(opts.db, opts.sessionId, 'user', opts.userContent)
  if (!userResult.ok) throw new ChatError('empty') // appendMessage rejects on empty; belt-and-suspenders
  const userId = userResult.message.id
  await opts.onUserId(userId)

  let fullText = ''
  try {
    fullText = await streamClaude({
      system,
      messages: convo,
      model: opts.model,
      onToken: opts.onToken,
      signal: opts.signal,
    })
  } catch (err) {
    // Persist whatever streamed so far (typically '' or a few tokens)
    // and re-throw a tagged error so the route can emit SSE error.
    const partial = fullText || '[stream interrupted]'
    const assistantResult = messages.appendMessage(
      opts.db, opts.sessionId, 'assistant', partial,
    )
    const assistantId = assistantResult.ok ? assistantResult.message.id : -1
    if (err instanceof ChatError) {
      // Preserve the assistantId on the error for the route, but the
      // simpler shape for now is to throw with the reason and let
      // the route deal with the partial on a best-effort basis.
      if (err.reason === 'aborted') {
        // The route maps aborted to a silent return; the partial
        // assistant row is still useful for the user on reload.
        throw Object.assign(err, { assistantId })
      }
      throw Object.assign(err, { assistantId })
    }
    throw new ChatError('llm-error', (err as Error).message)
  }

  const assistantResult = messages.appendMessage(
    opts.db, opts.sessionId, 'assistant', fullText,
  )
  if (!assistantResult.ok) throw new ChatError('llm-error', 'failed to persist assistant')
  return { userId, assistantId: assistantResult.message.id, fullText }
}
```

(One small simplification vs the spec: the spec describes partial-on-error with `[error: <reason>]` being appended client-side. The server just persists the raw partial text without the marker. The marker is added by the client when it receives the SSE `error` event. This is what the spec §3.9 `sendAndStream` does in the `error` branch.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/__tests__/chat.test.ts`
Expected: 8 passed (4 from Task 2 + 4 from this task).

- [ ] **Step 5: Commit**

```bash
git add server/ai/chat.ts server/__tests__/chat.test.ts
git commit -m "feat(ai): add runChat orchestrator (validate, persist user, stream, persist assistant)"
```

---

## Task 5: `POST /chat` route + extend `GET /active` in `server/ai/routes.ts`

**Files:**
- Modify: `server/ai/routes.ts` (add `POST /chat`; extend `GET /active`; add `import { streamSSE }`)
- Modify: `server/__tests__/ai-routes.test.ts` (update `/active` test for new shape; add 2 `/chat` tests)

The route layer is the only place that knows about SSE. `POST /chat` opens the stream, calls `runChat`, and writes the events. `GET /active` adds a `configured: boolean` field so the client can show the no-key banner on first paint (see spec §3.4 and §3.10).

- [ ] **Step 1: Update the existing `GET /active` test to expect the new shape**

Open `server/__tests__/ai-routes.test.ts`. Replace the existing `describe('GET /api/ai/active', ...)` block with:

```ts
describe('GET /api/ai/active', () => {
  it('returns { sessionId: null, configured: <bool> } when no active session', async () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const r = await call('GET', '/active')
      expect(r.status).toBe(200)
      const body = await r.json() as { sessionId: number | null; configured: boolean }
      expect(body.sessionId).toBeNull()
      expect(body.configured).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })

  it('reports configured: false when ANTHROPIC_API_KEY is unset', async () => {
    const prev = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const r = await call('GET', '/active')
      const body = await r.json() as { configured: boolean }
      expect(body.configured).toBe(false)
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/__tests__/ai-routes.test.ts`
Expected: FAIL — the new shape returns `{ sessionId }` only, so the assertions on `configured` fail.

- [ ] **Step 3: Modify `server/ai/routes.ts`**

Add the `streamSSE` import at the top:

```ts
import { streamSSE } from 'hono/streaming'
```

Extend the existing `GET /active` handler:

```ts
ai.get('/active', (c) =>
  c.json({
    sessionId: sessions.getActiveSessionId(getDb()),
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
  })
)
```

Add the new `POST /chat` handler at the end of the file (before `export default ai`):

```ts
// ---- /chat ----
ai.post('/chat', async (c) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return c.json({ ok: false, reason: 'no-api-key' }, 503)
  }
  const body = (await c.req.json().catch(() => null)) as
    | {
        sessionId?: unknown
        content?: unknown
        currentNotePath?: unknown
        currentNoteContent?: unknown
      }
    | null
  if (
    !body ||
    typeof body.sessionId !== 'number' ||
    typeof body.content !== 'string'
  ) {
    return c.json({ ok: false, reason: 'invalid' }, 400)
  }

  // We don't pre-validate the session here — runChat throws
  // ChatError('not-found') and the route maps it to an SSE error
  // event so the client can show a chip rather than a generic 404.
  return streamSSE(c, async (stream) => {
    try {
      const result = await runChat({
        db: getDb(),
        sessionId: body.sessionId,
        userContent: body.content,
        ctx: {
          currentNotePath: typeof body.currentNotePath === 'string' ? body.currentNotePath : undefined,
          currentNoteContent: typeof body.currentNoteContent === 'string' ? body.currentNoteContent : undefined,
        },
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
        signal: c.req.raw.signal,
        onUserId: async (id) => {
          await stream.writeSSE({ event: 'user', data: JSON.stringify({ id }) })
        },
        onToken: async (text) => {
          await stream.writeSSE({ event: 'token', data: JSON.stringify({ text }) })
        },
      })
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ userId: result.userId, assistantId: result.assistantId }),
      })
    } catch (err) {
      if (err instanceof ChatError && err.reason === 'aborted') return
      const reason = err instanceof ChatError ? err.reason : 'unknown'
      try {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ reason }) })
      } catch {
        // The stream may already be closed (client disconnect).
        // Best-effort: ignore.
      }
    }
  })
})
```

Add the import at the top:

```ts
import { runChat } from './chat.js'
import { ChatError } from './errors.js'
```

- [ ] **Step 4: Run the existing tests to verify the `/active` change passes**

Run: `npx vitest run server/__tests__/ai-routes.test.ts`
Expected: all pass (the new shape assertions now hold).

- [ ] **Step 5: Write the failing test for `POST /chat`**

Append to `server/__tests__/ai-routes.test.ts`:

```ts
import { vi } from 'vitest'
import * as chatModule from '../ai/chat'

// We mock runChat so the route test doesn't drag in the SDK or
// need a real DB session for the chat flow. The mock emits the
// expected events: a user id, two tokens, and a done with both ids.
vi.mock('../ai/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/chat')>()
  return {
    ...actual,
    runChat: vi.fn(async ({ onUserId, onToken }: any) => {
      await onUserId(101)
      await onToken('hello ')
      await onToken('world')
      return { userId: 101, assistantId: 202, fullText: 'hello world' }
    }),
  }
})

function sseBodyChunks(res: Response): Promise<string[]> {
  // Read the SSE body as a single string then split on \n\n blocks.
  return res.text().then((text) => {
    return text.split('\n\n').filter((b) => b.trim().length > 0)
  })
}

function parseEvent(block: string): { event: string; data: string } {
  const event = (block.match(/^event:\s*(.+)$/m) ?? ['', ''])[1].trim()
  const data = (block.match(/^data:\s*(.+)$/m) ?? ['', ''])[1].trim()
  return { event, data }
}

describe('POST /api/ai/chat', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
  })
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY
  })

  it('returns 503 when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const r = await call('POST', '/chat', { sessionId: 1, content: 'hi' })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ ok: false, reason: 'no-api-key' })
  })

  it('returns 400 when the body is invalid', async () => {
    const r = await call('POST', '/chat', { content: 'hi' })
    expect(r.status).toBe(400)
  })

  it('streams user → token* → done in order on success', async () => {
    // Create a session so the body validates.
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('POST', '/chat', { sessionId: created.id, content: 'hi' })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/)
    const blocks = await sseBodyChunks(r)
    const events = blocks.map(parseEvent)
    expect(events.map((e) => e.event)).toEqual(['user', 'token', 'token', 'done'])
    expect(JSON.parse(events[0].data)).toEqual({ id: 101 })
    expect(JSON.parse(events[1].data)).toEqual({ text: 'hello ' })
    expect(JSON.parse(events[2].data)).toEqual({ text: 'world' })
    expect(JSON.parse(events[3].data)).toEqual({ userId: 101, assistantId: 202 })
  })

  it('emits an error event when runChat throws not-found', async () => {
    vi.mocked(chatModule.runChat).mockRejectedValueOnce(new chatModule.ChatError('not-found'))
    // 999 is not a real session — the mock throws, so the route
    // emits the SSE error.
    const r = await call('POST', '/chat', { sessionId: 999, content: 'hi' })
    const blocks = await sseBodyChunks(r)
    const last = parseEvent(blocks[blocks.length - 1])
    expect(last.event).toBe('error')
    expect(JSON.parse(last.data)).toEqual({ reason: 'not-found' })
  })
})
```

- [ ] **Step 6: Run the test to verify it fails (or passes by luck)**

Run: `npx vitest run server/__tests__/ai-routes.test.ts`
Expected: the new `POST /chat` tests run. The 503/400 tests pass. The streaming test should pass if the route is implemented correctly. The not-found test depends on the mock.

- [ ] **Step 7: Run the full server test suite to make sure nothing else broke**

Run: `npx vitest run server/`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add server/ai/routes.ts server/__tests__/ai-routes.test.ts
git commit -m "feat(ai): add POST /chat (streamSSE) and extend GET /active with configured flag"
```

---

## Task 6: `streamChat` + types in `src/lib/ai-api.ts`

**Files:**
- Modify: `src/lib/ai-api.ts` (add `ChatRequest`, `ChatEvent`, `streamChat`; update `getActiveSessionId` for the new shape)
- Modify: `src/lib/__tests__/ai-api.test.ts` (add 1 `streamChat` test; update `getActiveSessionId` test for new shape)

`streamChat` is a typed async generator that consumes the SSE response. The fetch is mocked at the `globalThis.fetch` level; the test fakes a streaming `Response` with a `ReadableStream` body.

- [ ] **Step 1: Update the existing `getActiveSessionId` test for the new shape**

Open `src/lib/__tests__/ai-api.test.ts`. Find the test:

```ts
it('getActiveSessionId GETs /api/ai/active', async () => {
  responses.push({ status: 200, body: { sessionId: 42 } })
  const id = await api.getActiveSessionId()
  expect(calls[0].url).toBe('/api/ai/active')
  expect(id).toBe(42)
})
```

Replace it with:

```ts
it('getActiveSessionId returns { activeId, configured } shape', async () => {
  responses.push({ status: 200, body: { sessionId: 42, configured: true } })
  const out = await api.getActiveSessionId()
  expect(calls[0].url).toBe('/api/ai/active')
  expect(out.activeId).toBe(42)
  expect(out.configured).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/ai-api.test.ts`
Expected: FAIL — `getActiveSessionId` currently returns `number | null`, so `out.activeId` is undefined.

- [ ] **Step 3: Update `src/lib/ai-api.ts`**

Replace the bottom block (from `export async function getActiveSessionId` onward) with the new shape. Add the new types and `streamChat` above. The full file becomes:

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

export interface ActiveSession {
  activeId: number | null
  configured: boolean
}

export interface ChatRequest {
  sessionId: number
  content: string
  currentNotePath?: string
  currentNoteContent?: string
}

export type ChatEvent =
  | { type: 'user'; id: number }
  | { type: 'token'; text: string }
  | { type: 'done'; userId: number; assistantId: number }
  | { type: 'error'; reason: string }

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: r.statusText }))
    throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status, body })
  }
  return r.json() as Promise<T>
}

// Headers + body for a JSON request; the caller picks the method.
function jsonBody(body: unknown): RequestInit {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export async function listSessions(): Promise<Session[]> {
  return jsonOrThrow<Session[]>(await fetch('/api/ai/sessions', { method: 'GET' }))
}

export async function createSession(): Promise<Session> {
  return jsonOrThrow<Session>(await fetch('/api/ai/sessions', { method: 'POST' }))
}

export async function renameSession(id: number, title: string): Promise<Session> {
  return jsonOrThrow<Session>(await fetch(`/api/ai/sessions/${id}`, { method: 'PATCH', ...jsonBody({ title }) }))
}

export async function deleteSession(id: number): Promise<{ ok: true }> {
  return jsonOrThrow<{ ok: true }>(await fetch(`/api/ai/sessions/${id}`, { method: 'DELETE' }))
}

export async function listMessages(sessionId: number): Promise<Message[]> {
  return jsonOrThrow<Message[]>(await fetch(`/api/ai/sessions/${sessionId}/messages`, { method: 'GET' }))
}

export async function appendMessage(
  sessionId: number,
  role: 'user' | 'assistant',
  content: string,
): Promise<Message> {
  return jsonOrThrow<Message>(await fetch(`/api/ai/sessions/${sessionId}/messages`, { method: 'POST', ...jsonBody({ role, content }) }))
}

export async function getActiveSession(): Promise<ActiveSession> {
  return jsonOrThrow<ActiveSession>(await fetch('/api/ai/active', { method: 'GET' }))
}

// Backwards-compat shim: existing call sites use getActiveSessionId()
// as a function returning number|null. Re-export it so the rest of
// the codebase doesn't need to change in lockstep.
export async function getActiveSessionId(): Promise<number | null> {
  const out = await getActiveSession()
  return out.activeId
}

export async function setActiveSessionId(sessionId: number | null): Promise<number | null> {
  const r = await jsonOrThrow<{ sessionId: number | null }>(await fetch('/api/ai/active', { method: 'PUT', ...jsonBody({ sessionId }) }))
  return r.sessionId
}

/**
 * Open a streaming chat request and yield typed ChatEvent objects.
 * Yields exactly one {type: 'error'} event and returns on any HTTP
 * failure (the body parser short-circuits the stream).
 */
export async function* streamChat(
  req: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    ...jsonBody(req),
    signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ reason: `http-${res.status}` }))
    yield { type: 'error', reason: (body as any).reason ?? `http-${res.status}` }
    return
  }
  if (!res.body) {
    yield { type: 'error', reason: 'no-body' }
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const eventLine = block.match(/^event:\s*(.+)$/m)
      const dataLine = block.match(/^data:\s*(.+)$/m)
      if (!eventLine || !dataLine) continue
      try {
        const parsed = JSON.parse(dataLine[1])
        yield { type: eventLine[1].trim(), ...parsed } as ChatEvent
      } catch {
        // Ignore malformed blocks — the test will assert what we expect.
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/ai-api.test.ts`
Expected: the `getActiveSessionId` test now passes.

- [ ] **Step 5: Write the failing test for `streamChat`**

Append to `src/lib/__tests__/ai-api.test.ts`:

```ts
import { streamChat } from '../ai-api'

// Build a Response whose body is a ReadableStream of UTF-8 bytes
// carrying the given SSE text. Mirrors what Hono's streamSSE
// actually emits on the wire.
function sseResponse(events: { event: string; data: unknown }[]): Response {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
  const enc = new TextEncoder()
  return new Response(enc.encode(text), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('streamChat', () => {
  it('yields typed ChatEvents in order from a streaming SSE response', async () => {
    const events = [
      { event: 'user', data: { id: 11 } },
      { event: 'token', data: { text: 'a' } },
      { event: 'token', data: { text: 'b' } },
      { event: 'done', data: { userId: 11, assistantId: 12 } },
    ]
    globalThis.fetch = vi.fn(async () => sseResponse(events)) as unknown as typeof fetch
    const collected: unknown[] = []
    for await (const ev of streamChat({ sessionId: 1, content: 'x' })) {
      collected.push(ev)
    }
    expect(collected).toEqual([
      { type: 'user', id: 11 },
      { type: 'token', text: 'a' },
      { type: 'token', text: 'b' },
      { type: 'done', userId: 11, assistantId: 12 },
    ])
  })

  it('yields { type: error } on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'no-api-key' }), { status: 503, headers: { 'content-type': 'application/json' } })
    ) as unknown as typeof fetch
    const collected: unknown[] = []
    for await (const ev of streamChat({ sessionId: 1, content: 'x' })) {
      collected.push(ev)
    }
    expect(collected).toEqual([{ type: 'error', reason: 'no-api-key' }])
  })
})
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/ai-api.test.ts`
Expected: 11 passed (9 original + 2 new).

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai-api.ts src/lib/__tests__/ai-api.test.ts
git commit -m "feat(ai): add streamChat SSE parser + ActiveSession type"
```

---

## Task 7: `useCurrentNote` composable

**Files:**
- Create: `src/composables/vault/useCurrentNote.ts`
- Create: `src/composables/vault/__tests__/useCurrentNote.test.ts`

`useCurrentNote` is a module-level singleton (same pattern as `useAiHistory`). It watches the route for changes and fetches the post content via the existing `getPost` from `src/lib/api.ts`. Tests use `vue-router`'s `createMemoryHistory` so the composable can read `useRoute()` without a real router.

- [ ] **Step 1: Write the failing test**

Create `src/composables/vault/__tests__/useCurrentNote.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useCurrentNote, __resetForTesting } from '../useCurrentNote'

let responses: { status: number; body: unknown }[] = []

beforeEach(() => {
  responses = []
  globalThis.fetch = vi.fn(async (_url: string | URL | Request) => {
    const next = responses.shift() ?? { status: 200, body: { content: '' } }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  __resetForTesting()
})

async function mountAtRoute(initialPath: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/vault/:path(.*)*', name: 'vault', component: { template: '<div/>' } },
      { path: '/:catchAll(.*)', name: 'other', component: { template: '<div/>' } },
    ],
  })
  router.push(initialPath)
  await router.isReady()
  let captured: ReturnType<typeof useCurrentNote> | null = null
  const Comp = defineComponent({
    setup() {
      captured = useCurrentNote()
      return () => h('div')
    },
  })
  const wrap = mount(Comp, { global: { plugins: [router] } })
  await flushPromises()
  return { router, note: captured!, wrap }
}

describe('useCurrentNote', () => {
  it('exposes null path and empty content when the route is not the vault', async () => {
    const { note } = await mountAtRoute('/tags')
    expect(note.path.value).toBeNull()
    expect(note.content.value).toBe('')
  })

  it('derives path from /vault/:path and fetches the post', async () => {
    responses.push({ status: 200, body: { content: 'hello world', frontmatter: {} } })
    const { note } = await mountAtRoute('/vault/archive/foo.md')
    expect(note.path.value).toBe('archive/foo.md')
    expect(note.content.value).toBe('hello world')
  })

  it('updates path and refetches content when the route changes', async () => {
    responses.push({ status: 200, body: { content: 'first' } })
    responses.push({ status: 200, body: { content: 'second' } })
    const { router, note } = await mountAtRoute('/vault/archive/a.md')
    expect(note.content.value).toBe('first')
    await router.push('/vault/archive/b.md')
    await flushPromises()
    expect(note.path.value).toBe('archive/b.md')
    expect(note.content.value).toBe('second')
  })

  it('clears content on a fetch error', async () => {
    responses.push({ status: 404, body: { error: 'not found' } })
    const { note } = await mountAtRoute('/vault/missing.md')
    expect(note.path.value).toBe('missing.md')
    expect(note.content.value).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/composables/vault/__tests__/useCurrentNote.test.ts`
Expected: FAIL with `Cannot find module '../useCurrentNote'`.

- [ ] **Step 3: Create `src/composables/vault/useCurrentNote.ts`**

```ts
// Active-note tracking. The AI panel reads the current note's path
// + content from this composable when sending a chat message so the
// model has the right context. Singleton (like useAiHistory) because
// the vault view and the AI panel need to agree on what "current"
// means.
//
// Known limitation (see spec §3.7): the content is the SERVER-SAVED
// version, not the editor's live unsaved buffer. Auto-save debounces
// 800ms, so this is usually fine, but a freshly typed sentence can
// be missing for that window. A future spec will route live editor
// state through useEditorTabs.
import { ref, watch, type Ref } from 'vue'
import { useRoute, type RouteLocationNormalizedLoaded } from 'vue-router'
import { getPost } from '../../lib/api'

export interface CurrentNote {
  path: Ref<string | null>
  content: Ref<string>
}

let _state: CurrentNote | null = null

// Test-only escape hatch.
export function __resetForTesting(): void {
  _state = null
}

function pathFromRoute(route: RouteLocationNormalizedLoaded): string | null {
  if (route.name !== 'vault') return null
  const splat = route.params.path
  if (!splat) return null
  return Array.isArray(splat) ? splat.join('/') : (splat as string)
}

export function useCurrentNote(): CurrentNote {
  if (_state) return _state
  const route = useRoute()
  const path = ref<string | null>(null)
  const content = ref<string>('')

  watch(
    () => route.params.path,
    async () => {
      const p = pathFromRoute(route)
      path.value = p
      if (!p) {
        content.value = ''
        return
      }
      try {
        const post = await getPost(p)
        content.value = post.content
      } catch {
        content.value = ''
      }
    },
    { immediate: true },
  )

  _state = { path, content }
  return _state
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/composables/vault/__tests__/useCurrentNote.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/composables/vault/useCurrentNote.ts src/composables/vault/__tests__/useCurrentNote.test.ts
git commit -m "feat(ai): add useCurrentNote composable (route → post content)"
```

---

## Task 8: `sendAndStream` + `configured` state in `useAiHistory`

**Files:**
- Modify: `src/composables/vault/useAiHistory.ts` (add new state, add `sendAndStream`, update `loadActive`)
- Modify: `src/composables/vault/__tests__/useAiHistory.test.ts` (update the `loadActive` tests for the new shape; add 3 `sendAndStream` tests)

`useAiHistory` grows four new refs (`busy`, `errorState`, `abortRef`, `configured`) and one new method (`sendAndStream`). The `sendMessage` method from the prior spec is **kept** as a thin wrapper around `sendAndStream` so any external call site that might exist keeps working — though the only caller in the codebase is `AiPanel.vue`, which we update in Task 9. The `loadActive` method now reads the new `/active` shape and populates `configured`.

The key test seam is the `streamChat` async generator. We mock `ai-api`'s `streamChat` to control the event sequence. We also need to update the `loadActive` test setup because the response shape changed (Task 6).

- [ ] **Step 1: Update the `loadActive` tests for the new shape**

Open `src/composables/vault/__tests__/useAiHistory.test.ts`. Find:

```ts
it('with no active session, leaves activeSession null and messages empty', async () => {
  queue.push({ status: 200, body: { sessionId: null } })
  ...
})

it('with an active session, populates activeSession and messages', async () => {
  queue.push({ status: 200, body: { sessionId: 42 } })
  queue.push({ status: 200, body: [{ id: 1, sessionId: 42, role: 'user', content: 'hi', createdAt: 100 }] })
  ...
})
```

Replace with:

```ts
it('with no active session, leaves activeSession null and messages empty', async () => {
  queue.push({ status: 200, body: { sessionId: null, configured: true } })
  ...
  expect(h.api.configured.value).toBe(true)
})

it('with an active session, populates activeSession and messages', async () => {
  queue.push({ status: 200, body: { sessionId: 42, configured: true } })
  queue.push({ status: 200, body: [{ id: 1, sessionId: 42, role: 'user', content: 'hi', createdAt: 100 }] })
  ...
})
```

Also fix any other places in the test file that push `{ sessionId: ... }` without `configured` (search the file for `'sessionId:'`). Each one needs `configured: true` appended.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/composables/vault/__tests__/useAiHistory.test.ts`
Expected: the `loadActive` tests fail (the response body doesn't have `configured`).

- [ ] **Step 3: Update `src/composables/vault/useAiHistory.ts`**

Add `streamChat` to the imports, add the new refs, update `loadActive` to read `configured`, and add `sendAndStream`. The full file becomes:

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
//
// sendAndStream is the streaming equivalent of sendMessage. It
// uses the same optimistic-update pattern but iterates the SSE
// event stream from /api/ai/chat, appending tokens to the
// assistant message in place.
import { ref, type Ref } from 'vue'
import * as api from '../../lib/ai-api.js'
import type { Session, Message, ChatEvent } from '../../lib/ai-api.js'
import { streamChat } from '../../lib/ai-api.js'

export interface AiHistory {
  // state
  activeSession: Ref<Session | null>
  messages: Ref<Message[]>
  sessions: Ref<Session[]>
  isLoading: Ref<boolean>
  busy: Ref<boolean>
  errorState: Ref<string | null>
  configured: Ref<boolean>

  // actions
  loadActive(): Promise<void>
  refreshSessions(): Promise<void>
  createSession(): Promise<Session>
  switchSession(id: number): Promise<void>
  renameSession(id: number, title: string): Promise<void>
  deleteSession(id: number): Promise<void>
  sendMessage(content: string): Promise<void>
  sendAndStream(text: string, currentNote?: { path: string; content: string }): Promise<void>
}

let _state: AiHistory | null = null

// Test-only escape hatch: reset the singleton so each test starts
// from a clean slate. Not exported in the public type — tests reach
// for it via a re-export declared in __tests__.
export function __resetForTesting(): void {
  _state = null
}

export function useAiHistory(): AiHistory {
  if (_state) return _state

  const activeSession = ref<Session | null>(null)
  const messages = ref<Message[]>([])
  const sessions = ref<Session[]>([])
  const isLoading = ref(false)
  const busy = ref(false)
  const errorState = ref<string | null>(null)
  const configured = ref(false)

  async function loadActive() {
    isLoading.value = true
    try {
      const out = await api.getActiveSession()
      configured.value = out.configured
      if (out.activeId === null) {
        activeSession.value = null
        messages.value = []
        return
      }
      activeSession.value = { id: out.activeId, title: '', createdAt: 0, updatedAt: 0 }
      messages.value = await api.listMessages(out.activeId)
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
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = updated
  }

  async function deleteSession(id: number) {
    await api.deleteSession(id)
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (activeSession.value?.id === id) {
      activeSession.value = null
      messages.value = []
    }
  }

  async function sendMessage(content: string) {
    return sendAndStream(content)
  }

  async function sendAndStream(
    text: string,
    currentNote?: { path: string; content: string },
  ): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!configured.value) return
    if (busy.value) return
    if (activeSession.value === null) {
      const s = await createSession()
      activeSession.value = s
    }
    const sessionId = activeSession.value.id

    // Optimistic insert: user message (id 0) + empty assistant (id 0).
    // Object identity is the in-flight discriminator (see spec §3.9).
    const optimisticUser: Message = {
      id: 0, sessionId, role: 'user', content: trimmed, createdAt: Date.now(),
    }
    const optimisticAssistant: Message = {
      id: 0, sessionId, role: 'assistant', content: '', createdAt: Date.now() + 1,
    }
    messages.value = [...messages.value, optimisticUser, optimisticAssistant]

    busy.value = true
    errorState.value = null
    const ac = new AbortController()

    try {
      for await (const event of streamChat(
        {
          sessionId,
          content: trimmed,
          currentNotePath: currentNote?.path,
          currentNoteContent: currentNote?.content,
        },
        ac.signal,
      )) {
        applyEvent(event, optimisticUser, optimisticAssistant)
        if (event.type === 'done' || event.type === 'error') break
      }
      await refreshSessions()
    } finally {
      busy.value = false
    }
  }

  function applyEvent(
    event: ChatEvent,
    optimisticUser: Message,
    optimisticAssistant: Message,
  ): void {
    if (event.type === 'user') {
      messages.value = messages.value.map((m) =>
        m === optimisticUser ? { ...m, id: event.id } : m
      )
      optimisticUser.id = event.id
    } else if (event.type === 'token') {
      optimisticAssistant.content += event.text
      messages.value = messages.value.map((m) =>
        m === optimisticAssistant ? { ...m, content: optimisticAssistant.content } : m
      )
    } else if (event.type === 'done') {
      messages.value = messages.value.map((m) =>
        m === optimisticAssistant ? { ...m, id: event.assistantId } : m
      )
      optimisticAssistant.id = event.assistantId
    } else if (event.type === 'error') {
      optimisticAssistant.content += `\n\n[error: ${event.reason}]`
      messages.value = messages.value.map((m) =>
        m === optimisticAssistant ? { ...m, id: -1, content: optimisticAssistant.content } : m
      )
      errorState.value = event.reason
    }
  }

  _state = {
    activeSession,
    messages,
    sessions,
    isLoading,
    busy,
    errorState,
    configured,
    loadActive,
    refreshSessions,
    createSession,
    switchSession,
    renameSession,
    deleteSession,
    sendMessage,
    sendAndStream,
  }
  return _state
}
```

- [ ] **Step 4: Run the existing tests to verify the `loadActive` shape change passes**

Run: `npx vitest run src/composables/vault/__tests__/useAiHistory.test.ts`
Expected: the updated `loadActive` tests pass.

- [ ] **Step 5: Write the failing tests for `sendAndStream`**

Append to `src/composables/vault/__tests__/useAiHistory.test.ts`:

```ts
import { vi } from 'vitest'
import * as apiModule from '../../../lib/ai-api'

// streamChat is mocked at the module boundary. The default mock
// produces a happy-path event sequence: user id, two tokens, done.
vi.mock('../../../lib/ai-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ai-api')>()
  return {
    ...actual,
    streamChat: vi.fn(async function* () {
      yield { type: 'user', id: 7 }
      yield { type: 'token', text: 'hi ' }
      yield { type: 'token', text: 'there' }
      yield { type: 'done', userId: 7, assistantId: 8 }
    }),
  }
})

describe('sendAndStream', () => {
  it('optimistically inserts user + assistant, then replaces ids on done', async () => {
    // loadActive
    queue.push({ status: 200, body: { sessionId: 1, configured: true } })
    queue.push({ status: 200, body: [] })
    // refreshSessions after done
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    await h.api.sendAndStream('hello')
    expect(h.messages.value).toHaveLength(2)
    expect(h.messages.value[0]).toMatchObject({ id: 7, role: 'user', content: 'hello' })
    expect(h.messages.value[1]).toMatchObject({
      id: 8, role: 'assistant', content: 'hi there',
    })
    expect(h.busy.value).toBe(false)
    expect(h.errorState.value).toBeNull()
  })

  it('appends [error: ...] to the assistant and sets errorState on error event', async () => {
    const { streamChat } = await import('../../../lib/ai-api')
    vi.mocked(streamChat).mockImplementationOnce(async function* () {
      yield { type: 'user', id: 9 }
      yield { type: 'token', text: 'partial ' }
      yield { type: 'error', reason: 'llm-error' }
    })

    queue.push({ status: 200, body: { sessionId: 1, configured: true } })
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    await h.api.sendAndStream('hi')
    expect(h.messages.value[0].id).toBe(9)
    expect(h.messages.value[1].id).toBe(-1)
    expect(h.messages.value[1].content).toContain('partial ')
    expect(h.messages.value[1].content).toContain('[error: llm-error]')
    expect(h.errorState.value).toBe('llm-error')
  })

  it('is a no-op when called while busy is true', async () => {
    const { streamChat } = await import('../../../lib/ai-api')
    // First call: hangs (returns a never-resolving async gen).
    // Second call: would yield, but should be a no-op.
    vi.mocked(streamChat)
      .mockImplementationOnce(async function* () {
        // hang forever
        await new Promise(() => {})
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'user', id: 1 }
        yield { type: 'done', userId: 1, assistantId: 2 }
      })

    queue.push({ status: 200, body: { sessionId: 1, configured: true } })
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    const p1 = h.api.sendAndStream('first')
    // Don't await — busy is now true.
    await h.api.sendAndStream('second')
    // The second call should not have queued any messages beyond
    // what the first one already optimistically inserted.
    expect(h.messages.value.filter((m) => m.content === 'second')).toHaveLength(0)
    // Clean up: resolve p1 by aborting. (Not strictly needed; the
    // test will end and vitest will GC the dangling promise.)
    void p1
  })
})
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `npx vitest run src/composables/vault/__tests__/useAiHistory.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/composables/vault/useAiHistory.ts src/composables/vault/__tests__/useAiHistory.test.ts
git commit -m "feat(ai): add sendAndStream + busy/errorState/configured to useAiHistory"
```

---

## Task 9: `AiPanel.vue` + `style.css` updates

**Files:**
- Modify: `src/components/vault/AiPanel.vue` (replace `console.debug`; add banner / chip / busy state / caret)
- Modify: `src/style.css` (add styles for the new elements)

The component grows three new UI elements (banner, chip, caret) and replaces its `sendMessage` call with `sendAndStream`. The disabled state on the send button is now `!draft.trim() || history.busy.value || !history.configured.value`.

- [ ] **Step 1: Modify `src/components/vault/AiPanel.vue`**

Replace the file content with:

```vue
<script setup lang="ts">
// AI panel — UI + persistence + LLM. The close button emits `close`
// so the parent can decide what to do (typically toggleAi in
// VaultView). The composer sends a user message to the active
// session via useAiHistory.sendAndStream; the server streams back
// tokens that fill the assistant bubble in real time.
//
// The `configured` flag (from /api/ai/active) determines whether
// the send button is enabled. When false, a persistent banner
// explains the missing env var. The `busy` flag disables the send
// button while a stream is in flight; there is no Stop button in
// v1.
import { onMounted, ref } from 'vue'
import { ICON_AI } from './icons'
import { useAiHistory } from '../../composables/vault/useAiHistory'
import { useCurrentNote } from '../../composables/vault/useCurrentNote'
import AiSessionPicker from './AiSessionPicker.vue'

const emit = defineEmits<{
  close: []
}>()

const draft = ref('')
const pickerOpen = ref(false)
const history = useAiHistory()
const currentNote = useCurrentNote()

onMounted(async () => {
  await history.loadActive()
})

async function onSend() {
  const text = draft.value.trim()
  if (!text) return
  if (history.busy.value) return
  if (!history.configured.value) return
  draft.value = '' // clear immediately for snappy UX
  await history.sendAndStream(text, {
    path: currentNote.path.value ?? '',
    content: currentNote.content.value,
  })
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

const noteTitle = (path: string | null): string => {
  if (!path) return ''
  // Use the basename minus extension as a friendly title.
  const segs = path.split('/')
  const last = segs[segs.length - 1] ?? path
  return last.replace(/\.md$/i, '')
}
</script>

<template>
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
      <span
        v-if="currentNote.path.value"
        class="ai-note-chip"
        :title="currentNote.path.value"
      >📎 {{ noteTitle(currentNote.path.value) }}</span>
      <button
        class="ai-close"
        type="button"
        title="Close panel"
        aria-label="Close panel"
        @click="emit('close')"
      >×</button>
    </header>

    <div
      v-if="!history.configured.value"
      class="ai-no-key-banner"
      role="status"
    >AI not configured — set <code>ANTHROPIC_API_KEY</code> in the server environment.</div>

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
          :class="[m.role, { 'ai-streaming': m.id === 0 || m.id === -1 }]"
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
          :disabled="!draft.trim() || history.busy.value || !history.configured.value"
        >↑</button>
      </div>
    </form>

    <AiSessionPicker v-if="pickerOpen" @close="pickerOpen = false" />
  </aside>
</template>
```

- [ ] **Step 2: Append the new CSS to `src/style.css`**

Open `src/style.css` and append the new rules (anywhere in the file — these all sit at the top level of the `.ai-panel` namespace):

```css
/* LLM integration additions (spec §5) */
.ai-panel .ai-no-key-banner {
  background: var(--vs-bg-3);
  color: var(--vs-text-2);
  font-size: 0.8rem;
  padding: 8px 12px;
  line-height: 1.4;
  border-bottom: 1px solid var(--vs-border);
}

.ai-panel .ai-no-key-banner code {
  font-family: var(--mono);
  background: var(--vs-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.78rem;
}

.ai-panel .ai-note-chip {
  font-size: 0.75rem;
  color: var(--vs-text-2);
  background: var(--vs-bg-2);
  padding: 2px 8px;
  border-radius: 4px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: auto;
  margin-right: 8px;
}

.ai-panel .ai-message.assistant.ai-streaming .ai-bubble::after {
  content: '▍';
  display: inline-block;
  margin-left: 1px;
  color: var(--vs-accent);
  animation: ai-cursor-blink 1s steps(2) infinite;
}

@keyframes ai-cursor-blink {
  to { opacity: 0; }
}
```

- [ ] **Step 3: Run the typecheck and full client test suite**

Run: `npm test`
Expected: 219 passed (192 baseline + 27 new from Tasks 2–8: 4 buildSystemPrompt + 5 llm + 4 runChat + 5 routes + 2 streamChat + 4 useCurrentNote + 3 sendAndStream).

- [ ] **Step 4: Commit**

```bash
git add src/components/vault/AiPanel.vue src/style.css
git commit -m "feat(ai): wire AiPanel to sendAndStream + note chip + no-key banner + streaming caret"
```

---

## Task 10: Mount smoke test + spec §8 implementation notes

**Files:**
- Modify: `server/__tests__/mount.test.ts` (add 1 smoke test for `POST /api/ai/chat`)
- Modify: `docs/superpowers/specs/2026-06-07-llm-integration.md` (fill in §8 with implementation notes)

- [ ] **Step 1: Add a smoke test for `POST /api/ai/chat`**

Append to `server/__tests__/mount.test.ts`:

```ts
import { vi } from 'vitest'
import * as chatModule from '../ai/chat'

vi.mock('../ai/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/chat')>()
  return {
    ...actual,
    runChat: vi.fn(async ({ onUserId, onToken }: any) => {
      await onUserId(1)
      await onToken('ok')
      return { userId: 1, assistantId: 2, fullText: 'ok' }
    }),
  }
})

describe('app mounts /api/ai/chat', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
  })
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY
  })

  it('POST /api/ai/chat returns a text/event-stream response', async () => {
    // Create a session first.
    const created = await app.fetch(new Request('http://localhost/api/ai/sessions', { method: 'POST' }))
    const { id } = await created.json() as { id: number }
    const r = await app.fetch(new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id, content: 'hi' }),
    }))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/)
    const text = await r.text()
    expect(text).toContain('event: user')
    expect(text).toContain('event: done')
  })
})
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: 220 passed (219 after Task 9 + 1 new mount smoke).

- [ ] **Step 3: Append implementation notes to spec §8**

Open `docs/superpowers/specs/2026-06-07-llm-integration.md`. Replace the existing §8 stub with a section that records:
- Commit count for the feature (run `git log --oneline 1849e16..HEAD | wc -l` and round)
- The two main deviations from the spec (if any) — common candidates:
  - ChatError location (moved to its own `errors.ts` file to avoid circular import; behavior unchanged)
  - `runChat`'s partial-on-error behavior (server persists raw partial text, client appends the `[error: <reason>]` marker — see Task 4 step 3 comment)
  - `useCurrentNote`'s route change detection (uses `watch(() => route.params.path, ...)` — covers the splat-coercion case described in spec §3.7)
- A list of the new public exports and their test coverage
- A note that this work does NOT include tool use, slash commands, or stop button (deferred per spec §6)

A short, factual writeup is enough. Example:

```markdown
## 8. Implementation notes

Implemented across N commits. Two deviations from the original spec, neither behavioral:

- `ChatError` was extracted to its own `server/ai/errors.ts` file to avoid a
  circular import between `llm.ts` (which throws `no-api-key` /
  `aborted` / `llm-error`) and `chat.ts` (which throws `not-found` /
  `empty`). The class is identical to the spec sketch; consumers
  import from the same paths via the chat module re-exports.

- `runChat`'s error path persists the raw partial text (no
  `[error: <reason>]` marker). The marker is appended client-side
  in `useAiHistory.sendAndStream`'s `applyEvent` function. This
  matches the spec §3.9 sketch and keeps the server log clean of
  UI-only markers.

- `useCurrentNote` uses `watch(() => route.params.path, ...)` with
  `immediate: true` instead of computing the path inside the
  component. The behavior matches spec §3.7; the difference is that
  the watch fires once on mount even when the path is `null`, which
  keeps the "not on vault" branch in the same code path as the
  "switched off vault" branch.

Test coverage summary: 220 tests across 27 files. New files
contributing tests: `server/__tests__/llm.test.ts` (5),
`server/__tests__/chat.test.ts` (8), `src/composables/vault/
__tests__/useCurrentNote.test.ts` (4). Existing files extended:
`server/__tests__/ai-routes.test.ts` (+5: /active 1→2, +4 /chat),
`server/__tests__/mount.test.ts` (+1), `src/lib/__tests__/ai-api.test.ts`
(+2), `src/composables/vault/__tests__/useAiHistory.test.ts` (+3).

Out of scope items (spec §6) are unchanged: no tool use, no
slash commands, no stop button, no live-editor context.
```

- [ ] **Step 4: Commit**

```bash
git add server/__tests__/mount.test.ts docs/superpowers/specs/2026-06-07-llm-integration.md
git commit -m "test(ai): add POST /api/ai/chat smoke test; record implementation notes"
```

- [ ] **Step 5: Push to gitee**

```bash
git push gitee main
```

---

## Self-review checklist (for the implementer)

Before starting, sanity-check these against the spec:

- [ ] Spec §2 row 6 (`configured: false → banner + disabled send`) is implemented via `configured` from `/active` (Task 5 step 3 + Task 8 step 3 + Task 9 step 1).
- [ ] Spec §2 row 8 (`📎 chip in header, updates on note change`) is implemented via `useCurrentNote` (Task 7) + the chip in the AiPanel header (Task 9 step 1).
- [ ] Spec §2 row 12 (`network drop → error chip + partial preserved if server got it`) is implemented via `useAiHistory.sendAndStream`'s `error` branch (Task 8 step 3) + the spec's known-limitation note in §3.7.
- [ ] Spec §3.4 GET /active extension is implemented (Task 5 steps 1–3).
- [ ] Spec §3.7 live-editor limitation is documented in the `useCurrentNote` file's leading comment (Task 7 step 3) and acknowledged in the spec §8 (Task 10 step 3).
- [ ] All TypeScript types line up across files: `ChatEvent` is defined in `src/lib/ai-api.ts` and imported by `useAiHistory.ts`; `ChatError` is defined in `server/ai/errors.ts` and imported by `server/ai/llm.ts` and `server/ai/chat.ts`; `ActiveSession` is defined in `src/lib/ai-api.ts` and used in `useAiHistory.loadActive`.
- [ ] No `console.debug` left in `AiPanel.vue` (the old stub is replaced in Task 9 step 1).
- [ ] `@anthropic-ai/sdk` is in `package.json` `dependencies` (not `devDependencies`).
