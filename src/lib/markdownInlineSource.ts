/**
 * Source ranges for MarkdownIt's actual `code_inline` tokens.
 *
 * MarkdownIt exposes each token's content and backtick markup, but not its raw
 * source offsets. This helper mirrors only the installed backticks rule's
 * delimiter search and content normalization. The complete child sequence is
 * also part of the mapping: exact-source non-code children, especially
 * `html_inline`, advance the raw cursor before a later `code_inline` can be
 * matched. Raw source alone can never manufacture a code span.
 */
export interface MarkdownCodeInlineSourceRange {
  start: number
  end: number
  markerLength: number
}

export interface MarkdownInlineSourceRange {
  start: number
  end: number
}

export interface MarkdownInlineSourceChild {
  type: string
  content?: string
  markup?: string
  attrs?: ReadonlyArray<readonly [string, string]> | null
  nesting?: number
  children?: readonly MarkdownInlineSourceChild[] | null
}

export interface MarkdownInlineSourceOwnership {
  /** Ranges aligned with top-level `code_inline` children. */
  topLevelCodeRanges: Array<MarkdownCodeInlineSourceRange | null>
  /** All proven code-owned ranges, including nested image-alt children. */
  allCodeRanges: MarkdownCodeInlineSourceRange[]
  /** Ranges aligned with the complete top-level child sequence. */
  childSourceRanges: Array<MarkdownInlineSourceRange | null>
}

/**
 * The link helpers from the MarkdownIt instance that produced the children.
 * Passing these in keeps link-tail ownership aligned with the installed parser
 * without creating another MarkdownIt instance or duplicating its destination
 * and title grammar.
 */
export interface MarkdownInlineSourceParser {
  parseLinkDestination: (
    source: string,
    start: number,
    max: number,
  ) => { ok: boolean; pos: number; str: string }
  parseLinkTitle: (
    source: string,
    start: number,
    max: number,
  ) => { ok: boolean; pos: number; str: string }
  normalizeLink?: (url: string) => string
}

function runEnd(source: string, start: number): number {
  let end = start + 1
  while (end < source.length && source[end] === '`') end += 1
  return end
}

function findMatchingCloser(source: string, openerEnd: number, markerLength: number): number | null {
  let cursor = openerEnd
  while (true) {
    const candidate = source.indexOf('`', cursor)
    if (candidate === -1) return null
    const end = runEnd(source, candidate)
    if (end - candidate === markerLength) return end
    cursor = end
  }
}

interface MarkdownLinkSourceRange extends MarkdownInlineSourceRange {
  labelStart: number
  labelEnd: number
  tailStart: number
  kind: 'inline' | 'reference' | 'shortcut'
}

interface MarkdownLinkTail {
  tailStart: number
  end: number
  kind: MarkdownLinkSourceRange['kind']
  destination?: string
  title?: string
}

interface MarkdownLinkOwnership {
  kind: 'markdown' | 'opaque' | 'transparent' | 'unresolved'
  rawStart?: number
  labelStart?: number
  owner?: MarkdownInlineSourceChild
  consumedEnd?: number
}

function isLinkSpace(code: number): boolean {
  return code === 0x09 || code === 0x20 || code === 0x0A
}

function findReferenceLabelEnd(source: string, start: number): number | null {
  if (source[start] !== '[') return null

  let depth = 1
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1
      continue
    }
    if (source[cursor] === '[') {
      depth += 1
      continue
    }
    if (source[cursor] === ']') {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return null
}

function parseLinkTail(
  source: string,
  labelEnd: number,
  parser: MarkdownInlineSourceParser,
): MarkdownLinkTail | null {
  const max = source.length
  let cursor = labelEnd + 1

  if (source[cursor] === '(') {
    const tailStart = cursor
    cursor += 1
    while (cursor < max && isLinkSpace(source.charCodeAt(cursor))) cursor += 1
    if (cursor >= max) return null

    const destination = parser.parseLinkDestination(source, cursor, max)
    if (!destination.ok) return null
    cursor = destination.pos

    const separatorStart = cursor
    while (cursor < max && isLinkSpace(source.charCodeAt(cursor))) cursor += 1
    let titleValue = ''
    const title = parser.parseLinkTitle(source, cursor, max)
    if (cursor < max && separatorStart !== cursor && title.ok) {
      titleValue = title.str
      cursor = title.pos
      while (cursor < max && isLinkSpace(source.charCodeAt(cursor))) cursor += 1
    }

    if (source[cursor] !== ')') return null
    return {
      tailStart,
      end: cursor + 1,
      kind: 'inline',
      destination: destination.str,
      title: titleValue,
    }
  }

  if (source[cursor] === '[') {
    const referenceEnd = findReferenceLabelEnd(source, cursor)
    if (referenceEnd === null) return null
    return { tailStart: cursor, end: referenceEnd + 1, kind: 'reference' }
  }

  // A shortcut reference link consumes only its label. The actual link_open
  // child proves that this is a reference link; raw source alone never does.
  return { tailStart: labelEnd + 1, end: labelEnd + 1, kind: 'shortcut' }
}

