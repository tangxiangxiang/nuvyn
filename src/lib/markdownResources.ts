import type MarkdownIt from 'markdown-it'
import { authFetchForPath } from './diary-request'
import { findMarkdownInlineSourceOwnership } from './markdownInlineSource'
import { isManagedDiaryPath } from '../../shared/diaryProtocol'

export const MAX_SNIPPET_BYTES = 256 * 1024
export const MAX_INCLUDE_BYTES = 512 * 1024
export const MAX_EXPANDED_MARKDOWN_BYTES = 2 * 1024 * 1024
export const MAX_INCLUDE_DEPTH = 8
export const MAX_SELECTED_LINE = 100_000

export type MarkdownResourceKind = 'snippet' | 'include' | 'image'

export interface MarkdownResourceReadRequest {
  kind: MarkdownResourceKind
  path: string
  /** Source document identity used to apply the existing Diary body lease
   *  when a managed Diary renders an otherwise ordinary resource. */
  sourcePath?: string
  signal?: AbortSignal
}

export interface MarkdownResourceReadResult {
  kind: MarkdownResourceKind
  path: string
  content: string | Uint8Array
}

export interface MarkdownResourceResolver {
  read(request: MarkdownResourceReadRequest): Promise<MarkdownResourceReadResult>
}

export class MarkdownResourceError extends Error {
  readonly code: string

