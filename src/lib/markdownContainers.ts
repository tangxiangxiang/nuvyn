import type MarkdownIt from 'markdown-it'
import htmlBlockNames from 'markdown-it/lib/common/html_blocks.mjs'
import { HTML_OPEN_CLOSE_TAG_RE } from 'markdown-it/lib/common/html_re.mjs'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'

const CONTAINER_DEFINITIONS = {
  info: { title: 'Info', tag: 'div' },
  tip: { title: 'Tip', tag: 'div' },
  warning: { title: 'Warning', tag: 'div' },
  danger: { title: 'Danger', tag: 'div' },
  details: { title: 'Details', tag: 'details' },
} as const

export type MarkdownContainerType = keyof typeof CONTAINER_DEFINITIONS

interface ContainerOpening {
  markerLength: number
  type: MarkdownContainerType
  title: string
  open: boolean
}

interface ContainerClosing {
  markerLength: number
}

export interface FencedCodeOpening {
  marker: number
  markerLength: number
}

interface HtmlBlockSequence {
  open: RegExp
  close: RegExp
  canTerminateParagraph: boolean
}

interface HtmlBlockOpening {
  sequence: HtmlBlockSequence
}

function isSupportedType(value: string): value is MarkdownContainerType {
  return Object.prototype.hasOwnProperty.call(CONTAINER_DEFINITIONS, value)
}

function getLineStart(state: StateBlock, line: number): number {
  return state.bMarks[line] + state.tShift[line]
}

function getLineEnd(state: StateBlock, line: number): number {
  return state.eMarks[line]
}

function parseOpening(state: StateBlock, line: number): ContainerOpening | null {
  if (state.sCount[line] - state.blkIndent >= 4) return null

  const lineStart = getLineStart(state, line)
  const lineEnd = getLineEnd(state, line)
  if (lineStart >= lineEnd || state.src.charCodeAt(lineStart) !== 0x3a /* : */) return null

  let cursor = lineStart
  while (cursor < lineEnd && state.src.charCodeAt(cursor) === 0x3a) cursor += 1
  const markerLength = cursor - lineStart
  if (markerLength < 3) return null

  const rawRest = state.src.slice(cursor, lineEnd)
  // The type must be separated from the delimiter. Without this check a
  // future type-like token such as `:::info` would silently become a
  // container instead of remaining ordinary Markdown.
  if (!/^[ \t]/.test(rawRest)) return null
  const rest = rawRest.trimStart()
  const match = /^([a-z]+)(?:[ \t]+(.*?))?[ \t]*$/.exec(rest)
  if (!match || !isSupportedType(match[1])) return null

  const type = match[1]
  let title = match[2]?.trim() ?? ''
  let open = false

  // `{open}` is a feature-specific literal, not an attributes grammar. It is
  // accepted only for details and only as the final metadata token.
  if (type === 'details' && /(?:^|[ \t])\{open\}$/.test(title)) {
    title = title.slice(0, -'{open}'.length).trimEnd()
    open = true
  }

  return {
    markerLength,
    type,
    title: title || CONTAINER_DEFINITIONS[type].title,
    open,
  }
}

function parseClosing(state: StateBlock, line: number): ContainerClosing | null {
  if (state.sCount[line] - state.blkIndent >= 4) return null

  const lineStart = getLineStart(state, line)
  const lineEnd = getLineEnd(state, line)
  if (lineStart >= lineEnd || state.src.charCodeAt(lineStart) !== 0x3a /* : */) return null

  let cursor = lineStart
  while (cursor < lineEnd && state.src.charCodeAt(cursor) === 0x3a) cursor += 1
  const markerLength = cursor - lineStart
  if (markerLength < 3) return null

  // A closer is only a colon run followed by horizontal whitespace. This
  // keeps ordinary prose such as `::: text` out of the closing grammar.
  if (state.src.slice(cursor, lineEnd).trim() !== '') return null
  return { markerLength }
}

export function parseFencedCodeOpening(state: StateBlock, line: number): FencedCodeOpening | null {
  if (state.sCount[line] - state.blkIndent >= 4) return null

  const lineStart = getLineStart(state, line)
  const lineEnd = getLineEnd(state, line)
  const marker = state.src.charCodeAt(lineStart)
  if (marker !== 0x60 /* ` */ && marker !== 0x7e /* ~ */) return null

  let cursor = lineStart
  while (cursor < lineEnd && state.src.charCodeAt(cursor) === marker) cursor += 1
  const markerLength = cursor - lineStart
  if (markerLength < 3) return null
  if (marker === 0x60 && state.src.slice(cursor, lineEnd).includes('`')) return null
  return { marker, markerLength }
}

