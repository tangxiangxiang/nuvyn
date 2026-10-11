import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ManagedAttachment } from '../../../shared/attachmentProtocol.js'
import { CONTENT_DIR, resolveSafeRelativePathDetailed, verifySafePathResolution } from '../../paths.js'
import {
  MARKDOWN_RESOURCE_IMAGE_MIME_BY_EXTENSION,
  MARKDOWN_RESOURCE_SNIPPET_EXTENSIONS,
} from '../../markdownResources.js'

export const MAX_VAULT_ATTACHMENT_SCAN_DEPTH = 24
export const MAX_VAULT_ATTACHMENT_SCAN_DIRECTORIES = 5_000
export const MAX_VAULT_ATTACHMENT_SCAN_ENTRIES = 50_000
export const MAX_VAULT_ATTACHMENT_SCAN_MS = 8_000

const EXTRA_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
}

const INTERNAL_DIRECTORY_NAMES = new Set([
  '.git',
  '.nuvyn',
])

interface ScanQueueEntry {
  relativeDirectory: string
  depth: number
}

interface DirectoryIdentity {
  path: string
  dev: number
  ino: number
}

export interface VaultAttachmentScan {
  items: ManagedAttachment[]
  complete: boolean
  errorCode?: 'source-unavailable' | 'scan-limited'
}

function isHiddenOrTemporary(name: string): boolean {
  return name.startsWith('.')
    || name.endsWith('~')
    || /\.(?:tmp|temp|bak|swp|part|partial|download)$/i.test(name)
}

function isAllowedPath(relativePath: string): boolean {
  if (relativePath.length > 1024 || relativePath.includes('\\') || relativePath.includes('\0')) return false
  const segments = relativePath.split('/')
  return segments.every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !isHiddenOrTemporary(segment)
    && !/^[A-Za-z]:/.test(segment)
    && !/[\u0000-\u001f\u007f]/.test(segment)
  ))
}

function mimeTypeFor(relativePath: string): string | null {
  const extension = path.posix.extname(relativePath).toLowerCase()
  return MARKDOWN_RESOURCE_IMAGE_MIME_BY_EXTENSION[extension]
    ?? EXTRA_MIME_BY_EXTENSION[extension]
    ?? (MARKDOWN_RESOURCE_SNIPPET_EXTENSIONS.has(extension) ? 'text/plain' : null)
}

function isDiaryPath(relativePath: string): boolean {
  return relativePath.split('/')[0]?.toLowerCase() === 'diary'
}

async function verifyDirectory(resolutionPath: string, identity: DirectoryIdentity): Promise<boolean> {
  try {
    const stat = await fs.lstat(resolutionPath)
    return !stat.isSymbolicLink()
      && stat.isDirectory()
      && stat.dev === identity.dev
      && stat.ino === identity.ino
  } catch {
    return false
  }
}

/**
 * Bounded metadata-only traversal of the Vault root. It never opens file
 * contents, skips the entire protected Diary tree, and validates every
 * candidate path with the same no-symlink resolver used by resource reads.
 */
