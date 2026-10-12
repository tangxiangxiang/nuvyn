import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database as DatabaseT } from 'better-sqlite3'
import MarkdownIt from 'markdown-it'
import matter from 'gray-matter'
import type {
  AttachmentCleanupPreview,
  AttachmentReference,
  AttachmentReferenceCoverage,
  AttachmentReferenceIndexStatus,
  AttachmentReferencePage,
  AttachmentReferenceRelation,
  AttachmentResourceKey,
  ManagedAttachment,
} from '../../shared/attachmentProtocol.js'
import { isManagedDiaryPath } from '../../shared/diaryProtocol.js'
import { findMarkdownInlineSourceOwnership } from '../../src/lib/markdownInlineSource.js'
import { parseBoardReference } from '../../src/lib/boardReferences.js'
import {
  expandMarkdownResources,
  isAllowedResourcePath,
  resolveLogicalResourceReference,
  type MarkdownResourceResolver,
} from '../../src/lib/markdownResources.js'
import {
  CONTENT_DIR,
  readSafeRelativeFile,
  resolveSafeRelativePathDetailed,
  verifySafePathResolution,
} from '../paths.js'
import { onAttachmentReferencesChanged } from '../attachmentReferenceEvents.js'
import { ApiRequestError } from '../apiErrors.js'

export const MAX_REFERENCE_SCAN_NOTES = 20_000
export const MAX_REFERENCE_SCAN_DIRECTORIES = 5_000
export const MAX_REFERENCE_SCAN_ENTRIES = 100_000
export const MAX_REFERENCE_SCAN_DOCUMENT_BYTES = 2 * 1024 * 1024
export const MAX_REFERENCE_SCAN_TOTAL_BYTES = 128 * 1024 * 1024
export const MAX_REFERENCE_SCAN_EXPANDED_BYTES = 128 * 1024 * 1024
export const MAX_REFERENCE_SCAN_DURATION_MS = 30_000
export const MAX_REFERENCE_COUNT = 100_000
export const REFERENCE_SCAN_CONCURRENCY = 4

interface NoteFingerprint {
  dev: number
  ino: number
  mtimeMs: number
  size: number
}

interface NoteReferenceSnapshot {
  referencesByResource: Map<string, AttachmentReference[]>
  boardEmbedsByBoard: Map<string, AttachmentReference[]>
  titles: Map<string, string>
  fingerprints: Map<string, NoteFingerprint>
  noteCount: number
  coverage: 'complete' | 'partial' | 'unknown'
  refreshedAt: number
  snapshotId: string
}

interface DirectoryScanResult {
  paths: string[]
  complete: boolean
}

interface BoardMetadata {
  id: string
  title: string
}

interface BoardAssetReferenceRow {
  asset_id: string
  board_id: string
  title: string
  purpose: string
}

interface AttachmentReferenceProjection {
  referenceStatus: ManagedAttachment['referenceStatus']
  referenceCount: number
  ownerCount: number
}

interface BuildOptions {
  root?: () => string
  now?: () => number
  maxNotes?: number
  maxDirectories?: number
  maxEntries?: number
  maxDocumentBytes?: number
  maxTotalBytes?: number
  maxExpandedBytes?: number
  maxDurationMs?: number
  concurrency?: number
}

const EMPTY_COVERAGE: AttachmentReferenceCoverage = {
  currentNotes: 'unknown',
  boardReferences: 'unknown',
  historicalVersions: 'not-checked',
  unsavedDrafts: 'not-checked',
  protectedDiary: 'restricted',
  boardCheckpoints: 'not-checked',
  externalChanges: 'not-checked',
}

function stableResourceKey(key: AttachmentResourceKey): string {
  switch (key.kind) {
    case 'asset': return `asset:${key.id}`
    case 'vault-file': return `vault-file:${key.path}`
    case 'board-material': return `board-material:${key.id}`
  }
}

function notePathFromMarkdownSource(sourcePath: string | undefined): string | null {
  if (!sourcePath) return null
  const value = sourcePath.endsWith('.md') ? sourcePath.slice(0, -3) : sourcePath
  return value || null
}

function isProtectedDiaryPath(value: string): boolean {
  const logical = value.replace(/\.md$/iu, '')
  return logical.split('/')[0]?.toLowerCase() === 'diary' || isManagedDiaryPath(logical)
}

function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.')
    || name === '.git'
    || name === '.nuvyn'
    || name.endsWith('~')
    || /\.(?:tmp|temp|bak|swp|part|partial|download)$/iu.test(name)
}

