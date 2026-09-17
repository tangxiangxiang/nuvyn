import MarkdownIt from 'markdown-it'

const HEADING_STATE_KEY = '__nuvynMarkdownHeadingState'
const CUSTOM_ANCHOR_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/

interface MdToken {
  type: string
  tag: string
  children: MdToken[] | null
  content: string
  meta: unknown
  block: boolean
  map: [number, number] | null
  attrGet: (name: string) => string | null
}

interface HeadingRenderState {
  explicitIds: Array<string | null>
  nextSlugIndex: number
}

interface CoreStateLike {
  tokens: MdToken[]
  env: Record<string, unknown>
}

interface AnchorStateLike {
  env?: unknown
}

function getHeadingState(env: unknown): HeadingRenderState | null {
  if (typeof env !== 'object' || env === null) return null
  const record = env as Record<string, unknown>
  const existing = record[HEADING_STATE_KEY]
  if (existing && typeof existing === 'object') {
    return existing as HeadingRenderState
  }
  const state: HeadingRenderState = { explicitIds: [], nextSlugIndex: 0 }
  record[HEADING_STATE_KEY] = state
  return state
}

/** The automatic slug algorithm used by Nuvyn before custom IDs were added. */
export function slugifyNuvynHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

interface CustomAnchorSourceMatch {
  id: string
  escapedBackslashes: number
}

function trailingBackslashCount(value: string): number {
  let count = 0
  for (let index = value.length - 1; index >= 0 && value[index] === '\\'; index -= 1) {
    count += 1
  }
  return count
}

/**
 * Author-source authorization for the narrow final `{#id}` grammar. The
 * inline token content is the normalized/rendered form, so it is not enough
 * to inspect that content: `\{#id}` and `&#123;#id}` can both become visible
 * text that resembles metadata. The raw inline source is authoritative.
 */
function parseCustomAnchorSource(source: string): CustomAnchorSourceMatch | null {
  if (!source.endsWith('}')) return null
  const markerStart = source.lastIndexOf('{#')
  if (markerStart === -1) return null

  const id = source.slice(markerStart + 2, -1)
  if (!CUSTOM_ANCHOR_ID_RE.test(id)) return null

  const beforeMarker = source.slice(0, markerStart)
  const escapedBackslashes = trailingBackslashCount(beforeMarker)
  // A backslash pair produces a literal backslash and leaves the `{` opener
  // active; an odd run escapes the opener and therefore remains literal.
  if (escapedBackslashes % 2 === 1) return null

  const delimiterEnd = beforeMarker.length - escapedBackslashes
  if (delimiterEnd === 0 || !/\s/.test(beforeMarker[delimiterEnd - 1] ?? '')) return null

  return { id, escapedBackslashes }
}

/**
 * Removes only the authorized final `{#id}` suffix from inline children.
 * Keeping this at token level preserves strong/emphasis/code/emoji/link
 * children that precede the suffix. A literal backslash produced by an even
 * source escape run remains visible; only the metadata marker is removed.
 */
function consumeCustomAnchor(
  children: MdToken[] | null,
  id: string,
): string | null {
  if (!children || children.length === 0) return null
  const last = children.at(-1)
  if (!last || last.type !== 'text') return null

  const marker = `{#${id}}`
  if (!last.content.endsWith(marker)) return null

  const markerStart = last.content.length - marker.length
  const beforeMarker = last.content.slice(0, markerStart)
  const hasLiteralBackslash = trailingBackslashCount(beforeMarker) > 0
  const visibleEnd = hasLiteralBackslash ? markerStart : beforeMarker.trimEnd().length
  last.content = last.content.slice(0, visibleEnd)
  if (!last.content) children.pop()
  return id
}

function collectHeadingMetadata(state: CoreStateLike): void {
  const headingState = getHeadingState(state.env)
  if (!headingState) return

  for (let index = 0; index < state.tokens.length; index += 1) {
    const opening = state.tokens[index]
    if (opening.type !== 'heading_open') continue
    const inline = state.tokens[index + 1]
    const sourceMatch = inline?.type === 'inline'
      ? parseCustomAnchorSource(inline.content)
      : null
    const explicitId = sourceMatch
      ? consumeCustomAnchor(inline.children, sourceMatch.id)
      : null
    headingState.explicitIds.push(explicitId)
  }
}

/**
 * markdown-it-anchor invokes this for each heading without an id. The queue
 * was populated by the preceding core rule in the same render, so explicit
 * and automatic headings enter markdown-it-anchor's one allocator together.
 */
export function slugifyHeadingWithState(text: string, state: AnchorStateLike): string {
  const headingState = getHeadingState(state.env)
  if (!headingState) return slugifyNuvynHeading(text)

  const explicitId = headingState.explicitIds[headingState.nextSlugIndex]
  headingState.nextSlugIndex += 1
  return explicitId ?? slugifyNuvynHeading(text)
}

/** Register the narrow custom-heading rule before markdown-it-anchor. */
export function markdownHeadingsPlugin(md: MarkdownIt): void {
  md.core.ruler.before('anchor', 'nuvyn_heading_metadata', collectHeadingMetadata)
}

export const __testing__ = {
  consumeCustomAnchor,
  parseCustomAnchorSource,
}
