# AI Split to Draft — Atomic Card Generator

> Design spec for an AI-assisted note-splitting feature. Goal: turn a long note in `inbox/` or `literature/` into a set of atomic "zettel" draft cards, with the human still in the loop to review/edit before anything lands in the vault proper.

---

## Problem

A single markdown file in `inbox/` or `literature/` often mixes several distinct ideas. The user wants to keep the long-form context (good for re-reading) AND capture the underlying atomic ideas as standalone zettel cards (so they can be referenced, linked, and re-used). The hardest step is the *splitting* — identifying where one idea ends and another begins. Doing it manually is a chore, and most users never get around to it.

This spec adds a one-click "📤 拆为原子卡" action that:

1. Sends the note to Claude with a prompt that frames the splitting task.
2. Shows the proposed cards inside the AI panel (not directly on disk).
3. Lets the user edit, drop, or add cards before confirming.
4. On confirm, writes the cards to `src/content/zettel/draft/` (a staging area), with full frontmatter and a `source:` link back to the original.

The user reviews the drafts whenever they want, and `git mv` (or a future "publish" UI) moves the ones worth keeping to `src/content/zettel/`.

## Entry points

Two entry points, both routed through the **same** core action so behavior is identical regardless of how it was triggered:

| Entry | File | Where it shows up |
|---|---|---|
| **Tree context menu** | `src/components/vault/TreeRow.vue` | Right-click on any `.md` file → "📤 拆为原子卡" item. Only visible for files in `inbox/` or `literature/` (we know the source mode from the path). |
| **AI panel slash command** | `src/components/vault/AiPanel.vue` | Inside the chat input, `/split` opens a small "split mode" picker (inbox / literature) and uses the currently active note (or whatever tab the user is on). |

Both emit the same `splitCard(path, mode)` event to the vault view, which is responsible for opening the AI panel and running the action. We deliberately do **not** add a button to the editor toolbar or reading pane — that's more code for the same path.

## Action flow

