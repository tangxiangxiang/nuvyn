# LLM Integration — Design

**Date:** 2026-06-07
**Status:** Approved
**Scope:** Wire a real Anthropic Claude model behind the AI panel. Replace the `console.debug` stub in the composer with a streaming, server-proxied LLM call that is aware of the currently open note. New dependency: `@anthropic-ai/sdk`. No schema migration; the existing `messages` table already supports both `user` and `assistant` roles.

## 1. Problem & Goal

The AI panel is multi-session, persistent, and visually polished, but the composer still only does `console.debug` ([src/components/vault/AiPanel.vue:24-31](../../../src/components/vault/AiPanel.vue#L24-L31)). The panel is a stage with no actor. This spec closes the loop:

- The Enter key actually calls Claude and streams the response back.
- The assistant's reply is persisted to SQLite alongside the user's message.
- The model is given the currently open note as system context, so a knowledge-base user can ask questions about what they're reading.
- The API key is held server-side; the browser never sees it.

A successful completion turns the AI panel from a chat-log editor into a working assistant for the vault. The data model and infrastructure for chat are already in place from the prior spec; this work is the missing runtime.

## 2. Behavior (UX contract)

| # | Trigger | Result |
|---|---|---|
| 1 | Composer is empty and user presses Enter | No-op (the send button is also `:disabled` in this state). |
| 2 | Composer has text, user presses Enter (no in-flight stream) | User message is appended optimistically. Empty assistant bubble is appended after it. `POST /api/ai/chat` opens. The send button stays disabled for the duration of the stream. There is no separate "Stop" button in v1 (see §6). |
| 3 | First token arrives | Assistant bubble is filled with the accumulated text. Subsequent tokens append. |
| 4 | Stream completes | `done` event arrives; the assistant bubble is finalized with its real DB id. Composer is re-enabled. |
| 5 | Stream errors mid-way | `error` event arrives; the assistant bubble shows `[error: <reason>]` after the partial content. Composer is re-enabled. The user message is never lost. |
| 6 | `ANTHROPIC_API_KEY` is unset on the server | A persistent banner appears at the top of the panel: "AI not configured — set `ANTHROPIC_API_KEY` in the server environment." The send button stays disabled. |
| 7 | Reload with a session that has prior messages | Both user and assistant turns render from the DB. Clicking into a fresh empty session shows the welcome bubble. |
| 8 | Switch notes in the editor while panel is open | A small chip in the panel header updates: `📎 <note title>`. The next send uses the new note as system context. |
| 9 | No note is open (e.g., on `/tags`) | The chip is hidden; the system prompt contains only the base "you're a helpful assistant for a personal knowledge base" line. |
| 10 | User opens the panel for the first time after a successful send | The active session's `updated_at` is bumped; the picker reorders the session to the top of the list. |
| 11 | Two tabs of the app are open and one of them sends a message | The other tab does not see the live update mid-session (no realtime sync in v1; see §6). On reload, both see the same state. |
| 12 | Network drops during a stream | The fetch promise rejects; the assistant bubble is finalized with `[error: network]` and the partial text; the user message is preserved if the server received and persisted the request before the drop. (If the drop happens before the server processes the request, the optimistic user message is lost on reload — acceptable for v1; a localStorage-backed outbox is a future spec.) |

## 3. Architecture

### 3.1 Request shape and call origin

The browser calls `POST /api/ai/chat` on the Hono server. The server holds `ANTHROPIC_API_KEY` in `process.env`, opens a streaming request to `https://api.anthropic.com/v1/messages`, and pipes tokens back to the browser over SSE. The browser never has the key.

```
┌─────────────────┐  POST /api/ai/chat   ┌──────────────────────────┐
│ AiPanel.vue     │ ──────────────────►  │ Hono: ai/routes.ts       │
│  (useAiHistory) │                      │  POST /chat (streamSSE)  │
│                 │ ◄─── SSE events ───  │                          │
│                 │   user / token /     │  1. validate session     │
│                 │   done / error       │  2. read message history │
└─────────────────┘                      │  3. save user message    │
                                         │  4. runChat()            │
                                         │  5. on token → SSE       │
                                         │  6. save assistant       │
                                         │  7. SSE done/error       │
                                         └────────────┬─────────────┘
                                                      │ HTTPS + SSE
                                                      ▼
                                            ┌─────────────────────┐
                                            │ Anthropic Messages  │
                                            │ claude-sonnet-4-6   │
                                            └─────────────────────┘
```

The browser sends one request per user turn. The request body carries the new user content plus the current note (if any). The server streams back four event types: `user` (the saved user row id), `token` (incremental text), `done` (both row ids), `error` (a string reason).

### 3.2 New file: `server/ai/llm.ts`

Thin wrapper around `@anthropic-ai/sdk`. Single exported function:

```ts
// server/ai/llm.ts
export type StreamClaudeOpts = {
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  model: string
  signal?: AbortSignal
  onToken: (text: string) => void | Promise<void>
}

export async function streamClaude(opts: StreamClaudeOpts): Promise<string> {
  // Reads ANTHROPIC_API_KEY from process.env. Throws ChatError('no-api-key') if missing.
  // Calls client.messages.stream(...). Subscribes to 'text' events.
  // Accumulates text and calls onToken for each chunk.
  // Returns the full text on completion.
  // Throws ChatError('aborted') if signal fires, ChatError('llm-error') on API failure.
}
```

This file is the only place that knows about the Anthropic SDK. The rest of the AI module talks to `streamClaude` by callback. Test seam: the SDK is `vi.mock`-ed at the module boundary; the tests provide a fake `streamClaude` directly.

### 3.3 New file: `server/ai/chat.ts`

The orchestrator. Pure business logic, no HTTP knowledge:

```ts
// server/ai/chat.ts
export type ChatContext = {
  currentNotePath?: string
  currentNoteContent?: string
}

export type RunChatDeps = {
  db: Database
  model: string
  signal?: AbortSignal
  onUserId: (id: number) => void | Promise<void>
  onToken: (text: string) => void | Promise<void>
}

export async function runChat(opts: {
  sessionId: number
  userContent: string
  ctx: ChatContext
} & RunChatDeps): Promise<{ userId: number; assistantId: number; fullText: string }> {
  // 1. Validate: session exists, content is non-empty.
  // 2. Build system prompt (base + note context).
  // 3. Build messages array: history (from listMessages) + new user.
  // 4. appendMessage(db, sessionId, 'user', userContent); call onUserId(id).
  // 5. await streamClaude({ system, messages, model, signal, onToken }).
  // 6. On completion: appendMessage(db, sessionId, 'assistant', fullText); return.
  //    On error or abort: appendMessage with fullText || '[stream interrupted]';
  //      re-throw a tagged ChatError.
}

export function buildSystemPrompt(ctx: ChatContext): string {
  // Base: "You're a helpful assistant for a personal knowledge base."
  // If ctx.currentNotePath: append "\n\nThe user is currently reading: <path>\n\n<content>".
  // Truncate content at 20_000 chars; if truncated, append
  //   "\n\n[... truncated; full file at <path> ...]"
}
```

`ChatError` is a tagged union — `'no-api-key' | 'not-found' | 'empty' | 'aborted' | 'llm-error'` — defined here, used by the route to map to status codes. The service layer never throws raw `Error`; every failure has a `reason` string.

### 3.4 `server/ai/routes.ts` — add `POST /chat` and extend `GET /active`

**New: `POST /chat`** — the streaming endpoint.

```ts
// Inside the existing aiRoutes sub-app
app.post('/chat', async (c) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return c.json({ ok: false, reason: 'no-api-key' }, 503)
  }
  const body = await c.req.json().catch(() => null) as ChatRequest | null
  if (!body || typeof body.sessionId !== 'number' || typeof body.content !== 'string') {
    return c.json({ ok: false, reason: 'invalid' }, 400)
  }
  // Note: we DON'T 404 here even if the session id is bogus — runChat will throw
  // 'not-found' and we surface it as an SSE error event so the client can show
  // a chip. (Body validation only.)

  return streamSSE(c, async (stream) => {
    const db = getDb()
    try {
      const result = await runChat({
        db,
        sessionId: body.sessionId,
        userContent: body.content,
        ctx: {
          currentNotePath: body.currentNotePath,
          currentNoteContent: body.currentNoteContent,
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
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ reason }) })
    }
  })
})
```

**Modified: `GET /active`** — the existing endpoint from the prior spec is extended to also report whether the server is configured. This is how the client knows the no-key state on first paint, not after a failed send:

```ts
app.get('/active', (c) => {
  return c.json({
    activeId: getActiveSessionId(getDb()),
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
  })
})
```

The existing `ActiveSessionId` wire type in `src/lib/ai-api.ts` becomes `{ activeId: number | null; configured: boolean }`. The corresponding `loadActive` in `useAiHistory` reads both fields and stores `configured` on the singleton.

`ChatRequest` is the wire type and is declared in `src/lib/ai-api.ts` (the existing single source of truth for AI wire types). The server's `server/ai/routes.ts` imports the request shape from there for the body cast.

### 3.5 `server/ai/messages.ts` — no change needed

`appendMessage(db, sessionId, role, content)` from the prior spec already validates `role ∈ {'user', 'assistant'}` and rejects other strings with `invalid-role`. We call it twice: once for the user at the start of `runChat`, once for the assistant at the end. The two inserts are not transactional — atomicity is not required because the user message is written before the stream starts, so a crash only loses the in-flight assistant text.

### 3.6 New dependency: `@anthropic-ai/sdk`

Added to `package.json` dependencies. The model name is `claude-sonnet-4-6`. The SDK is invoked only from `server/ai/llm.ts`. No client-side SDK code, no streaming polyfill, no SSE library on the server (Hono's `streamSSE` is built in).

### 3.7 New module-level composable: `useCurrentNote`

```ts
// src/composables/vault/useCurrentNote.ts
// Singleton (like useAiHistory). Tracks the currently-open note's path and content.
// The AiPanel reads this on send.
export function useCurrentNote(): {
  path: Ref<string | null>
  content: Ref<string>
}
```

The composable derives the path from `useRoute()` (the `/vault/<path>` splat, or `null` if not on the vault). Vue Router exposes the splat as `route.params.path`; depending on the route definition, this is either a `string` or a `string[]` — the composable coerces it to a `string` by joining with `/` when it's an array, and falls back to `null` if the splat is empty or the active route is not the vault. When the path changes, the composable fetches the post content via the existing `getPost` API and caches it. The AiPanel does not need to call `getPost` itself.

**Known limitation (v1):** the cached content is the **server-saved** version, not the editor's live unsaved buffer. Because the editor auto-saves 800ms after the last keystroke, there can be a brief window where the AI sees a slightly stale note. This is acceptable for v1; addressing it requires pushing live editor state through `useEditorTabs`, which is a separate spec.

### 3.8 `src/lib/ai-api.ts` — add `streamChat`

```ts
export type ChatRequest = {
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

export async function* streamChat(
  req: ChatRequest,
  signal?: AbortSignal
): AsyncGenerator<ChatEvent> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.ok) {
    // 503 (no key), 400 (bad body): a JSON body comes back with { reason }.
    // 5xx without a body: synthesize a reason.
    const body = await res.json().catch(() => ({ reason: `http-${res.status}` }))
    yield { type: 'error', reason: body.reason ?? `http-${res.status}` }
    return
  }
  // Parse the SSE stream and yield ChatEvent objects.
  // (Implementation: read res.body with a TextDecoder, split on \n\n,
  // parse "event:" and "data:" lines, JSON.parse the data payload.)
}
```

`streamChat` is the only consumer of the `/api/ai/chat` endpoint on the client. It exposes a typed async iterator; the composable iterates it and updates the optimistic messages.

### 3.9 `useAiHistory` — add `sendAndStream`

The existing `sendMessage` is replaced (or complemented) by a streaming version. Sketch:

```ts
async function sendAndStream(
  text: string,
  currentNote?: { path: string; content: string }
): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || !activeSession.value || busy.value) return
  busy.value = true
  const sessionId = activeSession.value.id

  // Optimistic insert: user message (id 0) + empty assistant (id 0).
  const optimisticUser: Message = { id: 0, sessionId, role: 'user', content: trimmed, createdAt: Date.now() }
  const optimisticAssistant: Message = { id: 0, sessionId, role: 'assistant', content: '', createdAt: Date.now() + 1 }
  messages.value = [...messages.value, optimisticUser, optimisticAssistant]

  const ac = new AbortController()
  abortRef.value = ac

  try {
    for await (const event of streamChat({
      sessionId,
      content: trimmed,
      currentNotePath: currentNote?.path,
      currentNoteContent: currentNote?.content,
    }, ac.signal)) {
      if (event.type === 'user') {
        // Replace optimistic user id in place (by object identity).
        messages.value = messages.value.map(m => m === optimisticUser ? { ...m, id: event.id } : m)
        optimisticUser.id = event.id
      } else if (event.type === 'token') {
        optimisticAssistant.content += event.text
        messages.value = messages.value.map(m =>
          m === optimisticAssistant ? { ...m, content: optimisticAssistant.content } : m
        )
      } else if (event.type === 'done') {
        optimisticAssistant.id = event.assistantId
        messages.value = messages.value.map(m => m === optimisticAssistant ? { ...m, id: event.assistantId } : m)
        await refreshSessions()  // re-fetch so the picker reorders
      } else if (event.type === 'error') {
        optimisticAssistant.content += `\n\n[error: ${event.reason}]`
        messages.value = messages.value.map(m => m === optimisticAssistant ? { ...m, id: -1, content: optimisticAssistant.content } : m)
        errorState.value = event.reason
        break
      }
    }
  } finally {
    busy.value = false
    abortRef.value = null
  }
}
```

Object identity (`m === optimisticUser`) is the discriminator for in-flight messages, matching the `id: 0` pattern from the prior spec. Tests rely on this; it's also why the optimistic objects are kept in the closure rather than re-created per event.

The `busy` ref and `errorState` ref are new state on the singleton. `busy` is `true` for the duration of a stream; `errorState` holds the last error reason (or `null`).

### 3.10 `AiPanel.vue` — replace the stub

```ts
// New imports
import { useCurrentNote } from '../../composables/vault/useCurrentNote'
const currentNote = useCurrentNote()

// Replaces the old onSend
async function onSend() {
  const text = draft.value.trim()
  if (!text) return
  if (history.busy.value) return
  draft.value = ''
  await history.sendAndStream(text, {
    path: currentNote.path.value ?? '',
    content: currentNote.content.value,
  })
}
```

Template changes:
- Send button gets `:disabled="!draft.trim() || history.busy.value || !history.configured.value"`.
- A persistent banner above the composer shows when `!history.configured.value`: `AI not configured — set ANTHROPIC_API_KEY in the server environment.` The banner is also shown immediately on first paint if the `/active` response says the server is unconfigured, so the user never has to send once to discover the missing key.
- A small `📎 <title>` chip in the header (next to the title) shows the current note, hidden when none.
- The welcome bubble is still the empty state (no messages); messages render as before.
- The in-flight assistant bubble uses a `cursor: ▍` caret appended to the end while `busy` is true (v1: a CSS-only animated caret using `:after` with `animation: blink 1s steps(2) infinite`). After the stream ends, the caret disappears.

## 4. State summary

| Ref | Type | Owner | New? |
|---|---|---|---|
| `busy` | `Ref<boolean>` | `useAiHistory` | yes — true while a stream is in flight |
| `errorState` | `Ref<string \| null>` | `useAiHistory` | yes — last error reason, or `null` |
| `abortRef` | `Ref<AbortController \| null>` | `useAiHistory` | yes — current stream's controller, for v2 stop button |
| `configured` | `Ref<boolean>` | `useAiHistory` | yes — false if `ANTHROPIC_API_KEY` is unset, set from the `/active` response on mount |
| `currentNote.path` | `Ref<string \| null>` | `useCurrentNote` (new) | yes |
| `currentNote.content` | `Ref<string>` | `useCurrentNote` (new) | yes |
| `ANTHROPIC_API_KEY` | `process.env` | server | yes — required |
| `ANTHROPIC_MODEL` | `process.env` | server | yes — optional, default `claude-sonnet-4-6` |

No new tables, no schema migration, no new persistent state on the client beyond what `useAiHistory` already holds.

## 5. Visual / interaction details

- **In-flight assistant bubble.** Empty bubble appears immediately after the user's optimistic message. The first token fills the first line; subsequent tokens append without any re-render artifact. A 1px blinking caret (`▍` glyph, accent color) sits at the end of the content while `busy` is true.
- **Error chip.** When the stream fails, the assistant bubble shows the partial content (if any) followed by a one-line error marker in `--vs-text-3`. The bubble is still scrollable.
- **Persistent no-key banner.** Full-width strip at the top of the messages area, 32px tall, `--vs-bg-3` background, `--vs-text-2` text. Includes the literal env var name `ANTHROPIC_API_KEY` in `font-family: var(--mono)`. Hidden when `errorState` is not `'no-api-key'`.
- **Note chip.** Sits to the right of the `·` in the title bar, before the `×` close button. Format: `📎 {note title}` (truncated with ellipsis at 200px). Hidden when `currentNote.path` is `null`. Hover shows the full path as `title` attribute.
- **Send button disabled state.** `:disabled` when the draft is empty OR `busy` is true. The disabled visual is the existing 0.4 opacity treatment. There is no separate "Stop" button in v1.

## 6. Out of scope

- **Cancellable streams (Stop button).** The `AbortController` is wired but not exposed in the UI. Adding a Stop button is a follow-up; the wiring is in place to make it trivial.
- **Tool use.** The model is given text-only context (note + history). No file editing, no search, no function-calling. The SDK supports it; we'd add it in a later spec.
- **Multiple notes in context.** Only the active note is injected. Slash commands to add more notes (`/add archive/foo.md`) are a future spec.
- **Live editor state.** `useCurrentNote` reads the saved version, not the unsaved buffer. See §3.7.
- **Token budget / cost display.** No UI for max-tokens, no cost counter. The server uses `max_tokens: 4096` for the response; longer answers are cut off at that limit (Anthropic's `end_turn` reason is the normal completion path).
- **User-configurable model selection.** `ANTHROPIC_MODEL` env var only. No UI to switch.
- **Realtime multi-tab sync.** Already called out as out of scope in the SQLite spec; this spec doesn't change that.
- **FTS5 over messages.** Still a future spec; the new assistant rows are just normal message rows.
- **Message export/import.** Still a future spec.

## 7. Testing

Target: ~12 new tests, final count ~204.

**Server tests (8 new):**
- `server/__tests__/llm.test.ts` (3 tests) — mock `@anthropic-ai/sdk`; assert `onToken` is called per chunk, accumulated text is correct, signal abort throws `ChatError('aborted')`.
- `server/__tests__/chat.test.ts` (3 tests) — mock `streamClaude`; assert system prompt is built correctly with and without note context, truncation kicks in at 20K, `appendMessage` is called twice in the right order with the right roles.
- `server/__tests__/ai-routes.test.ts` (+2 tests, existing file) — `POST /chat` with a stub `runChat` that emits tokens; assert the SSE event sequence is `user → token* → done`. 503 when `ANTHROPIC_API_KEY` is unset (env var cleared at test start).

**Client tests (4 new):**
- `src/lib/__tests__/ai-api.test.ts` (+1 test) — `streamChat` parses a mock SSE response into the typed `ChatEvent` sequence; yields the right events in order.
- `src/composables/vault/__tests__/useAiHistory.test.ts` (+3 tests) — `sendAndStream`:
  - Happy path: optimistic insert, user event replaces id, token events append, done event finalizes; final messages list has the real ids (no `id: 0` left).
  - Error path: an `error` event mid-stream leaves the user message with a real id, the assistant content has the partial text + `[error: ...]` suffix, `errorState` is set.
  - Concurrent send: calling `sendAndStream` while `busy` is true is a no-op (no second fetch).

**Smoke test (1 new, in `server/__tests__/mount.test.ts`):**
- `POST /chat` with a real server and a stub `runChat` returns a 200 SSE response with the right Content-Type and at least one event.

**Manual smoke checklist** (documented in the plan, not in `npm test`):
- With `ANTHROPIC_API_KEY` set, sending "hi" produces a real assistant reply within 5 seconds.
- With `ANTHROPIC_API_KEY` unset, the panel shows the banner and the send button is disabled.
- Opening a note, asking "summarize this", and verifying the model received the note as context (visible in the response).
- Network tab shows a single `POST /api/ai/chat` per turn, with `text/event-stream` content type.

## 8. Implementation notes

Implemented across 10 commits on top of the LLM integration plan (`docs/superpowers/plans/2026-06-07-llm-integration.md`).

### Deviations from the original spec

Three deviations, all small and behavior-preserving:

- **`ChatError` lives in its own file (`server/ai/errors.ts`)**, not inside `chat.ts` as the original spec sketch suggested. This avoids a circular import between `llm.ts` (which throws `no-api-key` / `aborted` / `llm-error`) and `chat.ts` (which throws `not-found` / `empty`). The class is identical to the spec sketch; consumers import from the same path.

- **`ChatError` now carries a typed `assistantId?: number` field.** The original spec sketched `Object.assign(err, { assistantId })` to attach the partial assistantId to a re-thrown error. The implementation adds a proper optional `readonly assistantId?: number` to the class (constructor takes it as a third arg) so consumers can do `err.assistantId` type-safely. This was driven by the error-path tests added in Task 4.

- **`runChat`'s catch block mirrors tokens into a local accumulator.** The original sketch had `fullText` set only in the success path (from the `streamClaude` return value), which meant the catch block always wrote `'[stream interrupted]'` even when real partial tokens had streamed. The implementation wraps the consumer's `onToken` to mirror each token into a local `fullText` accumulator, so the catch block can persist the real partial text. This is a behavior fix, not a behavior change; the spec's intent (persist partial on abort) is now correctly implemented.

### Test coverage summary

223 tests across 27 files (was 192 across 24 before this feature).

New files contributing tests:
- `server/__tests__/chat.test.ts` (11: 4 buildSystemPrompt + 7 runChat)
- `server/__tests__/llm.test.ts` (5: 4 pumpStream + 1 streamClaude no-key)
- `server/__tests__/mount.test.ts` (+1: /api/ai/chat smoke)
- `src/composables/vault/__tests__/useCurrentNote.test.ts` (4)
- `src/lib/__tests__/ai-api.test.ts` (+2: streamChat happy + error)

Existing files extended:
- `server/__tests__/ai-routes.test.ts` (+5: 1 /active rewritten, 1 /active added, 4 /chat added)
- `src/composables/vault/__tests__/useAiHistory.test.ts` (+3: sendAndStream happy + error + busy-guard)
- `src/composables/vault/__tests__/useAiHistory.test.ts` also had mock-queue bodies updated for the new `/active` wire shape (`{ activeId, configured }`)

### Out of scope (still)

The spec's §6 "out of scope" items remain out of scope:
- No tool use, no slash commands, no stop button, no live editor context (the known limitation in `useCurrentNote`)

### Other notes

- The `@anthropic-ai/sdk` was pinned to `^0.102.0` (latest at install time) rather than the plan's `^0.40.0` placeholder. The import surface used (`new Anthropic({ apiKey })`, `client.messages.stream({...})` with `text` event and `finalMessage()`) is unchanged in v0.102.0.
- `npm install` reported 1 high-severity vulnerability at install time (transitive deps in the SDK's tree). Not investigated; the SDK is a server-side runtime dep and the warning is likely pre-existing in the broader ecosystem.