async function discoverMarkdownPaths(
  root: string,
  signal: AbortSignal,
  options: Required<Pick<BuildOptions, 'maxNotes' | 'maxDirectories' | 'maxEntries' | 'maxDurationMs'>>,
): Promise<DirectoryScanResult> {
  const rootPath = path.resolve(root)
  const startedAt = Date.now()
  const queue: Array<{ relative: string; depth: number }> = [{ relative: '', depth: 0 }]
  const paths: string[] = []
  let directories = 0
  let entriesSeen = 0
  let complete = true
  const rootStat = await fs.lstat(rootPath).catch(() => null)
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { paths, complete: false }
  }

  while (queue.length > 0) {
    if (signal.aborted) throw new Error('operation aborted')
    if (
      directories >= options.maxDirectories
      || entriesSeen >= options.maxEntries
      || paths.length >= options.maxNotes
      || Date.now() - startedAt > options.maxDurationMs
    ) {
      complete = false
      break
    }
    const current = queue.shift()!
    directories += 1
    const absolute = current.relative
      ? path.join(rootPath, ...current.relative.split('/'))
      : rootPath
    const stat = await fs.lstat(absolute).catch(() => null)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      complete = false
      continue
    }
    try {
      const resolution = current.relative
        ? await resolveSafeRelativePathDetailed(rootPath, current.relative)
        : { absolute: rootPath, identities: [{ path: rootPath, dev: stat.dev, ino: stat.ino, isFinal: false }] }
      await verifySafePathResolution({
        ...resolution,
        identities: resolution.identities.map((identity) => ({ ...identity, isFinal: false })),
      })
    } catch {
      complete = false
      continue
    }

    let children: import('node:fs').Dirent[]
    try {
      children = await fs.readdir(absolute, { withFileTypes: true })
    } catch {
      complete = false
      continue
    }
    for (const child of children) {
      entriesSeen += 1
      if (entriesSeen > options.maxEntries) {
        complete = false
        break
      }
      const name = child.name.toString()
      const childRelative = current.relative ? `${current.relative}/${name}` : name
      if (isSkippedDirectory(name)) continue
      // The whole Diary namespace is outside Attachment Manager's body access.
      if (!current.relative && name.toLowerCase() === 'diary') continue
      if (child.isDirectory()) {
        queue.push({ relative: childRelative, depth: current.depth + 1 })
        continue
      }
      if (child.isFile() && name.toLowerCase().endsWith('.md')) {
        const notePath = childRelative.slice(0, -3)
        if (!isProtectedDiaryPath(notePath)) paths.push(notePath)
      }
    }
  }
  paths.sort((left, right) => left.localeCompare(right))
  return { paths, complete }
}

function getNoteTitle(notePath: string, raw: string): string {
  try {
    const parsed = matter(raw)
    const frontmatterTitle = parsed.data.title
    if (typeof frontmatterTitle === 'string' && frontmatterTitle.trim()) return frontmatterTitle.trim().slice(0, 300)
    const heading = /^#\s+(.+)$/mu.exec(parsed.content)?.[1]?.trim()
    if (heading) return heading.slice(0, 300)
  } catch {
    // A damaged frontmatter block falls back to the non-sensitive basename.
  }
  return notePath.split('/').at(-1) ?? notePath
}

function countOwners(references: readonly AttachmentReference[]): number {
  return new Set(references.map((reference) => `${reference.owner.kind}\0${reference.owner.id}`)).size
}

function coverageFor(
  currentNotes: AttachmentReferenceCoverage['currentNotes'],
  boardReferences: AttachmentReferenceCoverage['boardReferences'],
): AttachmentReferenceCoverage {
  return {
    ...EMPTY_COVERAGE,
    currentNotes,
    boardReferences,
  }
}

function sourceLineForImage(
  tokenMap: [number, number] | null,
  inlineContent: string,
  offset: number | undefined,
): number | null {
  if (!tokenMap || offset === undefined) return null
  const lineOffset = inlineContent.slice(0, offset).split('\n').length - 1
  return tokenMap[0] + lineOffset
}

class BoundedMarkdownResourceCache {
  private readonly values = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string>>()
  private bytes = 0
  private readonly maxBytes = 8 * 1024 * 1024
  private readonly maxEntries = 64

  async get(key: string, load: () => Promise<string>): Promise<string> {
    const cached = this.values.get(key)
    if (cached !== undefined) {
      this.values.delete(key)
      this.values.set(key, cached)
      return cached
    }
    let pending = this.pending.get(key)
    if (!pending) {
      pending = load()
      this.pending.set(key, pending)
    }
    try {
      const value = await pending
      const size = Buffer.byteLength(value, 'utf8')
      if (size <= 1024 * 1024) {
        while (this.values.size >= this.maxEntries || this.bytes + size > this.maxBytes) {
          const first = this.values.entries().next().value as [string, string] | undefined
          if (!first) break
          this.values.delete(first[0])
          this.bytes -= Buffer.byteLength(first[1], 'utf8')
        }
        if (this.bytes + size <= this.maxBytes) {
          this.values.set(key, value)
          this.bytes += size
        }
      }
      return value
    } finally {
      this.pending.delete(key)
    }
  }
}

export class AttachmentReferenceIndex {
  private snapshot: NoteReferenceSnapshot | null = null
  private activePromise: Promise<void> | null = null
  private activeController: AbortController | null = null
  private generation = 0
  private lastRefreshFailed = false
  private readonly db: DatabaseT
  private readonly options: Required<BuildOptions>
  private readonly markdown: MarkdownIt

