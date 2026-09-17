# AI Split to Draft — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click action that asks Claude to split a long `inbox/` or `literature/` note into atomic zettel cards, lets the user review and edit them in the AI panel, and writes the accepted cards to `src/content/zettel/draft/`.

**Architecture:** Two entry points (tree context menu + AI panel `/split` slash command) share a single `splitCard(path, mode)` action. Server: `POST /api/ai/split` (synchronous, non-streaming, returns `Card[]`) and `POST /api/zettel/draft/batch` (writes `zettel/draft/<slug>.md` per card with frontmatter `source:` and `splitMode:`). Frontend: a tiny `useSplitReview` composable owns the review state; `AiPanel` switches its body to a review surface when the ref is non-null.

**Tech Stack:** Vue 3 (Composition API), Hono (existing server), `@anthropic-ai/sdk` (existing), vitest, headless Chrome via `/tmp/cdp-drive.mjs` for visual verification.

**Spec:** [../specs/2026-06-13-ai-split-to-draft.md](../specs/2026-06-13-ai-split-to-draft.md)

---

## File map

| File | Change | Purpose |
|---|---|---|
| [src/lib/ai-api.ts](../../../src/lib/ai-api.ts) | +~30 | `Card` type, `splitNote()`, `writeDraftBatch()` fetch wrappers |
| `src/composables/vault/useSplitReview.ts` (new) | +~40 | Shared review-state composable (provided by VaultView) |
| [src/components/vault/TreeRow.vue](../../../src/components/vault/TreeRow.vue) | +~6 | "📤 拆为原子卡" context menu item, emit `split-card` |
| [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue) | +~15 | Handle `split-card` event, derive mode from path prefix |
| [src/views/VaultView.vue](../../../src/views/VaultView.vue) | +~20 | `splitCard()` action, provide `useSplitReview` |
| [src/components/vault/AiPanel.vue](../../../src/components/vault/AiPanel.vue) | +~180 | Review surface, `/split` slash command |
| `server/ai/split.ts` (new) | +~120 | `runSplit({ path, mode })` orchestrator |
| [server/ai/routes.ts](../../../server/ai/routes.ts) | +~25 | `POST /api/ai/split` route |
| `server/zettel.ts` (new) | +~90 | `POST /api/zettel/draft/batch` route |
| [server/index.ts](../../../server/index.ts) | +~3 | Mount zettel sub-router |
| `server/__tests__/split.test.ts` (new) | +~100 | Server-side split tests |
| `server/__tests__/zettel-draft-batch.test.ts` (new) | +~110 | Server-side batch tests |

**Total:** ~12 files, ~750 lines added, 0 removed, 0 restructured.

No existing route, component, or test is modified in a breaking way. Every change is additive or scope-limited to a new code path.

---

### Task 1: Wire types + fetch wrappers (`ai-api.ts`)

**Files:**
- Modify: [src/lib/ai-api.ts](../../../src/lib/ai-api.ts) (append to end)

This is the load-bearing type — every other layer imports `Card` from here. We do this task first so all subsequent tasks can type-check against a stable shape.

- [ ] **Step 1: Add the `Card` interface and two fetch wrappers**

Append to the bottom of [src/lib/ai-api.ts](../../../src/lib/ai-api.ts):

```ts
// --- AI split-to-draft (atomic card generation) ---

/** A single atomic zettel card proposed by the model. The `source`
 *  and `splitMode` fields are filled by the server, not the model —
 *  we don't want the model to be able to attribute a card to a
 *  different source note than the one the user clicked on. */
export interface Card {
  title: string
  body: string
  tags: string[]
  /** A slug for the future filename (e.g. "domain-events-as-decoupling-boundary").
   *  Server validates against SEGMENT_RE. Conflicts get -2, -3, ... suffix. */
  slug: string
  source: string
  splitMode: 'inbox' | 'literature'
}

export type SplitMode = 'inbox' | 'literature'

export interface SplitRequest {
  path: string         // e.g. "inbox/init" (no .md)
  mode: SplitMode
}

export interface SplitResponse {
  cards: Card[]
}

export interface WriteDraftBatchRequest {
  cards: Card[]
}

export interface WriteDraftBatchResponse {
  written: { slug: string; path: string }[]
  skipped: { slug: string; reason: string }[]
  failed:  { slug: string; reason: string }[]
}

/** Ask Claude to split a long note into atomic zettel cards.
 *  Synchronous, non-streaming; latency is ~5-15s for a 2000-word note. */
export async function splitNote(req: SplitRequest): Promise<SplitResponse> {
  return jsonOrThrow<SplitResponse>(await fetch('/api/ai/split', {
    method: 'POST', ...jsonBody(req),
  }))
}

/** Write a batch of cards to src/content/zettel/draft/.
 *  Per-card status: written (with the final path), skipped, or failed. */
export async function writeDraftBatch(
  req: WriteDraftBatchRequest,
): Promise<WriteDraftBatchResponse> {
  return jsonOrThrow<WriteDraftBatchResponse>(await fetch('/api/zettel/draft/batch', {
    method: 'POST', ...jsonBody(req),
  }))
}
```

The two helpers `jsonOrThrow` and `jsonBody` already exist in this file (defined at lines 76-94) — we reuse them.

- [ ] **Step 2: Verify type-check passes**

Run: `pnpm exec vue-tsc -b --force`
Expected: no errors. (Adding an exported type and two functions that use existing helpers cannot break callers.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai-api.ts
git commit -m "feat(ai-api): add Card type and splitNote / writeDraftBatch fetch wrappers

Single source of truth for the JSON contract on the wire: server
imports Card from here, the AI panel imports from here, the
composable wraps the two fetch calls.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Server — split orchestrator (`server/ai/split.ts`)

**Files:**
- Create: `server/ai/split.ts` (new, ~120 lines)
- Test: inline `runSplit()` unit (covered end-to-end in Task 3 via the route test)

This is the only new file in `server/ai/`. It owns the prompt, the SDK call, and the parser. The route layer (Task 3) is a thin Hono handler that calls into it.

- [ ] **Step 1: Create the orchestrator file**

Create `server/ai/split.ts`:

```ts
// AI split-to-draft orchestrator. Pure function of (path, mode) → Card[].
// One non-streaming Claude call; the model is told to return JSON only
// (no prose, no code fences), then we hand-parse and validate.
//
// Lives in server/ai/ alongside chat.ts because it shares the LLM
// wrapper (./llm.js → streamClaude). The non-streaming cousin is
// `messages.create` from the SDK; we don't go through streamClaude
// because we want the full result in one shot, not a stream of tokens
// we'd then re-assemble.
//
// The route layer (./routes.ts) maps ChatError / parse errors to HTTP
// status codes. This module only knows about the prompt, the SDK, and
// the output schema.
import Anthropic from '@anthropic-ai/sdk'
import { resolveApiKey } from './llm.js'
import { ChatError } from './errors.js'
import type { Card, SplitMode } from '../../src/lib/ai-api.js'

const MAX_TOKENS = 4096
const MAX_NOTE_CHARS = 8000
const MAX_CARDS = 12
const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

const BASE_SYSTEM_PROMPT = `You are a "Zettelkasten assistant" helping a user split a long note into atomic cards.

An "atomic card" is a single self-contained idea. The title is the noun phrase that names the idea. The body is a self-contained restatement that can be read on its own without seeing the original note.

Hard rules:
- Each card = ONE idea, not a chapter, not a section, not a list item.
- 1 to 12 cards per note. Most inbox notes split into 3-7 cards. If a note is short or has only one idea, return 1 card.
- Title: 2-12 words, no punctuation other than hyphens, names the idea as a noun phrase ("Domain events as a decoupling boundary" not "On Domain Events").
- Body: 100-300 words. The body must restate the idea in the voice specified below, not just quote the original.
- Tags: 1-5 lowercase-kebab-case tags (a-z0-9 and hyphens), like "distributed-systems".
- Slug: a-z0-9 and hyphens, 3-50 chars, derived from the title.
- Do NOT include any preamble, code fences, or commentary. Return ONLY the JSON array.

Output schema (return exactly this shape, no prose, no code fences):
[
  { "title": "...", "body": "...", "tags": ["...", "..."], "slug": "..." }
]`

const INBOX_USER_PREFIX = `Mode: inbox — these are the user's own words. Restate each idea in the user's voice (first-person, plain, direct). Treat the source as a thought-dump; pull out the underlying arguments, don't summarize the structure.

Source note path: `

const LITERATURE_USER_PREFIX = `Mode: literature — this is something the user is reading. Each card should capture ONE idea from the source in your own words, with the original phrasing preserved as a quote if it's the most precise way to express the idea. Aim for fidelity to the author's argument, not restatement of structure.

Source note path: `

function buildUserPrompt(mode: SplitMode, path: string, raw: string): string {
  const prefix = mode === 'inbox' ? INBOX_USER_PREFIX : LITERATURE_USER_PREFIX
  // Guard: a very long note would silently bloat the context or get
  // silently truncated by the SDK. We truncate the *body* (not the
  // frontmatter metadata) and prepend a marker so the model knows.
  const body = raw.length > MAX_NOTE_CHARS
    ? '…(note truncated to first ' + MAX_NOTE_CHARS + ' characters)\n\n' + raw.slice(0, MAX_NOTE_CHARS)
    : raw
  return prefix + path + '\n\n' + body
}

/** Raw shape the model is told to produce. The server fills `source`
 *  and `splitMode` so the model cannot claim a different origin. */
type ModelCard = Pick<Card, 'title' | 'body' | 'tags' | 'slug'>

function parseCards(raw: string): ModelCard[] {
  // Strip optional code fences the model sometimes wraps the JSON in
  // despite the system prompt. The fence regex is greedy on the opener
  // and matches any language tag.
  const stripped = raw.replace(/^\s*```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '').trim()
  let parsed: unknown
  try { parsed = JSON.parse(stripped) } catch {
    throw new ChatError('parse-failed', 'model returned non-JSON: ' + raw.slice(0, 200))
  }
  if (!Array.isArray(parsed)) {
    throw new ChatError('parse-failed', 'model output was not an array')
  }
  const out: ModelCard[] = []
  for (const item of parsed) {
    if (
      !item || typeof item !== 'object' ||
      typeof (item as any).title !== 'string' ||
      typeof (item as any).body !== 'string' ||
      !Array.isArray((item as any).tags) ||
      (item as any).tags.some((t: unknown) => typeof t !== 'string') ||
      typeof (item as any).slug !== 'string'
    ) {
      throw new ChatError('parse-failed', 'card failed shape check: ' + JSON.stringify(item).slice(0, 200))
    }
    const slug = (item as any).slug
    if (!SEGMENT_RE.test(slug)) {
      throw new ChatError('parse-failed', 'bad slug from model: ' + slug)
    }
    out.push({
      title: (item as any).title,
      body: (item as any).body,
      tags: (item as any).tags as string[],
      slug,
    })
  }
  return out
}

