// AI tool surface. Seven workspace tools that let Claude read, list,
// create, write, patch, delete, and rename any file under
// `src/content/`. Paths are validated by the same `assertSafePath` /
// `filePathFor` helpers used by the REST CRUD layer in `server/index.ts`,
// so a tool can never escape the workspace.
//
// Every executor returns `ToolResult = { content, isError, changed? }`.
// `changed` is set on write/delete/rename and carries
// `{ path, kind, newMtime?, newRaw?, oldPath? }`; the chat
// orchestrator forwards it as a `file_changed` SSE event so the
// client's editor can refresh any open tab on that path.

import type { NormalizedTool } from './llm.js'
import type { Database as DatabaseT } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import matter from 'gray-matter'
import {
  CONTENT_DIR,
  filePathFor,
  folderPathFor,
  normalizeLogicalContentPath,
} from '../paths.js'
import { classifyDiaryPath } from '../../shared/diaryProtocol.js'
import { naturalPathCompare } from '../tree.js'
import { prepareRenameReferenceJournal, type PreparedRenameReferenceJournal } from '../renameReferenceJournal.js'
import { getDb } from '../db.js'
import { withDocumentWriteLock, withVaultStructureLock } from '../documentWriteLock.js'
import {
  getToolMutationTarget,
  guardToolMutation,
  readCurrentServerDocument,
  type ToolMutationTarget,
  type ToolSafetyPolicy,
} from './tool-safety.js'
import {
  deleteDocumentMetadata,
  ensureDocumentMetadata,
  getDocumentMetadata,
  moveDocumentMetadataReplacingDestination,
  patchDocumentMetadata,
  DocumentMetadataError,
  recordCommittedDocumentMutation,
  restoreDocumentMetadataMutation,
  snapshotDocumentMetadataMutation,
} from '../documentMetadata.js'
import { trackCleanedDocumentWrite } from '../metadataMigration.js'
import {
  RenameDestinationOccupiedError,
  RenameSourceReusedError,
  renameDocumentWithMetadata,
} from '../documentFileLifecycle.js'
import {
  getIndex as getLinkIndex,
} from '../linkIndex.js'
import { rewriteDocumentReferences } from '../renameReferences.js'
import { validateDocumentMutation } from '../documentMutationPolicy.js'
import {
  AtomicTextWriteConflictError,
  AtomicTextWriteTargetMissingError,
  atomicRemoveTextIfUnchanged,
  atomicReplaceTextIfUnchanged,
  prepareAtomicTextCreate,
  removeDurableJournal,
  syncParentDirectoryBestEffort,
  writeDurableJournal,
  type PreparedAtomicTextWrite,
} from '../atomicTextWrite.js'
import { recoveryMarkerName } from '../technicalNamespace.js'

export type ToolContext = {
  signal: AbortSignal
  db?: DatabaseT
  /** Server-side D8.1 gate for tools that can read or mutate Diary bodies. */
  diaryBodyAccess?: (path: string) => boolean
  /**
   * Edit-10.4: the safety policy derived ONCE per runChat from the
   * normalized ChatContext. Absent (or unrestricted) keeps the
   * original tool behavior — legacy clients and the `none` context
   * never receive a blocking policy. The policy lives only in the
   * current runChat's memory; it is never persisted, sent over SSE,
   * or exposed to the model beyond a short is_error text.
   */
  safety?: ToolSafetyPolicy
}

export type FileChangeKind = 'write' | 'delete' | 'rename'

export type FileChangeDescriptor = {
  path: string
  kind: FileChangeKind
  newMtime?: number
  newRaw?: string
  oldPath?: string
}

export type ToolResult = {
  content: string
  isError: boolean
  changed?: FileChangeDescriptor
  changes?: FileChangeDescriptor[]
}

// ---- helpers (also used by the test file) ----

/**
 * Read a post from disk and return the parsed bundle. Returns `null`
 * for ENOENT (clean error path for `read_file`); throws for any
 * other error (including unsafe paths — `assertSafePath` throws
 * before we touch the filesystem).
 */
export function readPostIfExists(
  relPath: string,
): { raw: string; content: string; frontmatter: Record<string, unknown>; abs: string; stat: fs.Stats } | null {
  const abs = filePathFor(relPath) // throws on unsafe path
  let raw: string
  try {
    raw = fs.readFileSync(abs, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  const parsed = matter(raw)
  const stat = fs.statSync(abs)
  return {
    raw,
    content: parsed.content,
    frontmatter: parsed.data as Record<string, unknown>,
    abs,
    stat,
  }
}

const MAX_READ_CHARS = 50_000
const MAX_PATCH_ERROR_CHARS = 8_000
const MAX_MATCH_SNIPPET_LINES = 3

function truncate(s: string, max: number, marker: string): string {
  if (s.length <= max) return s
  return s.slice(0, max) + marker
}

// ---- tool definitions (sent to the LLM as `tools`) ----

/* Tools are defined in a provider-neutral shape (NormalizedTool). Each
   ChatBackend maps to its native wire format: Anthropic keeps the
   JSON Schema object as `input_schema`, OpenAI wraps it inside a
   `type: 'function'` envelope. Keeping the canonical definitions
   here in one place means tool descriptions + JSON Schemas are not
   duplicated per provider. */

export const TOOL_DEFINITIONS: NormalizedTool[] = [
  {
    name: 'read_file',
    description:
      'Read a note. Returns Markdown body and database-owned metadata separately, plus size and mtime. Use this before patching so `old_string` matches the body.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Workspace-relative path WITHOUT the .md suffix (e.g. "inbox/markdown-syntax").',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'update_metadata',
    description: 'Update database-owned note metadata. Omitted fields remain unchanged. Never write metadata as YAML Frontmatter.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path WITHOUT the .md suffix.' },
        title: { type: 'string', description: 'Non-empty display title (max 200 characters).' },
        summary: { type: 'string', description: 'Search summary (max 2000 characters).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Searchable tags.' },
        expected_updated_at: {
          type: 'integer',
          description: 'Required when tags is supplied. Use the updatedAt token from read_file metadata.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description:
      'List top-level entries in a directory. No recursion. Each entry has path, size, mtime, and isDir. Omit scope to list the workspace root.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description:
            'Workspace-relative directory path WITHOUT trailing slash. Omit for the workspace root.',
        },
      },
    },
  },
  {
    name: 'create_file',
    description:
      'Create a new file. Fails if the file already exists — use write_file to overwrite. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path WITHOUT the .md suffix.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'write_file',
    description:
      'Overwrite an existing file or create a new one with the given content. Same primitive the editor\'s save action uses. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path WITHOUT the .md suffix.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'patch_file',
    description:
      'Find-and-replace inside a file. The server validates that `old_string` matches exactly once (or exactly N times if `replace_all=true`). If 0 or >1 matches, the call fails with enough context to disambiguate. Use this for small edits; use write_file for full rewrites.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path WITHOUT the .md suffix.' },
        old_string: {
          type: 'string',
          description:
            'Exact substring to replace. Must appear verbatim, including whitespace and indentation.',
        },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: {
          type: 'boolean',
          default: false,
          description: 'If true, replace every occurrence. If false (default), the call fails when old_string matches more than once.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace. Fails if the file does not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path WITHOUT the .md suffix.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'rename_file',
    description:
      'Move or rename a file. Both paths are workspace-relative. Fails if the source does not exist, the target already exists, or source equals target. Use delete_file + create_file if you need to overwrite a target.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Current workspace-relative path WITHOUT .md.' },
        new_path: { type: 'string', description: 'New workspace-relative path WITHOUT .md.' },
        update_references: { type: 'boolean', description: 'Update inbound Wiki/Markdown links. Defaults to true.' },
      },
      required: ['path', 'new_path'],
    },
  },
]