  constructor(db: DatabaseT, options: BuildOptions = {}) {
    this.db = db
    this.options = {
      root: options.root ?? (() => CONTENT_DIR),
      now: options.now ?? Date.now,
      maxNotes: options.maxNotes ?? MAX_REFERENCE_SCAN_NOTES,
      maxDirectories: options.maxDirectories ?? MAX_REFERENCE_SCAN_DIRECTORIES,
      maxEntries: options.maxEntries ?? MAX_REFERENCE_SCAN_ENTRIES,
      maxDocumentBytes: options.maxDocumentBytes ?? MAX_REFERENCE_SCAN_DOCUMENT_BYTES,
      maxTotalBytes: options.maxTotalBytes ?? MAX_REFERENCE_SCAN_TOTAL_BYTES,
      maxExpandedBytes: options.maxExpandedBytes ?? MAX_REFERENCE_SCAN_EXPANDED_BYTES,
      maxDurationMs: options.maxDurationMs ?? MAX_REFERENCE_SCAN_DURATION_MS,
      concurrency: Math.max(1, Math.min(options.concurrency ?? REFERENCE_SCAN_CONCURRENCY, 8)),
    }
    this.markdown = new MarkdownIt({ html: true, linkify: true, typographer: true })
  }

  getStatus(): AttachmentReferenceIndexStatus {
    const snapshot = this.snapshot
    if (!snapshot) {
      return {
        state: this.activePromise ? 'building' : this.lastRefreshFailed ? 'failed' : 'pending',
        complete: null,
        noteCount: 0,
        refreshedAt: null,
        snapshotId: null,
        coverage: { ...EMPTY_COVERAGE },
      }
    }
    const boardHealthy = this.hasCompleteBoardReferences()
    const stale = this.isSnapshotStale()
    return {
      state: stale
        ? 'stale'
        : snapshot.coverage === 'unknown' ? 'failed' : snapshot.coverage === 'complete' && boardHealthy ? 'ready' : 'partial',
      complete: !stale && snapshot.coverage === 'complete' && boardHealthy,
      noteCount: snapshot.noteCount,
      refreshedAt: snapshot.refreshedAt,
      snapshotId: snapshot.snapshotId,
      coverage: stale
        ? coverageFor('unknown', 'unknown')
        : coverageFor(snapshot.coverage, boardHealthy ? 'complete' : 'unknown'),
    }
  }

  invalidate(): void {
    this.generation += 1
    this.activeController?.abort()
    this.activeController = null
    this.activePromise = null
    this.snapshot = null
    this.lastRefreshFailed = false
  }

  async ensureReady(): Promise<void> {
    while (!this.snapshot) {
      const active = this.activePromise ?? this.refresh()
      await active
    }
  }

  async hasResource(resource: AttachmentResourceKey): Promise<boolean> {
    try {
      if (resource.kind === 'asset') {
        return Boolean(this.db.prepare('SELECT 1 AS found FROM assets WHERE id = ?').get(resource.id))
      }
      if (resource.kind === 'board-material') {
        return Boolean(this.db.prepare('SELECT 1 AS found FROM board_materials WHERE id = ?').get(resource.id))
      }
      if (isProtectedDiaryPath(resource.path)) return false
      const resolved = await resolveSafeRelativePathDetailed(path.resolve(this.options.root()), resource.path)
      await verifySafePathResolution(resolved)
      const stat = await fs.lstat(resolved.absolute)
      return stat.isFile() && !stat.isSymbolicLink()
    } catch {
      return false
    }
  }

  refresh(supersede = false): Promise<void> {
    if (this.activePromise && !supersede) return this.activePromise
    if (this.activePromise && supersede) this.activeController?.abort()

    const generation = ++this.generation
    const controller = new AbortController()
    this.activeController = controller
    const promise = this.buildSnapshot(controller.signal).then((snapshot) => {
      if (generation === this.generation) {
        this.snapshot = snapshot
        this.lastRefreshFailed = false
      }
    }).catch(() => {
      if (generation !== this.generation || controller.signal.aborted) return
      this.lastRefreshFailed = true
      throw new ApiRequestError(
        'ATTACHMENT_REFERENCES_UNAVAILABLE',
        503,
        'Attachment reference scan failed.',
      )
    }).finally(() => {
      if (generation === this.generation) {
        this.activePromise = null
        this.activeController = null
      }
    })
    this.activePromise = promise
    return promise
  }

