import { authFetch, diaryAuthFetch } from './auth-session'
import { authFetchForPath, authFetchForPaths } from './diary-request'
import type { DiaryDate } from '../../shared/diaryProtocol'
import type { DiaryMoodIconConfig, DiaryMoodId } from '../../shared/diaryMood'

export interface PostSummary {
  path: string            // e.g. "hello-world" or "notes/draft" or "archive/2024/old" — relative to src/content/, no implicit prefix
  title: string
  /** Database creation date (YYYY-MM-DD, UTC), with legacy Frontmatter fallback. */
  created: string
  /** Database update date formatted as YYYY-MM-DD, with file mtime fallback. */
  updated: string
  tags: string[]
  /** Only canonical managed Diary summaries expose this field. */
  mood?: string | null
  /** Current SQLite metadata version, when supplied by a bulk summary. */
  metadataUpdatedAt?: number
  documentId?: string
  summary?: string
  size: number
  mtime: number
  updatedReferences?: Array<{ path: string; raw: string; mtime: number }>
}

export interface DiaryDateCreateResult {
  date: DiaryDate
  path: string
  created: boolean
  post: PostSummary
}

export interface SavePostResult {
  ok: true
  raw: string
  post: PostSummary
}

export interface SavePostInput {
  raw: string
  baseRaw: string
}

export interface SavePostConflictPayload {
  error: string
  code: 'EDIT_CONFLICT'
  current: {
    raw: string
    mtime: number
    size: number
  }
}

export class SavePostConflictError extends Error {
  readonly code = 'EDIT_CONFLICT'
  readonly current: SavePostConflictPayload['current']

  constructor(current: SavePostConflictPayload['current']) {
    super('document changed on disk')
    this.name = 'SavePostConflictError'
    this.current = current
  }
}

export type TreeNode =
  | { kind: 'file';   name: string; path: string; title: string; mtime: number }
  | { kind: 'folder'; name: string; path: string; children: TreeNode[] }

export interface PostDetail {
  path: string
  raw: string
  /** Markdown body with the frontmatter block stripped. Used by the
   *  client-side full-text search (primeBody) and by the preview pane —
   *  the raw field is what gets written back on save. */
  content: string
  frontmatter: Record<string, unknown>
  metadata?: DocumentMetadata
  size: number
  mtime: number
}

export interface DocumentMetadata {
  id: string
  path: string
  title: string
  summary: string
  tags: string[]
  mood: string | null
  createdAt: number
  updatedAt: number
}

export type UpdateDocumentMetadata = {
  title?: string
  summary?: string
  tags?: string[]
  mood?: DiaryMoodId | null
  expectedUpdatedAt?: number
}

export interface MetadataMigrationSummary {
  total: number
  legacy: number
  imported: number
  verified: number
  cleaned: number
  failed: number
  orphaned: number
}

export interface FrontmatterCleanupPreview {
  candidates: Array<{
    path: string
    beforeBytes: number
    afterBytes: number
    removedBytes: number
    customFields: string[]
  }>
  blocked: Array<{ path: string; reason: string }>
}

export interface FrontmatterMutationResult {
  changed: Array<{ path: string; newRaw: string; newMtime: number }>
  failed: Array<{ path: string; reason: string }>
}

export async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    // Feature-specific wrappers may validate a richer error envelope after
    // this shared parser has preserved it. Keep the common helper free of
    // domain assumptions while retaining structured details.
    const body = (await r.json().catch(() => ({ error: r.statusText }))) as {
      error?: unknown
      code?: unknown
      details?: unknown
    }
    const message = typeof body.error === 'string' && body.error.trim()
      ? body.error
      : r.statusText || `HTTP ${r.status}`
    throw Object.assign(new Error(message), {
      status: r.status,
      body,
      code: typeof body.code === 'string' ? body.code : undefined,
    })
  }
  return r.json() as Promise<T>
}

/** Path is already relative to `src/content/`, so it goes straight into the splat route. */
function splat(path: string): string {
  return path
}

