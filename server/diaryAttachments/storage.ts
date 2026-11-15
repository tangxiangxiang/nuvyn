import { constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { MAX_DIARY_ATTACHMENT_BYTES } from '../../shared/diaryAttachments.js'
import { getDataDir } from '../db.js'
import { captureDurableFile, removeCreatedDurableFile, writeCreateOnlyDurableFile } from '../durableCreateOnlyFile.js'

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const HEADER_BYTES = 29
let rootOverride: string | null = null
const readyByDatabase = new WeakMap<Database, Promise<void>>()
const orphanScanRequired = new WeakSet<Database>()
let storageQueue = Promise.resolve()

export function markDiaryAttachmentOrphanScan(db: Database): void {
  orphanScanRequired.add(db)
}

export async function withDiaryAttachmentStorageLock<T>(run: () => Promise<T>): Promise<T> {
  const prior = storageQueue
  let release!: () => void
  storageQueue = new Promise<void>(resolve => { release = resolve })
  await prior
  try { return await run() } finally { release() }
}

export function __setDiaryAttachmentRootForTesting(root: string | null): void {
  rootOverride = root ? path.resolve(root) : null
}

export class DiaryAttachmentStorage {
  readonly directory: string

  constructor(directory = rootOverride ?? path.join(getDataDir(), 'diary-attachments')) {
    this.directory = path.resolve(directory)
  }

  async ensureDirectory(): Promise<void> {
    const parent = path.dirname(this.directory)
    const parentStat = await fs.lstat(parent)
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('Diary attachment data directory is unavailable')
    try { await fs.mkdir(this.directory, { mode: 0o700 }) } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
    }
    const stat = await fs.lstat(this.directory)
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('Diary attachment storage is unavailable')
  }

  pathFor(id: string): string {
    if (!UUID_V4.test(id)) throw new Error('Invalid Diary attachment ID')
    const file = path.resolve(this.directory, id)
    if (file !== path.join(this.directory, id)) throw new Error('Invalid Diary attachment ID')
    return file
  }

  async write(id: string, ciphertext: Uint8Array): Promise<void> {
    await this.ensureDirectory()
    await writeCreateOnlyDurableFile(this.pathFor(id), ciphertext, { mode: 0o600 })
  }

  async read(id: string): Promise<Buffer> {
    await this.ensureDirectory()
    const file = this.pathFor(id)
    const before = await fs.lstat(file, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o077n) !== 0n || before.size > BigInt(MAX_DIARY_ATTACHMENT_BYTES + HEADER_BYTES)) {
      throw new Error('Diary attachment is unavailable')
    }
    const noFollow = constants.O_NOFOLLOW ?? 0
    const handle = await fs.open(file, constants.O_RDONLY | noFollow)
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || (opened.mode & 0o077n) !== 0n || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
        throw new Error('Diary attachment changed while opening')
      }
      const ciphertext = await handle.readFile()
      const after = await fs.lstat(file, { bigint: true })
      if (after.isSymbolicLink() || (after.mode & 0o077n) !== 0n || after.dev !== before.dev || after.ino !== before.ino || ciphertext.byteLength !== Number(before.size)) {
        ciphertext.fill(0)
        throw new Error('Diary attachment changed while reading')
      }
      return ciphertext
    } finally {
      await handle.close()
    }
  }

  async remove(id: string): Promise<void> {
    await this.ensureDirectory()
    const owned = await captureDurableFile(this.pathFor(id))
    if (owned) await removeCreatedDurableFile(owned)
  }

  async list(): Promise<string[]> {
    await this.ensureDirectory()
    return await fs.readdir(this.directory)
  }
}

async function cleanupDeleting(db: Database, storage: DiaryAttachmentStorage, owner?: number): Promise<void> {
  const rows = (owner === undefined
    ? db.prepare("SELECT id FROM diary_day_attachments WHERE status = 'deleting'").all()
    : db.prepare("SELECT id FROM diary_day_attachments WHERE owner_user_id = ? AND status = 'deleting'").all(owner)) as Array<{ id: string }>
  for (const row of rows) {
    try {
      await storage.remove(row.id)
      if (owner === undefined) db.prepare("DELETE FROM diary_day_attachments WHERE id = ? AND status = 'deleting'").run(row.id)
      else db.prepare("DELETE FROM diary_day_attachments WHERE owner_user_id = ? AND id = ? AND status = 'deleting'").run(owner, row.id)
    } catch {
      // Keep this row as a retryable tombstone and continue cleaning other
      // records. A single filesystem failure must not block valid attachments.
    }
  }
}