// ---- executors ----

function ok(content: string, changed?: FileChangeDescriptor): ToolResult {
  return { content, isError: false, changed }
}

function err(content: string): ToolResult {
  return { content, isError: true }
}

function canonicalManagedDiaryPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const canonical = normalizeLogicalContentPath(value)
  return canonical && classifyDiaryPath(canonical) === 'managed' ? canonical : null
}

function diaryBodyAccessError(
  access: ((path: string) => boolean) | undefined,
  paths: readonly unknown[],
): ToolResult | null {
  if (!access) return null
  for (const value of paths) {
    const path = canonicalManagedDiaryPath(value)
    if (path && !access(path)) {
      return err(`Tool blocked: diary-locked. Diary body access is locked for ${path}. Unlock Diary before reading or changing it.`)
    }
  }
  return null
}

function diaryEncryptedBodyUnsupportedError(
  name: string,
  paths: readonly unknown[],
): ToolResult | null {
  if (!['read_file', 'create_file', 'write_file', 'patch_file'].includes(name)) return null
  for (const value of paths) {
    const diaryPath = canonicalManagedDiaryPath(value)
    if (diaryPath) {
      return err(`Tool blocked: diary-encrypted-body-unsupported. AI ${name} is disabled for managed Diary body ${diaryPath} until an adapter-aware owner is available.`)
    }
  }
  return null
}

function diaryEncryptedDeleteUnsupportedError(
  name: string,
  paths: readonly unknown[],
): ToolResult | null {
  if (name !== 'delete_file' && name !== 'update_metadata') return null
  for (const value of paths) {
    const diaryPath = canonicalManagedDiaryPath(value)
    if (diaryPath) {
      const code = name === 'delete_file'
        ? 'diary-encrypted-delete-unsupported'
        : 'diary-private-metadata-unsupported'
      return err(`Tool blocked: ${code}. ${name} is disabled for managed Diary path ${diaryPath} until an adapter-aware owner is available.`)
    }
  }
  return null
}

function executeReadFile(input: { path?: string }, db: DatabaseT): ToolResult {
  if (typeof input.path !== 'string' || input.path.length === 0) {
    return err('read_file: `path` is required')
  }
  let bundle: ReturnType<typeof readPostIfExists>
  try {
    bundle = readPostIfExists(input.path)
  } catch (e) {
    return err(`read_file: ${(e as Error).message}`)
  }
  if (bundle === null) {
    return err(`read_file: file does not exist: ${input.path}`)
  }
  const payload = {
    path: input.path,
    content: truncate(bundle.content, MAX_READ_CHARS, `\n\n[... note truncated; total ${bundle.stat.size} bytes ...]`),
    metadata: getDocumentMetadata(db, input.path),
    legacyFrontmatter: bundle.frontmatter,
    size: bundle.stat.size,
    mtime: bundle.stat.mtimeMs,
  }
  return ok(JSON.stringify(payload, null, 2))
}

function executeUpdateMetadata(input: {
  path?: string
  title?: unknown
  summary?: unknown
  tags?: unknown
  expected_updated_at?: unknown
}, db: DatabaseT): ToolResult {
  if (typeof input.path !== 'string' || !input.path) return err('update_metadata: `path` is required')
  try {
    validateDocumentMutation({ operation: 'write', destinationPath: input.path, destinationExists: true })
  } catch (e) {
    return err(`update_metadata: ${(e as Error).message}`)
  }
  const current = getDocumentMetadata(db, input.path)
  if (!current) return err(`update_metadata: document does not exist: ${input.path}`)
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200)) {
    return err('update_metadata: `title` must be a non-empty string of at most 200 characters')
  }
  if (input.summary !== undefined && (typeof input.summary !== 'string' || input.summary.length > 2000)) {
    return err('update_metadata: `summary` must be a string of at most 2000 characters')
  }
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((item) => typeof item !== 'string'))) {
    return err('update_metadata: `tags` must be an array of strings')
  }
  if (input.tags !== undefined && (!Number.isSafeInteger(input.expected_updated_at) || (input.expected_updated_at as number) < 0)) {
    return err('update_metadata: `expected_updated_at` is required for explicit tag changes')
  }
  const changes: import('../documentMetadata.js').DocumentMetadataChange[] = []
  if (input.title !== undefined) changes.push({ field: 'title', value: input.title as string })
  if (input.summary !== undefined) changes.push({ field: 'summary', value: input.summary as string })
  if (input.tags !== undefined) changes.push({ field: 'tags', values: input.tags as string[] })
  if (changes.length === 0) return err('update_metadata: at least one field is required')
  try {
    return ok(JSON.stringify(patchDocumentMetadata(db, {
      path: input.path,
      changes,
      ...(input.tags !== undefined ? { expectedUpdatedAt: input.expected_updated_at as number } : {}),
    }), null, 2))
  } catch (e) {
    if (e instanceof DocumentMetadataError) {
      return err(`update_metadata [${e.code}]: ${e.message}`)
    }
    return err(`update_metadata: ${(e as Error).message}`)
  }
}

function containsFrontmatter(content: string): boolean {
  return /^\uFEFF?---(?:\r?\n|$)/.test(content)
}

function executeListFiles(input: { scope?: string }): ToolResult {
  let targetDir: string
  if (input.scope === undefined || input.scope === '') {
    targetDir = CONTENT_DIR
  } else {
    try {
      targetDir = folderPathFor(input.scope)
    } catch (e) {
      return err(`list_files: ${(e as Error).message}`)
    }
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return err(`list_files: directory does not exist: ${input.scope ?? ''}`)
    }
    throw e
  }
  const relBase = input.scope && input.scope.length > 0 ? input.scope.replace(/\/+$/, '') : ''
  const out: { path: string; isDir: boolean; size: number; mtime: number }[] = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const abs = path.join(targetDir, ent.name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      continue
    }
    const childRel = ent.isDirectory() ? ent.name : ent.name.replace(/\.md$/, '')
    out.push({
      path: relBase ? `${relBase}/${childRel}` : childRel,
      isDir: ent.isDirectory(),
      size: stat.size,
      mtime: stat.mtimeMs,
    })
  }
  out.sort((a, b) => naturalPathCompare(a.path, b.path))
  return ok(JSON.stringify(out, null, 2))
}