export async function scanVaultAttachments(
  root = CONTENT_DIR,
  signal?: AbortSignal,
  limits: {
    maxDepth?: number
    maxDirectories?: number
    maxEntries?: number
    maxDurationMs?: number
  } = {},
): Promise<VaultAttachmentScan> {
  const maxDepth = limits.maxDepth ?? MAX_VAULT_ATTACHMENT_SCAN_DEPTH
  const maxDirectories = limits.maxDirectories ?? MAX_VAULT_ATTACHMENT_SCAN_DIRECTORIES
  const maxEntries = limits.maxEntries ?? MAX_VAULT_ATTACHMENT_SCAN_ENTRIES
  const maxDurationMs = limits.maxDurationMs ?? MAX_VAULT_ATTACHMENT_SCAN_MS
  const startedAt = Date.now()
  const items: ManagedAttachment[] = []
  const queue: ScanQueueEntry[] = [{ relativeDirectory: '', depth: 0 }]
  let visitedDirectories = 0
  let visitedEntries = 0
  let complete = true
  let errorCode: VaultAttachmentScan['errorCode']

  let rootStat
  try {
    rootStat = await fs.lstat(path.resolve(root))
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Vault root is unavailable')
  } catch {
    return { items, complete: false, errorCode: 'source-unavailable' }
  }

  while (queue.length > 0) {
    if (signal?.aborted) throw new Error('operation aborted')
    if (visitedDirectories >= maxDirectories || visitedEntries >= maxEntries || Date.now() - startedAt > maxDurationMs) {
      complete = false
      errorCode = 'scan-limited'
      break
    }

    const current = queue.shift()!
    if (current.depth > maxDepth) {
      complete = false
      errorCode = 'scan-limited'
      continue
    }
    const absoluteDirectory = current.relativeDirectory
      ? path.join(path.resolve(root), ...current.relativeDirectory.split('/'))
      : path.resolve(root)
    const expectedStat = current.relativeDirectory
      ? await fs.lstat(absoluteDirectory).catch(() => null)
      : rootStat
    if (!expectedStat || expectedStat.isSymbolicLink() || !expectedStat.isDirectory()) {
      complete = false
      continue
    }

    if (current.relativeDirectory) {
      try {
        const resolution = await resolveSafeRelativePathDetailed(root, current.relativeDirectory)
        await verifySafePathResolution({
          ...resolution,
          identities: resolution.identities.map((identity) => ({ ...identity, isFinal: false })),
        })
      } catch {
        complete = false
        continue
      }
    }

    const identity = { path: absoluteDirectory, dev: expectedStat.dev, ino: expectedStat.ino }
    if (!await verifyDirectory(absoluteDirectory, identity)) {
      complete = false
      continue
    }
    let entries
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true })
    } catch {
      complete = false
      continue
    }
    if (!await verifyDirectory(absoluteDirectory, identity)) {
      complete = false
      continue
    }
    visitedDirectories += 1
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      if (signal?.aborted) throw new Error('operation aborted')
      visitedEntries += 1
      if (visitedEntries % 64 === 0 && Date.now() - startedAt > maxDurationMs) {
        complete = false
        errorCode = 'scan-limited'
        break
      }
      if (visitedEntries > maxEntries) {
        complete = false
        errorCode = 'scan-limited'
        break
      }
      if (isHiddenOrTemporary(entry.name) || entry.isSymbolicLink()) continue
      const relativePath = current.relativeDirectory
        ? `${current.relativeDirectory}/${entry.name}`
        : entry.name
      if (!isAllowedPath(relativePath) || isDiaryPath(relativePath)) continue
      if (INTERNAL_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue

      if (entry.isDirectory()) {
        if (current.depth >= maxDepth) {
          complete = false
          errorCode = 'scan-limited'
          continue
        }
        queue.push({ relativeDirectory: relativePath, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue

      const mimeType = mimeTypeFor(relativePath)
      if (!mimeType || path.posix.extname(relativePath).toLowerCase() === '.md') continue
      try {
        const resolution = await resolveSafeRelativePathDetailed(root, relativePath)
        await verifySafePathResolution(resolution)
        const stat = await fs.lstat(resolution.absolute)
        if (stat.isSymbolicLink() || !stat.isFile()) continue
        const after = await fs.lstat(resolution.absolute)
        if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) continue
        items.push({
          key: { kind: 'vault-file', path: relativePath },
          source: 'vault-file',
          type: mimeType.startsWith('image/') ? 'image' : 'file',
          displayName: path.posix.basename(relativePath),
          mimeType,
          byteSize: Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : null,
          createdAt: Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? Math.trunc(stat.birthtimeMs) : null,
          modifiedAt: Number.isFinite(stat.mtimeMs) && stat.mtimeMs >= 0 ? Math.trunc(stat.mtimeMs) : null,
          referenceStatus: 'unknown',
        })
      } catch {
        // Concurrent removal/rename is a partial scan, not a reason to expose
        // a stale path or mark the whole source complete.
        complete = false
      }
    }
    if (errorCode === 'scan-limited') break
  }

  return { items, complete, errorCode }
}