export function findFencedCodeEnd(
  state: StateBlock,
  openingLine: number,
  endLine: number,
  opening: FencedCodeOpening,
): number {
  for (let line = openingLine + 1; line < endLine; line += 1) {
    if (state.sCount[line] - state.blkIndent >= 4) continue
    const lineStart = getLineStart(state, line)
    const lineEnd = getLineEnd(state, line)
    if (state.src.charCodeAt(lineStart) !== opening.marker) continue

    let cursor = lineStart
    while (cursor < lineEnd && state.src.charCodeAt(cursor) === opening.marker) cursor += 1
    if (cursor - lineStart < opening.markerLength) continue
    if (state.src.slice(cursor, lineEnd).trim() !== '') continue
    return line
  }
  return endLine
}

function findIndentedCodeEnd(
  state: StateBlock,
  openingLine: number,
  endLine: number,
): number {
  let nextLine = openingLine + 1
  let lastLine = nextLine

  while (nextLine < endLine) {
    if (state.isEmpty(nextLine)) {
      nextLine += 1
      continue
    }

    if (state.sCount[nextLine] - state.blkIndent >= 4) {
      nextLine += 1
      lastLine = nextLine
      continue
    }

    break
  }

  return lastLine
}

/* Keep the source-range detector aligned with markdown-it's html_block rule.
   The container rule runs later than html_block, so a line such as `<div>` has
   already claimed the following source range before container rendering. The
   scanner must honor that same ownership without invoking a second parser. */
const HTML_BLOCK_TAG_RE = new RegExp(
  '^</?(' + htmlBlockNames.join('|') + ')(?=(\\s|/?>|$))',
  'i',
)

const HTML_BLOCK_SEQUENCES: readonly HtmlBlockSequence[] = [
  { open: /^<(script|pre|style|textarea)(?=(\s|>|$))/i, close: /<\/(script|pre|style|textarea)>/i, canTerminateParagraph: true },
  { open: /^<!--/, close: /-->/, canTerminateParagraph: true },
  { open: /^<\?/, close: /\?>/, canTerminateParagraph: true },
  { open: /^<![A-Z]/, close: />/, canTerminateParagraph: true },
  { open: /^<!\[CDATA\[/, close: /\]\]>/, canTerminateParagraph: true },
  { open: HTML_BLOCK_TAG_RE, close: /^$/, canTerminateParagraph: true },
  { open: new RegExp(HTML_OPEN_CLOSE_TAG_RE.source + '\\s*$'), close: /^$/, canTerminateParagraph: false },
]

function parseHtmlBlockOpening(state: StateBlock, line: number): HtmlBlockOpening | null {
  if (!state.md.options.html) return null
  if (state.sCount[line] - state.blkIndent >= 4) return null

  const lineStart = getLineStart(state, line)
  const lineEnd = getLineEnd(state, line)
  if (lineStart >= lineEnd || state.src.charCodeAt(lineStart) !== 0x3c /* < */) return null

  const lineText = state.src.slice(lineStart, lineEnd)
  const sequence = HTML_BLOCK_SEQUENCES.find(({ open }) => open.test(lineText))
  return sequence ? { sequence } : null
}

function findHtmlBlockEnd(
  state: StateBlock,
  openingLine: number,
  endLine: number,
  opening: HtmlBlockOpening,
): number {
  const openingStart = getLineStart(state, openingLine)
  const openingEnd = getLineEnd(state, openingLine)
  const openingText = state.src.slice(openingStart, openingEnd)
  const endsOnBlankLine = opening.sequence.close.test('')
  let nextLine = openingLine + 1

  if (!opening.sequence.close.test(openingText)) {
    for (; nextLine < endLine; nextLine += 1) {
      if (state.sCount[nextLine] < state.blkIndent) {
        if (endsOnBlankLine || !state.isEmpty(nextLine)) break
      }

      const lineStart = getLineStart(state, nextLine)
      const lineEnd = getLineEnd(state, nextLine)
      const lineText = state.src.slice(lineStart, lineEnd)
      if (!opening.sequence.close.test(lineText)) continue

      if (lineText.length !== 0) nextLine += 1
      break
    }
  }

  return nextLine
}