function matchesLinkAttributes(
  tail: MarkdownLinkTail,
  owner: MarkdownInlineSourceChild,
  parser: MarkdownInlineSourceParser,
  destinationAttr: 'href' | 'src',
): boolean {
  if (tail.kind !== 'inline') return true

  const expectedDestination = owner.attrs?.find(([name]) => name === destinationAttr)?.[1]
  const expectedTitle = owner.attrs?.find(([name]) => name === 'title')?.[1]
  if (
    expectedDestination
    && parser.normalizeLink
    && parser.normalizeLink(tail.destination ?? '') !== expectedDestination
  ) return false
  if (expectedTitle !== undefined && expectedTitle !== tail.title) return false
  return true
}

/**
 * Finalize a normal Markdown link only after its actual `link_close` children
 * have consumed the label. At this point `cursor` must be the outer `]`; no
 * future label-end candidate is searched.
 */
function finalizeMarkdownLinkOwnership(
  source: string,
  cursor: number,
  ownership: MarkdownLinkOwnership,
  parser: MarkdownInlineSourceParser | undefined,
): MarkdownLinkSourceRange | null {
  if (
    ownership.kind !== 'markdown'
    || !parser
    || ownership.rawStart === undefined
    || ownership.labelStart === undefined
    || !ownership.owner
    || source[cursor] !== ']'
  ) return null

  const tail = parseLinkTail(source, cursor, parser)
  if (!tail || !matchesLinkAttributes(tail, ownership.owner, parser, 'href')) return null

  return {
    start: ownership.rawStart,
    end: tail.end,
    labelStart: ownership.labelStart,
    labelEnd: cursor,
    tailStart: tail.tailStart,
    kind: tail.kind,
  }
}

function findImageSourceRange(
  source: string,
  start: number,
  owner: MarkdownInlineSourceChild,
  parser: MarkdownInlineSourceParser | undefined,
): MarkdownLinkSourceRange | null {
  if (source[start] !== '!' || source[start + 1] !== '[') return null
  if (!parser || owner.content === undefined || owner.children === null || owner.children === undefined) return null

  // MarkdownIt's image rule already parsed the alt source and stores the exact
  // raw label slice in `content`. Use that parser-owned fact instead of trying
  // candidate `]` positions, which could be backticks inside nested alt code.
  const labelStart = start + 2
  const labelEnd = labelStart + owner.content.length
  if (source.slice(labelStart, labelEnd) !== owner.content || source[labelEnd] !== ']') return null

  const tail = parseLinkTail(source, labelEnd, parser)
  if (!tail || !matchesLinkAttributes(tail, owner, parser, 'src')) return null
  return {
    start,
    end: tail.end,
    labelStart,
    labelEnd,
    tailStart: tail.tailStart,
    kind: tail.kind,
  }
}

function findOpaqueAngleLinkEnd(source: string, start: number): number | null {
  if (source[start] !== '<') return null
  const end = source.indexOf('>', start + 1)
  return end === -1 ? null : end + 1
}