/** Retryable, model-actionable message when the ownership-verified commit
 * lost a race to an external writer; null for any other error. */
function atomicWriteRaceMessage(tool: string, documentPath: string, error: unknown): string | null {
  if (error instanceof AtomicTextWriteConflictError) {
    return `${tool}: ${documentPath} changed on disk while this ${tool} was committing; the external save was preserved. Re-read the file and retry.`
  }
  if (error instanceof AtomicTextWriteTargetMissingError) {
    return `${tool}: ${documentPath} was deleted on disk while this ${tool} was committing; nothing was overwritten. Retry if the file should exist.`
  }
  return null
}

async function commitDocumentBody(
  db: DatabaseT,
  documentPath: string,
  abs: string,
  raw: string,
  previous: { raw: string; mode: number } | null,
): Promise<fs.Stats> {
  const databaseSnapshot = snapshotDocumentMetadataMutation(db, [documentPath])
  let committed = false
  let prepared: PreparedAtomicTextWrite | null = null
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (previous) {
      const stat = fs.statSync(abs)
      ensureDocumentMetadata(db, documentPath, previous.raw, stat.mtimeMs)
      await atomicReplaceTextIfUnchanged(abs, previous.raw, raw, { mode: previous.mode })
    } else {
      deleteDocumentMetadata(db, documentPath)
      // Create-only: link(2) atomically fails with EEXIST, so a file
      // an external writer lands between the executor's exists-check
      // and this commit is reported as an error, never overwritten.
      prepared = await prepareAtomicTextCreate(abs, raw)
      await prepared.commit()
    }
    committed = true
    const stat = fs.statSync(abs)
    recordCommittedDocumentMutation(db, documentPath, raw, stat.mtimeMs, Date.now())
    trackCleanedDocumentWrite(db, documentPath, raw)
    return stat
  } catch (error) {
    const failures: unknown[] = [error]
    if (committed) {
      try {
        if (previous) await atomicReplaceTextIfUnchanged(abs, raw, previous.raw, { mode: previous.mode })
        else await atomicRemoveTextIfUnchanged(abs, raw)
      } catch (rollbackError) {
        // An external writer overwriting our commit makes the external
        // bytes authoritative — leaving them in place IS the correct
        // undo, not a rollback failure.
        if (!(rollbackError instanceof AtomicTextWriteConflictError)) failures.push(rollbackError)
      }
    } else if (prepared) {
      try { await prepared.rollback() } catch (rollbackError) { failures.push(rollbackError) }
    }
    try {
      restoreDocumentMetadataMutation(db, databaseSnapshot)
    } catch (rollbackError) { failures.push(rollbackError) }
    if (failures.length > 1) throw new AggregateError(failures, 'AI body write failed and rollback was incomplete')
    throw error
  }
}

async function executeCreateFile(input: { path?: string; content?: string }, db: DatabaseT): Promise<ToolResult> {
  if (typeof input.path !== 'string' || input.path.length === 0) {
    return err('create_file: `path` is required')
  }
  if (typeof input.content !== 'string') {
    return err('create_file: `content` is required')
  }
  if (containsFrontmatter(input.content)) return err('create_file: Markdown must contain body only; use update_metadata for metadata')
  let abs: string
  try {
    abs = filePathFor(input.path)
  } catch (e) {
    return err(`create_file: ${(e as Error).message}`)
  }
  if (fs.existsSync(abs)) {
    return err(`create_file: file already exists: ${input.path}. Use write_file to overwrite.`)
  }
  try {
    validateDocumentMutation({ operation: 'create', destinationPath: input.path })
    await commitDocumentBody(db, input.path, abs, input.content, null)
  } catch (e) {
    return err(`create_file: ${(e as Error).message}`)
  }
  const stat = fs.statSync(abs)
  return ok(`created ${input.path} (${stat.size} bytes)`, {
    path: input.path,
    kind: 'write',
    newMtime: stat.mtimeMs,
    newRaw: input.content,
  })
}

async function executeWriteFile(input: { path?: string; content?: string }, db: DatabaseT): Promise<ToolResult> {
  if (typeof input.path !== 'string' || input.path.length === 0) {
    return err('write_file: `path` is required')
  }
  if (typeof input.content !== 'string') {
    return err('write_file: `content` is required')
  }
  if (containsFrontmatter(input.content)) return err('write_file: Markdown must contain body only; use update_metadata for metadata')
  let abs: string
  try {
    abs = filePathFor(input.path)
  } catch (e) {
    return err(`write_file: ${(e as Error).message}`)
  }
  const existed = fs.existsSync(abs)
  try {
    validateDocumentMutation({ operation: 'write', destinationPath: input.path, destinationExists: existed })
  } catch (e) {
    return err(`write_file: ${(e as Error).message}`)
  }
  try {
    let previous: { raw: string; mode: number } | null = null
    if (existed) {
      const previousRaw = fs.readFileSync(abs, 'utf8')
      const previousStat = fs.statSync(abs)
      previous = { raw: previousRaw, mode: previousStat.mode }
    }
    await commitDocumentBody(db, input.path, abs, input.content, previous)
  } catch (e) {
    return err(atomicWriteRaceMessage('write_file', input.path, e) ?? `write_file: ${(e as Error).message}`)
  }
  const stat = fs.statSync(abs)
  return ok(`wrote ${input.path} (${stat.size} bytes)`, {
    path: input.path,
    kind: 'write',
    newMtime: stat.mtimeMs,
    newRaw: input.content,
  })
}

