import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { DIARY_ATTACHMENT_STAGE_LEASE_MS, MAX_DIARY_ATTACHMENT_BYTES, MAX_DIARY_DAY_ATTACHMENTS, MAX_DIARY_EVENT_ATTACHMENTS, isDiaryAttachmentMimeType, type DiaryAttachment, type DiaryAttachmentMimeType } from '../../shared/diaryAttachments.js'
import type { DiaryBodyOperation } from '../diaryAccess/service.js'
import { cleanupDiaryAttachmentId, cleanupDiaryAttachmentStorage, DiaryAttachmentStorage, ensureDiaryAttachmentStorage, markDiaryAttachmentOrphanScan, reconcileDiaryAttachmentOrphans, withDiaryAttachmentStorageLock } from './storage.js'

export class DiaryAttachmentError extends Error {
  readonly code: 'invalid' | 'not-found' | 'conflict' | 'too-many' | 'too-large' | 'unsupported' | 'storage'
  readonly status: 400 | 404 | 409 | 413 | 415 | 503

  constructor(code: DiaryAttachmentError['code'], status: DiaryAttachmentError['status']) {
    super('Diary attachment operation failed.')
    this.name = 'DiaryAttachmentError'
    this.code = code
    this.status = status
  }
}

type Metadata = { name: string; mimeType: DiaryAttachmentMimeType; size: number }
type AttachmentRow = {
  id: string
  day_date?: string
  event_id?: string | null
  encrypted_metadata: Buffer
  status: 'staged' | 'attached' | 'deleting'
  display_order: number
  created_at: number
  expires_at: number | null
  request_key: string | null
  stage_session_id: string | null
}
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const eventScope = (eventId: string) => `event:${eventId}`

function metadataFromRow(row: AttachmentRow, owner: number, operation: DiaryBodyOperation): DiaryAttachment {
  const date = row.day_date!
  const raw = operation.attachments!.decryptMetadata(row.encrypted_metadata, { owner, date, id: row.id })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Diary attachment metadata')
  const metadata = raw as Record<string, unknown>
  if (typeof metadata.name !== 'string' || !isDiaryAttachmentMimeType(metadata.mimeType)
    || !Number.isSafeInteger(metadata.size) || (metadata.size as number) < 1 || (metadata.size as number) > MAX_DIARY_ATTACHMENT_BYTES) {
    throw new Error('Invalid Diary attachment metadata')
  }
  return {
    id: row.id,
    date,
    name: metadata.name,
    mimeType: metadata.mimeType,
    size: metadata.size as number,
    createdAt: row.created_at,
    order: row.display_order,
  }
}

export function listDiaryDayAttachments(
  db: Database,
  owner: number,
  date: string,
  operation: DiaryBodyOperation,
): DiaryAttachment[] {
  operation.assertCurrent()
  const rows = db.prepare(`SELECT * FROM diary_day_attachments
    WHERE owner_user_id = ? AND day_date = ? AND status = 'attached'
    ORDER BY display_order, created_at, id`).all(owner, date) as AttachmentRow[]
  return rows.map(row => metadataFromRow(row, owner, operation))
}

export function listDiaryEventAttachments(
  db: Database,
  owner: number,
  eventId: string,
  operation: DiaryBodyOperation,
): DiaryAttachment[] {
  operation.assertCurrent()
  const rows = db.prepare(`SELECT * FROM diary_event_attachments
    WHERE owner_user_id = ? AND event_id = ? AND status = 'attached'
    ORDER BY display_order, created_at, id`).all(owner, eventId) as Array<AttachmentRow & { event_id: string }>
  return rows.map(row => {
    const raw = operation.attachments!.decryptMetadata(row.encrypted_metadata, { owner, date: eventScope(eventId), id: row.id })
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Diary event attachment metadata')
    const metadata = raw as Record<string, unknown>
    if (typeof metadata.name !== 'string' || !isDiaryAttachmentMimeType(metadata.mimeType)
      || !Number.isSafeInteger(metadata.size) || (metadata.size as number) < 1 || (metadata.size as number) > MAX_DIARY_ATTACHMENT_BYTES) {
      throw new Error('Invalid Diary event attachment metadata')
    }
    return { id: row.id, eventId, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size as number,
      createdAt: row.created_at, order: row.display_order }
  })
}