function findMathBlockEnd(state: StateBlock, openingLine: number, endLine: number): number | null {
  if (state.sCount[openingLine] - state.blkIndent >= 4) return null

  const openingStart = getLineStart(state, openingLine)
  const openingEnd = getLineEnd(state, openingLine)
  const openingText = state.src.slice(openingStart, openingEnd)
  const singleLine = /^\$\$(.*?)\$\$\s*$/.exec(openingText)
  if (singleLine && singleLine[1].trim()) return openingLine + 1
  if (openingText.trim() !== '$$') return null

  for (let line = openingLine + 1; line < endLine; line += 1) {
    const lineStart = getLineStart(state, line)
    const lineEnd = getLineEnd(state, line)
    if (state.src.slice(lineStart, lineEnd).trim() === '$$') return line + 1
  }

  // An unterminated $$ block is not owned by the Nuvyn math rule, so leave it
  // visible to the normal delimiter scan and preserve the existing fallback.
  return null
}

function findOpaqueBlockEnd(state: StateBlock, line: number, endLine: number): number | null {
  // This order follows the relevant earlier block rules: indented code, the
  // Nuvyn math rule, fenced code, then raw HTML. Each detector only returns a
  // range when the corresponding earlier rule would own the source.
  if (state.sCount[line] - state.blkIndent >= 4) {
    return findIndentedCodeEnd(state, line, endLine)
  }

  const mathEnd = findMathBlockEnd(state, line, endLine)
  if (mathEnd !== null) return mathEnd

  const fencedOpening = parseFencedCodeOpening(state, line)
  if (fencedOpening) {
    const fencedEnd = findFencedCodeEnd(state, line, endLine, fencedOpening)
    // findFencedCodeEnd returns the closing fence line for a closed fence;
    // normalize it to the first line after the opaque range for the scanner.
    return fencedEnd < endLine ? fencedEnd + 1 : endLine
  }

  const htmlOpening = parseHtmlBlockOpening(state, line)
  if (htmlOpening) return findHtmlBlockEnd(state, line, endLine, htmlOpening)

  return null
}

function paragraphTerminatorRules(state: StateBlock) {
  // The Nuvyn rule is itself in the paragraph alt chain. It is already handled
  // by the direct nested-opener path below; probing it here would recursively
  // rediscover the same container while finding its close.
  return state.md.block.ruler
    .getRules('paragraph')
    .filter((rule) => rule !== nuvynContainerRule)
}

function terminatesParagraph(
  state: StateBlock,
  line: number,
  endLine: number,
): boolean {
  const htmlOpening = parseHtmlBlockOpening(state, line)
  const previousParentType = state.parentType
  try {
    // MarkdownIt's paragraph rule supplies this context before it probes the
    // alternate terminator chain. In particular, list probing depends on it.
    state.parentType = 'paragraph'
    const ruleTerminated = paragraphTerminatorRules(state)
      .some((rule) => rule(state, line, endLine, true))

    // The installed html_block rule is authoritative for the probe. Keep the
    // mirrored sequence metadata as an explicit guard so a type-7 match cannot
    // become a paragraph terminator merely because its source looks like HTML.
    return htmlOpening
      ? ruleTerminated && htmlOpening.sequence.canTerminateParagraph
      : ruleTerminated
  } finally {
    state.parentType = previousParentType
  }
}

/**
 * Find a close owned by the current opener. A shorter supported opener starts
 * a nested container and is skipped together with its own matching close. A
 * close is eligible only when its marker is at least as long as the opener's
 * marker, matching MarkdownIt fence ownership semantics.
 */