async function executePatchFile(input: {
  path?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
}, db: DatabaseT): Promise<ToolResult> {
  if (typeof input.path !== 'string' || input.path.length === 0) {
    return err('patch_file: `path` is required')
  }
  if (typeof input.old_string !== 'string') {
    return err('patch_file: `old_string` is required')
  }
  if (typeof input.new_string !== 'string') {
    return err('patch_file: `new_string` is required')
  }
  if (input.old_string.length === 0) {
    return err('patch_file: `old_string` must be non-empty')
  }
  if (input.old_string === input.new_string) {
    return err('patch_file: `old_string` and `new_string` are identical; no change made')
  }
  try {
    validateDocumentMutation({ operation: 'write', destinationPath: input.path, destinationExists: true })
  } catch (e) {
    return err(`patch_file: ${(e as Error).message}`)
  }
  const replaceAll = input.replace_all === true

  let bundle: ReturnType<typeof readPostIfExists>
  try {
    bundle = readPostIfExists(input.path)
  } catch (e) {
    return err(`patch_file: ${(e as Error).message}`)
  }
  if (bundle === null) {
    return err(`patch_file: file does not exist: ${input.path}`)
  }

  // Count matches. `String.split` returns N+1 parts for N matches.
  const parts = bundle.raw.split(input.old_string)
  const matchCount = parts.length - 1

  if (matchCount === 0) {
    return err(
      `patch_file: old_string not found in ${input.path}.\n` +
        `Current file content:\n\n` +
        truncate(bundle.raw, MAX_PATCH_ERROR_CHARS, `\n\n[... truncated; full file is ${bundle.raw.length} bytes ...]`),
    )
  }

  if (matchCount > 1 && !replaceAll) {
    const lines = bundle.raw.split('\n')
    // Find each match's start line by searching through the original
    // raw for `old_string` positions, mapping char offsets to line
    // numbers.
    const matches: { startLine: number; snippet: string }[] = []
    let cursor = 0
    for (let i = 0; i < lines.length && matches.length < matchCount; i++) {
      // Naive but fine for moderate files: find the offset of each
      // line in the running cursor, then search for old_string from
      // there.
      const lineText = lines[i]
      const searchFrom = cursor
      const idx = bundle.raw.indexOf(input.old_string, searchFrom)
      if (idx === -1) {
        cursor += lineText.length + 1
        continue
      }
      const startLine = bundle.raw.slice(0, idx).split('\n').length
      const snippetStart = Math.max(0, startLine - 1 - 1)
      const snippet = lines
        .slice(snippetStart, startLine - 1 + input.old_string.split('\n').length + 1)
        .slice(0, MAX_MATCH_SNIPPET_LINES * 2 + 1)
        .map((l, j) => `${snippetStart + j + 1}: ${l}`)
        .join('\n')
      matches.push({ startLine, snippet })
      cursor = idx + input.old_string.length
      // Skip past the just-found match
      lines[i] = '' // mark as consumed; cheaper than rebuilding
    }
    const formatted = matches
      .map((m, i) => `match ${i + 1} (line ${m.startLine}):\n${m.snippet}`)
      .join('\n\n')
    return err(
      `patch_file: old_string matches ${matchCount} times in ${input.path}. ` +
        `Pass replace_all=true or narrow the context. Matches:\n\n${formatted}`,
    )
  }

  const updated = replaceAll
    ? bundle.raw.split(input.old_string).join(input.new_string)
    : bundle.raw.replace(input.old_string, input.new_string)
  try {
    await commitDocumentBody(db, input.path, bundle.abs, updated, { raw: bundle.raw, mode: bundle.stat.mode })
  } catch (e) {
    return err(atomicWriteRaceMessage('patch_file', input.path, e) ?? `patch_file: ${(e as Error).message}`)
  }
  const stat = fs.statSync(bundle.abs)
  return ok(
    `patched ${input.path} (${matchCount} replacement${matchCount === 1 ? '' : 's'})`,
    {
      path: input.path,
      kind: 'write',
      newMtime: stat.mtimeMs,
      newRaw: updated,
    },
  )
}

/**
 * A re-used path must never inherit the old documentId: drop any stale
 * identity row for the path and give the NEW generation now occupying
 * it a fresh identity. The old generation stays quarantined under its
 * `.nuvyn-delete-inflight-*` staging name. Returns the new generation's raw so
 * callers can refresh the process-level link index (which never saw an
 * applyDelete for the failed delete and would otherwise keep the old
 * file's outbound links and title until a restart).
 */
function reidentifyReusedPath(db: DatabaseT, documentPath: string, abs: string): string {
  deleteDocumentMetadata(db, documentPath)
  const reusedRaw = fs.readFileSync(abs, 'utf8')
  const reusedStat = fs.statSync(abs)
  ensureDocumentMetadata(db, documentPath, reusedRaw, reusedStat.mtimeMs, Date.now())
  return reusedRaw
}

async function executeDeleteFile(input: { path?: string }, db: DatabaseT): Promise<ToolResult> {
  if (typeof input.path !== 'string' || input.path.length === 0) {
    return err('delete_file: `path` is required')
  }
  let abs: string
  try {
    abs = filePathFor(input.path)
    validateDocumentMutation({ operation: 'delete', sourcePath: input.path })
  } catch (e) {
    return err(`delete_file: ${(e as Error).message}`)
  }
  const staged = path.join(
    path.dirname(abs),
    recoveryMarkerName('delete-inflight', path.basename(abs), randomUUID()),
  )
  const quarantine = path.join(
    path.dirname(abs),
    recoveryMarkerName('quarantine-reuse', path.basename(abs), randomUUID()),
  )
  const databaseSnapshot = snapshotDocumentMetadataMutation(db, [input.path])
  const reuseManifest = path.join(
    path.dirname(abs),
    recoveryMarkerName('delete-manifest', path.basename(abs), randomUUID()),
  )
  const persistReuseQuarantine = async (): Promise<void> => {
    const identities = databaseSnapshot.documents.map((row) => ({ path: String(row.path), id: String(row.id) }))
    if (identities.length) {
      await writeDurableJournal(reuseManifest, {
        version: 1, op: 'delete-path-reuse', kind: 'file', path: input.path,
        inflight: path.basename(staged), quarantine: path.basename(quarantine), identities,
      })
    }
    fs.renameSync(staged, quarantine)
    await syncParentDirectoryBestEffort(quarantine)
  }
  try {
    fs.renameSync(abs, staged)
    await syncParentDirectoryBestEffort(staged)
    deleteDocumentMetadata(db, input.path)
    fs.unlinkSync(staged)
  } catch (e) {
    const rollbackFailures: unknown[] = []
    if (fs.existsSync(staged)) {
      if (!fs.existsSync(abs)) {
        // The path is still empty: put our generation back. linkSync is
        // create-only, so an external file landing exactly here between
        // the check and the restore is detected as EEXIST (path reuse,
        // handled below) instead of being clobbered.
        let restored = false
        try {
          fs.linkSync(staged, abs)
          restored = true
        } catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') rollbackFailures.push(linkError)
        }
        if (restored) {
          try { fs.unlinkSync(staged) } catch (rollbackError) { rollbackFailures.push(rollbackError) }
          try { restoreDocumentMetadataMutation(db, databaseSnapshot) }
          catch (rollbackError) { rollbackFailures.push(rollbackError) }
        } else if (rollbackFailures.length === 0) {
          try {
            await persistReuseQuarantine()
            const reusedRaw = reidentifyReusedPath(db, input.path, abs)
            await removeDurableJournal(reuseManifest)
            // The failed delete never ran applyDelete; re-apply the
            // index entry against the NEW generation at this path.
            try { (await getLinkIndex()).applyWrite(input.path, reusedRaw) } catch { /* next rebuild repairs */ }
          } catch (reuseError) { rollbackFailures.push(reuseError) }
        }
      } else {
        // Path reuse: an external writer created a NEW generation at
        // this path while the delete was failing. The old documentId
        // must never bind to foreign bytes — drop the stale identity,
        // give the new file a fresh one, and leave the old generation
        // quarantined under its staging name.
        try {
          await persistReuseQuarantine()
          const reusedRaw = reidentifyReusedPath(db, input.path, abs)
          await removeDurableJournal(reuseManifest)
          try { (await getLinkIndex()).applyWrite(input.path, reusedRaw) } catch { /* next rebuild repairs */ }
        } catch (reuseError) { rollbackFailures.push(reuseError) }
      }
    } else {
      try { restoreDocumentMetadataMutation(db, databaseSnapshot) }
      catch (rollbackError) { rollbackFailures.push(rollbackError) }
    }
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return err(`delete_file: file does not exist: ${input.path}`)
    }
    if (rollbackFailures.length) {
      return err(`delete_file: ${(e as Error).message}; rollback was incomplete: ${rollbackFailures.map((failure) => (failure as Error).message).join('; ')}`)
    }
    return err(`delete_file: ${(e as Error).message}`)
  }
  return ok(`deleted ${input.path}`, {
    path: input.path,
    kind: 'delete',
  })
}