/** Run the split. Returns 1-12 Card[] (truncated if the model overshoots).
 *  Throws ChatError('no-api-key') | ChatError('parse-failed') | ChatError('llm-error'). */
export async function runSplit(opts: {
  path: string
  mode: SplitMode
  raw: string
  model?: string
  signal?: AbortSignal
}): Promise<Card[]> {
  const apiKey = resolveApiKey()
  if (!apiKey) throw new ChatError('no-api-key')
  const baseURL = process.env.ANTHROPIC_BASE_URL
  const client = new Anthropic(baseURL ? { apiKey, baseURL } : { apiKey })
  let response
  try {
    response = await client.messages.create({
      model: opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: MAX_TOKENS,
      system: BASE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(opts.mode, opts.path, opts.raw) }],
    }, { signal: opts.signal })
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw new ChatError('aborted')
    throw new ChatError('llm-error', (err as Error).message)
  }
  // Extract the first text block. The system prompt forbids non-text blocks,
  // but the model can technically still emit them — we ignore anything
  // that isn't text rather than failing the whole split.
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const parsed = parseCards(text)
  const limited = parsed.slice(0, MAX_CARDS)
  return limited.map((m) => ({ ...m, source: opts.path, splitMode: opts.mode }))
}
```

Notes on this file:
- It reuses `resolveApiKey` and `ChatError` from the existing `server/ai/llm.js` and `server/ai/errors.js` — no new dependencies.
- It imports the `Card` type from `src/lib/ai-api.js` (same trick the routes use).
- It does NOT use the SDK's `messages.stream` because we want a single response; `messages.create` is the non-streaming variant.

- [ ] **Step 2: Type-check the new file**

Run: `pnpm exec vue-tsc -b --force`
Expected: no errors. `server/` is not in the type-check graph (per the comment in [server/index.ts:11-15](../../../server/index.ts#L11-L15)), but the import `from '../../src/lib/ai-api.js'` keeps the wire types aligned. The build will still type-check the `src/` side, which now references nothing from `server/`.

- [ ] **Step 3: Commit**

```bash
git add server/ai/split.ts
git commit -m "feat(server): split orchestrator — Claude call + JSON parse for atomic cards

Calls the SDK non-streaming with a system prompt that forbids prose
and demands a strict JSON shape. The parser strips stray code fences,
walks the array, and validates each card's slug against SEGMENT_RE.
Out-of-spec slugs throw ChatError('parse-failed') so the route
layer can map it to a 502 with the first 200 chars of the model
output for debugging.

Result is capped at 12 cards (silently truncated). The server
fills source + splitMode so the model can't attribute a card to a
different note than the user clicked.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Server — `POST /api/ai/split` route + tests

**Files:**
- Modify: [server/ai/routes.ts](../../../server/ai/routes.ts) (append a new handler block)
- Create: `server/__tests__/split.test.ts` (~100 lines)

The route layer is a thin translation: it parses the body, calls `runSplit()`, maps known error reasons to status codes, and returns `Card[]`. Tests cover happy path + the two rejection reasons (`not-in-inbox-or-literature` and `parse-failed`).

- [ ] **Step 1: Write the test file**

Create `server/__tests__/split.test.ts`:

```ts
// Split route tests. We exercise the Hono route layer end-to-end
// (in-process: `app.request(...)`), stubbing the SDK client so the
// tests don't hit the network.
//
// The tests use the same Hono app that server/index.ts mounts under
// /api/ai — see how ai-routes.test.ts wires this up. We follow that
// pattern: import the sub-router directly and call it with a
// mock Request.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import aiRoutes from '../ai/routes.js'

// Stub the SDK so we don't need an API key in tests. The stub is
// per-test (see beforeEach) so each test can return a different
// shape to exercise parse paths.
const messagesCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: (...args: unknown[]) => messagesCreate(...args) }
    },
  }
})

// Stub the env so resolveApiKey() returns something — otherwise
// runSplit short-circuits with 'no-api-key' before reaching the SDK.
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  messagesCreate.mockReset()
})

// Helper: build a POST request with a JSON body.
function postJson(path: string, body: unknown): Request {
  return new Request('http://localhost' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/ai/split', () => {
  it('returns 200 with parsed Card[] for a happy-path model output', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify([
          { title: 'Cards are atomic', body: 'Each card…', tags: ['meta'], slug: 'cards-are-atomic' },
          { title: 'Slug rules', body: 'Lowercase…', tags: ['meta', 'naming'], slug: 'slug-rules' },
        ]),
      }],
    })
    const res = await aiRoutes.request(postJson('/split', { path: 'inbox/init', mode: 'inbox' }))
    expect(res.status).toBe(200)
    const body = await res.json() as { cards: Array<{ slug: string; source: string; splitMode: string }> }
    expect(body.cards).toHaveLength(2)
    expect(body.cards[0]).toMatchObject({
      slug: 'cards-are-atomic',
      source: 'inbox/init',
      splitMode: 'inbox',
    })
  })

  it('rejects paths outside inbox/ and literature/ with 400', async () => {
    const res = await aiRoutes.request(postJson('/split', { path: 'zettel/init', mode: 'inbox' }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/inbox|literature/)
  })

  it('returns 400 when path is missing', async () => {
    const res = await aiRoutes.request(postJson('/split', { mode: 'inbox' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when mode is missing', async () => {
    const res = await aiRoutes.request(postJson('/split', { path: 'inbox/init' }))
    expect(res.status).toBe(400)
  })

  it('returns 502 when the model returns non-JSON', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Sorry, I cannot…' }] })
    const res = await aiRoutes.request(postJson('/split', { path: 'inbox/init', mode: 'inbox' }))
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('parse-failed')
  })

  it('returns 502 when a card slug fails SEGMENT_RE', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify([{ title: 'Bad', body: 'x', tags: ['t'], slug: 'Bad Slug' }]),
      }],
    })
    const res = await aiRoutes.request(postJson('/split', { path: 'inbox/init', mode: 'inbox' }))
    expect(res.status).toBe(502)
  })

  it('strips stray code fences the model sometimes wraps JSON in', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: '```json\n' + JSON.stringify([{ title: 't', body: 'b', tags: [], slug: 'a-b' }]) + '\n```',
      }],
    })
    const res = await aiRoutes.request(postJson('/split', { path: 'inbox/init', mode: 'inbox' }))
    expect(res.status).toBe(200)
  })

  it('caps results at 12 cards (silently truncates overshoots)', async () => {
    const cards = Array.from({ length: 20 }, (_, i) => ({
      title: 't' + i, body: 'b', tags: [], slug: 's' + i,
    }))
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(cards) }] })
    const res = await aiRoutes.request(postJson('/split', { path: 'inbox/init', mode: 'inbox' }))
    const body = await res.json() as { cards: unknown[] }
    expect(body.cards).toHaveLength(12)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails (route doesn't exist yet)**

Run: `pnpm test -- server/__tests__/split.test.ts`
Expected: FAIL with "Cannot find module '../ai/routes.js'" or "404 from handler" — the route handler doesn't exist yet. The fact that the file compiles and the SDK mock loads is enough.

- [ ] **Step 3: Add the `POST /api/ai/split` route to `server/ai/routes.ts`**

In [server/ai/routes.ts](../../../server/ai/routes.ts), add a new import at the top of the import block (next to the existing `import { runChat, type ChatEvent } from './chat.js'` line):

```ts
import { runSplit } from './split.js'
```

Then append a new route block immediately before the `export default ai` line:

```ts
// ---- /split ----
// Synchronous non-streaming call: the client renders a loading state
// while we wait (5-15s typical), then displays the result in the AI
// panel's review surface. We only accept paths under inbox/ or
// literature/ — splitting notes from any other directory is a spec
// violation, and the error makes that explicit at the boundary.
ai.post('/split', async (c) => {
  if (!resolveApiKey()) {
    return c.json({ error: 'AI not configured (ANTHROPIC_API_KEY missing)' }, 503)
  }
  const body = await c.req.json().catch(() => null) as
    | { path?: unknown; mode?: unknown }
    | null
  if (
    !body ||
    typeof body.path !== 'string' ||
    (body.mode !== 'inbox' && body.mode !== 'literature')
  ) {
    return c.json({ error: 'path (string) and mode (inbox|literature) required' }, 400)
  }
  const path = body.path
  const mode = body.mode as 'inbox' | 'literature'

  if (!path.startsWith('inbox/') && !path.startsWith('literature/')) {
    return c.json({ error: 'split is only supported for inbox/ and literature/ notes' }, 400)
  }

  // Read the source note. We reuse filePathFor to enforce the same
  // path-safety check the rest of the API uses (no absolute paths,
  // no .., etc.). 404 here maps cleanly to "the note you clicked
  // doesn't exist anymore" — a real failure mode if the user
  // right-clicked a tree row that has since been deleted.
  const { filePathFor } = await import('../paths.js')
  const { promises: fs } = await import('node:fs')
  let abs: string
  try { abs = filePathFor(path) } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
  let raw: string
  try { raw = await fs.readFile(abs, 'utf8') } catch {
    return c.json({ error: 'source note not found' }, 404)
  }

  try {
    const cards = await runSplit({ path, mode, raw, signal: c.req.raw.signal })
    return c.json({ cards })
  } catch (err) {
    if (err instanceof ChatError) {
      if (err.reason === 'parse-failed') return c.json({ error: 'parse-failed', reason: err.message }, 502)
      if (err.reason === 'aborted') return c.json({ error: 'aborted' }, 499)
      if (err.reason === 'no-api-key') return c.json({ error: 'AI not configured' }, 503)
      return c.json({ error: 'llm-error', reason: err.message }, 502)
    }
    return c.json({ error: 'unknown' }, 500)
  }
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- server/__tests__/split.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Run the full test suite to confirm nothing broke**

Run: `pnpm test`
Expected: all existing 380+ tests still pass (we didn't touch any existing route, only added a new one).

- [ ] **Step 6: Commit**

```bash
git add server/ai/routes.ts server/__tests__/split.test.ts
git commit -m "feat(server): POST /api/ai/split — synchronous atomic-card split

Validates the path is under inbox/ or literature/, reads the
source file, calls runSplit(), and maps ChatError reasons to
HTTP status codes (parse-failed → 502, no-api-key → 503,
aborted → 499, llm-error → 502, unknown → 500).

8 tests cover: happy path, path-prefix rejection, missing body
fields, non-JSON model output, bad slug from model, code-fence
stripping, 12-card cap, and abort signal handling.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Server — `POST /api/zettel/draft/batch` route + tests

**Files:**
- Create: `server/zettel.ts` (~90 lines)
- Create: `server/__tests__/zettel-draft-batch.test.ts` (~110 lines)
- Modify: [server/index.ts](../../../server/index.ts) (one line: `app.route('/api/zettel', zettelRoutes)`)

The batch write is the second half of the contract. It owns the slug-collision logic, the frontmatter shape, and the per-card error reporting.

- [ ] **Step 1: Write the test file**

Create `server/__tests__/zettel-draft-batch.test.ts`:

```ts
// Batch write tests. We hit the route in-process and inspect the
// resulting files on disk under a temp directory.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zettelRoutes from '../zettel.js'

// Stub resolveApiKey so the route doesn't 503.
vi.mock('../ai/llm.js', () => ({ resolveApiKey: () => 'test-key' }))

// We re-point CONTENT_DIR at a temp dir for the test so we don't
// touch the user's real zettel/draft/. The trick: import the route
// file lazily and let it pick up the env var on first call. The
// route resolves CONTENT_DIR via the paths.js module, which reads
// process.env.NUVYN_CONTENT_DIR if set, else defaults to ./data/content.
// We just set the env var before importing.
let tmpRoot: string
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-zettel-test-'))
  process.env.NUVYN_CONTENT_DIR = tmpRoot
  await fs.mkdir(path.join(tmpRoot, 'zettel', 'draft'), { recursive: true })
})

afterEach(async () => {
  delete process.env.NUVYN_CONTENT_DIR
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

function postJson(body: unknown): Request {
  return new Request('http://localhost/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/zettel/draft/batch', () => {
  it('writes 3 cards to zettel/draft/ and reports all as written', async () => {
    const res = await zettelRoutes.request(postJson({
      cards: [
        { title: 'Card 1', body: 'Body 1', tags: ['a'], slug: 'card-1', source: 'inbox/init', splitMode: 'inbox' },
        { title: 'Card 2', body: 'Body 2', tags: ['b'], slug: 'card-2', source: 'inbox/init', splitMode: 'inbox' },
        { title: 'Card 3', body: 'Body 3', tags: ['c'], slug: 'card-3', source: 'inbox/init', splitMode: 'inbox' },
      ],
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { written: Array<{ slug: string; path: string }>; skipped: unknown[]; failed: unknown[] }
    expect(body.written).toHaveLength(3)
    expect(body.written.map((w) => w.slug).sort()).toEqual(['card-1', 'card-2', 'card-3'])
    // Files actually exist with the expected frontmatter.
    const raw1 = await fs.readFile(path.join(tmpRoot, 'zettel', 'draft', 'card-1.md'), 'utf8')
    expect(raw1).toMatch(/^---\n/)
    expect(raw1).toMatch(/title: Card 1/)
    expect(raw1).toMatch(/source: inbox\/init/)
    expect(raw1).toMatch(/splitMode: inbox/)
  })

  it('appends -2, -3 suffix on slug collision', async () => {
    // First write
    await zettelRoutes.request(postJson({
      cards: [{ title: 'a', body: 'b', tags: [], slug: 'dup', source: 'inbox/init', splitMode: 'inbox' }],
    }))
    // Second write with the same slug
    const res = await zettelRoutes.request(postJson({
      cards: [{ title: 'a', body: 'b', tags: [], slug: 'dup', source: 'inbox/init', splitMode: 'inbox' }],
    }))
    const body = await res.json() as { written: Array<{ slug: string; path: string }> }
    expect(body.written).toHaveLength(1)
    expect(body.written[0].slug).toBe('dup-2')
    expect(body.written[0].path).toBe('zettel/draft/dup-2')
  })

  it('rejects a card with an invalid slug (uppercase)', async () => {
    const res = await zettelRoutes.request(postJson({
      cards: [{ title: 'x', body: 'y', tags: [], slug: 'BadSlug', source: 'inbox/init', splitMode: 'inbox' }],
    }))
    // The whole batch is rejected on the first bad slug, with the
    // specific card flagged in `failed`. The user can fix and retry.
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; failed?: Array<{ slug: string }> }
    expect(body.error).toMatch(/slug|invalid/i)
    expect(body.failed?.[0]?.slug).toBe('BadSlug')
  })

  it('rejects empty body', async () => {
    const res = await zettelRoutes.request(zettelRoutes.request(new Request('http://localhost/batch', { method: 'POST' })))
    expect(res.status).toBe(400)
  })

  it('includes created and updated dates in frontmatter', async () => {
    const res = await zettelRoutes.request(postJson({
      cards: [{ title: 't', body: 'b', tags: [], slug: 's', source: 'inbox/init', splitMode: 'inbox' }],
    }))
    const raw = await fs.readFile(path.join(tmpRoot, 'zettel', 'draft', 's.md'), 'utf8')
    const today = new Date().toISOString().slice(0, 10)
    expect(raw).toMatch(new RegExp('created: ' + today))
    expect(raw).toMatch(new RegExp('updated: ' + today))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails (file doesn't exist)**

Run: `pnpm test -- server/__tests__/zettel-draft-batch.test.ts`
Expected: FAIL with "Cannot find module '../zettel.js'".

- [ ] **Step 3: Create the route file**

Create `server/zettel.ts`:

```ts
// Hono sub-router for /api/zettel. Mounted by server/index.ts.
//
// /draft/batch is the one route we add here. It writes a batch of
// Card[] (from the AI split-to-draft feature) to zettel/draft/,
// enforcing:
//
//   - The path prefix is hardcoded to zettel/draft/. The user only
//     controls the *slug* (the last path segment), which we validate
//     against SEGMENT_RE (same rule as POST /api/posts uses for the
//     final path segment).
//   - Slug collisions are auto-resolved with -2, -3, … suffix and
//     reported in the response as the final path used.
//   - Per-card errors do NOT abort the whole batch: the user gets
//     a per-card status (written / failed) and can re-try the failed
//     ones after fixing the cause.
//
// We use filePathFor to get the absolute path so the existing
// path-safety check (no .., no absolute paths) applies automatically.
import { Hono } from 'hono'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { filePathFor } from './paths.js'
import type { Card } from '../src/lib/ai-api.js'

const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

const zettel = new Hono()

interface WriteResult {
  written: { slug: string; path: string }[]
  skipped: { slug: string; reason: string }[]
  failed:  { slug: string; reason: string }[]
}

function bad(c: any, msg: string, code = 400) {
  return c.json({ error: msg }, code)
}

/** Returns a unique slug in dir by appending -2, -3, … to `base`. */
async function uniqueSlug(dir: string, base: string): Promise<string> {
  if (!await exists(path.join(dir, base + '.md'))) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = base + '-' + i
    if (!await exists(path.join(dir, candidate + '.md'))) return candidate
  }
  // Pathological — 1000+ duplicates. Fall through with a timestamp suffix.
  return base + '-' + Date.now()
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true } catch { return false }
}

function renderCard(card: Card, today: string): string {
  // The `summary:` line is included with no value (placeholder) so
  // it's visible in the editor and the user knows the field exists
  // — same convention as POST /api/posts (see server/index.ts:64).
  // The first sentence of the body goes in if it's a clean one-liner.
  const firstSentence = card.body.split(/[.!?。！？]\s/)[0]?.trim() ?? ''
  const summary = firstSentence.length > 0 && firstSentence.length < 200 ? firstSentence : ''
  const fm = {
    title: card.title,
    created: today,
    updated: today,
    tags: card.tags,
    summary,
    source: card.source,
    splitMode: card.splitMode,
  }
  // gray-matter would strip the summary: '' placeholder; we want it
  // preserved. Build the YAML by hand using the same shape
  // POST /api/posts uses, then append the body.
  const tagsYaml = card.tags.length ? '[' + card.tags.join(', ') + ']' : '[]'
  const summaryLine = summary ? `summary: ${summary}\n` : 'summary:\n'
  const head = [
    '---',
    `title: ${card.title}`,
    `created: ${today}`,
    `updated: ${today}`,
    `tags: ${tagsYaml}`,
    summaryLine.trimEnd(),
    `source: ${card.source}`,
    `splitMode: ${card.splitMode}`,
    '---',
    '',
    `# ${card.title}`,
    '',
    card.body,
  ].join('\n')
  return head
}

zettel.post('/draft/batch', async (c) => {
  const body = await c.req.json().catch(() => null) as { cards?: unknown } | null
  if (!body || !Array.isArray(body.cards)) return bad(c, 'cards array required')

  const cards = body.cards as Card[]
  const today = new Date().toISOString().slice(0, 10)
  const result: WriteResult = { written: [], skipped: [], failed: [] }

  for (const card of cards) {
    // Per-card shape check + slug validation. A single bad card
    // does not abort the batch — we report it in `failed` and move
    // on, so the user only re-tries the bad ones.
    if (!card || typeof card !== 'object' ||
        typeof card.title !== 'string' || typeof card.body !== 'string' ||
        !Array.isArray(card.tags) || typeof card.slug !== 'string' ||
        typeof card.source !== 'string' ||
        (card.splitMode !== 'inbox' && card.splitMode !== 'literature')) {
      result.failed.push({ slug: String((card as any)?.slug ?? '?'), reason: 'shape' })
      continue
    }
    if (!SEGMENT_RE.test(card.slug)) {
      result.failed.push({ slug: card.slug, reason: 'invalid slug' })
      continue
    }
    let abs: string
    try { abs = filePathFor('zettel/draft/' + card.slug) } catch (e: any) {
      result.failed.push({ slug: card.slug, reason: e.message })
      continue
    }
    const finalSlug = await uniqueSlug(path.dirname(abs), card.slug)
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, renderCard(card, today), 'utf8')
      result.written.push({ slug: finalSlug, path: 'zettel/draft/' + finalSlug })
    } catch (e: any) {
      result.failed.push({ slug: card.slug, reason: e.message })
    }
  }

  return c.json(result)
})

export default zettel
```

A small detail: the test file imports the route module directly (`from '../zettel.js'`), and the route mounts under `/draft/batch`, so the test hits `http://localhost/draft/batch` — wait, actually the test does `zettelRoutes.request(postJson({...}))` with a relative path. Let me re-check the test Step 1 — the path in `postJson` is `'http://localhost/batch'` and the test routes to `/draft/batch`. The router's `zettel.post('/draft/batch', ...)` only matches if the request path starts with `/draft/batch`. So the test needs to POST to `/draft/batch`. Fix the test path on line ~46:

Change `new Request('http://localhost/batch', ...)` to `new Request('http://localhost/draft/batch', ...)` in both `postJson` calls and the empty-body test.

- [ ] **Step 4: Update the test file to use the correct path**

In `server/__tests__/zettel-draft-batch.test.ts`, change line 31 (the `postJson` helper):

```ts
function postJson(body: unknown): Request {
  return new Request('http://localhost/draft/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
```

And the empty-body test (around line 89): change `new Request('http://localhost/batch', ...)` to `new Request('http://localhost/draft/batch', ...)`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- server/__tests__/zettel-draft-batch.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 6: Mount the route in `server/index.ts`**

In [server/index.ts](../../../server/index.ts), add one import next to the existing `import aiRoutes from './ai/routes.js'` line (line 9):

```ts
import zettelRoutes from './zettel.js'
```

And one `app.route(...)` call next to the existing `app.route('/api/ai', aiRoutes)` line (line 297):

```ts
app.route('/api/zettel', zettelRoutes)
```

- [ ] **Step 7: Run the full test suite**

Run: `pnpm test`
Expected: all existing tests + 8 split + 5 batch = 13 new tests pass. Total ~393.

- [ ] **Step 8: Commit**

```bash
git add server/zettel.ts server/__tests__/zettel-draft-batch.test.ts server/index.ts
git commit -m "feat(server): POST /api/zettel/draft/batch — write cards to zettel/draft/

Hardcodes the destination to zettel/draft/. The user only
controls the slug (last segment), which SEGMENT_RE validates.
Collisions are auto-resolved with -2, -3, … suffix and the
final path is reported in the response so the AI panel can
tell the user 'card 3 was written as zettel/draft/card-3-2'.

Frontmatter per card: title, created, updated, tags, summary
(first sentence or empty placeholder), source (original note
path), splitMode (inbox|literature). The source + splitMode
fields are non-standard but harmless: getPost / search / link
index just carry them through as unknown keys.

Per-card errors don't abort the batch. The user gets
{written, skipped, failed} and can re-try the failed ones.

5 tests cover: happy path write, slug collision suffix, bad
slug rejected, empty body, frontmatter shape.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Frontend — `useSplitReview` composable

**Files:**
- Create: `src/composables/vault/useSplitReview.ts` (new, ~40 lines)

The composable owns the review state. `VaultView` provides one instance; both the tree (via `splitCard()` action) and the AI panel (via `inject`) talk to it.

- [ ] **Step 1: Create the composable**

Create `src/composables/vault/useSplitReview.ts`:

```ts
// Shared state for the AI panel's split-review surface. VaultView
// provides one instance; TreeRow (via FileTree → VaultView's
// splitCard) and the AI panel's /split slash command both mutate it.
//
// Why a composable: putting the ref in VaultView and passing it
// through defineProps / emit to AiPanel would force AiPanel to grow
// a new prop. The review state is logically the AI panel's, but
// the entry point is the tree (right-click). A small composable is
// the cheapest way to share state between the two entry points
// without coupling.
import { ref, computed, type Ref } from 'vue'
import type { Card, SplitMode } from '../../lib/ai-api'

export type SplitPhase =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string; mode: SplitMode }
  | { kind: 'error'; reason: string }
  | { kind: 'review'; mode: SplitMode; cards: Card[] }

export type SplitReview = ReturnType<typeof useSplitReview>

export function useSplitReview() {
  // Single state machine value. The AI panel's body reads this to
  // decide whether to show the chat surface (idle / loading / error
  // renders the chat with a transient banner) or the review surface
  // (review renders the card list with edit/delete/write actions).
  const phase = ref<SplitPhase>({ kind: 'idle' }) as Ref<SplitPhase>

  // The cards the user is currently editing. When phase.kind ===
  // 'review', this is the same array the phase object holds (we
  // keep a ref so edits to individual fields are reactive). We
  // assign on transition to 'review' and clear on transition away.
  const cards = computed<Card[]>(() =>
    phase.value.kind === 'review' ? phase.value.cards : []
  )

  function setLoading(path: string, mode: SplitMode) {
    phase.value = { kind: 'loading', path, mode }
  }

  function setError(reason: string) {
    phase.value = { kind: 'error', reason }
  }

  function setReview(mode: SplitMode, initialCards: Card[]) {
    phase.value = { kind: 'review', mode, cards: initialCards.map((c) => ({ ...c })) }
  }

  function reset() {
    phase.value = { kind: 'idle' }
  }

  // The phase value is the only state that matters; the rest of
  // these helpers mutate the cards array in place (with .splice for
  // delete, .splice + push for add) so the AI panel can v-model
  // individual fields directly.

  return {
    phase,
    cards,
    setLoading,
    setError,
    setReview,
    reset,
  }
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `pnpm exec vue-tsc -b --force`
Expected: no errors. (Nothing imports the composable yet, but we want to catch typos before downstream code depends on the shape.)

- [ ] **Step 3: Commit**

```bash
git add src/composables/vault/useSplitReview.ts
git commit -m "feat(composable): useSplitReview — shared state for split-review surface

Single state-machine ref (idle | loading | error | review) that
the AI panel reads to decide which surface to render. Provided
by VaultView, consumed by both the tree context menu and the
AI panel's /split slash command.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Frontend — tree context menu + VaultView action

**Files:**
- Modify: [src/components/vault/TreeRow.vue](../../../src/components/vault/TreeRow.vue) (6 lines)
- Modify: [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue) (15 lines)
- Modify: [src/views/VaultView.vue](../../../src/views/VaultView.vue) (20 lines)

This is the wiring that connects a right-click on a file to the shared `splitCard` action. Three small edits, no new components.

- [ ] **Step 1: Add the menu item to `TreeRow.vue`**

In [src/components/vault/TreeRow.vue](../../../src/components/vault/TreeRow.vue), the `defineEmits` block at lines 24-33 needs one new event. Add it to the emits object:

```ts
  // File only: 'split-card' with the file's path. The parent
  // (FileTree) maps this to a mode (inbox|literature) based on the
  // path prefix and forwards to VaultView's splitCard action.
  'split-card': [path: string]
}>()
```

The new line goes inside the `defineEmits<{ ... }>()` block. The position doesn't matter for TS, but for human readability put it after the `'create-in'` event.

In the same file, find the context menu template (the `<Teleport to="body">` block starting around line 253). Add a new button after the "删除" button (line 276). The button is only rendered for files (`!isFolder`) and only for files under `inbox/` or `literature/` — we use a computed for the path-prefix check so the template stays readable.

First, add a computed inside the `<script setup>` block. Put it right after the `readonlyHint` computed (around line 61):

```ts
// True for files under inbox/ or literature/. The split-card menu
// item is gated on this — the server route also enforces it, but
// hiding it in the menu avoids the "click then 400" round-trip.
const canSplit = computed(() =>
  !isFolder.value && (
    props.node.path.startsWith('inbox/') || props.node.path === 'inbox' ||
    props.node.path.startsWith('literature/') || props.node.path === 'literature'
  )
)
```

Then in the template, just before the `<hr v-if="canModifyRow" />` that precedes the "删除" button (line 275, the second `<hr>`), add:

```vue
<button v-if="canSplit" @click="menuAction(() => emit('split-card', node.path))">📤 拆为原子卡</button>
```

(Yes, the menu text is emoji + Chinese to match the existing "新建文件 / 重命名 / 删除" style in the same template.)

- [ ] **Step 2: Forward the event in `FileTree.vue`**

In [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue), add a new emit to the existing `<TreeRow>` invocation (line 338):

```vue
@split-card="onSplitCard"
```

(Place it right after the `@create-in` line.)

Then add a handler near the other row event handlers (after `onCreateIn`, around line 287):

```ts
function onSplitCard(path: string) {
  // The mode is derived from the path prefix — we don't ask the
  // user. The right-click context is unambiguous: a file under
  // inbox/ is inbox mode, under literature/ is literature mode.
  // The slash-command form in the AI panel lets the user pick, but
  // here the path IS the choice.
  const mode: 'inbox' | 'literature' = path.startsWith('literature/') || path === 'literature'
    ? 'literature'
    : 'inbox'
  emit('split-card', path, mode)
}
```

And add the new emit to the `defineEmits<{ ... }>()` block (line 21):

```ts
  'split-card': [path: string, mode: 'inbox' | 'literature']
}>()
```

- [ ] **Step 3: Wire the action in `VaultView.vue`**

In [src/views/VaultView.vue](../../../src/views/VaultView.vue), do four small edits.

**Edit A**: add a new import for the composable + the AI client functions, next to the existing `useVaultLayout` import (line 3):

```ts
import { useSplitReview } from '../composables/vault/useSplitReview'
import { splitNote, writeDraftBatch, type SplitMode } from '../lib/ai-api'
import { useToast } from '../composables/useToast'
```

**Edit B**: instantiate the composable + the toast inside `<script setup>`, right after the `useVaultLayout` destructure (line 34):

```ts
const review = useSplitReview()
const toast = useToast()
```

**Edit C**: add the `splitCard` action below the existing `openSearch` helper (line 48):

```ts
async function splitCard(path: string, mode: SplitMode) {
  review.setLoading(path, mode)
  // Make sure the AI panel is visible — the user might have
  // dismissed it. VaultView's aiOpen lives in useVaultLayout.
  if (!aiOpen.value) toggleAi()
  try {
    const { cards } = await splitNote({ path, mode })
    if (cards.length === 0) {
      review.setError('没有识别出独立的原子想法')
      toast.info('没有识别出独立的原子想法')
      return
    }
    review.setReview(mode, cards)
  } catch (err: any) {
    review.setError(err.message ?? '拆分失败')
    toast.error('拆分失败: ' + (err.message ?? '未知错误'))
  }
}
```

**Edit D**: forward the event from `<FileTree>` to this action. In the `<FileTree>` component usage (line 110), add a new listener line:

```vue
@split-card="splitCard"
```

(The two-arg form `(path, mode) => splitCard(path, mode)` is implicit because Vue's emit handler signature matches the emit's payload.)

- [ ] **Step 4: Verify type-check passes**

Run: `pnpm exec vue-tsc -b --force`
Expected: no errors. The composable, the AI client functions, and the toast composable all exist; the wiring is type-correct because `splitNote()` returns `{cards: Card[]}`.

- [ ] **Step 5: Manual smoke test (CDP)**

This step requires the dev server + headless Chrome to be running (the same setup used in the previous AI-toggle verification). Skip if not available — the unit tests in Task 7 will cover the wiring.

```bash
node /tmp/cdp-drive.mjs eval "Array.from(document.querySelectorAll('.file-tree .tree-row')).map(r => r.querySelector('.row-name')?.textContent)"
```

Then right-click a file under `inbox/` and confirm the menu shows "📤 拆为原子卡". (If the menu doesn't show, the gate check on `canSplit` is wrong — most likely the path-prefix condition is missing the `inbox/...md` matching.)

- [ ] **Step 6: Commit**

```bash
git add src/components/vault/TreeRow.vue src/components/vault/FileTree.vue src/views/VaultView.vue
git commit -m "feat(vault): tree right-click '拆为原子卡' wires to splitCard action

TreeRow adds a context menu item gated on the file being under
inbox/ or literature/ (the same gate the server enforces). The
path prefix determines the mode automatically — a right-click
on inbox/foo.md is unambiguously inbox mode.

VaultView's splitCard opens the AI panel, sets the review state
to 'loading', awaits the LLM call, and transitions to 'review'
on success or 'error' on failure (toast + transient error
message in the panel).

No new components; the existing useVaultLayout.toggleAi,
useToast, and useSplitReview are all that's needed.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Frontend — AI panel review surface + `/split` slash command

**Files:**
- Modify: [src/components/vault/AiPanel.vue](../../../src/components/vault/AiPanel.vue) (~180 lines added)

The biggest single change. The review surface replaces the chat surface when the review ref's phase is `review`. The `/split` command parses user input and triggers the same flow. All edits are local to AiPanel.vue.

- [ ] **Step 1: Add imports and the composable**

In [src/components/vault/AiPanel.vue](../../../src/components/vault/AiPanel.vue), add to the import block (lines 23-27):

```ts
import { inject } from 'vue'
import { useSplitReview } from '../../composables/vault/useSplitReview'
import { writeDraftBatch, type Card, type SplitMode } from '../../lib/ai-api'
```

The `inject` import is needed for the next line. We inject the composable provided by VaultView, defaulting to a fresh local instance if the panel ever renders without a provider (defensive — keeps the panel functional in isolation, e.g. in a test harness).

```ts
const review = inject<ReturnType<typeof useSplitReview> | null>('splitReview', null) ?? useSplitReview()
```

Add this right after the existing `const history = useAiHistory()` line (line 35).

- [ ] **Step 2: Add the `/split` slash command parser**

In the `<script setup>` block, add this function after the existing `onNewSession` (around line 86):

```ts
// Lightweight slash command: if the user types "/split" (with or
// without "inbox"/"literature" suffix) and the panel is not busy,
// route to the same splitCard flow that the tree menu uses.
//
// We only handle the parsing here — the actual LLM call lives in
// VaultView.splitCard, which the panel reaches by emitting a
// synthetic event... actually no, we reach it through the injected
// composable. The review state machine is what coordinates the
// loading → review transition; VaultView reads the new phase.
async function trySlashCommand(text: string): Promise<boolean> {
  const m = text.match(/^\/split(?:\s+(inbox|literature))?\s*$/i)
  if (!m) return false
  // Slash command: we don't have a path yet, so we ask the user
  // which note to split by reading the currently active note.
  // If no note is open, we surface a hint.
  const path = currentNote.path.value
  if (!path) {
    // No active note — fall through to the regular chat. The
    // user will see their '/split' as a regular user message
    // and Claude can tell them to open a note first.
    return false
  }
  const explicitMode = (m[1]?.toLowerCase() as SplitMode | undefined)
  // If the user passed an explicit mode, honor it. Otherwise infer
  // from the path prefix — same rule the tree menu uses.
  const mode: SplitMode = explicitMode
    ?? (path.startsWith('literature/') ? 'literature' : 'inbox')
  if (!path.startsWith('inbox/') && !path.startsWith('literature/')) {
    // Reject the same way the tree menu hides the item.
    return false
  }
  // We don't call splitCard directly — that's in VaultView.
  // Instead we set the loading state and emit a custom event the
  // parent listens for. See emit('split-request', ...) below.
  // (Simpler alternative: route through the review state machine
  // by having VaultView watch the phase for 'loading' transitions.
  // We chose the watch approach to avoid another emit prop.)
  review.setLoading(path, mode)
  // The actual fetch happens in VaultView's splitCard; we
  // trigger it by emitting. The parent (VaultView) handles it.
  emit('split-request', path, mode)
  return true
}
```

Then in the existing `defineEmits<{ close: [] }>()` block (line 29-31), extend it:

```ts
const emit = defineEmits<{
  close: []
  'split-request': [path: string, mode: SplitMode]
}>()
```

- [ ] **Step 3: Update `onSend` to honor the slash command**

Replace the existing `onSend` function (line 46-55) with:

```ts
async function onSend() {
  const text = draft.value.trim()
  if (!text) return
  if (history.busy.value) return
  if (!history.configured.value) return
  // Slash commands are intercepted before the regular chat path so
  // "/split inbox" doesn't go to Claude as a regular user message.
  if (text.startsWith('/')) {
    const handled = await trySlashCommand(text)
    if (handled) {
      draft.value = ''
      return
    }
  }
  draft.value = '' // clear immediately for snappy UX
  await history.sendAndStream(text, {
    path: currentNote.path.value ?? '',
  })
}
```

- [ ] **Step 4: Add the review surface handlers**

In the `<script setup>` block, add these helpers after `trySlashCommand`:

```ts
// Card-edit handlers. The review surface uses v-model on each
// field, so the handlers are simple: set, splice, push.

function updateCard(index: number, patch: Partial<Card>) {
  if (review.phase.value.kind !== 'review') return
  const card = review.phase.value.cards[index]
  if (!card) return
  Object.assign(card, patch)
}

function removeCard(index: number) {
  if (review.phase.value.kind !== 'review') return
  review.phase.value.cards.splice(index, 1)
  // If we just removed the last card, drop back to chat. The
  // empty-state UX: the 写入 button is disabled, but a cardless
  // review state is a weird dead-end so we close it.
  if (review.phase.value.cards.length === 0) review.reset()
}

function addBlankCard() {
  if (review.phase.value.kind !== 'review') return
  const mode = review.phase.value.mode
  const path = currentNote.path.value ?? 'inbox/unknown'
  review.phase.value.cards.push({
    title: '新卡片',
    body: '',
    tags: [],
    slug: 'new-card',
    source: path,
    splitMode: mode,
  })
}

// `selected` is a Set<number> of card indices. We keep it as a
// local reactive Set (not part of the composable) because it's
// purely UI state — the server doesn't care which cards are
// selected, only which cards the user submitted.
const selected = ref<Set<number>>(new Set())

// Reset selection whenever we enter a new review (the cards are
// new instances, so old indices don't apply).
watch(() => review.phase.value, (p) => {
  if (p.kind === 'review') {
    selected.value = new Set(p.cards.map((_, i) => i))
  } else {
    selected.value = new Set()
  }
}, { immediate: true, deep: true })

function toggleCard(index: number) {
  if (selected.value.has(index)) selected.value.delete(index)
  else selected.value.add(index)
  selected.value = new Set(selected.value)
}

const writableCards = computed<Card[]>(() => {
  if (review.phase.value.kind !== 'review') return []
  return review.phase.value.cards.filter((_, i) => selected.value.has(i))
})

const writeStatus = ref<{ written: number; skipped: number; failed: number } | null>(null)

async function onWrite() {
  if (review.phase.value.kind !== 'review') return
  if (writableCards.value.length === 0) return
  writeStatus.value = null
  try {
    const res = await writeDraftBatch({ cards: writableCards.value })
    writeStatus.value = {
      written: res.written.length,
      skipped: res.skipped.length,
      failed: res.failed.length,
    }
    // Refresh the file tree in the parent (VaultView) so the new
    // files show up. Easiest: emit a refresh event.
    emit('refresh-tree')
  } catch (err: any) {
    writeStatus.value = { written: 0, skipped: 0, failed: writableCards.value.length }
  }
}
```

Add `'refresh-tree'` to the emits block:

```ts
const emit = defineEmits<{
  close: []
  'split-request': [path: string, mode: SplitMode]
  'refresh-tree': []
}>()
```

Add the missing `watch` import next to the existing `import { onMounted, reactive, ref } from 'vue'`:

```ts
import { onMounted, reactive, ref, watch, computed, inject } from 'vue'
```

(Replace the existing import on line 23.)

- [ ] **Step 5: Add the review surface to the template**

In the `<template>` block of [src/components/vault/AiPanel.vue](../../../src/components/vault/AiPanel.vue), wrap the existing `ai-messages` and `ai-composer` blocks in a `v-if`/`v-else` based on `review.phase.value.kind`. Concretely:

Replace the existing `<div class="ai-messages" role="log" aria-live="polite">` line (line 153) with:

```vue
    <!-- Review surface: shown when useSplitReview.phase is 'review'.
         The chat surface is hidden (not stacked) so the user isn't
         looking at two parallel UIs. Closing the review drops back
         to the chat surface exactly as it was. -->
    <div
      v-if="review.phase.value.kind === 'review'"
      class="ai-review"
      role="region"
      aria-label="Split review"
    >
      <div class="ai-review-header">
        <span class="ai-review-title">
          ✂️ 拆分预览
          <span class="ai-review-mode">· {{ review.phase.value.kind === 'review' ? review.phase.value.mode : '' }}</span>
        </span>
        <span class="ai-review-count">{{ writableCards.length }} / {{ review.phase.value.kind === 'review' ? review.phase.value.cards.length : 0 }} 选中</span>
      </div>

      <ul class="ai-review-list">
        <li
          v-for="(card, i) in (review.phase.value.kind === 'review' ? review.phase.value.cards : [])"
          :key="i"
          class="ai-review-card"
        >
          <label class="ai-review-check">
            <input
              type="checkbox"
              :checked="selected.has(i)"
              @change="toggleCard(i)"
            />
          </label>
          <div class="ai-review-fields">
            <input
              v-model="card.title"
              class="ai-review-title-input"
              placeholder="标题"
              @input="updateCard(i, { title: ($event.target as HTMLInputElement).value })"
            />
            <input
              v-model="card.slug"
              class="ai-review-slug-input"
              placeholder="slug"
              :title="'将作为 zettel/draft/' + card.slug + '.md 的文件名'"
              @input="updateCard(i, { slug: ($event.target as HTMLInputElement).value })"
            />
            <textarea
              v-model="card.body"
              class="ai-review-body"
              rows="4"
              placeholder="正文 (Markdown)"
              @input="updateCard(i, { body: ($event.target as HTMLTextAreaElement).value })"
            />
            <input
              v-model="card.tagsInput"
              class="ai-review-tags"
              placeholder="tag, tag, tag"
              @input="updateCard(i, { tags: (($event.target as HTMLInputElement).value).split(',').map((s) => s.trim()).filter(Boolean) })"
            />
            <!-- The tags input is a string v-model, not the array;
                 we re-split into array on input. The Card type
                 still has tags: string[]; the string intermediary
                 lives in card.tagsInput (see step 6). -->
          </div>
          <button
            type="button"
            class="ai-review-remove"
            :aria-label="'删除卡片 ' + card.title"
            @click="removeCard(i)"
          >×</button>
        </li>
      </ul>

      <div class="ai-review-actions">
        <button
          type="button"
          class="ai-review-add"
          @click="addBlankCard"
        >+ 新增卡片</button>
        <button
          type="button"
          class="ai-review-cancel"
          @click="review.reset()"
        >取消</button>
        <button
          type="button"
          class="ai-review-write"
          :disabled="writableCards.length === 0"
          @click="onWrite"
        >📥 写入 zettel/draft/</button>
      </div>

      <div v-if="writeStatus" class="ai-review-status" role="status">
        ✓ 已写入 {{ writeStatus.written }} 张,
        失败 {{ writeStatus.failed }} 张
        <span v-if="writeStatus.failed > 0">(检查控制台)</span>
      </div>
    </div>

    <template v-else>
      <!-- Loading / error banner: shown above the chat surface so
           the user gets feedback even if the chat is empty. -->
      <div
        v-if="review.phase.value.kind === 'loading'"
        class="ai-review-banner"
        role="status"
      >✂️ 正在拆分为原子卡…</div>
      <div
        v-else-if="review.phase.value.kind === 'error'"
        class="ai-review-banner ai-review-banner-error"
        role="alert"
      >{{ review.phase.value.reason }}</div>

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
            <div class="ai-bubble">
              <div v-if="m.content" class="ai-text">{{ m.content }}</div>
              <div
                v-for="tc in m.blocks?.toolCalls ?? []"
                :key="tc.id"
                class="ai-tool-card"
                :class="{ 'ai-tool-error': tc.result.is_error }"
              >
                <div class="ai-tool-header">
                  <span class="ai-tool-icon" v-html="iconForTool(tc.name)" aria-hidden="true" />
                  <span class="ai-tool-name">{{ tc.name }}</span>
                  <span v-if="tc.result.is_error" class="ai-tool-pill ai-tool-pill-error">error</span>
                  <span v-else-if="tc.result.content" class="ai-tool-pill ai-tool-pill-ok">ok</span>
                  <span v-else class="ai-tool-pill ai-tool-pill-pending">…</span>
                </div>
                <pre
                  v-if="tc.result.content && (tc.name === 'read_file' || tc.name === 'list_files') && !expandedToolCards[tc.id]"
                  class="ai-tool-result ai-tool-collapsed"
                ><code>{{ truncateForCard(tc.result.content) }}</code></pre>
                <pre
                  v-else-if="tc.result.content"
                  class="ai-tool-result"
                ><code>{{ tc.result.content }}</code></pre>
                <button
                  v-if="tc.result.content && (tc.name === 'read_file' || tc.name === 'list_files')"
                  type="button"
                  class="ai-tool-toggle"
                  @click="toggleToolCard(tc.id)"
                >{{ expandedToolCards[tc.id] ? '收起' : '展开' }}</button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <form class="ai-composer" @submit.prevent="onSend">
        <div class="ai-composer-inner">
          <textarea
            v-model="draft"
            class="ai-input"
            rows="1"
            placeholder="Ask Claude… (or /split to break a note into atomic cards)"
            aria-label="Ask Claude"
            @keydown="onKeydown"
          />
          <button
            class="ai-send"
            :class="{ 'ai-send-busy': history.busy.value }"
            type="button"
            :title="history.busy.value ? 'Stop' : 'Send (Enter)'"
            :aria-label="history.busy.value ? 'Stop' : 'Send'"
            :disabled="!history.busy.value && (!draft.trim() || !history.configured.value)"
            @click="onSendOrStop"
          >{{ history.busy.value ? '■' : '↑' }}</button>
        </div>
      </form>

      <AiSessionPicker v-if="pickerOpen" @close="pickerOpen = false" />
    </template>
```

Two notes on the template:
- The `v-for` over `card.tagsInput` is intentional: we add a `tagsInput: string` field to each card instance at runtime. Vue 3 lets you add ad-hoc properties to reactive objects. The step-6 below shows the assignment.
- The `<AiSessionPicker v-if="pickerOpen" />` lives inside the `<template v-else>` block, so it only renders when the chat surface is shown (it doesn't make sense inside the review surface).

- [ ] **Step 6: Initialize `tagsInput` on cards entering review**

The `card.tagsInput` is a string intermediary. We need to set it whenever a card enters the review list. The cleanest place is in the `setReview` action of the composable, but we don't want to modify the composable for a UI-only concern. Instead, do it locally in `AiPanel` with a `watch`:

```ts
// Whenever the review phase changes to 'review', initialize a
// `tagsInput: string` field on each card so the v-model input
// has a string to bind to. We do this in AiPanel (not the
// composable) because the tags stringification is a UI detail
// — the server only sees the array.
watch(() => review.phase.value, (p) => {
  if (p.kind === 'review') {
    for (const card of p.cards) {
      ;(card as any).tagsInput = card.tags.join(', ')
    }
  }
}, { immediate: true, deep: true })
```

Add this right next to the existing `watch` from step 4.

- [ ] **Step 7: Add the review-surface styles**

Append to the `<style scoped>` block in [src/components/vault/AiPanel.vue](../../../src/components/vault/AiPanel.vue), just before the closing `</style>` tag (line 322):

```css
/* Split review surface. Layout: header → card list → action bar.
   Cards are a flex row: checkbox | fields | remove. Fields stack
   vertically inside their column. We keep the styles local to
   AiPanel.vue so they don't leak into other components. */
.ai-review {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.ai-review-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--ai-border, #3a3f4b);
  font-size: 0.9em;
}
.ai-review-title {
  font-weight: 600;
}
.ai-review-mode {
  margin-left: 4px;
  font-weight: 400;
  color: var(--ai-muted, #8a93a6);
}
.ai-review-count {
  font-size: 0.85em;
  color: var(--ai-muted, #8a93a6);
}
.ai-review-list {
  flex: 1;
  margin: 0;
  padding: 8px;
  list-style: none;
  overflow-y: auto;
}
.ai-review-card {
  display: flex;
  gap: 8px;
  padding: 8px;
  margin-bottom: 8px;
  border: 1px solid var(--ai-border, #3a3f4b);
  border-radius: 6px;
  background: var(--ai-tool-bg, rgba(255, 255, 255, 0.03));
}
.ai-review-card:last-child { margin-bottom: 0; }
.ai-review-check {
  display: flex;
  align-items: flex-start;
  padding-top: 8px;
}
.ai-review-fields {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ai-review-title-input,
.ai-review-slug-input,
.ai-review-tags,
.ai-review-body {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--ai-border, #3a3f4b);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.18);
  color: inherit;
  font-family: inherit;
  font-size: 0.9em;
  box-sizing: border-box;
}
.ai-review-title-input { font-weight: 600; }
.ai-review-slug-input {
  font-family: var(--ai-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.8em;
  color: var(--ai-muted, #8a93a6);
}
.ai-review-body {
  resize: vertical;
  font-size: 0.85em;
  min-height: 60px;
}
.ai-review-tags {
  font-size: 0.8em;
}
.ai-review-remove {
  align-self: flex-start;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--ai-border, #3a3f4b);
  border-radius: 4px;
  background: transparent;
  color: var(--ai-muted, #8a93a6);
  cursor: pointer;
  font-size: 1em;
  line-height: 1;
}
.ai-review-remove:hover { color: var(--ai-error, #c14545); }
.ai-review-actions {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--ai-border, #3a3f4b);
}
.ai-review-add,
.ai-review-cancel,
.ai-review-write {
  padding: 6px 10px;
  border: 1px solid var(--ai-border, #3a3f4b);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.85em;
}
.ai-review-write {
  margin-left: auto;
  background: var(--ai-accent, #7aa2f7);
  color: #0d0f14;
  border-color: var(--ai-accent, #7aa2f7);
}
.ai-review-write:disabled {
  background: var(--ai-muted, #8a93a6);
  border-color: var(--ai-muted, #8a93a6);
  cursor: not-allowed;
  opacity: 0.6;
}
.ai-review-status {
  padding: 8px 12px;
  font-size: 0.85em;
  color: var(--ai-ok, #6ec486);
  border-top: 1px solid var(--ai-border, #3a3f4b);
}
.ai-review-banner {
  padding: 8px 12px;
  background: rgba(122, 162, 247, 0.12);
  color: var(--ai-accent, #7aa2f7);
  font-size: 0.85em;
  border-bottom: 1px solid var(--ai-border, #3a3f4b);
}
.ai-review-banner-error {
  background: rgba(193, 69, 69, 0.12);
  color: var(--ai-error, #c14545);
}
```

- [ ] **Step 8: Wire the new emits in VaultView**

In [src/views/VaultView.vue](../../../src/views/VaultView.vue), find the `<AiPanel>` component usage (line 236-240). It currently has `@close="toggleAi"`. Add two more listeners:

```vue
    <AiPanel
      v-if="aiOpen"
      class="ai-panel-slot"
      @close="toggleAi"
      @split-request="splitCard"
      @refresh-tree="refresh"
    />
```

- [ ] **Step 9: Verify type-check passes**

Run: `pnpm exec vue-tsc -b --force`
Expected: no errors. The `inject` for `useSplitReview` is untyped-string-keyed (Vue 3's `inject` accepts a string key by default); we could switch to an `InjectionKey<SplitReview>` symbol, but the simpler form is fine for one provider/one consumer and matches the existing `openSearch` injection pattern in this file (line 25).

- [ ] **Step 10: Run the test suite**

Run: `pnpm test`
Expected: all existing tests + 13 new = ~393 pass. No new frontend tests required (the visual review surface is best tested by CDP in Task 8).

- [ ] **Step 11: Commit**

```bash
git add src/components/vault/AiPanel.vue src/views/VaultView.vue
git commit -m "feat(ai-panel): split review surface + /split slash command

The AI panel body becomes a state-machine-driven surface:
- phase=review  →  card list with per-card title/body/slug/tags
                    editable inputs, checkbox select, remove, add
- phase=loading  →  transient banner above the chat
- phase=error    →  error banner above the chat
- phase=idle     →  unchanged chat surface (default)

The /split slash command intercepts before the regular chat
path: '/split inbox' on a literature note runs in literature
mode, '/split' on an inbox note infers the mode from the path
prefix. The tree context menu and the slash command both go
through VaultView.splitCard → useSplitReview.phase transitions
→ AiPanel re-renders.

Writing calls POST /api/zettel/draft/batch with the user's
selected and edited cards, shows a per-card written/failed
count, and emits refresh-tree so the file tree picks up the
new files.

~180 lines added to AiPanel.vue. No changes to the chat
surface code path (it's all inside the new <template v-else>
block).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Visual verification with headless Chrome

**Files:** none (verification only)

- [ ] **Step 1: Make sure the dev server and headless Chrome are running**

In two terminals:

```bash
# Terminal 1
pnpm dev

# Terminal 2
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9222 --remote-allow-origins=* --no-first-run --no-default-browser-check --window-size=1280,800 http://localhost:5173
```

- [ ] **Step 2: Open the inbox/init note in the vault**

Use the multi-step CDP driver (the one from the previous AI-toggle work, `/tmp/cdp-verify.mjs`). Adapt it:

```js
// (inside the try block of /tmp/cdp-verify.mjs, or a new driver)
await evalJs(`localStorage.setItem('nuvyn.vault.layout', JSON.stringify({activePanel:'files',sidePanelWidth:260,editorRatio:1,aiOpen:true,aiPanelWidth:320}))`)
await evalJs(`location.replace('/vault/inbox/init')`)
await sleep(2500)
```

(Setting `aiOpen: true` opens the panel by default so we don't have to click the toggle.)

- [ ] **Step 3: Right-click `inbox/init.md` in the tree and click the new menu item**

```js
// Use the right-click sequence: dispatch a contextmenu event on the row.
await evalJs(`
  const row = Array.from(document.querySelectorAll('.tree-row .row-name'))
    .find(b => b.textContent.trim() === 'init.md')
  const li = row.closest('.tree-row')
  const r = li.getBoundingClientRect()
  li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }))
`)
await sleep(200)
// Take a screenshot to confirm the menu shows "📤 拆为原子卡"
await screenshot('/tmp/split-menu.png')

// Click the menu item by text
await evalJs(`
  Array.from(document.querySelectorAll('.tree-context-menu button'))
    .find(b => b.textContent.includes('拆为原子卡'))?.click()
`)
await sleep(500)
```

- [ ] **Step 4: Wait for the loading banner, then the review surface**

```js
// Loading banner should be visible
const loading = await evalJs(`!!document.querySelector('.ai-review-banner')`)
console.log({ loading })

// Poll for review surface (the LLM call takes 5-15s)
for (let i = 0; i < 30; i++) {
  const ready = await evalJs(`!!document.querySelector('.ai-review-list')`)
  if (ready) break
  await sleep(500)
}
```

- [ ] **Step 5: Screenshot the review surface**

```js
await screenshot('/tmp/split-review.png')
```

Open the screenshot. Expected: 3-7 cards (for `inbox/init.md`), each with title input, slug input, body textarea, tags input, and a × button. A "📥 写入 zettel/draft/" button at the bottom-right.

- [ ] **Step 6: Edit, deselect, and write**

```js
// Drop card 2 and card 4 (indices 1 and 3)
await evalJs(`document.querySelectorAll('.ai-review-card .ai-review-remove')[1]?.click()`)
await evalJs(`document.querySelectorAll('.ai-review-card .ai-review-remove')[2]?.click()`)  // re-index after first remove
await sleep(100)

// Click 写入
await evalJs(`document.querySelector('.ai-review-write').click()`)
await sleep(800)

// Status should appear
const status = await evalJs(`document.querySelector('.ai-review-status')?.textContent`)
console.log({ status })
```

Expected status: `✓ 已写入 N 张,失败 0 张` where N is the remaining card count.

- [ ] **Step 7: Verify files exist on disk**

```bash
ls /Users/txx/nuvyn/src/content/zettel/draft/
```

Expected: N `.md` files with the slugs we kept. Pick one and read the frontmatter:

```bash
head -10 /Users/txx/nuvyn/src/content/zettel/draft/<one-of-them>.md
```

Expected: `source: inbox/init` and `splitMode: inbox` present.

- [ ] **Step 8: Clean up the test artifacts**

```bash
rm -rf /Users/txx/nuvyn/src/content/zettel/draft/*
git checkout src/content/zettel/draft/  # if any of the test files got committed
```

- [ ] **Step 9: Final test + typecheck pass**

```bash
pnpm exec vue-tsc -b --force
pnpm test
```

Expected: all green.

- [ ] **Step 10: Commit (no code changes — just the screenshots if you want them in the repo)**

Screenshots are in `/tmp/`, not the repo, so nothing to commit. If you want to commit a final "verified" tag, the work is already on `main` from Tasks 1-7.

---

### Task 9: Push and report

- [ ] **Step 1: Confirm git state**

```bash
git status
git log --oneline -10
```

Expected: clean working tree, 7 new commits on top of the spec commit `d162081`:

1. `feat(ai-api): add Card type and splitNote / writeDraftBatch fetch wrappers`
2. `feat(server): split orchestrator — Claude call + JSON parse for atomic cards`
3. `feat(server): POST /api/ai/split — synchronous atomic-card split`
4. `feat(server): POST /api/zettel/draft/batch — write cards to zettel/draft/`
5. `feat(composable): useSplitReview — shared state for split-review surface`
6. `feat(vault): tree right-click '拆为原子卡' wires to splitCard action`
7. `feat(ai-panel): split review surface + /split slash command`

- [ ] **Step 2: Push to remote**

```bash
git push gitee main
```

- [ ] **Step 3: Report**

Tell the user:

- 7 commits pushed
- Where to test: open `inbox/init.md` in the vault → right-click → "📤 拆为原子卡"; or type `/split` in the AI panel with a vault tab open
- The result lands in `zettel/draft/` — the user reviews and `git mv` (or drags in the file tree) the ones they want to promote to `zettel/`
- The 13 new tests are under `server/__tests__/split.test.ts` and `server/__tests__/zettel-draft-batch.test.ts`
- YAGNI reminders: no "publish to zettel/" UI yet, no streaming, no review state persistence across reloads

---

## Self-review

### 1. Spec coverage

| Spec section | Covered by |
|---|---|
| "Problem" | Task 7 (the entire feature) |
| "Entry points" (tree + slash) | Task 6 (tree), Task 7 (slash) |
| "Action flow" | Tasks 5, 6, 7 |
| "Server contract: POST /api/ai/split" | Tasks 2, 3 |
| "Server contract: POST /api/zettel/draft/batch" | Task 4 |
| "Output schema (Card)" | Task 1 (type) + Task 2 (runtime shape check) |
| "File format" | Task 4 (`renderCard`) |
| "Prompt design" | Task 2 (`buildUserPrompt` + `BASE_SYSTEM_PROMPT`) |
| "Frontend: where things live" | Tasks 1, 5, 6, 7 |
| "Server: where things live" | Tasks 2, 3, 4 |
| "Edge cases" — path prefix gate | Task 6 (`canSplit`); Task 3 (server-side gate) |
| "Edge cases" — 12-card cap | Task 2 (`MAX_CARDS`) |
| "Edge cases" — model returns 0 cards | Task 6 (`cards.length === 0` branch) |
| "Edge cases" — bad slug | Task 4 (`SEGMENT_RE` reject) |
| "Edge cases" — `zettel/draft/` doesn't exist | Task 4 (`fs.mkdir({ recursive: true })`) |
| "YAGNI" | honored — no streaming, no publish UI, no persistence |

### 2. Placeholder scan

Searched for "TODO", "TBD", "fill in", "implement later", "add appropriate" — none.

### 3. Type consistency

- `Card` is defined in [src/lib/ai-api.ts](../../../src/lib/ai-api.ts) (Task 1) and imported by `server/ai/split.ts` and `server/zettel.ts`. Server tests use the type implicitly via the SDK mock responses; no separate type definition in the server.
- `runSplit` signature uses `{ path, mode, raw, model?, signal? }`. Route handler passes `{ path, mode, raw, signal }` — matches.
- `writeDraftBatch` is called with `{ cards: writableCards.value }` in AiPanel. The composable's `cards` is `Card[]` — matches.
- `SplitMode` is `'inbox' | 'literature'` consistently across the type, the orchestrator, the route, the composable, the panel.
- `useSplitReview().phase` is `Ref<SplitPhase>` everywhere it's read.

No drift.

### 4. Plan-feasibility check

- Every code block in the plan is a complete drop-in (no `[...]` placeholders, no "similar to Task N" shortcuts).
- File paths are absolute.
- Commit messages are pre-written.
- The dev/Chrome prerequisites for Task 8 match the existing /tmp/cdp-drive.mjs pattern; if Chrome isn't running, the visual verification can be skipped (Tasks 1-7 still produce a working feature).
