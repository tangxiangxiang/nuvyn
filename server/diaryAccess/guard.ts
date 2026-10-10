import { classifyDiaryPath } from '../../shared/diaryProtocol.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { filePathFor } from '../paths.js'
import { getAuthRuntime } from '../auth/runtime.js'
import { readDiaryAccessCapability, type DiaryBodyOperation } from './service.js'

/** History routes conventionally include `.md`; the live API uses logical paths. */
function logicalBodyPath(path: string): string {
  return path.endsWith('.md') ? path.slice(0, -3) : path
}

function lockedResponse(c: any): Response {
  c.header('Cache-Control', 'no-store')
  return c.json({ error: 'Diary access is locked.', code: 'diary-locked' }, 423)
}

export function isManagedDiaryBodyPath(path: string): boolean {
  return classifyDiaryPath(logicalBodyPath(path)) === 'managed'
}

export function hasDiaryBodyAccess(sessionId: unknown, capability: unknown): boolean {
  if (typeof sessionId !== 'number') return false
  const runtime = getAuthRuntime()
  return Boolean(runtime && runtime.diaryAccess.isCapabilityValid(sessionId, capability))
}

/** Execute a bounded body operation without exposing the live DEK to routes. */
export async function withDiaryBodyOperation<T>(
  c: any,
  callback: (operation: DiaryBodyOperation) => Promise<T> | T,
): Promise<T | null> {
  const runtime = getAuthRuntime()
  const sessionId = c.get('authSessionId')
  const capability = readDiaryAccessCapability(c.req.raw.headers)
  if (!runtime || typeof sessionId !== 'number') return null
  return runtime.diaryAccess.withBodyOperation(sessionId, capability, callback)
}

/**
 * Return a 423 response for managed Diary body access without a capability.
 * Structural metadata endpoints intentionally do not call this helper.
 */
export function requireDiaryBodyAccess(c: any, path: string): Response | null {
  if (!isManagedDiaryBodyPath(path)) return null
  const runtime = getAuthRuntime()
  const sessionId = c.get('authSessionId')
  const capability = readDiaryAccessCapability(c.req.raw.headers)
  if (runtime && hasDiaryBodyAccess(sessionId, capability)) return null
  return lockedResponse(c)
}

/** Structural probe used by operations that are intentionally disabled for
 * managed Diary (private metadata migration/tag/archive and mixed folder
 * deletes). It enumerates names only and never opens a body. */
export async function hasManagedDiaryFiles(): Promise<boolean> {
  try {
    const diaryRoot = path.dirname(filePathFor('diary/2000-01-01'))
    const entries = await fs.readdir(diaryRoot, { withFileTypes: true })
    return entries.some((entry) =>
      entry.isFile()
      && entry.name.endsWith('.md')
      && isManagedDiaryBodyPath(`diary/${entry.name.slice(0, -3)}`),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Stable 422 for private managed-Diary metadata operations. */
export function rejectManagedDiaryPrivateMetadata(c: any, documentPath?: string): Response | null {
  if (documentPath !== undefined && !isManagedDiaryBodyPath(documentPath)) return null
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: 'Private managed Diary metadata is unavailable until an adapter-aware owner exists.',
    code: 'diary-private-metadata-unsupported',
  }, 422)
}

/**
 * Gate a vault-wide metadata migration, which scans raw Markdown and cannot
 * be checked one path at a time before the scan starts. An uninitialized
 * Diary access configuration is intentionally allowed; once configured, the
 * whole scan requires the same capability as a managed Diary body read.
 */
export function requireDiaryVaultBodyAccess(c: any): Response | null {
  const runtime = getAuthRuntime()
  if (!runtime) return null
  try {
    const status = runtime.diaryAccess.status(
      c.get('authSessionId'),
      readDiaryAccessCapability(c.req.raw.headers),
    )
    if (status.state === 'UNINITIALIZED' || status.state === 'UNLOCKED') return null
  } catch {
    c.header('Cache-Control', 'no-store')
    return c.json({
      error: 'Diary access is temporarily unavailable.',
      code: 'diary-access-unavailable',
    }, 503)
  }
  return lockedResponse(c)
}
