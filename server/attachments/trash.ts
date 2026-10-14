import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database as DatabaseT } from 'better-sqlite3'
import { NOTE_IMAGE_FORMATS, NOTE_IMAGE_UPLOAD_MAX_BYTES } from '../../shared/noteImageProtocol.js'
import { isAssetId } from '../../shared/assetProtocol.js'
import type { AttachmentCleanupPreview, AttachmentTrashItem, AttachmentTrashPage } from '../../shared/attachmentProtocol.js'
import { ApiRequestError } from '../apiErrors.js'
import { readSafeRelativeFile, resolveSafeRelativePathDetailed, verifySafePathResolution } from '../paths.js'
import { withVaultMutation } from '../vaultMutation.js'
import { recordAttachmentOperation, attachmentFailureCategory } from './audit.js'

export const ATTACHMENT_TRASH_DIRECTORY = '.nuvyn/attachment-trash'
const tokenSecret = randomBytes(32)
const TOKEN_LIFETIME_MS = 60_000

interface Identity {
  vault_key: string
  path: string
  resource_id: string
  mime_type: string
  byte_size: number
  sha256: string
  dev: string
  ino: string
  mtime: string
}
interface TrashRow extends Identity {
  id: string
  recycled_at: number
  restored_at: number | null
  state: 'recycling' | 'trashed' | 'restoring' | 'restored' | 'blocked'
}

function vaultKey(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex')
}

export function managedNoteImage(resourcePath: string): { id: string; mimeType: string } | null {
  const match = /^attachments\/images\/([a-f0-9-]+)(\.[a-z]+)$/u.exec(resourcePath)
  if (!match || !isAssetId(match[1]!)) return null
  const format = NOTE_IMAGE_FORMATS.find((item) => item.extension === match[2])
  return format ? { id: match[1]!, mimeType: format.mimeType } : null
}

function unavailable(): never {
  throw new ApiRequestError('ATTACHMENT_TRASH_CONFLICT', 409, 'Attachment identity or storage changed. Refresh and try again.')
}

