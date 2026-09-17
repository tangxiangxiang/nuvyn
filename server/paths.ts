import path from 'node:path'
import { promises as fs } from 'node:fs'

// Where the user's vault lives. In dev this defaults to
// `<project>/src/content`; in production it can be overridden via
// the VAULT_DIR env var so Nuvyn can point at any directory the
// user happens to keep their notes in. This is also the directory
// the history feature treats as a git repo root — see
// server/history/routes.ts.
//
// Resolution order at module load:
//   1. process.env.VAULT_DIR, if set (absolute or relative-to-cwd)
//   2. <cwd>/src/content (dev convention)
//
// `let` (not `const`) so tests can swap the content dir via
// `setContentDir`. All call sites (assertSafePath, filePathFor,
// folderPathFor) read `CONTENT_DIR` inside their function body, so
// they pick up the current value on each call.
function resolveInitialContentDir(): string {
  const fromEnv = process.env.VAULT_DIR?.trim()
  if (fromEnv && fromEnv.length > 0) {
    return path.isAbsolute(fromEnv)
      ? path.normalize(fromEnv)
      : path.resolve(process.cwd(), fromEnv)
  }
  return path.resolve(process.cwd(), 'src/content')
}

export let CONTENT_DIR = resolveInitialContentDir()

/**
 * Override the workspace root. Intended for tests that exercise
 * filesystem helpers against a temp dir, and for runtime config
 * reload if we ever add one. Pass the result of
 * `resolveInitialContentDir()` (i.e. the value picked from env /
 * cwd at module load) to restore.
 */
export function setContentDir(dir: string): void {
  CONTENT_DIR = dir
}

// Content paths are intentionally strict ASCII kebab slugs. Markdown
// titles/frontmatter may be Chinese, but folder/file path segments stay
// boring and portable for git history, URLs, shell tools, and sync clients.
const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const PATH_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/

export function isValidSegment(s: string): boolean {
  if (!SEGMENT_RE.test(s)) return false
  if (s === '.' || s === '..') return false
  if (s.startsWith('-') || s.endsWith('-')) return false
  if (s.endsWith('.md')) return false
  return true
}

export function isValidPathSyntax(p: string): boolean {
  if (!p || p.startsWith('/') || p.endsWith('/')) return false
  if (!PATH_RE.test(p)) return false
  return p.split('/').every(isValidSegment)
}

/**
 * Canonicalize a vault-relative logical content path for equivalence
 * comparison (Edit-10.4). Two legal spellings exist: the canonical
 * extensionless form ("notes/a") used by the editor and tool API, and
 * the history system's single-trailing-.md form ("notes/a.md"). Both
 * canonicalize to "notes/a" so a protected path and a tool path are
 * compared on equal footing.
 *
 * Strips exactly ONE trailing ".md", then delegates to the single
 * strict syntax validator (rejects absolute paths, "..", backslashes,
 * NUL, uppercase, mid-path ".md" segments, leading/trailing dashes).
 * Returns `null` for anything invalid — callers treat an unnormalizable
 * tool path as never equivalent to a protected path (the tool's own
 * `assertSafePath` still rejects it before any side effect). Never
 * resolves to a filesystem path; this is logical-path equivalence only.
 */
export function normalizeLogicalContentPath(p: string): string | null {
  if (typeof p !== 'string') return null
  const bare = p.endsWith('.md') ? p.slice(0, -'.md'.length) : p
  return isValidPathSyntax(bare) ? bare : null
}

export function assertSafePath(p: string): string {
  if (!isValidPathSyntax(p)) {
    throw new Error(`invalid path: ${p}`)
  }
  // Defensive: even with a passing regex, make sure resolve can't escape CONTENT_DIR.
  // (e.g. symlink games — out of scope for v1 but cheap to add.)
  const resolved = path.resolve(CONTENT_DIR, p)
  if (!resolved.startsWith(CONTENT_DIR + path.sep) && resolved !== CONTENT_DIR) {
    throw new Error(`path escapes content dir: ${p}`)
  }
  return resolved
}

export function filePathFor(p: string): string {
  return path.join(assertSafePath(p)) + '.md'
}

export function folderPathFor(p: string): string {
  return path.join(assertSafePath(p))
}

export type SafePathOptions = {
  allowMissingFinal?: boolean
  maxBytes?: number
  signal?: AbortSignal
}

export class SafePathResourceLimitError extends Error {
  readonly code = 'SAFE_PATH_RESOURCE_LIMIT'

  constructor(relativePath: string, maxBytes: number) {
    super(`file exceeds the ${maxBytes}-byte limit: ${relativePath}`)
    this.name = 'SafePathResourceLimitError'
  }
}