export function findClosingLine(
  state: StateBlock,
  bodyStart: number,
  endLine: number,
  openerLength: number,
): number {
  let inParagraph = false

  for (let line = bodyStart; line < endLine; line += 1) {
    // The current container close is structural syntax owned by this scan. It
    // remains eligible even when the preceding body line is paragraph text.
    const closing = parseClosing(state, line)
    if (closing && closing.markerLength >= openerLength) return line

    const nested = parseOpening(state, line)
    if (nested && nested.markerLength < openerLength) {
      const nestedClose = findClosingLine(state, line + 1, endLine, nested.markerLength)
      if (nestedClose !== -1) {
        line = nestedClose
        inParagraph = false
        continue
      }
      // An unclosed nested opener is treated as ordinary body text. This lets
      // a later outer close terminate the valid outer container without
      // swallowing the remainder of the document.
    }

    let blockRuleOwned = false
    if (inParagraph) {
      if (state.isEmpty(line)) {
        inParagraph = false
        continue
      }

      // MarkdownIt's paragraph parser treats deeply-indented lines as lazy
      // continuation once a paragraph is already open. Do not manufacture an
      // indented-code opaque range at that position.
      if (state.sCount[line] - state.blkIndent > 3 || state.sCount[line] < 0) {
        continue
      }

      // Use the installed block rules in silent mode, with the same parent
      // type that paragraph.mjs supplies. A non-terminating rule (notably HTML
      // type 7) leaves the line in the current paragraph.
      if (!terminatesParagraph(state, line, endLine)) continue
      inParagraph = false
      blockRuleOwned = true
    } else if (!state.isEmpty(line)) {
      // A heading/list/blockquote/table/etc. can own a line at a block
      // boundary without producing an opaque range. Probe the same paragraph
      // terminator chain so the following line does not inherit a paragraph
      // state that the real block tokenizer would not have.
      blockRuleOwned = terminatesParagraph(state, line, endLine)
    }

    // At a real block boundary, earlier rules may own an entire source range.
    // Only now is it safe to skip indented code, Nuvyn math, fences, or HTML.
    const opaqueEnd = findOpaqueBlockEnd(state, line, endLine)
    if (opaqueEnd !== null) {
      line = opaqueEnd - 1
      inParagraph = false
      continue
    }

    if (!state.isEmpty(line)) inParagraph = !blockRuleOwned
  }
  return -1
}

function pushInlineTitle(state: StateBlock, title: string, startLine: number): void {
  const inline = state.push('inline', '', 0)
  inline.content = title
  inline.map = [startLine, startLine + 1]
  inline.children = []
}

function nuvynContainerRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const opening = parseOpening(state, startLine)
  if (!opening) return false

  const closeLine = findClosingLine(state, startLine + 1, endLine, opening.markerLength)
  if (closeLine === -1) return false
  if (silent) return true

  const definition = CONTAINER_DEFINITIONS[opening.type]
  const openToken = state.push('nuvyn_container_open', definition.tag, 1)
  openToken.attrSet('class', `markdown-container markdown-container-${opening.type}`)
  if (opening.type === 'details' && opening.open) openToken.attrSet('open', 'open')
  openToken.map = [startLine, closeLine + 1]
  openToken.meta = {
    type: opening.type,
    markerLength: opening.markerLength,
    open: opening.open,
  }

  const titleTag = opening.type === 'details' ? 'summary' : 'div'
  const titleOpen = state.push('nuvyn_container_title_open', titleTag, 1)
  titleOpen.attrSet('class', 'markdown-container-title')
  titleOpen.map = [startLine, startLine + 1]
  pushInlineTitle(state, opening.title, startLine)
  const titleClose = state.push('nuvyn_container_title_close', titleTag, -1)
  titleClose.map = [startLine, startLine + 1]

  // Reuse MarkdownIt's current block state and rules for the body. This is
  // what keeps headings, callouts, math, WikiLinks, Shiki fences, Mermaid,
  // and MarkMap in the same document token stream.
  state.md.block.tokenize(state, startLine + 1, closeLine)

  const closeToken = state.push('nuvyn_container_close', definition.tag, -1)
  closeToken.map = [closeLine, closeLine + 1]
  closeToken.meta = {
    type: opening.type,
    markerLength: opening.markerLength,
  }
  state.line = closeLine + 1
  return true
}

export function markdownContainersPlugin(md: MarkdownIt): void {
  // `paragraph` is a named, stable insertion point in MarkdownIt's block
  // ruler. The rule's alt list lets a valid container interrupt a paragraph
  // without depending on incidental numeric ruler indexes.
  md.block.ruler.before(
    'paragraph',
    'nuvyn-container',
    nuvynContainerRule,
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
  )

  md.renderer.rules.nuvyn_container_open = (tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options)
  md.renderer.rules.nuvyn_container_close = (tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options)
  md.renderer.rules.nuvyn_container_title_open = (tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options)
  md.renderer.rules.nuvyn_container_title_close = (tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options)
}

export const __testing__ = {
  CONTAINER_DEFINITIONS,
  parseOpening,
  parseClosing,
  parseFencedCodeOpening,
  findFencedCodeEnd,
  findClosingLine,
}