async function inspect(root: string, relativePath: string): Promise<{ bytes: Buffer; dev: string; ino: string; mtime: string; sha256: string } | null> {
  let resolution
  try {
    resolution = await resolveSafeRelativePathDetailed(root, relativePath, { allowMissingFinal: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const bytes = await readSafeRelativeFile(root, relativePath, undefined, { maxBytes: NOTE_IMAGE_UPLOAD_MAX_BYTES })
  if (bytes === null) return null
  if (!Buffer.isBuffer(bytes)) unavailable()
  const stat = await fs.lstat(resolution.absolute, { bigint: true })
  await verifySafePathResolution(resolution)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== BigInt(bytes.length)) unavailable()
  return { bytes, dev: String(stat.dev), ino: String(stat.ino), mtime: String(stat.mtimeNs), sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function verify(root: string, relativePath: string, row: Identity): Promise<Buffer | null> {
  const observed = await inspect(root, relativePath)
  if (!observed) return null
  if (observed.dev !== row.dev || observed.ino !== row.ino || observed.mtime !== row.mtime
    || observed.bytes.length !== row.byte_size || observed.sha256 !== row.sha256) unavailable()
  return observed.bytes
}

/** Called only after the existing authenticated upload has validated and durably created bytes. */
export async function registerNoteImage(db: DatabaseT, root: string, resourcePath: string): Promise<void> {
  const resource = managedNoteImage(resourcePath)
  if (!resource) unavailable()
  const observed = await inspect(root, resourcePath)
  if (!observed) unavailable()
  db.prepare(`INSERT INTO note_image_identity (vault_key, path, resource_id, mime_type, byte_size, sha256, dev, ino, mtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(vaultKey(root), resourcePath, resource.id, resource.mimeType,
    observed.bytes.length, observed.sha256, observed.dev, observed.ino, observed.mtime)
}

async function syncDirectory(root: string, relativePath: string): Promise<void> {
  const resolution = await resolveSafeRelativePathDetailed(root, relativePath)
  const handle = await fs.open(resolution.absolute, 'r')
  try {
    await handle.sync()
    await verifySafePathResolution({ ...resolution, identities: resolution.identities.map((item) => ({ ...item, isFinal: false })) })
  } finally { await handle.close() }
}

async function ensureTrash(root: string): Promise<void> {
  for (const relative of ['.nuvyn', ATTACHMENT_TRASH_DIRECTORY]) {
    // Check parents before mkdir so a replaced .nuvyn cannot redirect creation.
    if (relative.includes('/')) await syncDirectory(root, '.nuvyn')
    else {
      const stat = await fs.lstat(root)
      if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable()
    }
    await fs.mkdir(path.join(root, relative), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    await syncDirectory(root, relative)
  }
  const [source, target] = await Promise.all([fs.lstat(path.join(root, 'attachments/images')), fs.lstat(path.join(root, ATTACHMENT_TRASH_DIRECTORY))])
  if (source.dev !== target.dev) unavailable()
  await syncDirectory(root, 'attachments/images')
  await syncDirectory(root, '.nuvyn')
}

function trashPath(row: TrashRow): string {
  if (!isAssetId(row.id) || !managedNoteImage(row.path)) unavailable()
  return `${ATTACHMENT_TRASH_DIRECTORY}/${row.id}${path.posix.extname(row.path)}`
}

function publicRow(row: TrashRow): AttachmentTrashItem {
  if (row.state === 'restored') unavailable()
  return { id: row.id, path: row.path, resourceId: row.resource_id, mimeType: row.mime_type,
    byteSize: row.byte_size, sha256: row.sha256, recycledAt: row.recycled_at, state: row.state }
}

export class AttachmentTrash {
  readonly db: DatabaseT
  readonly root: string

  constructor(db: DatabaseT, root: string) { this.db = db; this.root = root }

  private async durable<T>(operation: () => Promise<T>): Promise<T> {
    const previous = Number(this.db.pragma('synchronous', { simple: true }))
    if (previous < 2) this.db.pragma('synchronous = FULL')
    try {
      if (Number(this.db.pragma('synchronous', { simple: true })) < 2) unavailable()
      return await operation()
    } finally {
      if (previous < 2) this.db.pragma(`synchronous = ${previous}`)
    }
  }

  private identity(resourcePath: string): Identity | undefined {
    return this.db.prepare('SELECT * FROM note_image_identity WHERE vault_key = ? AND path = ?').get(vaultKey(this.root), resourcePath) as Identity | undefined
  }

  private row(id: string): TrashRow {
    if (!isAssetId(id)) unavailable()
    const row = this.db.prepare('SELECT * FROM attachment_trash WHERE vault_key = ? AND id = ?').get(vaultKey(this.root), id) as TrashRow | undefined
    if (!row) throw new ApiRequestError('ATTACHMENT_TRASH_NOT_FOUND', 404, 'Recycled attachment is unavailable.')
    return row
  }

  private audit(row: Identity, operation: 'attachment-quarantine' | 'attachment-restore', error?: unknown): void {
    try {
      recordAttachmentOperation(this.db, { operation, resourceType: 'vault-image', resourceId: row.resource_id,
        sourceWorkspace: 'vault-image', sourceResourceId: row.path, targetWorkspace: 'note-library',
        result: error ? 'failure' : 'success', failureCategory: error ? attachmentFailureCategory(error) : null })
    } catch { /* Durable lifecycle records never depend on bounded audit availability. */ }
  }

  async preview(preview: AttachmentCleanupPreview, sessionId: number, catalogComplete: boolean): Promise<AttachmentCleanupPreview> {
    const result = { ...preview, quarantineAllowed: false }
    if (preview.resource.kind !== 'vault-file' || !managedNoteImage(preview.resource.path)) return { ...result, quarantineReason: 'unsupported' }
    if (!catalogComplete || preview.stale || preview.currentFinding !== 'no-current-reference'
      || preview.coverage.currentNotes !== 'complete' || preview.coverage.boardReferences !== 'complete' || !preview.snapshotId) {
      return { ...result, quarantineReason: 'index-unverified' }
    }
    const row = this.identity(preview.resource.path)
    if (!row) return { ...result, quarantineReason: 'identity-unverified' }
    try {
      if (!await verify(this.root, row.path, row)) unavailable()
      await ensureTrash(this.root)
      const existing = this.db.prepare("SELECT id FROM attachment_trash WHERE vault_key = ? AND path = ? AND state != 'restored'").get(vaultKey(this.root), row.path)
      if (existing) unavailable()
      const payload = Buffer.from(JSON.stringify({ sessionId, snapshot: preview.snapshotId, row, expires: Date.now() + TOKEN_LIFETIME_MS })).toString('base64url')
      const signature = createHmac('sha256', tokenSecret).update(payload).digest('base64url')
      return { ...result, quarantineAllowed: true, quarantineToken: `${payload}.${signature}` }
    } catch { return { ...result, quarantineReason: 'storage-unavailable' } }
  }

  async quarantine(token: string, sessionId: number, validate: (snapshot: string, resourcePath: string) => Promise<void>): Promise<AttachmentTrashItem> {
    if (typeof token !== 'string' || token.length > 4096) unavailable()
    const parts = token.split('.')
    if (parts.length !== 2) unavailable()
    const [payload, signature] = parts
    if (!payload || !signature) unavailable()
    const expected = createHmac('sha256', tokenSecret).update(payload).digest()
    const supplied = Buffer.from(signature, 'base64url')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) unavailable()
    let parsed: { sessionId: number; snapshot: string; row: Identity; expires: number }
    try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) } catch { unavailable() }
    if (parsed.sessionId !== sessionId || parsed.expires < Date.now() || parsed.row.vault_key !== vaultKey(this.root)) unavailable()
    return withVaultMutation(this.root, () => this.durable(async () => {
      const identity = this.identity(parsed.row.path)
      if (!identity || JSON.stringify(identity) !== JSON.stringify(parsed.row)) unavailable()
      try {
        await this.reconcile()
        await validate(parsed.snapshot, identity.path)
        if (!await verify(this.root, identity.path, identity)) unavailable()
        await ensureTrash(this.root)
        const row: TrashRow = { ...identity, id: randomUUID(), recycled_at: Date.now(), restored_at: null, state: 'recycling' }
        this.db.prepare(`INSERT INTO attachment_trash (id, vault_key, path, resource_id, mime_type, byte_size, sha256, dev, ino, mtime, recycled_at, state)
          VALUES (@id, @vault_key, @path, @resource_id, @mime_type, @byte_size, @sha256, @dev, @ino, @mtime, @recycled_at, @state)`).run(row)
        await this.finish(row)
        this.audit(identity, 'attachment-quarantine')
        return publicRow(this.row(row.id))
      } catch (error) { this.audit(identity, 'attachment-quarantine', error); throw error }
    }))
  }

  async restore(id: string): Promise<void> {
    return withVaultMutation(this.root, () => this.durable(async () => {
      const row = this.row(id)
      if (row.state === 'restored') return
      try {
        await this.reconcile()
        const current = this.row(id)
        if (current.state === 'restored') return
        if (current.state !== 'trashed') unavailable()
        // Never adopt or overwrite an incumbent, even if its bytes match.
        if (await inspect(this.root, current.path)) unavailable()
        if (!await verify(this.root, trashPath(current), current)) unavailable()
        this.db.prepare("UPDATE attachment_trash SET state = 'restoring' WHERE id = ?").run(id)
        await this.finish({ ...current, state: 'restoring' })
        this.audit(current, 'attachment-restore')
      } catch (error) { this.audit(row, 'attachment-restore', error); throw error }
    }))
  }

  /** Hard-link publication is exclusive, same-filesystem, and preserves generation.
   * The journal is committed BEFORE linking/unlinking. Each restart can prove
   * both entries against the same inode/hash before finishing an interrupted move. */
  private async finish(row: TrashRow): Promise<void> {
    await ensureTrash(this.root)
    const recycling = row.state === 'recycling'
    const from = recycling ? row.path : trashPath(row)
    const to = recycling ? trashPath(row) : row.path
    const source = await verify(this.root, from, row)
    let target = await verify(this.root, to, row)
    if (!source && !target) unavailable()
    if (!target) {
      const [sourceResolution, targetResolution] = await Promise.all([
        resolveSafeRelativePathDetailed(this.root, from),
        resolveSafeRelativePathDetailed(this.root, to, { allowMissingFinal: true }),
      ])
      await verifySafePathResolution(sourceResolution)
      await verifySafePathResolution(targetResolution)
      await fs.link(sourceResolution.absolute, targetResolution.absolute)
      const handle = await fs.open(targetResolution.absolute, 'r')
      try { await handle.sync() } finally { await handle.close() }
      await syncDirectory(this.root, path.posix.dirname(to))
      target = await verify(this.root, to, row)
      if (!target) unavailable()
    }
    if (source) {
      // Repeat the proof immediately before unlink; an external replacement is
      // never removed. Portable filesystems still require the single-writer contract.
      if (!await verify(this.root, from, row) || !await verify(this.root, to, row)) unavailable()
      await fs.unlink(path.join(this.root, from))
      await syncDirectory(this.root, path.posix.dirname(from))
    }
    this.db.prepare('UPDATE attachment_trash SET state = ?, restored_at = ? WHERE id = ?')
      .run(recycling ? 'trashed' : 'restored', recycling ? null : Date.now(), row.id)
  }

  /** Caller holds the Vault mutation lock, including startup recovery. */
  async reconcile(): Promise<void> {
    return this.durable(async () => {
      const rows = this.db.prepare("SELECT * FROM attachment_trash WHERE vault_key = ? AND state IN ('recycling', 'restoring')").all(vaultKey(this.root)) as TrashRow[]
      for (const row of rows) {
        try {
          await this.finish(row)
          this.audit(row, row.state === 'recycling' ? 'attachment-quarantine' : 'attachment-restore')
        } catch (error) {
          this.audit(row, row.state === 'recycling' ? 'attachment-quarantine' : 'attachment-restore', error)
          // Keep the journal and binaries intact; retry on the next recovery.
        }
      }
    })
  }

  list(search = '', offset = 0, limit = 30): AttachmentTrashPage {
    const filter = "vault_key = ? AND state != 'restored'"
    const stats = this.db.prepare(`SELECT count(*) AS total, coalesce(sum(byte_size), 0) AS bytes FROM attachment_trash WHERE ${filter}`).get(vaultKey(this.root)) as { total: number; bytes: number }
    const pattern = `%${search.replace(/[\\%_]/gu, '\\$&')}%`
    const total = this.db.prepare(`SELECT count(*) AS total FROM attachment_trash WHERE ${filter} AND path LIKE ? ESCAPE '\\'`).get(vaultKey(this.root), pattern) as { total: number }
    const rows = this.db.prepare(`SELECT * FROM attachment_trash WHERE ${filter} AND path LIKE ? ESCAPE '\\' ORDER BY recycled_at DESC, id LIMIT ? OFFSET ?`).all(vaultKey(this.root), pattern, limit, offset) as TrashRow[]
    return { items: rows.map(publicRow), total: total.total, knownBytes: stats.bytes, offset, limit }
  }

  async read(resourcePath: string): Promise<Buffer | null> {
    if (!managedNoteImage(resourcePath)) return null
    const row = this.db.prepare("SELECT * FROM attachment_trash WHERE vault_key = ? AND path = ? AND state != 'restored'").get(vaultKey(this.root), resourcePath) as TrashRow | undefined
    if (!row) return null
    // During crash recovery both paths may exist, but only the recorded generation can be read.
    const source = await verify(this.root, row.path, row)
    return source ?? await verify(this.root, trashPath(row), row)
  }
}