export type SafePathResolution = {
  absolute: string
  identities: Array<{ path: string; dev: number; ino: number; isFinal: boolean }>
}

/**
 * Resolve a vault-relative filesystem path without following symlinks.
 *
 * The synchronous helpers above are retained for callers that only need a
 * lexical path. Security-sensitive readers must use this async resolver so
 * every existing path segment is checked with lstat before it is opened.
 */
export async function resolveSafeRelativePath(
  root: string,
  relativePath: string,
  options: SafePathOptions = {},
): Promise<string> {
  return (await resolveSafeRelativePathDetailed(root, relativePath, options)).absolute
}

export async function resolveSafeRelativePathDetailed(
  root: string,
  relativePath: string,
  options: SafePathOptions = {},
): Promise<SafePathResolution> {
  if (
    !relativePath
    || relativePath.includes('\0')
    || relativePath.includes('\\')
    || path.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid relative path: ${relativePath}`)
  }

  const rootAbs = path.resolve(root)
  const rootStat = await fs.lstat(rootAbs)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('path root is not a directory')
  }

  let current = rootAbs
  const segments = relativePath.split('/')
  const identities: SafePathResolution['identities'] = [{
    path: rootAbs,
    dev: rootStat.dev,
    ino: rootStat.ino,
    isFinal: false,
  }]
  for (let index = 0; index < segments.length; index += 1) {
    if (options.signal?.aborted) throw new Error('operation aborted')
    const segment = segments[index]!
    current = path.join(current, segment)
    let segmentStat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      segmentStat = await fs.lstat(current)
      if (segmentStat.isSymbolicLink()) {
        throw new Error(`symbolic links are not allowed: ${relativePath}`)
      }
      if (index < segments.length - 1 && !segmentStat.isDirectory()) {
        throw new Error(`path segment is not a directory: ${relativePath}`)
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT' && index === segments.length - 1 && options.allowMissingFinal) {
        return { absolute: current, identities }
      }
      throw error
    }
    identities.push({
      path: current,
      dev: segmentStat.dev,
      ino: segmentStat.ino,
      isFinal: index === segments.length - 1,
    })
  }
  return { absolute: current, identities }
}

export async function verifySafePathResolution(
  resolution: SafePathResolution,
): Promise<void> {
  for (const identity of resolution.identities) {
    let stat
    try {
      stat = await fs.lstat(identity.path)
    } catch (error: any) {
      throw new Error(`path changed while accessing ${identity.path}`, { cause: error })
    }
    if (
      stat.isSymbolicLink()
      || stat.dev !== identity.dev
      || stat.ino !== identity.ino
      || (identity.isFinal && !stat.isFile())
    ) {
      throw new Error(`path changed while accessing ${identity.path}`)
    }
  }
}

/** Read one existing worktree file after validating its physical path. */
export async function readSafeRelativeFile(
  root: string,
  relativePath: string,
  encoding?: BufferEncoding,
  options: SafePathOptions = {},
): Promise<Buffer | string | null> {
  if (options.signal?.aborted) throw new Error('operation aborted')
  const resolution = await resolveSafeRelativePathDetailed(root, relativePath, { allowMissingFinal: true })
  const absolute = resolution.absolute
  let before: Awaited<ReturnType<typeof fs.lstat>>
  try {
    before = await fs.lstat(absolute)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`path is not a regular file: ${relativePath}`)
  }

  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const handle = await fs.open(absolute, fs.constants.O_RDONLY | noFollow)
  try {
    const maxBytes = options.maxBytes
    let value: Buffer | string
    if (maxBytes === undefined) {
      value = encoding ? await handle.readFile({ encoding }) : await handle.readFile()
    } else {
      const buffer = Buffer.allocUnsafe(maxBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > maxBytes) throw new SafePathResourceLimitError(relativePath, maxBytes)
      value = encoding ? buffer.subarray(0, bytesRead).toString(encoding) : buffer.subarray(0, bytesRead)
    }
    if (options.signal?.aborted) throw new Error('operation aborted')
    const afterHandle = await handle.stat()
    await verifySafePathResolution(resolution)
    const afterPath = await fs.lstat(absolute)
    if (
      afterPath.isSymbolicLink()
      || afterHandle.dev !== before.dev
      || afterHandle.ino !== before.ino
      || afterPath.dev !== before.dev
      || afterPath.ino !== before.ino
    ) {
      throw new Error(`path changed while reading: ${relativePath}`)
    }
    return value
  } finally {
    await handle.close()
  }
}

export { SEGMENT_RE }

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