  async query(
    resource: AttachmentResourceKey,
    offset = 0,
    limit = 30,
  ): Promise<AttachmentReferencePage> {
    await this.ensureReady()
    const snapshot = this.requireSnapshot()
    const stale = this.isSnapshotStale()
    const boardQuery = resource.kind === 'asset'
      ? this.queryBoardAssetReferences(resource.id)
      : { references: [], complete: this.hasCompleteBoardReferences() }
    const coverage = stale
      ? coverageFor('unknown', 'unknown')
      : coverageFor(snapshot.coverage, boardQuery.complete ? 'complete' : 'partial')
    const references = this.referencesFor(snapshot, resource, boardQuery.references)
      .sort((left, right) => (
        (left.owner.title ?? left.owner.id).localeCompare(right.owner.title ?? right.owner.id)
        || left.owner.kind.localeCompare(right.owner.kind)
        || left.owner.id.localeCompare(right.owner.id)
        || left.kind.localeCompare(right.kind)
        || (left.sourcePath ?? '').localeCompare(right.sourcePath ?? '')
        || (left.line ?? 0) - (right.line ?? 0)
      ))
    const currentFinding = this.currentFinding(resource, references, coverage)
    const safeOffset = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 30
    const page = references.slice(safeOffset, safeOffset + safeLimit)
    return {
      resource,
      references: page,
      referenceCount: references.length,
      ownerCount: countOwners(references),
      offset: safeOffset,
      limit: safeLimit,
      nextOffset: safeOffset + page.length < references.length ? safeOffset + page.length : null,
      currentFinding,
      stale,
      coverage,
      snapshotId: snapshot.snapshotId,
      checkedAt: stale ? snapshot.refreshedAt : this.options.now(),
    }
  }

  async preview(resource: AttachmentResourceKey): Promise<AttachmentCleanupPreview> {
    const page = await this.query(resource, 0, 100)
    const riskReasons: AttachmentCleanupPreview['riskReasons'] = []
    if (page.referenceCount > 0) riskReasons.push('current-references-found')
    if (page.coverage.currentNotes !== 'complete' || page.coverage.boardReferences !== 'complete') {
      riskReasons.push('current-scan-incomplete')
    }
    riskReasons.push(
      'historical-versions-not-checked',
      'draft-recovery-not-checked',
      'unsaved-editor-state-not-observable',
      'protected-diary-restricted',
      'board-checkpoints-not-checked',
      'external-changes-not-checked',
    )
    if (resource.kind === 'board-material') riskReasons.push('board-material-usage-unknown')
    const riskLevel = page.currentFinding === 'in-use'
      ? 'known-use'
      : page.currentFinding === 'unknown'
        ? 'unverified'
        : 'review-required'
    return {
      resource,
      currentFinding: page.currentFinding,
      riskLevel,
      referenceCount: page.referenceCount,
      ownerCount: page.ownerCount,
      stale: page.stale,
      coverage: page.coverage,
      riskReasons,
      deletionAllowed: false,
      snapshotId: page.snapshotId,
      checkedAt: page.checkedAt,
    }
  }