async function executeRenameFile(input: { path?: string; new_path?: string; update_references?: boolean }, db: DatabaseT, plan: RenamePlan): Promise<ToolResult> {
  if (typeof input.path !== 'string' || input.path.length === 0) {
    return err('rename_file: `path` is required')
  }
  if (typeof input.new_path !== 'string' || input.new_path.length === 0) {
    return err('rename_file: `new_path` is required')
  }
  if (input.path === input.new_path) {
    return err(`rename_file: source equals target: ${input.path}`)
  }
  let srcAbs: string
  let dstAbs: string
  try {
    srcAbs = filePathFor(input.path)
    dstAbs = filePathFor(input.new_path)
  } catch (e) {
    return err(`rename_file: ${(e as Error).message}`)
  }
  if (!fs.existsSync(srcAbs)) {
    return err(`rename_file: source does not exist: ${input.path}`)
  }
  if (fs.existsSync(dstAbs)) {
    return err(
      `rename_file: target already exists: ${input.new_path}. ` +
        `Use delete_file + create_file (or write_file) to overwrite.`,
    )
  }
  try {
    validateDocumentMutation({ operation: 'rename', sourcePath: input.path, destinationPath: input.new_path })
  } catch (e) {
    return err(`rename_file: ${(e as Error).message}`)
  }
  // The reference writes come VERBATIM from the plan that
  // executeGuardedRename built, locked, and guarded. This executor
  // performs NO independent backlink discovery (no getLinkIndex for
  // footprint purposes, no rewriteDocumentReferences): the guarded
  // plan and the executed plan are the same object, so a concurrent
  // link-index change between the guard and the writes cannot add an
  // unguarded reference write. update_references is likewise decided
  // at plan time (an empty plan.references), never re-checked here.
  // Snapshot semantics (the chosen backlink contract): links added
  // AFTER the in-lock footprint check are not part of this rename —
  // it never writes a document whose lock it does not hold.
  let raw = ''
  const references = plan.references.map((r) => ({
    sourcePath: r.sourcePath,
    path: r.outputPath,
    abs: filePathFor(r.outputPath),
    raw: r.originalRaw,
    updated: r.updatedRaw,
  }))
  const databaseSnapshot = snapshotDocumentMetadataMutation(db, [input.path, input.new_path, ...references.map((reference) => reference.path)])
  let rollbackSourceReused = false
  let referenceJournal: PreparedRenameReferenceJournal | null = null
  let preserveReferenceJournal = false
  try {
    raw = fs.readFileSync(srcAbs, 'utf8')
    const sourceStat = fs.statSync(srcAbs)
    ensureDocumentMetadata(db, input.path, raw, sourceStat.mtimeMs)
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true })
    const sourceDocumentId = getDocumentMetadata(db, input.path)?.id
    if (!sourceDocumentId) throw new Error('source document identity was not created')
    referenceJournal = await prepareRenameReferenceJournal({
      sourceAbs: srcAbs,
      op: 'document-rename-references',
      srcRel: input.path,
      destRel: input.new_path,
      documentId: sourceDocumentId,
      references: references.map((reference) => ({ path: reference.path, beforeRaw: reference.raw, afterRaw: reference.updated })),
    })
    await renameDocumentWithMetadata({
      db, fromPath: input.path, toPath: input.new_path, fromAbs: srcAbs, toAbs: dstAbs,
    })
    const written: typeof references = []
    try {
      for (const reference of references) {
        // External-writer-safe: the bytes on disk must still be exactly
        // what the guarded plan read. In-process locks do not stop
        // Obsidian/vim/sync software; the ownership-verified commit
        // detects their saves and fails the rename closed instead of
        // silently overwriting them.
        await atomicReplaceTextIfUnchanged(reference.abs, reference.raw, reference.updated)
        written.push(reference)
        const stat = fs.statSync(reference.abs)
        recordCommittedDocumentMutation(db, reference.path, reference.updated, stat.mtimeMs, Date.now())
      }
      await referenceJournal?.cleanup()
      referenceJournal = null
    } catch (error) {
      const rollbackErrors: unknown[] = []
      if (referenceJournal) {
        try { await referenceJournal.setDirection('roll-back') }
        catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      for (const reference of written.reverse()) {
        try {
          // Undo ONLY our rewrite: an external save on top of it wins
          // and the undo leaves those bytes untouched.
          await atomicReplaceTextIfUnchanged(reference.abs, reference.updated, reference.raw)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      try {
        // Create-only: if an external writer re-used the original path
        // while the reference writes were failing, the rollback fails
        // closed and the bytes stay at the destination.
        await renameDocumentWithMetadata({ db, fromPath: input.new_path, toPath: input.path, fromAbs: dstAbs, toAbs: srcAbs })
      } catch (rollbackError) {
        if (rollbackError instanceof RenameDestinationOccupiedError) {
          // The bytes are at new_path; the original path belongs to an
          // external writer. The outer metadata restore below puts the
          // identity back on input.path — we then move it to new_path
          // so the identity follows the bytes.
          rollbackSourceReused = true
        } else {
          rollbackErrors.push(rollbackError)
        }
      }
      try { restoreDocumentMetadataMutation(db, databaseSnapshot) }
      catch (rollbackError) { rollbackErrors.push(rollbackError) }
      if (referenceJournal) {
        try {
          if (rollbackSourceReused) {
            await referenceJournal.setDirection('roll-forward')
            preserveReferenceJournal = true
          } else if (!rollbackErrors.length) {
            await referenceJournal.cleanup()
            referenceJournal = null
          } else {
            preserveReferenceJournal = true
          }
        } catch (rollbackError) { rollbackErrors.push(rollbackError); preserveReferenceJournal = true }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'AI rename failed and rollback was incomplete')
      throw error
    }
  } catch (e) {
    try { restoreDocumentMetadataMutation(db, databaseSnapshot) }
    catch (rollbackError) {
      return err(`rename_file: ${(e as Error).message}; metadata rollback failed: ${(rollbackError as Error).message}`)
    }
    if (referenceJournal && !preserveReferenceJournal) {
      try { await referenceJournal.cleanup(); referenceJournal = null }
      catch (cleanupError) {
        return err(`rename_file: ${(e as Error).message}; reference journal cleanup failed: ${(cleanupError as Error).message}`)
      }
    }
    if (e instanceof RenameSourceReusedError && e.survivingPath === 'staging') {
      try {
        deleteDocumentMetadata(db, input.path)
        if (fs.existsSync(srcAbs)) {
          const externalRaw = fs.readFileSync(srcAbs, 'utf8')
          const externalStat = fs.statSync(srcAbs)
          ensureDocumentMetadata(db, input.path, externalRaw, externalStat.mtimeMs, Date.now())
          try { (await getLinkIndex()).applyWrite(input.path, externalRaw) } catch { /* next rebuild repairs */ }
        }
      } catch (reidentifyError) {
        return err(`rename_file: both paths were re-used; failed to reidentify external source: ${(reidentifyError as Error).message}`)
      }
    }
    if (e instanceof RenameSourceReusedError && e.survivingPath === 'destination') {
      rollbackSourceReused = true
    }
    if (rollbackSourceReused) {
      // Identity follows the bytes, not the path: the document now
      // lives at new_path. If the destination somehow vanished too
      // (pathological double reuse), drop the row rather than bind it
      // to foreign bytes.
      try {
        if (fs.existsSync(dstAbs)) moveDocumentMetadataReplacingDestination(db, input.path, input.new_path)
        else deleteDocumentMetadata(db, input.path)
        const idx = await getLinkIndex()
        idx.applyRename(input.path, input.new_path, raw)
        if (e instanceof RenameSourceReusedError && e.journalPath) {
          await removeDurableJournal(e.journalPath)
        }
      } catch { /* best effort: the next index rebuild re-derives paths */ }
      return err(
        `rename_file: the original path was re-used externally during rollback; ` +
          `the document was kept at ${input.new_path} without overwriting the external file; ` +
          `reference updates were not applied`,
      )
    }
    if (e instanceof RenameDestinationOccupiedError) {
      return err(
        `rename_file: target was claimed by an external writer during the move; ` +
          `${input.path} was restored untouched; retry the rename`,
      )
    }
    if (e instanceof RenameSourceReusedError) {
      return err(
        `rename_file: both paths were re-used externally; ` +
          `the document was preserved under a staging name and nothing was overwritten`,
      )
    }
    if (e instanceof AtomicTextWriteConflictError) {
      return err(
        `rename_file: a referenced document changed on disk during the rename; ` +
          `the rename was undone without overwriting the external save. Retry the rename.`,
      )
    }
    return err(`rename_file: ${(e as Error).message}`)
  }
  // After ALL disk writes complete (rename + every rewritten reference),
  // re-read the destination so the event reports the final on-disk body
  // — NOT the pre-rewrite `raw` captured before the rename. Self-references
  // and other in-place body rewrites are written to dstAbs during the
  // reference loop above, so the destination's final content may differ
  // from `raw`. The client trusts `newRaw` as authoritative and skips the
  // poll's getPost when `serverMtime` matches `state.mtime`, so any
  // divergence here would be frozen into the tab until the next save.
  const stat = fs.statSync(dstAbs)
  const finalRaw = fs.readFileSync(dstAbs, 'utf8')
  try {
    const idx = await getLinkIndex()
    idx.applyRename(input.path, input.new_path, finalRaw)
    for (const reference of references) if (reference.path !== input.new_path) idx.applyWrite(reference.path, reference.updated)
  } catch { /* next rebuild repairs the index */ }
  const renamedChange: FileChangeDescriptor = {
    path: input.new_path,
    oldPath: input.path,
    kind: 'rename',
    newMtime: stat.mtimeMs,
    newRaw: finalRaw,
  }
  return { content: `renamed ${input.path} → ${input.new_path}`, isError: false, changed: renamedChange, changes: references
    .filter((reference) => reference.path !== input.new_path)
    .map((reference) => ({ path: reference.path, kind: 'write', newRaw: reference.updated })) }
}

// ---- rename plan (Edit-10.4) ----

/**
 * ONE authoritative plan for a rename_file execution. The plan that
 * determines the LOCK SET, the plan that is GUARDED, and the plan
 * the executor WRITES are the same object — the executor performs
 * no independent backlink discovery, so there is no window in which
 * a concurrent link-index change can slip an unguarded reference
 * write past the safety check.
 */
export interface RenamePlanReference {
  /** The backlink source file (the rename source itself for a self-reference). */
  sourcePath: string
  /** The file the rewritten body is written to (the destination for a self-reference). */
  outputPath: string
  /** Body before the rewrite (rollback). */
  originalRaw: string
  /** Body that will be written. */
  updatedRaw: string
}

export interface RenamePlan {
  sourcePath: string
  destinationPath: string
  references: RenamePlanReference[]
}

type RenameReferenceSnapshot = {
  readonly allPaths: readonly string[]
  readonly sourcePaths: readonly string[]
}

/** Discover the potential backlink footprint from the structural LinkIndex
 * only. This phase deliberately performs no body I/O, so Diary capability
 * authorization can cover every candidate before buildRenamePlan reads raw. */
async function discoverRenameReferenceSnapshot(input: {
  path?: string
  new_path?: string
  update_references?: boolean
}): Promise<RenameReferenceSnapshot> {
  const sourcePath = input.path as string
  const destinationPath = input.new_path as string
  if (
    input.update_references === false
    || typeof sourcePath !== 'string' || sourcePath.length === 0
    || typeof destinationPath !== 'string' || destinationPath.length === 0
  ) return { allPaths: [], sourcePaths: [] }
  // Rename planning is structural-only. LinkIndex deliberately excludes
  // managed-Diary body-derived edges, so an unrelated encrypted Diary must
  // not force a vault-wide body authorization scan or block Note renames.
  const idx = await getLinkIndex()
  return {
    allPaths: idx.snapshot().paths,
    sourcePaths: [...new Set(idx.getBacklinks(sourcePath).map((backlink) => backlink.source))],
  }
}

/**
 * Compute the full plan for one rename: the source→destination move
 * plus every reference file whose rewrite WILL be modified
 * (update_references defaults to on), including self-references
 * (written to the destination). Mirrors the executor's historical
 * rewrite pass exactly — same link index snapshot, same
 * rewriteDocumentReferences call, same `updated !== refRaw`
 * predicate — so no false blocks on backlinks whose text the
 * rewrite wouldn't change. Metadata is NOT touched here — the
 * executor's ensureDocumentMetadata calls run only once the guard
 * has allowed the rename.
 *
 * Throws propagate: a failure here is the SAME failure the old
 * executor would have hit before any side effect (index build or a
 * reference read); executeGuardedRename converts it into the
 * identical rename_file tool error — no crash into the chat loop.
 */
async function buildRenamePlan(input: {
  path?: string
  new_path?: string
  update_references?: boolean
}, snapshot?: RenameReferenceSnapshot): Promise<RenamePlan> {
  const sourcePath = input.path as string
  const destinationPath = input.new_path as string
  const references: RenamePlanReference[] = []
  if (
    input.update_references !== false
    && typeof sourcePath === 'string' && sourcePath.length > 0
    && typeof destinationPath === 'string' && destinationPath.length > 0
  ) {
    const resolved = snapshot ?? await discoverRenameReferenceSnapshot(input)
    const allPaths = [...resolved.allPaths]
    let selfRaw: string | null = null
    for (const backlinkSource of resolved.sourcePaths) {
      const isSelf = backlinkSource === sourcePath
      let refRaw: string
      if (isSelf) {
        if (selfRaw === null) selfRaw = fs.readFileSync(filePathFor(sourcePath), 'utf8')
        refRaw = selfRaw
      } else {
        refRaw = fs.readFileSync(filePathFor(backlinkSource), 'utf8')
      }
      const updatedRaw = rewriteDocumentReferences(refRaw, backlinkSource, sourcePath, destinationPath, allPaths)
      if (updatedRaw === refRaw) continue
      references.push({
        sourcePath: backlinkSource,
        outputPath: isSelf ? destinationPath : backlinkSource,
        originalRaw: refRaw,
        updatedRaw,
      })
    }
  }
  return { sourcePath, destinationPath, references }
}

/** Set equality over canonical logical paths (notes/a ≡ notes/a.md). */
function sameNormalizedPathSet(a: readonly string[], b: readonly string[]): boolean {
  const normalize = (list: readonly string[]) => new Set(list.map((p) => normalizeLogicalContentPath(p) ?? p))
  const setA = normalize(a)
  const setB = normalize(b)
  if (setA.size !== setB.size) return false
  for (const p of setA) if (!setB.has(p)) return false
  return true
}

/**
 * Test-only seam for the rename concurrency tests: deterministic
 * injection points that simulate a concurrent editor save landing
 * in the two race windows — `beforeReplan` fires inside the lock
 * just before the in-lock candidate plan is computed; `beforeExecute`
 * fires after the guard has allowed the candidate plan, immediately
 * before the executor runs. Null in production (never set outside
 * tests).
 */
export type RenameRaceHooks = {
  beforeReplan?: () => void | Promise<void>
  beforeExecute?: () => void | Promise<void>
}
let __renameRaceHooks: RenameRaceHooks | null = null
export function __setRenameRaceHooksForTesting(hooks: RenameRaceHooks | null): void {
  __renameRaceHooks = hooks
}

// ---- dispatcher ----

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.signal.aborted) {
    return err('aborted')
  }
  const db = ctx.db ?? getDb()
  // Edit-10.4: classify first. Read-only tools (`none`) need no
  // protection; unknown tools and malformed mutating input (`unknown`)
  // go straight to the dispatcher, which rejects them without side
  // effects — the guard never certifies them as safe, it simply has
  // nothing to protect against. Every real mutation runs its guard
  // INSIDE the same per-path write lock the editor's save route uses,
  // immediately before the executor's side effect: verification and
  // mutation share one critical section, so an autosave landing
  // mid-turn is seen by the clean-document re-verification (as
  // active-context-stale) instead of being silently raced.
  // rename_file goes further: executeGuardedRename computes ONE plan,
  // locks its full footprint, re-computes the plan inside the lock
  // (fail closed on drift), guards it, and hands THAT SAME plan to
  // the executor — locked = guarded = executed.
  const policy = ctx.safety ?? { kind: 'unrestricted' }
  const target = getToolMutationTarget(name, input)
  const pathAccessError = name === 'read_file'
    ? diaryBodyAccessError(ctx.diaryBodyAccess, [input.path])
    : target.kind === 'single-path'
      ? diaryBodyAccessError(ctx.diaryBodyAccess, [target.path])
      : target.kind === 'rename'
        ? diaryBodyAccessError(ctx.diaryBodyAccess, [target.sourcePath, target.destinationPath])
        : null
  if (pathAccessError) return pathAccessError
  const encryptedBodyError = name === 'read_file'
    ? diaryEncryptedBodyUnsupportedError(name, [input.path])
    : target.kind === 'single-path'
      ? diaryEncryptedBodyUnsupportedError(name, [target.path])
      : null
  if (encryptedBodyError) return encryptedBodyError
  const encryptedMutationError = name === 'delete_file' || name === 'update_metadata'
    ? diaryEncryptedDeleteUnsupportedError(name, target.kind === 'single-path' ? [target.path] : [input.path])
    : null
  if (encryptedMutationError) return encryptedMutationError
  if (target.kind === 'none' || target.kind === 'unknown') {
    return dispatchToolCall(name, input, db)
  }
  if (target.kind === 'rename') {
    // rename_file runs the atomic plan flow: the locked plan is the
    // guarded plan is the executed plan (see executeGuardedRename).
    return executeGuardedRename(target, input, db, policy, ctx.diaryBodyAccess)
  }
  // create/delete always change tree membership; write_file may create
  // the file — all three take the vault structure lock in addition to
  // the per-path document lock(s) so they linearize against folder
  // lifecycle transactions. patch_file edits an existing file in
  // place and stays on the document lock only.
  const structural = name === 'create_file' || name === 'write_file' || name === 'delete_file'
  return withMutationLocks(target, async () => {
    const accessError = diaryBodyAccessError(ctx.diaryBodyAccess, [target.path])
    if (accessError) return accessError
    const decision = await guardToolMutation({
      policy,
      target,
      readCurrentDocument: (logicalPath) => readCurrentServerDocument(db, logicalPath),
    })
    if (!decision.allowed) {
      // Ordinary tool_result: is_error text, no changed descriptor,
      // no throw, no file_changed, no disk or DB touch. The model can
      // read the message and continue — on an unrelated path, or by
      // asking the user to save / resolve the workspace.
      return err(decision.message)
    }
    const postGuardAccessError = diaryBodyAccessError(ctx.diaryBodyAccess, [target.path])
    if (postGuardAccessError) return postGuardAccessError
    return dispatchToolCall(name, input, db)
  }, { structural })
}