export async function stageDiaryEventAttachment(options: {
  db: Database
  owner: number
  eventId: string
  sessionId: string
  name: string
  mimeType: DiaryAttachmentMimeType
  bytes: Buffer
  requestKey: string
  operation: DiaryBodyOperation
  storage: DiaryAttachmentStorage
}): Promise<DiaryAttachment> {
  const { db, owner, eventId, sessionId, name, mimeType, bytes, requestKey, operation, storage } = options
  operation.assertCurrent()
  if (!UUID_V4.test(requestKey) || !UUID_V4.test(sessionId) || !UUID_V4.test(eventId)
    || !name || !isDiaryAttachmentMimeType(mimeType) || bytes.byteLength < 1) throw new DiaryAttachmentError('invalid', 400)
  if (bytes.byteLength > MAX_DIARY_ATTACHMENT_BYTES) throw new DiaryAttachmentError('too-large', 413)
  await ensureDiaryAttachmentStorage(db, storage)
  await cleanupDiaryAttachmentStorage(db, storage, owner)
  await reconcileDiaryAttachmentOrphans(db, storage)

  return withDiaryAttachmentStorageLock(async () => {
    operation.assertCurrent()
    const existing = db.prepare(`SELECT * FROM diary_event_attachments
      WHERE owner_user_id = ? AND request_key = ?`).get(owner, requestKey) as (AttachmentRow & { stage_event_id: string | null }) | undefined
    if (existing) {
      if (existing.stage_event_id !== eventId || existing.status !== 'staged' || existing.stage_session_id !== sessionId) throw new DiaryAttachmentError('conflict', 409)
      const ciphertext = await storage.read(existing.id)
      let stored: Buffer
      try { stored = operation.attachments!.decryptFile(ciphertext, { owner, date: eventScope(eventId), id: existing.id }) } finally { ciphertext.fill(0) }
      try {
        const previous = operation.attachments!.decryptMetadata(existing.encrypted_metadata, { owner, date: eventScope(eventId), id: existing.id }) as Metadata
        if (previous.name !== name || previous.mimeType !== mimeType || previous.size !== bytes.byteLength || !stored.equals(bytes)) {
          throw new DiaryAttachmentError('conflict', 409)
        }
        return { id: existing.id, eventId, ...previous, createdAt: existing.created_at, order: existing.display_order }
      } finally { stored.fill(0) }
    }

    const countForEvent = () => (db.prepare(`SELECT COUNT(*) AS count FROM diary_event_attachments
      WHERE owner_user_id = ? AND (event_id = ? OR stage_event_id = ?) AND status IN ('staged', 'attached')`).get(owner, eventId, eventId) as { count: number }).count
    const count = countForEvent()
    if (count >= MAX_DIARY_EVENT_ATTACHMENTS) throw new DiaryAttachmentError('too-many', 400)
    const id = randomUUID().toLowerCase()
    const createdAt = Date.now()
    const metadata: Metadata = { name, mimeType, size: bytes.byteLength }
    const crypto = operation.attachments!
    const context = { owner, date: eventScope(eventId), id }
    const encryptedMetadata = crypto.encryptMetadata(metadata, context)
    let encryptedFile: Buffer | null = null
    let inserted = false
    try {
      encryptedFile = crypto.encryptFile(bytes, context)
      await storage.write(id, encryptedFile)
      operation.assertCurrent()
      db.transaction(() => {
        if (countForEvent() >= MAX_DIARY_EVENT_ATTACHMENTS) throw new DiaryAttachmentError('too-many', 400)
        db.prepare(`INSERT INTO diary_event_attachments
          (id, owner_user_id, event_id, stage_event_id, encrypted_metadata, status, display_order, created_at, expires_at, request_key, stage_session_id)
          VALUES (?, ?, NULL, ?, ?, 'staged', ?, ?, ?, ?, ?)`)
          .run(id, owner, eventId, encryptedMetadata, count, createdAt, createdAt + DIARY_ATTACHMENT_STAGE_LEASE_MS, requestKey, sessionId)
      })()
      inserted = true
      operation.assertCurrent()
    } catch (error) {
      if (inserted) {
        const marked = db.prepare("UPDATE diary_event_attachments SET status = 'deleting', stage_event_id = NULL, expires_at = NULL, stage_session_id = NULL WHERE owner_user_id = ? AND id = ? AND status = 'staged'").run(owner, id)
        if (marked.changes) {
          try {
            await storage.remove(id)
            db.prepare("DELETE FROM diary_event_attachments WHERE owner_user_id = ? AND id = ? AND status = 'deleting'").run(owner, id)
          } catch { /* retry through protected cleanup */ }
        }
      } else {
        try { await storage.remove(id) } catch { markDiaryAttachmentOrphanScan(db) }
      }
      if (error instanceof DiaryAttachmentError) throw error
      throw new DiaryAttachmentError('storage', 503)
    } finally {
      encryptedMetadata.fill(0)
      encryptedFile?.fill(0)
    }
    return { id, eventId, ...metadata, createdAt, order: count }
  })
}

