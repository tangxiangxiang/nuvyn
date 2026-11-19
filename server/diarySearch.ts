import type { Database } from 'better-sqlite3'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export type DiarySearchScope = 'events' | 'tasks'
export type DiarySearchPhase = 'title' | 'description'
export type DiarySearchEntityKind = 'one-off' | 'series'

export interface DiarySearchCursor {
  v: 1
  owner: number
  scope: DiarySearchScope
  queryHash: string
  phase: DiarySearchPhase
  afterId: string | null
  afterKind?: DiarySearchEntityKind | null
  revision?: number
}

export class DiarySearchCursorError extends Error {}

function cursorSecret(db: Database): Buffer {
  const row = db.prepare('SELECT secret FROM diary_task_list_cursor_key WHERE id = 1').get() as { secret: Buffer } | undefined
  if (!row || !Buffer.isBuffer(row.secret) || row.secret.length !== 32) {
    throw new Error('Diary search cursor signing key is unavailable')
  }
  return row.secret
}

function queryHash(query: string): string {
  return createHash('sha256').update(query.trim().toLowerCase()).digest('hex')
}

export function encodeDiarySearchCursor(
  db: Database,
  payload: Omit<DiarySearchCursor, 'queryHash'> & { query: string },
): string {
  const { query, ...cursor } = payload
  const encoded = Buffer.from(JSON.stringify({ ...cursor, queryHash: queryHash(query) })).toString('base64url')
  const signature = createHmac('sha256', cursorSecret(db)).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

export function decodeDiarySearchCursor(
  db: Database,
  cursor: string,
  expected: { owner: number; scope: DiarySearchScope; query: string },
): DiarySearchCursor {
  if (!cursor || cursor.length > 1024) throw new DiarySearchCursorError()
  const parts = cursor.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) {
    throw new DiarySearchCursorError()
  }
  const encoded = parts[0]!
  const bytes = Buffer.from(encoded, 'base64url')
  const supplied = Buffer.from(parts[1]!, 'base64url')
  if (bytes.toString('base64url') !== encoded || supplied.toString('base64url') !== parts[1]!
    || supplied.length !== 32) throw new DiarySearchCursorError()
  const signature = createHmac('sha256', cursorSecret(db)).update(encoded).digest()
  if (!timingSafeEqual(supplied, signature)) throw new DiarySearchCursorError()

  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new DiarySearchCursorError() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DiarySearchCursorError()
  const payload = value as Record<string, unknown>
  const keys = Object.keys(payload).sort()
  const expectedKeys = (expected.scope === 'events'
    ? ['afterId', 'owner', 'phase', 'queryHash', 'scope', 'v']
    : ['afterId', 'afterKind', 'owner', 'phase', 'queryHash', 'revision', 'scope', 'v']).sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || payload.v !== 1 || payload.owner !== expected.owner || payload.scope !== expected.scope
    || payload.queryHash !== queryHash(expected.query)
    || !['title', 'description'].includes(payload.phase as string)
    || !(payload.afterId === null || (typeof payload.afterId === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.afterId)))) {
    throw new DiarySearchCursorError()
  }
  if (expected.scope === 'tasks' && (!(payload.afterKind === null || payload.afterKind === 'one-off' || payload.afterKind === 'series')
    || !Number.isSafeInteger(payload.revision) || (payload.revision as number) < 0)) throw new DiarySearchCursorError()
  return payload as unknown as DiarySearchCursor
}

export function diarySearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, ' ').trim()
  const normalizedQuery = query.trim()
  const startAt = normalizedText.toLowerCase().indexOf(normalizedQuery.toLowerCase())
  if (startAt < 0) return ''
  const contextBefore = Math.min(56, Math.max(0, 160 - normalizedQuery.length))
  const start = Math.max(0, startAt - contextBefore)
  const end = Math.min(normalizedText.length, Math.max(start + 160, startAt + normalizedQuery.length))
  return `${start > 0 ? '…' : ''}${normalizedText.slice(start, end)}${end < normalizedText.length ? '…' : ''}`
}