/**
 * rename_file under Edit-10.4 safety, executed atomically:
 *
 *   plan (pre-lock)  →  lock the plan's FULL footprint  →  candidate
 *   plan (in-lock)   →  drift? fail closed (retryable)  →  guard the
 *   candidate        →  executor writes the candidate VERBATIM.
 *
 * The candidate plan is the single authority: it is computed under
 * the complete lock set, verified by the guard, and handed to the
 * executor, which performs NO independent backlink discovery. If the
 * candidate footprint disagrees with the locked footprint, the
 * rename fails closed with a retryable error instead of executing
 * under an incomplete lock set (extending the lock set while holding
 * locks would break the globally-sorted acquisition order). A retry
 * replans from scratch against the updated link set and goes through
 * the normal guard.
 */
async function executeGuardedRename(
  base: Extract<ToolMutationTarget, { kind: 'rename' }>,
  input: Record<string, unknown>,
  db: DatabaseT,
  policy: ToolSafetyPolicy,
  diaryBodyAccess?: (path: string) => boolean,
): Promise<ToolResult> {
  const renameInput = input as { path?: string; new_path?: string; update_references?: boolean }
  if (canonicalManagedDiaryPath(renameInput.path) || canonicalManagedDiaryPath(renameInput.new_path)) {
    return err('rename_file: managed Diary cannot change identity; encrypted-body rename/reference rewrite is unsupported until an adapter-aware owner is available.')
  }
  let discovered: RenameReferenceSnapshot
  try {
    discovered = await discoverRenameReferenceSnapshot(renameInput)
  } catch (e) {
    return err(`rename_file: ${(e as Error).message}`)
  }
  const discoveryAccessError = diaryBodyAccessError(diaryBodyAccess, [
    base.sourcePath,
    base.destinationPath,
    ...discovered.sourcePaths,
  ])
  if (discoveryAccessError) return discoveryAccessError
  if (discovered.sourcePaths.some((value) => canonicalManagedDiaryPath(value))) {
    return err('rename_file: reference rewrite footprint contains an encrypted managed Diary body; operation failed closed.')
  }
  let plan: RenamePlan
  try {
    plan = await buildRenamePlan(renameInput, discovered)
  } catch (e) {
    return err(`rename_file: ${(e as Error).message}`)
  }
  const locked: Extract<ToolMutationTarget, { kind: 'rename' }> = {
    ...base,
    referencePaths: [...discovered.sourcePaths],
  }
  return withMutationLocks(locked, async () => {
    const accessError = diaryBodyAccessError(diaryBodyAccess, [
      plan.sourcePath,
      plan.destinationPath,
      ...discovered.sourcePaths,
    ])
    if (accessError) return accessError
    if (__renameRaceHooks?.beforeReplan) await __renameRaceHooks.beforeReplan()
    let candidateSnapshot: RenameReferenceSnapshot
    try {
      candidateSnapshot = await discoverRenameReferenceSnapshot(renameInput)
    } catch (e) {
      return err(`rename_file: ${(e as Error).message}`)
    }
    if (!sameNormalizedPathSet(discovered.sourcePaths, candidateSnapshot.sourcePaths)) {
      return err(
        `rename_file: the set of files linking to ${renameInput.path} changed while this rename was being prepared ` +
          `(a concurrent edit added or removed a link). Retry the rename; the retry will plan against the updated link set.`,
      )
    }
    const candidateAccessError = diaryBodyAccessError(diaryBodyAccess, [
      base.sourcePath,
      base.destinationPath,
      ...candidateSnapshot.sourcePaths,
    ])
    if (candidateAccessError) return candidateAccessError
    if (candidateSnapshot.sourcePaths.some((value) => canonicalManagedDiaryPath(value))) {
      return err('rename_file: reference rewrite footprint contains an encrypted managed Diary body; operation failed closed.')
    }
    let candidate: RenamePlan
    try {
      candidate = await buildRenamePlan(renameInput, candidateSnapshot)
    } catch (e) {
      return err(`rename_file: ${(e as Error).message}`)
    }
    const decision = await guardToolMutation({
      policy,
      target: { ...base, referencePaths: [...candidateSnapshot.sourcePaths] },
      readCurrentDocument: (logicalPath) => readCurrentServerDocument(db, logicalPath),
    })
    if (!decision.allowed) {
      // Ordinary tool_result: is_error text, no changed descriptor,
      // no throw, no file_changed, no disk or DB touch.
      return err(decision.message)
    }
    if (__renameRaceHooks?.beforeExecute) await __renameRaceHooks.beforeExecute()
    const preExecuteAccessError = diaryBodyAccessError(diaryBodyAccess, [
      candidate.sourcePath,
      candidate.destinationPath,
      ...candidateSnapshot.sourcePaths,
    ])
    if (preExecuteAccessError) return preExecuteAccessError
    // The candidate plan is the executed plan — verbatim.
    return dispatchToolCall('rename_file', renameInput, db, candidate)
  }, { structural: true })
}