export async function renewDiaryEventAttachmentStageSession(options: {
  db: Database
  owner: number
  eventId: string
  sessionId: string
  operation: DiaryBodyOperation
  storage: DiaryAttachmentStorage
}): Promise<void> {
  const { db, owner, eventId, sessionId, operation, storage } = options
  operation.assertCurrent()
  if (!UUID_V4.test(eventId) || !UUID_V4.test(sessionId)) throw new DiaryAttachmentError('invalid', 400)
  await cleanupDiaryAttachmentStorage(db, storage, owner)
  operation.assertCurrent()
  const now = Date.now()
  db.prepare(`UPDATE diary_event_attachments SET expires_at = ?
    WHERE owner_user_id = ? AND stage_event_id = ? AND stage_session_id = ?
      AND status = 'staged' AND expires_at > ?`).run(now + DIARY_ATTACHMENT_STAGE_LEASE_MS, owner, eventId, sessionId, now)
  operation.assertCurrent()
}

export async function stageDiaryAttachment(options: {
  db: Database
  owner: number
  date: string
  sessionId: string
  name: string
  mimeType: DiaryAttachmentMimeType
  bytes: Buffer
  requestKey: string
  operation: DiaryBodyOperation
  storage: DiaryAttachmentStorage
}): Promise<DiaryAttachment> {
  const { db, owner, date, sessionId, name, mimeType, bytes, requestKey, operation, storage } = options
  operation.assertCurrent()
  if (!UUID_V4.test(requestKey) || !UUID_V4.test(sessionId) || !name || !isDiaryAttachmentMimeType(mimeType) || bytes.byteLength < 1) throw new DiaryAttachmentError('invalid', 400)
  if (bytes.byteLength > MAX_DIARY_ATTACHMENT_BYTES) throw new DiaryAttachmentError('too-large', 413)
  await ensureDiaryAttachmentStorage(db, storage)
  await cleanupDiaryAttachmentStorage(db, storage, owner)
  await reconcileDiaryAttachmentOrphans(db, storage)

  return withDiaryAttachmentStorageLock(async () => {
    operation.assertCurrent()
    const existing = db.prepare(`SELECT * FROM diary_day_attachments
      WHERE owner_user_id = ? AND request_key = ?`).get(owner, requestKey) as AttachmentRow | undefined
    if (existing) {
      if (existing.day_date !== date || existing.status !== 'staged' || existing.stage_session_id !== sessionId) throw new DiaryAttachmentError('conflict', 409)
      const previousMetadata = metadataFromRow(existing, owner, operation)
      const ciphertext = await storage.read(existing.id)
      let stored: Buffer
      try { stored = operation.attachments!.decryptFile(ciphertext, { owner, date, id: existing.id }) } finally { ciphertext.fill(0) }
      try {
        if (previousMetadata.name !== name || previousMetadata.mimeType !== mimeType || previousMetadata.size !== bytes.byteLength || !stored.equals(bytes)) {
          throw new DiaryAttachmentError('conflict', 409)
        }
        return previousMetadata
      } finally { stored.fill(0) }
    }

    const count = (db.prepare(`SELECT COUNT(*) AS count FROM diary_day_attachments
      WHERE owner_user_id = ? AND day_date = ? AND status IN ('staged', 'attached')`).get(owner, date) as { count: number }).count
    if (count >= MAX_DIARY_DAY_ATTACHMENTS) throw new DiaryAttachmentError('too-many', 400)

    const id = randomUUID().toLowerCase()
    const createdAt = Date.now()
    const metadata: Metadata = { name, mimeType, size: bytes.byteLength }
    const crypto = operation.attachments!
    const context = { owner, date, id }
    const encryptedMetadata = crypto.encryptMetadata(metadata, context)
    let encryptedFile: Buffer | null = null
    let inserted = false
    try {
      encryptedFile = crypto.encryptFile(bytes, context)
      await storage.write(id, encryptedFile)
      operation.assertCurrent()
      db.transaction(() => {
        const currentCount = (db.prepare(`SELECT COUNT(*) AS count FROM diary_day_attachments
          WHERE owner_user_id = ? AND day_date = ? AND status IN ('staged', 'attached')`).get(owner, date) as { count: number }).count
        if (currentCount >= MAX_DIARY_DAY_ATTACHMENTS) throw new DiaryAttachmentError('too-many', 400)
        db.prepare(`INSERT INTO diary_day_attachments
          (id, owner_user_id, day_date, encrypted_metadata, status, display_order, created_at, expires_at, request_key, stage_session_id)
          VALUES (?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?)`)
          .run(id, owner, date, encryptedMetadata, currentCount, createdAt, createdAt + DIARY_ATTACHMENT_STAGE_LEASE_MS, requestKey, sessionId)
      })()
      inserted = true
      operation.assertCurrent()
    } catch (error) {
      if (inserted) {
        // If the capability is revoked after the staged row commits, remove
        // both sides where possible. A failed unlink leaves a tombstone for
        // startup/request recovery instead of a retry key pointing at no file.
        const marked = db.prepare("UPDATE diary_day_attachments SET status = 'deleting', expires_at = NULL, stage_session_id = NULL WHERE owner_user_id = ? AND id = ? AND status = 'staged'").run(owner, id)
        if (marked.changes) {
          try {
            await storage.remove(id)
            db.prepare("DELETE FROM diary_day_attachments WHERE owner_user_id = ? AND id = ? AND status = 'deleting'").run(owner, id)
          } catch {
            // Keep the tombstone. The next protected cleanup retries unlink
            // and only removes the row after that operation succeeds.
          }
        }
      } else {
        try { await storage.remove(id) } catch {
          // There is no row to tombstone yet. Flag this opaque encrypted file
          // for the next protected orphan reconciliation pass.
          markDiaryAttachmentOrphanScan(db)
        }
      }
      if (error instanceof DiaryAttachmentError) throw error
      throw new DiaryAttachmentError('storage', 503)
    } finally {
      encryptedMetadata.fill(0)
      encryptedFile?.fill(0)
    }
    return { id, date, ...metadata, createdAt, order: count }
  })
}

