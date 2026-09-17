import MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'

export const CALLOUT_TYPES = {
  NOTE: { title: '注意' },
  TIP: { title: '提示' },
  IMPORTANT: { title: '重要' },
  WARNING: { title: '警告' },
  CAUTION: { title: '小心' },
} as const

export type CalloutType = keyof typeof CALLOUT_TYPES

interface CalloutMeta {
  type: CalloutType
  title: string
}

interface CalloutMarker {
  type: CalloutType
  title: string
  bodyStart: number
}

/* A marker must occupy the beginning of the first paragraph and be the only
   content on its source line. Matching is intentionally exact and
   case-sensitive: unsupported, legacy, folded, and titled markers remain
   ordinary blockquotes. */
const CALLOUT_MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function parseMarker(content: string): CalloutMarker | null {
  const match = CALLOUT_MARKER_RE.exec(content)
  if (!match) return null
  const type = match[1] as CalloutType
  const title = CALLOUT_TYPES[type].title
  return { type, title, bodyStart: match[0].length }
}

function stripMarker(inline: {
  content: string
  children: Array<{ type: string; content: string }> | null
}, marker: CalloutMarker): void {
  inline.content = inline.content.slice(marker.bodyStart)
  const children = inline.children ?? []
  const breakIndex = children.findIndex((token) => token.type === 'softbreak' || token.type === 'hardbreak')
  inline.children = breakIndex === -1 ? [] : children.slice(breakIndex + 1)
}

function isCalloutMeta(value: unknown): value is CalloutMeta {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CalloutMeta>
  return typeof candidate.type === 'string'
    && Object.prototype.hasOwnProperty.call(CALLOUT_TYPES, candidate.type)
    && typeof candidate.title === 'string'
}

function transformCallouts(state: StateCore): void {
  const tokens = state.tokens
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index]
    if (open.type !== 'blockquote_open') continue

    const paragraphOpen = tokens[index + 1]
    const inline = tokens[index + 2]
    const paragraphClose = tokens[index + 3]
    if (
      paragraphOpen?.type !== 'paragraph_open'
      || inline?.type !== 'inline'
      || paragraphClose?.type !== 'paragraph_close'
    ) continue

    const marker = parseMarker(inline.content)
    if (!marker) continue

    const meta: CalloutMeta = { type: marker.type, title: marker.title }
    // Preserve metadata added by another core rule. `Token.meta` is a
    // shared extension point in markdown-it; replacing it would silently
    // discard unrelated plugin state when callouts are transformed.
    open.meta = { ...open.meta, callout: meta }

    const closeIndex = findMatchingBlockquoteClose(tokens, index)
    if (closeIndex !== -1) {
      const close = tokens[closeIndex]
      close.meta = { ...close.meta, callout: meta }
    }

    stripMarker(inline, marker)
    if (inline.children?.length === 0) {
      // A marker-only first paragraph would otherwise leave an empty <p>
      // before the actual content (or an empty content block for a title-only
      // callout). Keep the remaining block tokens intact.
      tokens.splice(index + 1, 3)
    }
  }
}

function findMatchingBlockquoteClose(
  tokens: StateCore['tokens'],
  openIndex: number,
): number {
  let depth = 0
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'blockquote_open') depth += 1
    else if (token.type === 'blockquote_close') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

export function calloutPlugin(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'nuvyn-callouts', transformCallouts)

  const previousOpen = md.renderer.rules.blockquote_open
  const previousClose = md.renderer.rules.blockquote_close

  md.renderer.rules.blockquote_open = (tokens, index, options, env, self) => {
    const meta = tokens[index].meta?.callout
    if (!isCalloutMeta(meta)) {
      return previousOpen
        ? previousOpen(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options)
    }
    return `<div class="callout callout-${meta.type.toLowerCase()}">\n`
      + '<div class="callout-title">'
      + `<span class="callout-title-text">${escapeHtml(meta.title)}</span>`
      + '</div>\n'
      + '<div class="callout-content">\n'
  }

  md.renderer.rules.blockquote_close = (tokens, index, options, env, self) => {
    const meta = tokens[index].meta?.callout
    if (!isCalloutMeta(meta)) {
      return previousClose
        ? previousClose(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options)
    }
    return '</div>\n</div>\n'
  }
}