/**
 * Acquire the per-path write lock(s) for one mutation target, in a
 * globally sorted order so concurrent multi-path operations (renames)
 * cannot deadlock. A rename locks its ENTIRE footprint — source,
 * destination, and every backlink reference file it will rewrite —
 * so the guard's decision and the executor's writes are all atomic
 * with respect to editor saves on any touched document. The lock key
 * is the CANONICAL logical path — the same key `routes/posts.ts`
 * locks when the editor saves — so the guard's server re-verification
 * and the tool's own write are atomic with respect to editor saves
 * on the same document.
 *
 * `structural` additionally takes the vault structure lock FIRST
 * (fixed global order: structure → sorted document paths) for tools
 * that change tree membership, so they linearize against folder
 * lifecycle transactions and can never have a file created or
 * removed underneath them mid-flight.
 */
async function withMutationLocks(
  target: Extract<ToolMutationTarget, { kind: 'single-path' } | { kind: 'rename' }>,
  operation: () => Promise<ToolResult>,
  options: { structural?: boolean } = {},
): Promise<ToolResult> {
  const rawPaths = target.kind === 'single-path'
    ? [target.path]
    : [target.sourcePath, target.destinationPath, ...target.referencePaths]
  // Unnormalizable paths keep their raw spelling as the lock key so
  // the call still serializes; the executor's own assertSafePath
  // rejects them before any side effect. Document lock keys live in
  // their own namespace ('document:<path>'), so even a raw spelling
  // equal to the reserved structure-lock string can never collide
  // with the structure lock this call also holds (a shared key would
  // self-deadlock the call and jam every later membership operation).
  const lockPaths = [...new Set(rawPaths.map((p) => normalizeLogicalContentPath(p) ?? p))].sort()
  const locked = lockPaths.reduceRight(
    (next, lockPath) => () => withDocumentWriteLock(lockPath, next),
    operation,
  )
  return options.structural ? withVaultStructureLock(locked) : locked()
}