export async function renewDiaryAttachmentStageSession(options: {
  db: Database
  owner: number
  date: string
  sessionId: string
  operation: DiaryBodyOperation
  storage: DiaryAttachmentStorage
}): Promise<void> {
  const { db, owner, date, sessionId, operation, storage } = options
  operation.assertCurrent()
  if (!UUID_V4.test(sessionId)) throw new DiaryAttachmentError('invalid', 400)
  await cleanupDiaryAttachmentStorage(db, storage, owner)
  operation.assertCurrent()
  const now = Date.now()
  db.prepare(`UPDATE diary_day_attachments
    SET expires_at = ?
    WHERE owner_user_id = ? AND day_date = ? AND stage_session_id = ?
      AND status = 'staged' AND expires_at > ?`)
    .run(now + DIARY_ATTACHMENT_STAGE_LEASE_MS, owner, date, sessionId, now)
  operation.assertCurrent()
}

export async function discardStagedDiaryAttachment(options: {
  db: Database
  owner: number
  id: string
  operation: DiaryBodyOperation
  storage: DiaryAttachmentStorage
}): Promise<void> {
  const { db, owner, id, operation, storage } = options
  operation.assertCurrent()
  if (!UUID_V4.test(id)) throw new DiaryAttachmentError('not-found', 404)
  let found = false
  db.transaction(() => {
    const dayRow = db.prepare('SELECT status FROM diary_day_attachments WHERE owner_user_id = ? AND id = ?').get(owner, id) as { status: string } | undefined
    const eventRow = db.prepare('SELECT status FROM diary_event_attachments WHERE owner_user_id = ? AND id = ?').get(owner, id) as { status: string } | undefined
    const row = dayRow ? { ...dayRow, scope: 'day' as const } : eventRow ? { ...eventRow, scope: 'event' as const } : undefined
    if (!row) return
    found = true
    if (row.status === 'attached') throw new DiaryAttachmentError('conflict', 409)
    if (row.status === 'staged' && row.scope === 'day') {
      db.prepare("UPDATE diary_day_attachments SET status = 'deleting', expires_at = NULL, stage_session_id = NULL WHERE owner_user_id = ? AND id = ?").run(owner, id)
    } else if (row.status === 'staged') {
      db.prepare("UPDATE diary_event_attachments SET status = 'deleting', stage_event_id = NULL, expires_at = NULL, stage_session_id = NULL WHERE owner_user_id = ? AND id = ?").run(owner, id)
    }
  })()
  // Never let a caller without an owner-scoped row trigger physical cleanup
  // for an opaque ID belonging to another Diary owner.
  if (!found) return
  operation.assertCurrent()
  await cleanupDiaryAttachmentId(db, storage, owner, id)
}