1. User right-clicks `inbox/init.md` in the tree → menu shows "📤 拆为原子卡" (because path starts with `inbox/`).
2. Clicking it opens the AI panel (if not open) and inserts a transient "split mode: inbox" indicator. The AI panel then shows a loading state ("✂️ 正在拆分为原子卡…").
3. Server runs the split (synchronous from the client's perspective, 5–15s): calls Claude with a structured-output prompt, parses the result into `Card[]`.
4. The AI panel swaps its chat surface for a **Split Review surface**:
   - List of proposed cards, each with: title (editable), body (editable textarea), tags (editable), slug (derived from title, editable, with a duplicate-collision hint).
   - Per-card checkbox (defaulted to checked). A "+ 新增卡片" button at the bottom.
   - "📥 全部写入 zettel/draft/" primary action (disabled if zero cards checked).
   - "✕ 取消" returns to the chat surface without writing anything.
5. User edits / drops / adds → clicks 写入 → server batch-writes to `zettel/draft/` (one file per card, slug as filename) → response is `{written, skipped, failed}` and the panel shows a one-line summary: "✓ 已写入 5 张,跳过 0 张,失败 0 张". The user can then close the panel or click 取消 to return to chat.

## Server contract

### `POST /api/ai/split`

**Request body** (JSON):
```ts
{
  path: string          // e.g. "inbox/init" — no .md suffix, no leading slash
  mode: 'inbox' | 'literature'
}
```

**Behavior:**
1. Resolve and read the file (same as `GET /api/posts/:path`). 404 if missing.
2. Reject if `path` is not in `inbox/` or `literature/`. Return `{error: 'split only supported for inbox/ and literature/ notes'}` with 400.
3. Build the system prompt and the user prompt (see "Prompt design" below). Call Claude non-streaming (`messages.create`, not `messages.stream`) — we want the full result in one go, not a UI stream.
4. Parse Claude's response as a `Card[]` (see "Output schema" below). If parsing fails, return 502 with `{error: 'parse-failed', reason: '<first 200 chars of raw>'}`.
5. Return `Card[]` as JSON.

**Response 200:**
```ts
{
  cards: Card[]  // length 1..20; clamped if model overshoots
}
```

**Why non-streaming:** the AI panel's chat surface can't render partial card lists cleanly, and the user expects a "done" moment (loading → review). Streaming would be 5x the code for negligible UX gain. The total round-trip latency is the same as the first-token latency (~3-5s) plus finalization.

### `POST /api/zettel/draft/batch`

**Request body** (JSON):
```ts
{
  cards: Card[]   // the user's edited card list
}
```

Each `Card` carries a `slug` (the user may have edited it). The server:

1. Validates each slug against `SEGMENT_RE` (lowercase a-z0-9 with hyphens, no leading/trailing hyphen — same as `POST /api/posts` already enforces).
2. For each card, computes a final destination path. If `zettel/draft/<slug>.md` already exists, append `-2`, `-3`, etc. until unique.
3. Writes the file with frontmatter (see "File format" below). On any per-file write error, that card is reported in `failed` and the rest are still written (no transactional rollback — the user gets to fix or delete the failed card manually).
4. Returns:
   ```ts
   {
     written: { slug: string; path: string }[]   // path is "zettel/draft/<slug>"
     skipped: { slug: string; reason: string }[] // currently unused; reserved
     failed:  { slug: string; reason: string }[] // e.g. { slug, reason: "permission denied" }
   }
   ```

The route does **not** use `POST /api/posts` (which validates the *new file path* in the client-supplied body) — this route is hardcoded to write under `zettel/draft/` and the slug is the only user-controlled segment.

## Output schema (`Card`)

```ts
export interface Card {
  title: string         // 2-12 words, the noun phrase of the idea
  body: string          // 100-300 words (mode-dependent; see prompt)
  tags: string[]        // 1-5 lowercase-kebab tags
  slug: string          // derived from title by the model: a-z0-9 + hyphens
  source: string        // the original note path, e.g. "inbox/init"
  splitMode: 'inbox' | 'literature'
}
```

The model is told to fill `title`, `body`, `tags`, and `slug`. The server fills `source` and `splitMode` from the request — the model never produces these, which prevents prompt-injection-style attempts to make a card claim a different origin.

## File format (one .md per card)

```yaml
---
title: <card.title>
created: <YYYY-MM-DD>      # UTC date the batch write happened
updated: <YYYY-MM-DD>
tags: [<card.tags>]
summary:                    # first 1-2 sentences of <card.body>, or empty
source: <card.source>        # e.g. "inbox/init"  — original note path (no .md)
splitMode: <card.splitMode>  # 'inbox' | 'literature'
---

# <card.title>

<card.body>
```

The `source:` and `splitMode:` fields are non-standard for the rest of the vault, but they only ever appear in `zettel/draft/*` (and eventually `zettel/*`). Other code paths (`getPost`, search index, link index) just carry them as unknown frontmatter keys and ignore them — no schema changes elsewhere.

The `summary:` is included (with no value) so the placeholder is visible, matching the convention in `POST /api/posts` (see server/index.ts:64). The batch route populates it with a trimmed first sentence when possible; empty string otherwise.

## Prompt design

A two-message prompt (system + user). The system prompt is short; the user prompt carries the note text and the mode-specific framing.

### System prompt (constant)

```
You are a "Zettelkasten assistant" helping a user split a long note into atomic cards.

An "atomic card" is a single self-contained idea. The title is the noun phrase that
names the idea. The body is a self-contained restatement that can be read on its own
without seeing the original note.

Hard rules:
- Each card = ONE idea, not a chapter, not a section, not a list item.
- 1 to 12 cards per note. Most inbox notes split into 3-7 cards. If a note is short
  or has only one idea, return 1 card.
- Title: 2-12 words, no punctuation other than hyphens, names the idea as a noun
  phrase ("Domain events as a decoupling boundary" not "On Domain Events").
- Body: 100-300 words. The body must restate the idea in the voice specified below,
  not just quote the original.
- Tags: 1-5 lowercase-kebab-case tags (a-z0-9 and hyphens), like "distributed-systems".
- Slug: a-z0-9 and hyphens, 3-50 chars, derived from the title.
- Do NOT include any preamble, code fences, or commentary. Return ONLY the JSON array.

Output schema (return exactly this shape, no prose, no code fences):
[
  { "title": "...", "body": "...", "tags": ["...", "..."], "slug": "..." }
]
```

### User prompt template (one per mode)

**mode: `inbox`**
```
Mode: inbox — these are the user's own words. Restate each idea in the user's
voice (first-person, plain, direct). Treat the source as a thought-dump; pull
out the underlying arguments, don't summarize the structure.

Source note path: <path>

<note text>
```

**mode: `literature`**
```
Mode: literature — this is something the user is reading. Each card should
capture ONE idea from the source in your own words, with the original phrasing
preserved as a quote if it's the most precise way to express the idea. Aim for
fidelity to the author's argument, not restatement of structure.

Source note path: <path>

<note text>
```

The model is told (in the system prompt) to return a JSON array, and the server validates the shape with a hand-written parser (no JSON-schema library — we just check `Array.isArray` and that each item has the four required string fields, plus `tags` is an array of strings). If parsing fails, we return 502 with the first 200 chars of the raw text in `reason` so the user can see "the model decided to be chatty" and try again.

The model used is the same `claude-sonnet-4-6` default (env `ANTHROPIC_MODEL`) used by chat. Splitting is a single-turn, no-tools call — we explicitly omit the `tools` parameter.

## Frontend: where things live

| Concern | File | Change |
|---|---|---|
| Wire types | [src/lib/ai-api.ts](../../../src/lib/ai-api.ts) | `+ ~30` — add `Card` interface + `splitNote()` + `writeDraftBatch()` |
| Tree context menu item | [src/components/vault/TreeRow.vue](../../../src/components/vault/TreeRow.vue) | `+ ~6` — add "📤 拆为原子卡" button + emit `split-card` |
| Tree handler | [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue) | `+ ~12` — listen for `split-card`, decide mode from path prefix, call the vault-view action |
| Vault view action | [src/views/VaultView.vue](../../../src/views/VaultView.vue) | `+ ~20` — `splitCard(path, mode)` opens AI panel, sets a shared store flag, switches panel surface to "review" |
| AI panel "review" surface | [src/components/vault/AiPanel.vue](../../../src/components/vault/AiPanel.vue) | `+ ~150` — review state (cards ref + edit handlers) + template (card list with checkboxes/edit fields) + 写入 button |
| AI panel `/split` slash command | [src/components/vault/AiPanel.vue](../../../src/components/vault/AiPanel.vue) | `+ ~30` — input parser picks up `/split`, prompts for mode, calls the same `splitCard()` |
| Shared store (so the panel can show "review" even if invoked from the tree, not from the input) | new tiny composable `src/composables/vault/useSplitReview.ts` | `+ ~40` — one ref `reviewState: { mode, cards, dirty } \| null`; reset/write methods |

The "tiny composable" avoids passing split-review state through `defineProps`/`emit` chains, which would force the AI panel to grow new props. The vault view owns the instance and passes it via `provide`.

## Server: where things live

| Concern | File | Change |
|---|---|---|
| Split orchestrator | new `server/ai/split.ts` | `+ ~120` — `runSplit({ path, mode })` calls Claude, parses, returns `Card[]` |
| `POST /api/ai/split` route | `server/ai/routes.ts` | `+ ~20` — handler that calls `runSplit`, maps errors to status codes |
| `POST /api/zettel/draft/batch` route | new `server/zettel.ts` (a sibling of `server/ai/`) | `+ ~80` — `writeBatch({ cards })` validates, dedupes slugs, writes files, returns `{written, skipped, failed}` |
| Mount the new route in `server/index.ts` | `server/index.ts` | `+ ~3` — `app.route('/api/zettel', zettelRoutes)` |

Both new files import the `Card` type from `src/lib/ai-api.ts` (same trick the AI routes already use — see `server/ai/routes.ts:1-9` for the precedent).

## Edge cases

| Case | Behavior |
|---|---|
| File is in `zettel/` or anywhere else not `inbox/` or `literature/` | Server returns 400. Tree menu doesn't show the item. |
| Note text is <100 words | Allowed. Model returns 1 card (system prompt says so). |
| Note text is >8000 words | The model has a 4096 max_tokens output cap, but input is the model's context window — the user-side guard is to truncate to the first 8000 chars of the note body and prepend `…(truncated)`. We document this in a code comment. |
| Model returns prose instead of JSON (refuses, hallucinates a wrapper, etc.) | 502 with `reason: '<first 200 chars of raw>'`. AI panel shows the reason as a toast and stays on the chat surface. |
| Model returns more than 12 cards | Truncate to the first 12 silently. |
| Model returns 0 cards | The AI panel shows "没有识别出独立的原子想法" and stays on the chat surface; no review opens. |
| User clicks 写入 with 0 cards checked | Button is disabled. |
| User writes a card with a `slug` that contains a slash or uppercase | Server-side `SEGMENT_RE` check rejects with 400. The AI panel surfaces the error per-card. |
| `zettel/draft/` doesn't exist on disk yet | `mkdir -p` before writing. |
| User has a tab open with the same note being split | No coupling. The split only reads the file (one-time, at request start); it doesn't hold a lock. Worst case the user edits the source between request start and batch write — the cards still go to `draft/`, untouched. |
| AI panel is closed when the user clicks 写入 | N/A — the review surface is the panel; it can't be closed. |
| Two simultaneous splits on the same note | Two requests run, produce two batches. Both go to `draft/`. Slug collisions get `-2` suffix. The user can de-dup manually. |

## What we are NOT doing (YAGNI)

- ❌ A "publish to zettel/" button that auto-moves cards from `draft/` to the parent `zettel/`. The user can `git mv` or use the file tree's drag-to-move. Adding publish UI is the next feature, not this one.
- ❌ Streaming the cards as the model produces them. The latency win is small (3-5s vs 5-15s for a 2000-word note) and the UI cost is significant (incremental render of an editable list).
- ❌ Editing the source note in response to a successful split (e.g. inserting a `[[zettel/draft/foo]]` link in the source). Out of scope.
- ❌ Persisting the review state across page reloads. If the user closes the panel mid-review, the next click starts fresh. Re-running the LLM call is cheap (5-15s) compared to the cost of persisting half-edited cards.
- ❌ A "history of splits" view. Just look at `zettel/draft/` in the file tree.
- ❌ Auto-routing the source path to a mode. The mode is always passed explicitly. (Even if the path starts with `inbox/`, the slash-command form lets the user pick `literature` if they want.)

## Testing

**Backend (Vitest, in `server/__tests__/`):**

1. `split.test.ts` — feed a fixture note (use the existing `inbox/init.md` as a fixture, since it's already in the repo), mock the SDK, assert:
   - Returns 1-12 cards, all with non-empty title/body/tags/slug
   - Cards with `mode: 'inbox'` have first-person voice markers in body
   - Slugs match `SEGMENT_RE`
2. `zettel-draft-batch.test.ts` — feed 3 cards, assert:
   - All 3 written to `zettel/draft/`
   - Calling again with the same cards reports all 3 as `written` with `-2` suffix on the slugs
   - Card with bad slug (uppercase, slash) returns 400
3. Route-level: `app.request('/api/ai/split', { method: 'POST', body: {...} })` returns 200 with `cards: [...]`. `app.request('/api/ai/split', { method: 'POST', body: {path: 'zettel/init', mode: 'inbox'} })` returns 400. Existing AI tests stay green.

**Frontend (Vitest + happy-dom, in `src/components/vault/__tests__/AiPanel.test.ts`):**

1. Tree menu doesn't show the item for `zettel/*` paths. (Use the existing `useVaultLayout.test.ts` patterns.)
2. AI panel `/split` command parsing: `/split` opens the mode picker; `/split inbox` runs immediately.
3. Split review surface: cards render with editable fields, dropping a card removes it, 写入 button is disabled when zero checked, calling 写入 calls `writeDraftBatch` with the current edited values.

**Visual smoke test** (CDP, like the AI toggle):

1. Right-click `inbox/init.md` → click "📤 拆为原子卡" → panel opens with cards after ~5-15s.
2. Edit card 2's title, drop card 4, click 写入.
3. File tree refresh shows 4 new files in `zettel/draft/`.
4. Open one of them in the editor: frontmatter is correct, body is editable.

## Files changed

| File | Lines | Change |
|---|---|---|
| [src/lib/ai-api.ts](../../../src/lib/ai-api.ts) | +~30 | `Card` type + 2 fetch wrappers |
| [src/components/vault/TreeRow.vue](../../../src/components/vault/TreeRow.vue) | +~6 | context menu item + emit |
| [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue) | +~12 | listener for `split-card` |
| [src/components/vault/AiPanel.vue](../../../src/components/vault/AiPanel.vue) | +~180 | review surface + `/split` command |
| [src/views/VaultView.vue](../../../src/views/VaultView.vue) | +~20 | `splitCard` action + provide composable |
| `src/composables/vault/useSplitReview.ts` (new) | +~40 | shared review state |
| `server/ai/split.ts` (new) | +~120 | split orchestrator |
| [server/ai/routes.ts](../../../server/ai/routes.ts) | +~20 | `POST /api/ai/split` |
| `server/zettel.ts` (new) | +~80 | batch write route |
| [server/index.ts](../../../server/index.ts) | +~3 | mount new route |
| `server/__tests__/split.test.ts` (new) | +~80 | server-side split tests |
| `server/__tests__/zettel-draft-batch.test.ts` (new) | +~80 | server-side batch tests |
| Frontend test file(s) | +~120 | review surface + slash command |

**Total:** ~13 files, ~800 lines added, 0 lines removed, 0 files restructured.

## Safety / no-break plan

Three rules we follow to keep the existing app working throughout:

1. **No changes to existing routes or components.** Every existing route, every existing test, every existing component keeps its current shape. We add files; we don't modify public contracts.
2. **The new tree menu item is gated by path prefix.** It only renders for `inbox/` and `literature/` rows. `zettel/` rows and any other path get the existing menu unchanged.
3. **The new AI panel surface is gated by a ref.** When the ref is null, the AI panel renders the existing chat surface exactly as today. When non-null, it shows the review surface in place of (not in addition to) the chat. Closing the review ref nulls the ref and the chat surface returns.