async function recover(db: Database, storage: DiaryAttachmentStorage): Promise<void> {
  await storage.ensureDirectory()
  db.prepare("UPDATE diary_day_attachments SET status = 'deleting', expires_at = NULL, stage_session_id = NULL WHERE status = 'staged' AND expires_at <= ?").run(Date.now())
  await cleanupDeleting(db, storage)

  // A crash after the durable file write but before its SQLite insert leaves
  // an encrypted orphan. Reconcile only strict UUID regular files; never
  // follow or unlink symlinks found in this private directory.
  if (!await cleanupOrphans(db, storage)) markDiaryAttachmentOrphanScan(db)
}

export async function ensureDiaryAttachmentStorage(db: Database, storage = new DiaryAttachmentStorage()): Promise<void> {
  let pending = readyByDatabase.get(db)
  if (!pending) {
    pending = recover(db, storage).catch(error => {
      readyByDatabase.delete(db)
      throw error
    })
    readyByDatabase.set(db, pending)
  }
  await pending
}

/** Retry tombstoned and expired staged-file cleanup on attachment requests. */
export async function cleanupDiaryAttachmentStorage(db: Database, storage = new DiaryAttachmentStorage(), owner?: number): Promise<void> {
  const now = Date.now()
  const needsCleanup = owner === undefined
    ? db.prepare(`SELECT 1 AS found FROM diary_day_attachments
      WHERE status = 'deleting' OR (status = 'staged' AND expires_at <= ?) LIMIT 1`).get(now)
    : db.prepare(`SELECT 1 AS found FROM diary_day_attachments WHERE owner_user_id = ?
      AND (status = 'deleting' OR (status = 'staged' AND expires_at <= ?)) LIMIT 1`).get(owner, now)
  if (!needsCleanup && !orphanScanRequired.has(db)) return
  await ensureDiaryAttachmentStorage(db, storage)
  await withDiaryAttachmentStorageLock(async () => {
    if (owner === undefined) db.prepare("UPDATE diary_day_attachments SET status = 'deleting', expires_at = NULL, stage_session_id = NULL WHERE status = 'staged' AND expires_at <= ?").run(now)
    else db.prepare("UPDATE diary_day_attachments SET status = 'deleting', expires_at = NULL, stage_session_id = NULL WHERE owner_user_id = ? AND status = 'staged' AND expires_at <= ?").run(owner, now)
    await cleanupDeleting(db, storage, owner)
    if ((needsCleanup || orphanScanRequired.has(db)) && await cleanupOrphans(db, storage)) orphanScanRequired.delete(db)
  })
}

async function cleanupOrphans(db: Database, storage: DiaryAttachmentStorage): Promise<boolean> {
  let complete = true
  const known = new Set((db.prepare('SELECT id FROM diary_day_attachments').all() as Array<{ id: string }>).map(row => row.id))
  for (const name of await storage.list()) {
    if (!UUID_V4.test(name) || known.has(name)) continue
    let stat
    try { stat = await fs.lstat(storage.pathFor(name), { bigint: true }) } catch (error: any) {
      if (error?.code === 'ENOENT') continue
      complete = false
      continue
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue
    try {
      const owned = await captureDurableFile(storage.pathFor(name))
      if (owned) await removeCreatedDurableFile(owned)
    } catch {
      complete = false
    }
  }
  return complete
}

export async function reconcileDiaryAttachmentOrphans(db: Database, storage = new DiaryAttachmentStorage()): Promise<void> {
  await ensureDiaryAttachmentStorage(db, storage)
  await withDiaryAttachmentStorageLock(async () => {
    if (await cleanupOrphans(db, storage)) orphanScanRequired.delete(db)
    else orphanScanRequired.add(db)
  })
}

export async function cleanupDiaryAttachmentId(
  db: Database,
  storage: DiaryAttachmentStorage,
  owner: number,
  id: string,
): Promise<void> {
  await ensureDiaryAttachmentStorage(db, storage)
  await withDiaryAttachmentStorageLock(async () => {
    await storage.remove(id)
    db.prepare("DELETE FROM diary_day_attachments WHERE owner_user_id = ? AND id = ? AND status = 'deleting'").run(owner, id)
  })
}