function beginLinkOwnership(
  source: string,
  cursor: number,
  child: MarkdownInlineSourceChild,
  parser: MarkdownInlineSourceParser | undefined,
  nonCodeRanges: MarkdownInlineSourceRange[],
): MarkdownLinkOwnership {
  if (source[cursor] === '[' && source[cursor + 1] === '[') {
    const end = source.indexOf(']]', cursor + 2)
    if (end === -1) return { kind: 'unresolved' }
    nonCodeRanges.push({ start: cursor, end: end + 2 })
    return { kind: 'opaque', consumedEnd: end + 2 }
  }

  if (child.type === 'link_open' && source[cursor] === '[') {
    if (!parser) return { kind: 'unresolved' }
    return {
      kind: 'markdown',
      rawStart: cursor,
      labelStart: cursor + 1,
      owner: child,
    }
  }

  if (child.type === 'link_open') {
    const end = findOpaqueAngleLinkEnd(source, cursor)
    if (end !== null) {
      nonCodeRanges.push({ start: cursor, end })
      return { kind: 'opaque', consumedEnd: end }
    }
    // Linkify tokens have no Markdown link delimiter to skip. Only allow the
    // transparent path when the raw source visibly begins with the semantic
    // href; otherwise an unresolved preceding child could expose old source.
    const href = child.attrs?.find(([name]) => name === 'href')?.[1]
    if (href && (source.startsWith(href, cursor) || source.startsWith(href.replace(/^https?:\/\//iu, ''), cursor))) {
      return { kind: 'transparent' }
    }
  }

  return { kind: 'unresolved' }
}

function rangesOverlap(
  left: MarkdownInlineSourceRange,
  right: MarkdownInlineSourceRange,
): boolean {
  return left.start < right.end && right.start < left.end
}

/**
 * Keep source ownership strictly forward-only. A backwards transition means
 * the preceding child mapping was not proven; failing closed prevents a later
 * code_inline token from reclaiming already-consumed raw source.
 */
function advanceCursor(source: string, current: number, next: number): number {
  if (next < current || next > source.length) return source.length
  return next
}

function findExactChildSourceRange(
  source: string,
  cursor: number,
  child: MarkdownInlineSourceChild,
): MarkdownInlineSourceRange | null {
  if (child.type === 'softbreak' && source.startsWith('\n', cursor)) {
    return { start: cursor, end: cursor + 1 }
  }

  if (child.type === 'hardbreak') {
    for (const rawBreak of ['\\\n', '  \n', '\n']) {
      if (source.startsWith(rawBreak, cursor)) {
        return { start: cursor, end: cursor + rawBreak.length }
      }
    }
  }

  if (child.type === 'html_inline') {
    const content = child.content ?? ''
    if (content.length === 0) return null
    return source.startsWith(content, cursor)
      ? { start: cursor, end: cursor + content.length }
      : null
  }

  // Inline formatting markers are structural source owned by the actual
  // MarkdownIt child sequence. Consume only an exact raw prefix; do not try to
  // reverse-map normalized inline content or reproduce the inline parser.
  if (
    child.markup
    && (child.type.endsWith('_open') || child.type.endsWith('_close'))
    && source.startsWith(child.markup, cursor)
  ) {
    return { start: cursor, end: cursor + child.markup.length }
  }

  const content = child.content ?? ''
  if (content.length === 0) return null

  // Plain text is only consumed when its token content is an exact raw prefix.
  // Entities, escapes, typographer output, and other normalized inline rules
  // are deliberately left unresolved rather than reverse-mapped heuristically.
  if (child.type === 'text' && source.startsWith(content, cursor)) {
    return { start: cursor, end: cursor + content.length }
  }

  return null
}

/** This is the normalization used by MarkdownIt's installed backticks rule. */
export function normalizeMarkdownCodeInlineSource(source: string): string {
  return source.replace(/\n/gu, ' ').replace(/^ (.+) $/u, '$1')
}

function findNextCodeInlineSourceRange(
  source: string,
  cursor: number,
  markerLength: number,
  content: string,
  nonCodeRanges: readonly MarkdownInlineSourceRange[],
): MarkdownCodeInlineSourceRange | null {
  if (markerLength < 1) return null

  let opener = source.indexOf('`', cursor)
  while (opener !== -1) {
    const openerEnd = runEnd(source, opener)
    if (openerEnd - opener === markerLength) {
      const end = findMatchingCloser(source, openerEnd, markerLength)
      if (end !== null) {
        const candidate = { start: opener, end }
        if (nonCodeRanges.some((range) => rangesOverlap(candidate, range))) {
          opener = source.indexOf('`', end)
          continue
        }
        const rawContent = source.slice(openerEnd, end - markerLength)
        if (normalizeMarkdownCodeInlineSource(rawContent) === content) {
          return { start: opener, end, markerLength }
        }
        // This is a complete, but unrelated, raw span. Skip it so that a
        // later actual code_inline child can only claim a later candidate.
        opener = source.indexOf('`', end)
        continue
      }
    }
    opener = openerEnd
  }
  return null
}

function translateCodeRange(
  range: MarkdownCodeInlineSourceRange,
  offset: number,
): MarkdownCodeInlineSourceRange {
  return {
    start: offset + range.start,
    end: offset + range.end,
    markerLength: range.markerLength,
  }
}

function walkMarkdownInlineSourceOwnership(
  source: string,
  children: readonly MarkdownInlineSourceChild[],
  parser?: MarkdownInlineSourceParser,
): MarkdownInlineSourceOwnership {
  const topLevelCodeRanges: Array<MarkdownCodeInlineSourceRange | null> = []
  const allCodeRanges: MarkdownCodeInlineSourceRange[] = []
  const childSourceRanges: Array<MarkdownInlineSourceRange | null> = children.map(() => null)
  let cursor = 0
  const nonCodeRanges: MarkdownInlineSourceRange[] = []
  const linkOwnership: MarkdownLinkOwnership[] = []

  for (const [childIndex, child] of children.entries()) {
    if (child.type === 'link_open') {
      const ownership = beginLinkOwnership(source, cursor, child, parser, nonCodeRanges)
      linkOwnership.push(ownership)
      if (ownership.kind === 'markdown' && ownership.labelStart !== undefined) {
        cursor = advanceCursor(source, cursor, ownership.labelStart)
      } else if (ownership.consumedEnd !== undefined) {
        cursor = advanceCursor(source, cursor, ownership.consumedEnd)
      } else if (ownership.kind === 'unresolved') {
        cursor = source.length
      }
      continue
    }

    if (child.type === 'image') {
      const surface = findImageSourceRange(source, cursor, child, parser)
      if (!surface) {
        cursor = source.length
        continue
      }

      // `image.children` is already the child sequence produced by the
      // running MarkdownIt image rule. Walk it recursively only to map its
      // existing nested ownership; do not parse image.content again.
      const nested = walkMarkdownInlineSourceOwnership(child.content ?? '', child.children ?? [], parser)
      const altStart = cursor + 2
      for (const range of nested.allCodeRanges) {
        allCodeRanges.push(translateCodeRange(range, altStart))
      }
      childSourceRanges[childIndex] = surface
      nonCodeRanges.push({ start: surface.start, end: surface.end })
      cursor = advanceCursor(source, cursor, surface.end)
      continue
    }

    if (child.type === 'link_close') {
      const ownership = linkOwnership.pop()
      if (ownership?.kind === 'markdown') {
        const surface = finalizeMarkdownLinkOwnership(source, cursor, ownership, parser)
        if (!surface) {
          cursor = source.length
        } else {
          if (surface.tailStart < surface.end) {
            nonCodeRanges.push({ start: surface.tailStart, end: surface.end })
          }
          cursor = advanceCursor(source, cursor, surface.end)
        }
      }
      continue
    }

    if (child.type !== 'code_inline') {
      const exactRange = findExactChildSourceRange(source, cursor, child)
      if (exactRange) {
        cursor = advanceCursor(source, cursor, exactRange.end)
        nonCodeRanges.push(exactRange)
      } else if (child.type === 'html_inline') {
        // An HTML token is an ownership anchor. If its exact source cannot be
        // located, later mappings must not guess around the unresolved range.
        cursor = source.length
      }
      continue
    }

    const range = findNextCodeInlineSourceRange(
      source,
      cursor,
      child.markup?.length ?? 0,
      child.content ?? '',
      nonCodeRanges,
    )
    topLevelCodeRanges.push(range)
    childSourceRanges[childIndex] = range
    if (range === null) {
      // Once one actual child cannot be mapped exactly, advancing later
      // children would invent ownership. Preserve only proven ranges.
      cursor = source.length
    } else {
      allCodeRanges.push(range)
      cursor = advanceCursor(source, cursor, range.end)
    }
  }

  return { topLevelCodeRanges, allCodeRanges, childSourceRanges }
}

/**
 * Locate the raw source ranges represented by MarkdownIt's code_inline
 * children in one inline block. The result is aligned to the `code_inline`
 * children in actual child order; a null entry means that exact mapping could
 * not be proven. A failed mapping never causes later children to be guessed.
 *
 * Every child is visited. Proven exact-source non-code children advance the
 * monotonic cursor and are recorded as unavailable to later code-span matches.
 * This is what prevents backticks inside an `html_inline` attribute from being
 * mistaken for a later real `code_inline` with identical normalized content.
 */
export function findMarkdownCodeInlineSourceRanges(
  source: string,
  children: readonly MarkdownInlineSourceChild[],
  parser?: MarkdownInlineSourceParser,
): Array<MarkdownCodeInlineSourceRange | null> {
  return walkMarkdownInlineSourceOwnership(source, children, parser).topLevelCodeRanges
}

/**
 * Return the single child-guided ownership walk used by resource expansion and
 * source-context mapping. Nested image-alt `code_inline` ranges are translated
 * into the outer source coordinates without reparsing the alt content.
 */
export function findMarkdownInlineSourceOwnership(
  source: string,
  children: readonly MarkdownInlineSourceChild[],
  parser?: MarkdownInlineSourceParser,
): MarkdownInlineSourceOwnership {
  return walkMarkdownInlineSourceOwnership(source, children, parser)
}