  constructor(code = 'resource-unavailable') {
    super('Unable to load Markdown resource.')
    this.name = 'MarkdownResourceError'
    this.code = code
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
const REGION_RE = /^[A-Za-z0-9_.-]{1,120}$/u
const RANGE_ITEM_RE = /^([0-9]+)(?:-([0-9]+))?$/u
const LANGUAGE_RE = /^[A-Za-z][A-Za-z0-9_+-]{0,63}$/u
const FENCE_MODIFIER_RE = /^:(?:line-numbers|no-line-numbers)(?:=[0-9]+)?$/u

export interface ResourceRange {
  start: number
  end?: number
}

export interface ResourceSelection {
  ranges?: ResourceRange[]
  region?: string
}

export interface ResourceDirective {
  kind: 'snippet' | 'include'
  pathReference: string
  selection?: ResourceSelection
  explicitLanguage?: string
  fenceModifiers: string[]
  label?: string
}

export interface ExpandedMarkdown {
  markdown: string
  /** One source identity per flattened Markdown line. */
  sourcePathByLine: Array<string | undefined>
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function normalizeSourceIdentity(sourcePath: string): string | null {
  const value = sourcePath.endsWith('.md') ? sourcePath : `${sourcePath}.md`
  return canonicalizePath(value, [])
}

function canonicalizePath(value: string, base: string[]): string | null {
  if (
    !value
    || value.includes('\\')
    || value.includes('\0')
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.startsWith('/')
    || value.startsWith('//')
    || URI_SCHEME_RE.test(value)
    || value.includes('?')
    || value.includes('#')
  ) return null

  const segments = [...base]
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    if (!RESOURCE_SEGMENT_RE.test(segment) || segment.startsWith('.')) return null
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : null
}

/**
 * Resolve an author-facing resource reference in the logical vault namespace.
 * This is intentionally the only layer that consumes `.` and `..`; callers
 * pass its result to the server as a canonical path with no dot segments.
 */
export function resolveLogicalResourceReference(
  sourcePath: string | undefined,
  resourceReference: string,
): string | null {
  const reference = resourceReference.trim()
  if (!reference || reference === '@' || reference.startsWith('\\')) return null

  if (reference.startsWith('@/')) {
    return canonicalizePath(reference.slice(2), [])
  }

  const source = sourcePath ? normalizeSourceIdentity(sourcePath) : null
  if (!source) return null
  const sourceParts = source.split('/')
  sourceParts.pop()
  return canonicalizePath(reference, sourceParts)
}

export function resourceExtension(resourcePath: string): string {
  const slash = resourcePath.lastIndexOf('/')
  const file = resourcePath.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(dot).toLowerCase() : ''
}

export function isAllowedResourcePath(kind: MarkdownResourceKind, resourcePath: string): boolean {
  const extension = resourceExtension(resourcePath)
  if (kind === 'include') return extension === '.md'
  if (kind === 'snippet') return SNIPPET_EXTENSIONS.has(extension)
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXTENSION, extension)
}

export function imageMimeTypeForPath(resourcePath: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[resourceExtension(resourcePath)] ?? null
}

/** Return the authenticated image URL for a canonical local resource path. */
export function markdownResourceImageUrl(
  sourcePath: string | undefined,
  source: string,
): string | null {
  const trimmed = source.trim()
  if (
    !trimmed
    || trimmed.startsWith('#')
    || trimmed.startsWith('/')
    || trimmed.startsWith('//')
    || URI_SCHEME_RE.test(trimmed)
  ) return null
  const canonical = resolveLogicalResourceReference(sourcePath, trimmed)
  if (!canonical || !isAllowedResourcePath('image', canonical)) return null
  const query = new URLSearchParams({ kind: 'image', path: canonical })
  if (sourcePath && isManagedDiaryPath(sourcePath.replace(/\.md$/, ''))) {
    query.set('source', sourcePath.replace(/\.md$/, ''))
  }
  return `/api/markdown-resources?${query.toString()}`
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_SELECTED_LINE
    ? parsed
    : null
}

export function parseResourceRanges(value: string): ResourceRange[] | null {
  if (!value.trim()) return null
  if (value.length > 10_000 || value.split(',').length > 1_000) return null
  if (/^\d+,$/u.test(value.trim())) {
    const start = parsePositiveInteger(value.trim().slice(0, -1))
    return start === null ? null : [{ start }]
  }
  const ranges: ResourceRange[] = []
  for (const item of value.split(',')) {
    const match = RANGE_ITEM_RE.exec(item)
    if (!match) return null
    const start = parsePositiveInteger(match[1] ?? '')
    const parsedEnd = match[2] === undefined || match[2] === ''
      ? start
      : parsePositiveInteger(match[2])
    if (start === null || parsedEnd === null) return null
    if (parsedEnd !== undefined && parsedEnd !== null && parsedEnd < start) return null
    ranges.push({ start, end: parsedEnd })
  }
  return ranges.length > 0 ? ranges : null
}

function parseFenceMetadata(value: string): {
  explicitLanguage?: string
  fenceModifiers: string[]
} | null {
  const tokens = value.trim().split(/\s+/u).filter(Boolean)
  let explicitLanguage: string | undefined
  const fenceModifiers: string[] = []
  for (const rawToken of tokens) {
    const parts = rawToken.split(':')
    if (!explicitLanguage && parts.length > 1 && LANGUAGE_RE.test(parts[0] ?? '')) {
      explicitLanguage = parts[0]
      const modifiers = parts.slice(1).map((part) => `:${part}`)
      if (!modifiers.every((modifier) => FENCE_MODIFIER_RE.test(modifier))) return null
      fenceModifiers.push(...modifiers)
      continue
    }
    if (!explicitLanguage && LANGUAGE_RE.test(rawToken)) {
      explicitLanguage = rawToken
      continue
    }
    if (!FENCE_MODIFIER_RE.test(rawToken)) return null
    fenceModifiers.push(rawToken)
  }
  return { ...(explicitLanguage ? { explicitLanguage } : {}), fenceModifiers }
}

function parseDirectiveSpec(
  kind: 'snippet' | 'include',
  body: string,
): ResourceDirective | null {
  let value = body.trim()
  if (!value) return null

  let label: string | undefined
  if (kind === 'snippet') {
    const labelMatch = /\s+\[([^\[\]\r\n]{1,200})\]\s*$/u.exec(value)
    if (labelMatch) {
      label = labelMatch[1]?.trim()
      value = value.slice(0, labelMatch.index).trimEnd()
      if (!label) return null
    }
  }

  let braceMetadata = ''
  const braceMatch = /\{([^{}]*)\}\s*$/u.exec(value)
  if (braceMatch) {
    braceMetadata = braceMatch[1]?.trim() ?? ''
    value = value.slice(0, braceMatch.index).trimEnd()
    if (!braceMetadata) return null
  }

  let region: string | undefined
  const hashIndex = value.lastIndexOf('#')
  if (hashIndex !== -1) {
    region = value.slice(hashIndex + 1).trim()
    value = value.slice(0, hashIndex).trimEnd()
    if (!region || !REGION_RE.test(region)) return null
  }
  if (!value) return null

  let ranges: ResourceRange[] | undefined
  let metadata = braceMetadata
  if (metadata) {
    const firstSpace = metadata.search(/\s/u)
    const first = firstSpace === -1 ? metadata : metadata.slice(0, firstSpace)
    const parsedRanges = parseResourceRanges(first)
    if (parsedRanges) {
      ranges = parsedRanges
      metadata = metadata.slice(first.length).trim()
    }
  }

  if (kind === 'include' && metadata) return null
  const fence = kind === 'snippet'
    ? parseFenceMetadata(metadata)
    : { fenceModifiers: [] }
  if (!fence) return null

  return {
    kind,
    pathReference: value,
    ...(ranges || region ? { selection: { ...(ranges ? { ranges } : {}), ...(region ? { region } : {}) } } : {}),
    ...(fence.explicitLanguage ? { explicitLanguage: fence.explicitLanguage } : {}),
    fenceModifiers: fence.fenceModifiers,
    ...(label ? { label } : {}),
  }
}

export function parseMarkdownResourceDirective(line: string): ResourceDirective | null {
  const snippet = /^\s*<<<\s+(.+?)\s*$/u.exec(line)
  if (snippet) return parseDirectiveSpec('snippet', snippet[1] ?? '')
  const include = /^\s*<!--@include:\s*(.*?)\s*-->\s*$/u.exec(line)
  if (include) return parseDirectiveSpec('include', include[1] ?? '')
  return null
}

function regionMarker(line: string): { kind: 'start' | 'end'; name?: string } | null {
  const match = /^\s*(?:(?:\/\/|#|\/\*|<!--)\s*)#?end(?:region|region)\b\s*([A-Za-z0-9_.-]+)?\s*(?:\*\/|-->)?\s*$/iu.exec(line)
  if (match) return { kind: 'end', ...(match[1] ? { name: match[1] } : {}) }
  const start = /^\s*(?:(?:\/\/|#|\/\*|<!--)\s*)#?region\b\s*([A-Za-z0-9_.-]+)\s*(?:\*\/|-->)?\s*$/iu.exec(line)
  if (start) return { kind: 'start', name: start[1] }
  return null
}

/**
 * Accumulates normalized selected lines while counting the exact UTF-8 cost
 * of each line and its emitted LF separator before retaining it.
 */
class BoundedLineAccumulator {
  private readonly lines: string[] = []

  private bytes = 0

  private readonly maxBytes: number | undefined

  constructor(maxBytes?: number) {
    this.maxBytes = maxBytes
  }

  append(line: string): boolean {
    const nextBytes = this.bytes + (this.lines.length > 0 ? 1 : 0) + byteLength(line)
    if (this.maxBytes !== undefined && nextBytes > this.maxBytes) return false
    this.lines.push(line)
    this.bytes = nextBytes
    return true
  }

  appendLines(lines: string[], start: number, end: number): boolean {
    for (let index = start; index <= end; index += 1) {
      if (!this.append(lines[index] ?? '')) return false
    }
    return true
  }

  finish(): string {
    return this.lines.join('\n')
  }
}

function selectNamedRegion(source: string, name: string, maxBytes?: number): string | null {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  const stack: Array<{ name: string; start: number }> = []
  const selected = new BoundedLineAccumulator(maxBytes)
  let matched = false
  for (let index = 0; index < lines.length; index += 1) {
    const marker = regionMarker(lines[index] ?? '')
    if (!marker) continue
    if (marker.kind === 'start') {
      stack.push({ name: marker.name as string, start: index })
      continue
    }
    const current = stack.at(-1)
    if (!current || (marker.name && marker.name !== current.name)) return null
    stack.pop()
    if (current.name === name) {
      matched = true
      if (!selected.appendLines(lines, current.start + 1, index - 1)) return null
    }
  }
  if (stack.length > 0 || !matched) return null
  return selected.finish()
}

function selectRanges(source: string, ranges: ResourceRange[], maxBytes?: number): string | null {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  const selected = new BoundedLineAccumulator(maxBytes)
  for (const range of ranges) {
    const end = range.end ?? lines.length
    if (range.start > lines.length || end > lines.length) return null
    if (!selected.appendLines(lines, range.start - 1, end - 1)) return null
  }
  return selected.finish()
}

function selectResourceContent(
  source: string,
  selection: ResourceSelection | undefined,
  maxBytes: number,
): string | null {
  if (!selection) return selectRanges(source, [{ start: 1 }], maxBytes)
  if (selection.region) return selectNamedRegion(source, selection.region, maxBytes)
  if (selection.ranges) return selectRanges(source, selection.ranges, maxBytes)
  return null
}

function inferLanguage(resourcePath: string): string {
  const extension = resourceExtension(resourcePath)
  const aliases: Record<string, string> = {
    '.tsx': 'tsx', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js', '.vue': 'vue',
    '.scss': 'scss', '.less': 'less', '.html': 'html', '.xml': 'xml',
    '.yml': 'yaml', '.py': 'python', '.rs': 'rust', '.rb': 'ruby', '.sh': 'bash',
    '.bash': 'bash', '.zsh': 'bash', '.fish': 'fish', '.c': 'c', '.h': 'c',
    '.cc': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.kt': 'kotlin',
    '.kts': 'kotlin', '.swift': 'swift', '.dart': 'dart', '.lua': 'lua', '.r': 'r',
  }
  return (aliases[extension] ?? extension.slice(1)) || 'text'
}

function fenceMarkerForSource(source: string): string {
  let longest = 0
  for (const match of source.matchAll(/~+/gu)) longest = Math.max(longest, match[0]?.length ?? 0)
  return '~'.repeat(Math.max(3, longest + 1))
}

function buildSnippetFence(
  source: string,
  resourcePath: string,
  directive: ResourceDirective,
): string {
  const language = directive.explicitLanguage ?? inferLanguage(resourcePath)
  const info = [language, ...directive.fenceModifiers, directive.label ? `[${directive.label}]` : '']
    .filter(Boolean)
    .join(' ')
  const marker = fenceMarkerForSource(source)
  return `${marker}${info}\n${source}\n${marker}`
}

function placeholder(): string {
  return '<div class="markdown-resource-error">Unable to load Markdown resource.</div>'
}

function isDirectiveLineAllowed(
  lineNumber: number,
  directive: ResourceDirective | null,
  opaqueLines: Set<number>,
  singleLineHtmlBlocks: Set<number>,
): boolean {
  if (!directive) return false
  if (!opaqueLines.has(lineNumber)) return true
  // The approved include directive is itself an HTML comment. A standalone
  // one-line comment is a directive; comments embedded in a larger raw HTML
  // block remain opaque and are never expanded.
  return directive.kind === 'include' && singleLineHtmlBlocks.has(lineNumber)
}

function looksLikeResourceDirective(line: string): boolean {
  return /^\s*<<<(?:\s|$)/u.test(line) || /^\s*<!--@include:/u.test(line)
}

function collectOpaqueLines(md: MarkdownIt, source: string): {
  opaqueLines: Set<number>
  singleLineHtmlBlocks: Set<number>
  codeSpanDirectiveLines: Set<number>
} {
  const opaqueLines = new Set<number>()
  const singleLineHtmlBlocks = new Set<number>()
  const codeSpanDirectiveLines = new Set<number>()
  const tokens = md.parse(source, {})
  for (const token of tokens) {
    if (token.map && (token.type === 'fence' || token.type === 'code_block' || token.type === 'html_block')) {
      for (let line = token.map[0]; line < token.map[1]; line += 1) opaqueLines.add(line)
      if (token.type === 'html_block' && token.map[1] - token.map[0] === 1) {
        singleLineHtmlBlocks.add(token.map[0])
      }
    }
  }

  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children || !token.map) continue
    const ownership = findMarkdownInlineSourceOwnership(token.content, token.children, {
      ...md.helpers,
      normalizeLink: md.normalizeLink.bind(md),
    })
    const codeSpans = ownership.allCodeRanges
    if (codeSpans.length === 0) continue

    let lineStart = 0
    const inlineLines = token.content.split('\n')
    for (let lineIndex = 0; lineIndex < inlineLines.length; lineIndex += 1) {
      const line = inlineLines[lineIndex] ?? ''
      // Record ownership of the complete non-whitespace slice without asking
      // whether it is a valid or malformed resource directive. The expansion
      // pass checks this set before all directive parsing and lookalike logic.
      const leadingWhitespace = line.search(/\S/u)
      const start = lineStart + (leadingWhitespace === -1 ? line.length : leadingWhitespace)
      const end = lineStart + line.trimEnd().length
      if (codeSpans.some((span) => span.start <= start && end <= span.end)) {
        codeSpanDirectiveLines.add(token.map[0] + lineIndex)
      }
      lineStart += line.length + 1
    }
  }
  return { opaqueLines, singleLineHtmlBlocks, codeSpanDirectiveLines }
}

interface ExpansionContext {
  md: MarkdownIt
  resolver?: MarkdownResourceResolver
  signal?: AbortSignal
  cache: Map<string, Promise<string>>
  stack: Set<string>
  budgetUsed: number
  emittedLineCount: number
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError')
    || (typeof error === 'object' && error !== null && 'name' in error
      && (error as { name?: unknown }).name === 'AbortError')
}

async function readTextResource(
  context: ExpansionContext,
  kind: 'snippet' | 'include',
  resourcePath: string,
  sourcePath?: string,
): Promise<string> {
  if (!context.resolver) throw new MarkdownResourceError('resource-resolver-unavailable')
  const key = `${kind}:${sourcePath ?? ''}:${resourcePath}`
  let pending = context.cache.get(key)
  if (!pending) {
    pending = context.resolver.read({
      kind,
      path: resourcePath,
      ...(sourcePath && isManagedDiaryPath(sourcePath.replace(/\.md$/, '')) ? { sourcePath } : {}),
      signal: context.signal,
    }).then((result) => {
      if (typeof result.content !== 'string') throw new MarkdownResourceError('resource-not-text')
      return result.content
    })
    context.cache.set(key, pending)
  }
  return pending
}

function addLines(
  context: ExpansionContext,
  target: Array<{ text: string; sourcePath?: string }>,
  text: string,
  sourcePath: string | undefined,
): void {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  let nextBudget = context.budgetUsed
  let nextLineCount = context.emittedLineCount
  for (const line of lines) {
    const separatorBytes = nextLineCount > 0 ? 1 : 0
    const nextBytes = separatorBytes + byteLength(line)
    if (nextBudget + nextBytes > MAX_EXPANDED_MARKDOWN_BYTES) {
      throw new MarkdownResourceError('expanded-size-limit')
    }
    nextBudget += nextBytes
    nextLineCount += 1
  }
  context.budgetUsed = nextBudget
  context.emittedLineCount = nextLineCount
  for (const line of lines) target.push({ text: line, ...(sourcePath ? { sourcePath } : {}) })
}

async function expandSource(
  source: string,
  sourcePath: string | undefined,
  depth: number,
  context: ExpansionContext,
): Promise<Array<{ text: string; sourcePath?: string }>> {
  throwIfAborted(context.signal)
  const normalized = source.replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  const { opaqueLines, singleLineHtmlBlocks, codeSpanDirectiveLines } = collectOpaqueLines(context.md, normalized)
  const output: Array<{ text: string; sourcePath?: string }> = []

  for (let index = 0; index < lines.length; index += 1) {
    throwIfAborted(context.signal)
    const line = lines[index] ?? ''
    // Code-span ownership has priority over both valid and malformed resource
    // directive parsing. A standalone-looking slice owned by code_inline is
    // literal source, never a resource read or a local error placeholder.
    if (codeSpanDirectiveLines.has(index)) {
      addLines(context, output, line, sourcePath)
      continue
    }
    const directive = parseMarkdownResourceDirective(line)
    if (!isDirectiveLineAllowed(index, directive, opaqueLines, singleLineHtmlBlocks)) {
      if (!directive && looksLikeResourceDirective(line) && !opaqueLines.has(index)) {
        addLines(context, output, placeholder(), sourcePath)
        continue
      }
      addLines(context, output, line, sourcePath)
      continue
    }

    const beforeBudget = context.budgetUsed
    const beforeEmittedLineCount = context.emittedLineCount
    try {
      const current = directive as ResourceDirective
      const resourcePath = resolveLogicalResourceReference(sourcePath, current.pathReference)
      if (!resourcePath || !isAllowedResourcePath(current.kind, resourcePath)) {
        throw new MarkdownResourceError('resource-path-rejected')
      }
      if (current.kind === 'include' && depth + 1 > MAX_INCLUDE_DEPTH) {
        throw new MarkdownResourceError('include-depth-limit')
      }
      if (current.kind === 'include' && context.stack.has(resourcePath)) {
        throw new MarkdownResourceError('include-cycle')
      }

      const raw = await readTextResource(context, current.kind, resourcePath, sourcePath)
      const maxSelectedBytes = current.kind === 'snippet' ? MAX_SNIPPET_BYTES : MAX_INCLUDE_BYTES
      const selected = selectResourceContent(
        raw,
        current.selection,
        maxSelectedBytes,
      )
      if (selected === null) throw new MarkdownResourceError('resource-selection-rejected')
      if (byteLength(selected) > maxSelectedBytes) {
        throw new MarkdownResourceError('resource-size-limit')
      }

      if (current.kind === 'snippet') {
        addLines(context, output, buildSnippetFence(selected, resourcePath, current), resourcePath)
      } else {
        context.stack.add(resourcePath)
        try {
          const included = await expandSource(selected, resourcePath, depth + 1, context)
          output.push(...included)
        } finally {
          context.stack.delete(resourcePath)
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      context.budgetUsed = beforeBudget
      context.emittedLineCount = beforeEmittedLineCount
      addLines(context, output, placeholder(), sourcePath)
    }
  }
  return output
}

export async function expandMarkdownResources(
  markdown: string,
  options: {
    md: MarkdownIt
    sourcePath?: string
    resourceResolver?: MarkdownResourceResolver
    signal?: AbortSignal
  },
): Promise<ExpandedMarkdown> {
  const sourcePath = options.sourcePath ? normalizeSourceIdentity(options.sourcePath) ?? undefined : undefined
  const context: ExpansionContext = {
    md: options.md,
    resolver: options.resourceResolver,
    signal: options.signal,
    cache: new Map(),
    stack: new Set(sourcePath ? [sourcePath] : []),
    budgetUsed: 0,
    emittedLineCount: 0,
  }
  const lines = await expandSource(markdown, sourcePath, 0, context)
  const expandedMarkdown = lines.map(({ text }) => text).join('\n')
  const actualBytes = byteLength(expandedMarkdown)
  if (actualBytes !== context.budgetUsed || actualBytes > MAX_EXPANDED_MARKDOWN_BYTES) {
    throw new MarkdownResourceError('expanded-size-limit')
  }
  return {
    markdown: expandedMarkdown,
    sourcePathByLine: lines.map(({ sourcePath: path }) => path),
  }
}

async function readJsonError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { code?: unknown } | null
  const code = typeof body?.code === 'string' ? body.code : 'resource-unavailable'
  throw new MarkdownResourceError(code)
}

export const authenticatedMarkdownResourceResolver: MarkdownResourceResolver = {
  async read(request): Promise<MarkdownResourceReadResult> {
    const query = new URLSearchParams({ kind: request.kind, path: request.path })
    if (request.sourcePath && isManagedDiaryPath(request.sourcePath.replace(/\.md$/, ''))) {
      query.set('source', request.sourcePath.replace(/\.md$/, ''))
    }
    // A managed Diary source authorizes the resource expansion through the
    // existing Diary capability even when the included/snippet resource is an
    // ordinary path. Selecting auth by resource path alone would omit that
    // capability and incorrectly fail every unlocked cross-file resource.
    const response = await authFetchForPath(request.sourcePath ?? request.path, `/api/markdown-resources?${query.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
      signal: request.signal,
    })
    if (!response.ok) return readJsonError(response)
    if (request.kind === 'image') {
      return { kind: request.kind, path: request.path, content: new Uint8Array(await response.arrayBuffer()) }
    }
    const body = await response.json().catch(() => null) as { content?: unknown } | null
    if (typeof body?.content !== 'string') throw new MarkdownResourceError('resource-invalid-response')
    return { kind: request.kind, path: request.path, content: body.content }
  },
}

export const __testing__ = {
  SNIPPET_EXTENSIONS,
  IMAGE_MIME_BY_EXTENSION,
  selectNamedRegion,
  selectRanges,
  inferLanguage,
  collectOpaqueLines,
}