async function dispatchToolCall(
  name: string,
  input: Record<string, unknown>,
  db: DatabaseT,
  renamePlan?: RenamePlan,
): Promise<ToolResult> {
  switch (name) {
    case 'read_file':
      return executeReadFile(input as { path?: string }, db)
    case 'list_files':
      return executeListFiles(input as { scope?: string })
    case 'update_metadata':
      return executeUpdateMetadata(input as { path?: string; title?: unknown; summary?: unknown; tags?: unknown; expected_updated_at?: unknown }, db)
    case 'create_file':
      return executeCreateFile(input as { path?: string; content?: string }, db)
    case 'write_file':
      return executeWriteFile(input as { path?: string; content?: string }, db)
    case 'patch_file':
      return executePatchFile(
        input as {
          path?: string
          old_string?: string
          new_string?: string
          replace_all?: boolean
        }, db,
      )
    case 'delete_file':
      return executeDeleteFile(input as { path?: string }, db)
    case 'rename_file':
      // A rename may only run with a plan that executeGuardedRename
      // has locked and guarded — never with executor-side discovery.
      if (!renamePlan) return err('rename_file: internal error: rename plan missing')
      return executeRenameFile(input as { path?: string; new_path?: string; update_references?: boolean }, db, renamePlan)
    default:
      return err(`unknown tool: ${name}`)
  }
}