export async function readDiaryAttachment(options: {
  db: Database
  owner: number
  id: string
  operation: DiaryBodyOperation
  storage: DiaryAttachmentStorage
}): Promise<{ metadata: DiaryAttachment; bytes: Buffer } | null> {
  const { db, owner, id, operation, storage } = options
  operation.assertCurrent()
  if (!UUID_V4.test(id)) return null
  let row = db.prepare(`SELECT a.* FROM diary_day_attachments a
    JOIN diary_days d ON d.owner_user_id = a.owner_user_id AND d.date = a.day_date
    WHERE a.owner_user_id = ? AND a.id = ? AND a.status = 'attached'`)
    .get(owner, id) as AttachmentRow | undefined
  let eventRow: (AttachmentRow & { event_id: string }) | undefined
  if (!row) {
    eventRow = db.prepare(`SELECT * FROM diary_event_attachments
      WHERE owner_user_id = ? AND id = ? AND status = 'attached' AND event_id IS NOT NULL`)
      .get(owner, id) as (AttachmentRow & { event_id: string }) | undefined
    if (!eventRow) return null
  }
  await cleanupDiaryAttachmentStorage(db, storage, owner)
  row = db.prepare(`SELECT a.* FROM diary_day_attachments a
    JOIN diary_days d ON d.owner_user_id = a.owner_user_id AND d.date = a.day_date
    WHERE a.owner_user_id = ? AND a.id = ? AND a.status = 'attached'`)
    .get(owner, id) as AttachmentRow | undefined
  if (row) eventRow = undefined
  else eventRow = db.prepare(`SELECT * FROM diary_event_attachments
      WHERE owner_user_id = ? AND id = ? AND status = 'attached' AND event_id IS NOT NULL`)
      .get(owner, id) as (AttachmentRow & { event_id: string }) | undefined
  if (!row && !eventRow) return null
  const metadata = row ? metadataFromRow(row, owner, operation) : (() => {
    const current = eventRow!
    const raw = operation.attachments!.decryptMetadata(current.encrypted_metadata, { owner, date: eventScope(current.event_id), id: current.id })
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Diary event attachment metadata')
    const value = raw as Record<string, unknown>
    if (typeof value.name !== 'string' || !isDiaryAttachmentMimeType(value.mimeType)
      || !Number.isSafeInteger(value.size) || (value.size as number) < 1 || (value.size as number) > MAX_DIARY_ATTACHMENT_BYTES) throw new Error('Invalid Diary event attachment metadata')
    return { id: current.id, eventId: current.event_id, name: value.name, mimeType: value.mimeType,
      size: value.size as number, createdAt: current.created_at, order: current.display_order }
  })()
  const encrypted = await storage.read(id)
  let bytes: Buffer
  const contextDate = row ? row.day_date! : eventScope(eventRow!.event_id)
  try { bytes = operation.attachments!.decryptFile(encrypted, { owner, date: contextDate, id }) } finally { encrypted.fill(0) }
  try {
    operation.assertCurrent()
    if (bytes.byteLength !== metadata.size) throw new Error('Invalid Diary attachment size')
  } catch (error) {
    bytes.fill(0)
    throw error
  }
  return { metadata, bytes }
}