export async function getTree(): Promise<TreeNode[]> {
  return jsonOrThrow<TreeNode[]>(await authFetch('/api/tree'))
}

export async function listPosts(): Promise<PostSummary[]> {
  return jsonOrThrow<PostSummary[]>(await authFetch('/api/posts'))
}

export async function getFileStates(paths: string[]): Promise<Array<{
  path: string; exists: boolean; mtime: number; size: number
}>> {
  return jsonOrThrow(await authFetch('/api/files/state', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }),
  }))
}

export async function getPost(path: string): Promise<PostDetail> {
  return jsonOrThrow<PostDetail>(await authFetchForPath(
    path,
    '/api/posts/' + splat(path),
  ))
}

function isSavePostConflictPayload(value: unknown): value is SavePostConflictPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<SavePostConflictPayload>
  const current = payload.current
  return payload.code === 'EDIT_CONFLICT'
    && typeof payload.error === 'string'
    && Boolean(current)
    && typeof current?.raw === 'string'
    && typeof current?.mtime === 'number'
    && Number.isFinite(current.mtime)
    && typeof current?.size === 'number'
    && Number.isFinite(current.size)
}

export async function savePost(
  path: string,
  raw: string,
  baseRaw: string,
): Promise<SavePostResult> {
  const response = await authFetchForPath(path, '/api/posts/' + splat(path), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw, baseRaw } satisfies SavePostInput),
  })
  if (response.status === 409) {
    const payload = await response.clone().json().catch(() => null)
    if (isSavePostConflictPayload(payload)) {
      throw new SavePostConflictError(payload.current)
    }
  }
  return jsonOrThrow<SavePostResult>(response)
}

export interface RecoverPostResult {
  ok: true
  raw: string
  mtime: number
  post: PostSummary
}

export async function recoverPost(path: string, raw: string): Promise<RecoverPostResult> {
  return jsonOrThrow(await authFetchForPath(path, '/api/recover/' + splat(path), {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }),
  }))
}

/** Current metadata by STABLE document id — the path-based lookups
 *  (posts list, tab state, tree) can all be stale under a concurrent
 *  rename, but the server's by-identity row always reports the
 *  document's CURRENT path. Returns null when the document no longer
 *  exists server-side (404); any other failure throws so callers can
 *  fail closed instead of trusting a stale path. */
export async function getDocumentMetadataById(id: string): Promise<DocumentMetadata | null> {
  const response = await authFetch(`/api/metadata/documents/${encodeURIComponent(id)}`)
  if (response.status === 404) return null
  return jsonOrThrow<DocumentMetadata>(response)
}

