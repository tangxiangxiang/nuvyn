// Messages service. The two functions are listMessages (read) and
// appendMessage (write). appendMessage does several things in one
// transaction: validate input, ensure the session exists, insert the
// message, refresh the session's updated_at, and (for the first user
// message in an empty-title session) auto-derive a title from the
// message content. The title derivation uses Unicode code-point
// counting so a surrogate pair (e.g. an emoji) can't be split.
//
// Tool-using assistant turns persist a JSON envelope into the
// existing `content` column so the schema is unchanged. The
// envelope is detected by `parseStoredContent` when the history is
// rehydrated for a follow-up turn — the matching tool_results user
// turn is synthesized from the envelope (no need to persist it).
//
// Envelope versions:
//   v: 1 — `rounds` is `unknown[][]`, each entry is a provider-native
//          content block array (Anthropic-shaped: text + tool_use).
//          Reads transparently convert to NormalizedRound on the fly.
//   v: 2 — `rounds` is `NormalizedRound[]`, provider-neutral shape
//          `({ text, toolCalls: [{id, name, input}] })`. This is what
//          every backend writes now.
//
// v: 2 was introduced alongside multi-provider support; legacy v: 1
// envelopes are still readable but new turns always write v: 2 so the
// on-disk shape converges after a few turns.
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

// --- JSON envelope for tool-using assistant turns ---------------------------

export type ToolCallRecord = {
  id: string
  name: string
  input: Record<string, unknown>
  result: { content: string; is_error: boolean }
}

/* Provider-neutral shape for a single LLM round within an assistant
   turn. Captures the assistant's text + tool calls for that round;
   tool results live in the top-level `toolCalls` list (paired by
   id), so rehydration can rebuild the multi-turn convo without
   re-running the tool side effects. */
export type NormalizedRound = {
  text: string
  toolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>
}

/* v: 2 envelope — what new turns are written as. */
export type AssistantEnvelopeV2 = {
  v: 2
  text: string
  rounds: NormalizedRound[]
  toolCalls: ToolCallRecord[]
}

/* v: 1 envelope — legacy. `rounds[i]` is `unknown[]` of Anthropic-
   shaped content blocks (text + tool_use). Still readable for
   history loaded from old sessions; on read we convert to v: 2
   shape in memory so the rest of the pipeline stays simple. */
export type AssistantEnvelopeV1 = {
  v: 1
  text: string
  rounds: unknown[][]
  toolCalls: ToolCallRecord[]
}

export type AssistantEnvelope = AssistantEnvelopeV2

export type StoredContent =
  | { kind: 'envelope'; envelope: AssistantEnvelope }
  | { kind: 'plain'; text: string }

/* Lift an Anthropic-shaped `content: ContentBlockParam[]` into a
   NormalizedRound. Anything that isn't a recognized text / tool_use
   block is silently dropped (the model could in theory return
   other block types we don't use). */
function anthropicBlocksToRound(blocks: unknown[]): NormalizedRound {
  let text = ''
  const toolCalls: NormalizedRound['toolCalls'] = []
  for (const b of blocks as Array<Record<string, unknown>>) {
    if (b.type === 'text' && typeof b.text === 'string') {
      text += b.text
    } else if (b.type === 'tool_use') {
      toolCalls.push({
        id: String(b.id ?? ''),
        name: String(b.name ?? ''),
        input: (b.input as Record<string, unknown>) ?? {},
      })
    }
  }
  return { text, toolCalls }
}

function convertV1ToV2(envelopeV1: AssistantEnvelopeV1): AssistantEnvelopeV2 {
  return {
    v: 2,
    text: envelopeV1.text,
    rounds: envelopeV1.rounds.map((blocks) => anthropicBlocksToRound(blocks)),
    toolCalls: envelopeV1.toolCalls,
  }
}

/**
 * Try to parse a DB row's `content` as an assistant envelope. Detects
 * both v: 1 (Anthropic-shaped rounds) and v: 2 (NormalizedRound[]).
 * Returns the envelope in its v: 2 shape; legacy v: 1 is converted
 * in memory. Safe to call on any string — never throws.
 */
export function parseStoredContent(raw: string): StoredContent {
  try {
    const j = JSON.parse(raw)
    if (
      j &&
      typeof j === 'object' &&
      Array.isArray(j.toolCalls)
    ) {
      if (j.v === 2 && typeof j.text === 'string' && Array.isArray(j.rounds)) {
        // Sanity-check the shape of each round; fall back to plain
        // text if anything looks off (defensive — should never fire
        // for well-formed writes).
        const rounds: NormalizedRound[] = []
        for (const r of j.rounds) {
          if (
            r &&
            typeof r === 'object' &&
            typeof r.text === 'string' &&
            Array.isArray(r.toolCalls)
          ) {
            rounds.push(r as NormalizedRound)
          }
        }
        return { kind: 'envelope', envelope: { v: 2, text: j.text, rounds, toolCalls: j.toolCalls } }
      }
      if (j.v === 1 && typeof j.text === 'string' && Array.isArray(j.rounds)) {
        return { kind: 'envelope', envelope: convertV1ToV2(j as AssistantEnvelopeV1) }
      }
    }
  } catch {
    // not JSON — fall through
  }
  return { kind: 'plain', text: raw }
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