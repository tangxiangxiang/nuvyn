import path from 'node:path'
import { TextDecoder } from 'node:util'
import { CONTENT_DIR, readSafeRelativeFile, SafePathResourceLimitError } from './paths.js'

export const MAX_SNIPPET_BYTES = 256 * 1024
export const MAX_INCLUDE_BYTES = 512 * 1024
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export type MarkdownResourceKind = 'snippet' | 'include' | 'image'

export class MarkdownResourceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 400) {
    super('Unable to load Markdown resource.')
    this.name = 'MarkdownResourceError'
    this.code = code
    this.status = status
  }
}

const SNIPPET_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.css', '.scss', '.less',
  '.html', '.xml', '.json', '.yaml', '.yml', '.toml', '.sql', '.py', '.java', '.go',
  '.rs', '.rb', '.php', '.sh', '.bash', '.zsh', '.fish', '.c', '.h', '.cc', '.cpp',
  '.hh', '.hpp', '.cs', '.kt', '.kts', '.swift', '.dart', '.lua', '.r', '.txt',
])

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

const RESOURCE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/u

export type MarkdownResourceReadResult =
  | { kind: 'snippet' | 'include'; path: string; content: string }
  | { kind: 'image'; path: string; content: Buffer; contentType: string }

/**
 * Validate only the canonical logical path accepted by the resource route.
 * This deliberately remains stricter than the author-facing logical resolver:
 * no dot segments ever reach server/paths.ts.
 */
export function validateCanonicalResourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) {
    throw new MarkdownResourceError('resource-invalid-path', 400)
  }
  if (
    value.includes('\\')
    || value.includes('\0')
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.startsWith('/')
    || value.startsWith('//')
    || URI_SCHEME_RE.test(value)
  ) throw new MarkdownResourceError('resource-invalid-path', 400)

  const segments = value.split('/')
  if (segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.startsWith('.')
    || !RESOURCE_SEGMENT_RE.test(segment)
  ))) throw new MarkdownResourceError('resource-invalid-path', 400)

  return segments.join('/')
}

function extensionOf(resourcePath: string): string {
  return path.posix.extname(resourcePath).toLowerCase()
}

function validateKindAndExtension(kind: unknown, resourcePath: string): MarkdownResourceKind {
  if (kind !== 'snippet' && kind !== 'include' && kind !== 'image') {
    throw new MarkdownResourceError('resource-invalid-kind', 400)
  }
  const extension = extensionOf(resourcePath)
  const allowed = kind === 'include'
    ? extension === '.md'
    : kind === 'snippet'
      ? SNIPPET_EXTENSIONS.has(extension)
      : Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXTENSION, extension)
  if (!allowed) throw new MarkdownResourceError('resource-unsupported-type', 415)
  return kind
}

function isBinaryText(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) return true
  }
  return false
}

function decodeUtf8(buffer: Buffer): string {
  if (isBinaryText(buffer)) throw new MarkdownResourceError('resource-binary', 415)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new MarkdownResourceError('resource-invalid-encoding', 422)
  }
}

function classifyReadError(error: unknown, resourcePath: string): MarkdownResourceError {
  if (error instanceof MarkdownResourceError) return error
  if (error instanceof SafePathResourceLimitError) {
    return new MarkdownResourceError('resource-size-limit', 413)
  }
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return new MarkdownResourceError('resource-unavailable', 404)
  }
  // Keep the path argument intentionally unused in the public message. It is
  // retained in this helper signature so future server-only logging can add
  // context without accidentally returning it to a client.
  void resourcePath
  return new MarkdownResourceError('resource-unavailable', 404)
}

export async function readMarkdownResource(
  kindInput: unknown,
  pathInput: unknown,
  signal?: AbortSignal,
): Promise<MarkdownResourceReadResult> {
  if (signal?.aborted) throw new MarkdownResourceError('resource-aborted', 499)
  const resourcePath = validateCanonicalResourcePath(pathInput)
  const kind = validateKindAndExtension(kindInput, resourcePath)
  const maxBytes = kind === 'snippet'
    ? MAX_SNIPPET_BYTES
    : kind === 'include'
      ? MAX_INCLUDE_BYTES
      : MAX_IMAGE_BYTES

  try {
    const value = await readSafeRelativeFile(CONTENT_DIR, resourcePath, undefined, { maxBytes, signal })
    if (value === null) throw new MarkdownResourceError('resource-unavailable', 404)
    if (typeof value === 'string') throw new MarkdownResourceError('resource-not-binary', 500)
    if (kind === 'image') {
      return {
        kind,
        path: resourcePath,
        content: value,
        contentType: IMAGE_MIME_BY_EXTENSION[extensionOf(resourcePath)] as string,
      }
    }
    return { kind, path: resourcePath, content: decodeUtf8(value) }
  } catch (error) {
    if (signal?.aborted || (error as Error | undefined)?.message === 'operation aborted') {
      throw new MarkdownResourceError('resource-aborted', 499)
    }
    throw classifyReadError(error, resourcePath)
  }
}

export const __testing__ = {
  SNIPPET_EXTENSIONS,
  IMAGE_MIME_BY_EXTENSION,
  isBinaryText,
  decodeUtf8,
}