export async function updateDocumentMetadata(
  path: string,
  input: UpdateDocumentMetadata,
): Promise<DocumentMetadata> {
  return jsonOrThrow<DocumentMetadata>(await authFetchForPath(path, '/api/metadata/documents/' + splat(path), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

export async function getDiaryMoodIconConfig(): Promise<DiaryMoodIconConfig> {
  return jsonOrThrow<DiaryMoodIconConfig>(await authFetch('/api/diary/mood-icons'))
}

export async function patchDiaryMoodIconConfig(
  input: Omit<DiaryMoodIconConfig, 'version'> & { expectedVersion: number },
): Promise<DiaryMoodIconConfig> {
  return jsonOrThrow<DiaryMoodIconConfig>(await authFetch('/api/diary/mood-icons', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

export async function getMetadataMigrationStatus(): Promise<{
  running: boolean
  summary: MetadataMigrationSummary
  failures: Array<{ path: string; error: string }>
  cleanedPaths: string[]
}> {
  return jsonOrThrow(await authFetch('/api/metadata/migration'))
}

export async function cleanDocumentFrontmatter(paths: string[]): Promise<FrontmatterMutationResult> {
  return jsonOrThrow(await authFetchForPaths(paths, '/api/metadata/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths, confirm: 'REMOVE_FRONTMATTER' }),
  }))
}

export async function restoreDocumentFrontmatter(
  paths: string[],
  mode: 'canonical' | 'original' = 'original',
): Promise<FrontmatterMutationResult> {
  return jsonOrThrow(await authFetchForPaths(paths, '/api/metadata/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths, mode, confirm: 'RESTORE_FRONTMATTER' }),
  }))
}

export async function getFrontmatterCleanupPreview(): Promise<FrontmatterCleanupPreview> {
  return jsonOrThrow(await diaryAuthFetch('/api/metadata/cleanup/preview'))
}

export async function exportDocumentFrontmatter(
  path: string,
  mode: 'canonical' | 'original' = 'canonical',
): Promise<string> {
  const query = new URLSearchParams({ path, mode })
  const result = await jsonOrThrow<{ frontmatter: string }>(
    await authFetchForPath(path, '/api/metadata/export?' + query.toString()),
  )
  return result.frontmatter
}

export async function createPost(input: { path: string; title?: string }): Promise<PostSummary> {
  return jsonOrThrow<PostSummary>(await authFetchForPath(input.path, '/api/posts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

/** Create one exact Diary date through the D2 domain command. */
export async function createDiaryDate(input: {
  date: DiaryDate
  timeZone: string
}): Promise<DiaryDateCreateResult> {
  return jsonOrThrow<DiaryDateCreateResult>(await diaryAuthFetch('/api/diary/dates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

export async function patchPost(srcPath: string, body: { name?: string; targetPath?: string; updateReferences?: boolean }): Promise<PostSummary> {
  return jsonOrThrow<PostSummary>(await authFetchForPaths(
    [srcPath, ...(body.targetPath ? [body.targetPath] : [])],
    '/api/posts/' + splat(srcPath),
    {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ))
}

export async function getRenameImpact(path: string, recursive = false): Promise<{ path: string; count: number; sources: string[] }> {
  return jsonOrThrow(await authFetchForPath(
    path,
    '/api/links/rename-impact?path=' + encodeURIComponent(path) + (recursive ? '&recursive=true' : ''),
  ))
}

export async function deletePost(path: string): Promise<{ ok: true }> {
  return jsonOrThrow<{ ok: true }>(await authFetchForPath(
    path,
    '/api/posts/' + splat(path),
    { method: 'DELETE' },
  ))
}

export async function createFolder(path: string): Promise<{ path: string }> {
  return jsonOrThrow<{ path: string }>(await authFetch('/api/folders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  }))
}

export async function renameFolder(srcPath: string, newPath: string, updateReferences = false): Promise<{ path: string; moved: string[]; updatedReferences?: Array<{ path: string; raw: string; mtime: number }> }> {
  return jsonOrThrow<{ path: string; moved: string[]; updatedReferences?: Array<{ path: string; raw: string; mtime: number }> }>(await authFetchForPaths([srcPath, newPath], '/api/folders/' + splat(srcPath), {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newPath, updateReferences }),
  }))
}

export async function deleteFolder(path: string, recursive: boolean): Promise<{ deleted: string[] }> {
  const url = '/api/folders/' + splat(path) + (recursive ? '?recursive=true' : '')
  return jsonOrThrow<{ deleted: string[] }>(await authFetch(url, { method: 'DELETE' }))
}

// --- Link index (bi-directional links) ---

export interface Link {
  target: string
  alias?: string
  anchor?: string
  kind: 'wiki' | 'md'
}

export interface LinkIndexSnapshot {
  paths: string[]
  outgoing: Record<string, Link[]>
  /** path -> display title (database metadata -> Frontmatter -> first H1 -> filename). */
  titles?: Record<string, string>
}

export interface BacklinkRecord {
  source: string
  alias?: string
  anchor?: string
  kind: 'wiki' | 'md'
}

export async function getLinkIndexSnapshot(): Promise<LinkIndexSnapshot> {
  return jsonOrThrow<LinkIndexSnapshot>(await authFetch('/api/links/index'))
}

export async function getBacklinks(path: string): Promise<BacklinkRecord[]> {
  return jsonOrThrow<BacklinkRecord[]>(
    await authFetch('/api/backlinks?path=' + encodeURIComponent(path)),
  )
}