  getCatalogProjection(): { get(resourceKey: string): AttachmentReferenceProjection | undefined } | null {
    const snapshot = this.snapshot
    if (!snapshot && !this.activePromise && !this.lastRefreshFailed) return null
    if (!snapshot || this.isSnapshotStale()) {
      return {
        get: () => ({ referenceStatus: 'unknown', referenceCount: 0, ownerCount: 0 }),
      }
    }
    const directBoardCounts = new Map<string, { references: number; owners: Set<string> }>()
    const embeddedBoardsByAsset = new Map<string, Set<string>>()
    let boardComplete = true
    try {
      const rows = this.db.prepare(`
        SELECT ar.asset_id, ar.owner_id
        FROM asset_references AS ar
        JOIN boards AS b ON b.id = ar.owner_id
        WHERE ar.owner_type = 'board'
          AND ar.purpose IN ('scene', 'thumbnail')
        GROUP BY ar.asset_id, ar.owner_id, ar.purpose
      `).all() as Array<{ asset_id: string; owner_id: string }>
      for (const row of rows) {
        const counts = directBoardCounts.get(row.asset_id) ?? { references: 0, owners: new Set<string>() }
        counts.references += 1
        counts.owners.add(row.owner_id)
        directBoardCounts.set(row.asset_id, counts)
      }
      const embeddedBoardIds = Array.from(snapshot.boardEmbedsByBoard.keys())
      for (let index = 0; index < embeddedBoardIds.length; index += 500) {
        const chunk = embeddedBoardIds.slice(index, index + 500)
        if (!chunk.length) continue
        const placeholders = chunk.map(() => '?').join(',')
        const embedRows = this.db.prepare(`
          SELECT ar.asset_id, ar.owner_id AS board_id
          FROM asset_references AS ar
          JOIN boards AS b ON b.id = ar.owner_id
          WHERE ar.owner_type = 'board'
            AND ar.purpose IN ('scene', 'thumbnail')
            AND ar.owner_id IN (${placeholders})
        `).all(...chunk) as Array<{ asset_id: string; board_id: string }>
        for (const row of embedRows) {
          const boards = embeddedBoardsByAsset.get(row.asset_id) ?? new Set<string>()
          boards.add(row.board_id)
          embeddedBoardsByAsset.set(row.asset_id, boards)
        }
      }
      const orphan = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM asset_references AS ar
        LEFT JOIN boards AS b ON b.id = ar.owner_id
        WHERE ar.owner_type = 'board'
          AND ar.purpose IN ('scene', 'thumbnail')
          AND b.id IS NULL
      `).get() as { count: number }
      boardComplete = Number(orphan.count) === 0
    } catch {
      boardComplete = false
    }

    const projection = new Map<string, AttachmentReferenceProjection>()
    const resourceKeys = new Set([
      ...snapshot.referencesByResource.keys(),
    ])
    const noteCounts = new Map<string, { references: number; owners: Set<string> }>()
    for (const [key, refs] of snapshot.referencesByResource) {
      noteCounts.set(key, {
        references: refs.length,
        owners: new Set(refs.map((reference) => `${reference.owner.kind}\0${reference.owner.id}`)),
      })
    }
    for (const assetId of directBoardCounts.keys()) resourceKeys.add(`asset:${assetId}`)
    for (const resourceKey of resourceKeys) {
      const noteCount = noteCounts.get(resourceKey)
      let referenceCount = noteCount?.references ?? 0
      const owners = new Set(noteCount?.owners ?? [])
      if (resourceKey.startsWith('asset:')) {
        const assetId = resourceKey.slice('asset:'.length)
        const boardCount = directBoardCounts.get(assetId)
        if (boardCount) {
          referenceCount += boardCount.references
          for (const ownerId of boardCount.owners) owners.add(`board\0${ownerId}`)
        }
        for (const boardId of embeddedBoardsByAsset.get(assetId) ?? []) {
          const noteEmbeds = snapshot.boardEmbedsByBoard.get(boardId) ?? []
          referenceCount += noteEmbeds.length
          for (const reference of noteEmbeds) owners.add(`note\0${reference.owner.id}`)
        }
      }
      const isMaterial = resourceKey.startsWith('board-material:')
      const boardReferencesRequired = resourceKey.startsWith('asset:')
      const referenced = referenceCount > 0
      const status: ManagedAttachment['referenceStatus'] = referenced
        ? 'referenced'
        : isMaterial || snapshot.coverage !== 'complete' || (boardReferencesRequired && !boardComplete)
          ? 'unknown'
          : 'unreferenced'
      projection.set(resourceKey, {
        referenceStatus: status,
        referenceCount,
        ownerCount: owners.size,
      })
    }
    return {
      get: (resourceKey) => {
        const known = projection.get(resourceKey)
        if (known) return known
        if (resourceKey.startsWith('board-material:')) {
          return { referenceStatus: 'unknown', referenceCount: 0, ownerCount: 0 }
        }
        const boardReferencesRequired = resourceKey.startsWith('asset:')
        const status: ManagedAttachment['referenceStatus'] = snapshot.coverage === 'complete' && (!boardReferencesRequired || boardComplete)
          ? 'unreferenced'
          : 'unknown'
        return { referenceStatus: status, referenceCount: 0, ownerCount: 0 }
      },
    }
  }

  private currentFinding(
    resource: AttachmentResourceKey,
    references: readonly AttachmentReference[],
    coverage: AttachmentReferenceCoverage,
  ): AttachmentReferencePage['currentFinding'] {
    if (this.isSnapshotStale()) return 'unknown'
    if (references.length > 0) return 'in-use'
    if (resource.kind === 'board-material') return 'unknown'
    if (coverage.currentNotes !== 'complete' || coverage.boardReferences !== 'complete') return 'unknown'
    return 'no-current-reference'
  }

  private isSnapshotStale(): boolean {
    return this.activePromise !== null || this.lastRefreshFailed
  }

  private referencesFor(
    snapshot: NoteReferenceSnapshot,
    resource: AttachmentResourceKey,
    boardReferences: AttachmentReference[],
  ): AttachmentReference[] {
    const key = stableResourceKey(resource)
    if (resource.kind === 'vault-file') return [...(snapshot.referencesByResource.get(key) ?? [])]
    if (resource.kind === 'board-material') return []
    const references = [...boardReferences, ...(snapshot.referencesByResource.get(key) ?? [])]
    const boardIds = new Set(boardReferences.map((reference) => reference.owner.id))
    for (const boardId of boardIds) {
      const board = boardReferences.find((reference) => reference.owner.id === boardId)?.owner
      if (!board) continue
      for (const embed of snapshot.boardEmbedsByBoard.get(boardId) ?? []) {
        const via = [
          ...(embed.via ?? []),
          { kind: 'board' as const, id: boardId, title: board.title },
        ]
        references.push({
          ...embed,
          kind: 'board-embed',
          relation: 'indirect',
          via,
          target: { kind: 'asset', id: resource.id },
          navigable: true,
        })
      }
    }
    return references
  }

  private queryBoardAssetReferences(assetId: string): { references: AttachmentReference[]; complete: boolean } {
    try {
      const rows = this.db.prepare(`
        SELECT ar.asset_id, ar.owner_id AS board_id, b.title, ar.purpose
        FROM asset_references AS ar
        JOIN boards AS b ON b.id = ar.owner_id
        WHERE ar.asset_id = @assetId
          AND ar.owner_type = 'board'
          AND ar.purpose IN ('scene', 'thumbnail')
        ORDER BY b.title COLLATE NOCASE, b.id, ar.purpose
      `).all({ assetId }) as BoardAssetReferenceRow[]
      const orphan = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM asset_references AS ar
        LEFT JOIN boards AS b ON b.id = ar.owner_id
        WHERE ar.asset_id = @assetId
          AND ar.owner_type = 'board'
          AND ar.purpose IN ('scene', 'thumbnail')
          AND b.id IS NULL
      `).get({ assetId }) as { count: number }
      return {
        references: rows.map((row) => ({
          owner: { kind: 'board', id: row.board_id, title: row.title },
          kind: row.purpose === 'thumbnail' ? 'board-thumbnail' : 'board-scene',
          relation: 'direct',
          target: { kind: 'asset', id: row.asset_id },
          navigable: true,
        })),
        complete: Number(orphan.count) === 0,
      }
    } catch {
      return { references: [], complete: false }
    }
  }

  private hasCompleteBoardReferences(): boolean {
    try {
      const result = this.db.prepare(`
        SELECT SUM(CASE WHEN b.id IS NULL THEN 1 ELSE 0 END) AS orphaned
        FROM asset_references AS ar
        LEFT JOIN boards AS b ON b.id = ar.owner_id
        WHERE ar.owner_type = 'board'
          AND ar.purpose IN ('scene', 'thumbnail')
      `).get() as { orphaned: number | null }
      return Number(result.orphaned ?? 0) === 0
    } catch {
      return false
    }
  }

  private async buildSnapshot(signal: AbortSignal): Promise<NoteReferenceSnapshot> {
    const root = path.resolve(this.options.root())
    const startedAt = Date.now()
    const scan = await discoverMarkdownPaths(root, signal, {
      maxNotes: this.options.maxNotes,
      maxDirectories: this.options.maxDirectories,
      maxEntries: this.options.maxEntries,
      maxDurationMs: this.options.maxDurationMs,
    })
    let complete = scan.complete
    let stopped = false
    let totalBytes = 0
    let expandedBytes = 0
    let indexedReferences = 0
    let scannedNotes = 0
    const referencesByResource = new Map<string, AttachmentReference[]>()
    const boardEmbedsByBoard = new Map<string, AttachmentReference[]>()
    const titles = new Map<string, string>()
    const fingerprints = new Map<string, NoteFingerprint>()
    let boards = new Map<string, string>()
    let boardMetadataComplete = true
    try {
      const boardRows = this.db.prepare('SELECT id, title FROM boards').all() as BoardMetadata[]
      boards = new Map(boardRows.map((board) => [board.id, board.title]))
    } catch {
      boardMetadataComplete = false
      complete = false
    }
    const resourceCache = new BoundedMarkdownResourceCache()
    const mdParser = this.markdown
    const parserHelpers = {
      ...mdParser.helpers,
      normalizeLink: mdParser.normalizeLink.bind(mdParser),
    }
    let nextPath = 0

    const markIncomplete = () => { complete = false }
    const reserveReference = (): boolean => {
      if (indexedReferences >= MAX_REFERENCE_COUNT) {
        complete = false
        stopped = true
        return false
      }
      indexedReferences += 1
      return true
    }
    const pushReference = (key: string, reference: AttachmentReference) => {
      if (!reserveReference()) return
      const references = referencesByResource.get(key) ?? []
      references.push(reference)
      referencesByResource.set(key, references)
    }

    const resourceResolver: MarkdownResourceResolver = {
      async read(request) {
        if (isProtectedDiaryPath(request.path)) throw new Error('protected resource')
        const cacheKey = `${request.kind}:${request.path}`
        const content = await resourceCache.get(cacheKey, async () => {
          const result = await readSafeRelativeFile(root, request.path, 'utf8', {
            maxBytes: request.kind === 'include' ? 512 * 1024 : 256 * 1024,
            signal: request.signal ?? signal,
          })
          if (typeof result !== 'string') throw new Error('resource unavailable')
          return result
        })
        if (request.kind === 'include') titles.set(request.path.replace(/\.md$/iu, ''), getNoteTitle(request.path.replace(/\.md$/iu, ''), content))
        return { kind: request.kind, path: request.path, content }
      },
    }

    const scanOne = async (notePath: string): Promise<void> => {
      if (signal.aborted) throw new Error('operation aborted')
      if (stopped || Date.now() - startedAt > this.options.maxDurationMs) {
        complete = false
        stopped = true
        return
      }
      const relative = `${notePath}.md`
      const absolute = path.join(root, ...relative.split('/'))
      let before: Awaited<ReturnType<typeof fs.lstat>>
      try {
        before = await fs.lstat(absolute)
      } catch {
        markIncomplete()
        return
      }
      if (!before.isFile() || before.isSymbolicLink()) {
        markIncomplete()
        return
      }
      let value: string | Buffer | null
      try {
        value = await readSafeRelativeFile(root, relative, 'utf8', {
          maxBytes: this.options.maxDocumentBytes,
          signal,
        })
      } catch {
        markIncomplete()
        return
      }
      if (value === null) {
        markIncomplete()
        return
      }
      const raw = typeof value === 'string' ? value : value.toString('utf8')
      const bytes = Buffer.byteLength(raw, 'utf8')
      totalBytes += bytes
      if (totalBytes > this.options.maxTotalBytes) {
        markIncomplete()
        stopped = true
        return
      }
      let after: Awaited<ReturnType<typeof fs.lstat>>
      try {
        after = await fs.lstat(absolute)
      } catch {
        markIncomplete()
        return
      }
      if (
        after.isSymbolicLink()
        || !after.isFile()
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
      ) {
        markIncomplete()
        return
      }
      const fingerprint = { dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, size: after.size }
      const title = getNoteTitle(notePath, raw)
      titles.set(notePath, title)
      fingerprints.set(notePath, fingerprint)
      scannedNotes += 1

      // Avoid an extra MarkdownIt expansion pass for ordinary notes. Every
      // supported image or resource directive necessarily contains one of
      // these marker characters, so this is only a safe negative fast path.
      if (!raw.includes('!') && !raw.includes('<<<') && !raw.includes('<!--@include:')) return

      let frontmatterLineOffset = 0
      let markdownBody = raw
      try {
        const parsed = matter(raw)
        markdownBody = parsed.content
        if (markdownBody) {
          const contentOffset = raw.indexOf(markdownBody)
          if (contentOffset >= 0) frontmatterLineOffset = raw.slice(0, contentOffset).split('\n').length - 1
        }
      } catch {
        markIncomplete()
      }

      const owner = { kind: 'note' as const, id: notePath, title }
      try {
        const expanded = await expandMarkdownResources(markdownBody, {
          md: mdParser,
          sourcePath: `${notePath}.md`,
          resourceResolver,
          signal,
          onResourceReference: (event) => {
            if (event.kind !== 'snippet' || isProtectedDiaryPath(event.resourcePath)) return
            const sourceNotePath = notePathFromMarkdownSource(event.sourcePath)
            if (sourceNotePath && isProtectedDiaryPath(sourceNotePath)) {
              markIncomplete()
              return
            }
            // The expansion event already contains the canonical resolved
            // path. Resolving it a second time would prepend the source folder.
            const resourcePath = event.resourcePath
            if (!resourcePath || !isAllowedResourcePath('snippet', resourcePath)) {
              markIncomplete()
              return
            }
            const sourcePath = sourceNotePath ?? notePath
            const includeChain = event.includeChain.map((includePath) => includePath.replace(/\.md$/iu, ''))
            const relation: AttachmentReferenceRelation = includeChain.length > 0 ? 'indirect' : 'direct'
            const reference: AttachmentReference = {
              owner,
              kind: 'note-snippet',
              relation,
              sourcePath,
              ...(includeChain.length === 0
                ? { line: sourcePath === notePath ? event.line + frontmatterLineOffset : event.line }
                : {}),
              ...(includeChain.length > 0 ? {
                via: includeChain.map((id) => ({ kind: 'include' as const, id, title: titles.get(id) ?? null })),
              } : {}),
              target: { kind: 'vault-file', id: resourcePath },
              navigable: true,
            }
            pushReference(stableResourceKey({ kind: 'vault-file', path: resourcePath }), reference)
          },
          onError: () => markIncomplete(),
        })
        expandedBytes += Buffer.byteLength(expanded.markdown, 'utf8')
        if (expandedBytes > this.options.maxExpandedBytes) {
          markIncomplete()
          stopped = true
          return
        }
        const tokens = mdParser.parse(expanded.markdown, {})
        for (const token of tokens) {
          if (token.type !== 'inline' || !token.children || !token.map) continue
          const ownership = findMarkdownInlineSourceOwnership(token.content, token.children, parserHelpers)
          for (const [childIndex, child] of token.children.entries()) {
            if (child.type !== 'image') continue
            const range = ownership.childSourceRanges[childIndex]
            const relativeLine = sourceLineForImage(token.map, token.content, range?.start)
            if (relativeLine === null) {
              markIncomplete()
              continue
            }
            const expandedLine = relativeLine
            const actualSourcePath = expanded.sourcePathByLine[expandedLine]
            const actualSourceNote = notePathFromMarkdownSource(actualSourcePath)
            const sourcePath = actualSourceNote ?? notePath
            if (isProtectedDiaryPath(sourcePath)) {
              markIncomplete()
              continue
            }
            const originalLine = expanded.sourceLineByLine[expandedLine]
            const includeChain = (expanded.viaPathsByLine[expandedLine] ?? []).map((includePath) => includePath.replace(/\.md$/iu, ''))
            const relation: AttachmentReferenceRelation = includeChain.length > 0 ? 'indirect' : 'direct'
            const source = child.attrGet('src') ?? ''
            const boardId = parseBoardReference(source)
            if (boardId) {
              if (!boardMetadataComplete || !boards.has(boardId)) {
                markIncomplete()
                continue
              }
              const boardReference: AttachmentReference = {
                owner,
                kind: 'board-embed',
                relation,
                sourcePath,
                ...(includeChain.length === 0 && originalLine !== undefined
                  ? { line: sourcePath === notePath ? originalLine + frontmatterLineOffset : originalLine }
                  : {}),
                ...(includeChain.length > 0 ? {
                  via: includeChain.map((id) => ({ kind: 'include' as const, id, title: titles.get(id) ?? null })),
                } : {}),
                target: { kind: 'board', id: boardId },
                navigable: true,
              }
              if (!reserveReference()) return
              const embeds = boardEmbedsByBoard.get(boardId) ?? []
              embeds.push(boardReference)
              boardEmbedsByBoard.set(boardId, embeds)
              continue
            }

            const resolved = resolveLogicalResourceReference(actualSourcePath, source)
            if (!resolved || !isAllowedResourcePath('image', resolved) || isProtectedDiaryPath(resolved)) continue
            try {
              const resolution = await resolveSafeRelativePathDetailed(root, resolved)
              await verifySafePathResolution(resolution)
              const targetStat = await fs.lstat(resolution.absolute)
              if (!targetStat.isFile() || targetStat.isSymbolicLink()) continue
            } catch (error) {
              markIncomplete()
              continue
            }
            const imageReference: AttachmentReference = {
              owner,
              kind: 'note-image',
              relation,
              sourcePath,
              ...(includeChain.length === 0 && originalLine !== undefined
                ? { line: sourcePath === notePath ? originalLine + frontmatterLineOffset : originalLine }
                : {}),
              ...(includeChain.length > 0 ? {
                via: includeChain.map((id) => ({ kind: 'include' as const, id, title: titles.get(id) ?? null })),
              } : {}),
              target: { kind: 'vault-file', id: resolved },
              navigable: true,
            }
            pushReference(stableResourceKey({ kind: 'vault-file', path: resolved }), imageReference)
          }
        }
      } catch {
        markIncomplete()
      }
    }

    const worker = async () => {
      while (true) {
        if (signal.aborted) throw new Error('operation aborted')
        if (stopped) return
        const index = nextPath
        nextPath += 1
        const notePath = scan.paths[index]
        if (notePath === undefined) return
        await scanOne(notePath)
      }
    }
    await Promise.all(Array.from({ length: this.options.concurrency }, () => worker()))

    const checkedAt = this.options.now()
    const snapshot: NoteReferenceSnapshot = {
      referencesByResource,
      boardEmbedsByBoard,
      titles,
      fingerprints,
      noteCount: scannedNotes,
      coverage: complete ? 'complete' : 'partial',
      refreshedAt: checkedAt,
      snapshotId: `attachment-refs-${this.generation}-${checkedAt}`,
    }
    // The contents of notes and included Markdown are intentionally discarded;
    // only relation rows, names, and filesystem fingerprints survive a scan.
    return snapshot
  }

  private requireSnapshot(): NoteReferenceSnapshot {
    if (!this.snapshot) throw new Error('Attachment reference index is not ready')
    return this.snapshot
  }
}

let defaultIndex: { db: DatabaseT; root: string; index: AttachmentReferenceIndex } | null = null
let indexOverride: AttachmentReferenceIndex | null = null

export function getAttachmentReferenceIndex(db: DatabaseT, root = CONTENT_DIR): AttachmentReferenceIndex {
  if (indexOverride) return indexOverride
  if (!defaultIndex || defaultIndex.db !== db || defaultIndex.root !== root) {
    const index = new AttachmentReferenceIndex(db, { root: () => root })
    defaultIndex = { db, root, index }
  }
  return defaultIndex.index
}

export function __setAttachmentReferenceIndexForTesting(index: AttachmentReferenceIndex | null): void {
  indexOverride = index
  if (index === null) defaultIndex = null
}

onAttachmentReferencesChanged(() => {
  defaultIndex?.index.invalidate()
  indexOverride?.invalidate()
})

export function attachmentResourceStableKey(key: AttachmentResourceKey): string {
  return stableResourceKey(key)
}

export function isAttachmentResourceKey(value: unknown): value is AttachmentResourceKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'asset' || candidate.kind === 'board-material') {
    return typeof candidate.id === 'string' && candidate.id.length >= 1 && candidate.id.length <= 100
  }
  if (candidate.kind !== 'vault-file' || typeof candidate.path !== 'string') return false
  const valuePath = candidate.path
  return valuePath.length > 0
    && valuePath.length <= 1024
    && !valuePath.startsWith('/')
    && !valuePath.includes('\\')
    && !valuePath.includes('\0')
    && !valuePath.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))
}
