import type { ITransformHooks, ITransformPlugin } from 'markmap-lib'
import { createMarkdownSanitizer, type MarkdownSanitizer } from './markdown'

interface RawHtmlToken {
  type: string
  content: string
  meta?: Record<string, unknown>
  children?: RawHtmlToken[] | null
}

/*
 * Markmap renders Markdown after the main Nuvyn v-html sanitizer has run.
 * Keep the security boundary at MarkdownIt's author-controlled raw HTML
 * tokens, before trusted Markmap plugins render their output.
 *
 * Do not move this to the transformed tree: node.content is a mixture of
 * author HTML, MarkdownIt output, highlight output, and trusted KaTeX/plugin
 * output by that point. Blanket-sanitizing it removes KaTeX's layout styles.
 */
export function sanitizeMarkmapRawHtml(
  html: string,
  sanitizer?: MarkdownSanitizer,
): string {
  try {
    return (sanitizer ?? createMarkdownSanitizer())(html)
  } catch {
    /* A sanitizer failure must not turn user-authored raw HTML into a
       Markmap crash. An empty fragment is the safe fallback. Renderer
       errors happen before this function and are intentionally not caught. */
    return ''
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function sanitizeOpeningTag(
  raw: string,
  sanitizer: MarkdownSanitizer,
): { html: string } | null {
  const match = /^<\s*([A-Za-z][A-Za-z0-9:-]*)(?:\s|\/?>)/.exec(raw)
  if (!match || typeof DOMParser === 'undefined') return null
  const requestedTagName = match[1]!.toLowerCase()
  const sanitized = sanitizeMarkmapRawHtml(`<div>${raw}</div>`, sanitizer)
  if (!sanitized) return null

  /* DOMPurify serializes an allowed opening tag as a complete element when
     it is sanitized in isolation. Parse that result only to recover the
     sanitized opening tag; never copy author attributes directly. */
  const parsed = new DOMParser().parseFromString(sanitized, 'text/html')
  const wrapper = parsed.body.firstElementChild
  const element = wrapper?.firstElementChild
  if (!element || element.tagName.toLowerCase() !== requestedTagName) return null

  const attrs = Array.from(element.attributes)
    .map((attr) => ` ${attr.name}="${escapeAttribute(attr.value)}"`)
    .join('')
  const tagName = element.tagName.toLowerCase()
  return { html: `<${tagName}${attrs}>` }
}

function isAllowedClosingTag(tagName: string, sanitizer: MarkdownSanitizer): boolean {
  if (typeof DOMParser === 'undefined') return false
  const sanitized = sanitizeMarkmapRawHtml(`<div><${tagName}>x</${tagName}></div>`, sanitizer)
  if (!sanitized) return false
  const parsed = new DOMParser().parseFromString(sanitized, 'text/html')
  const element = parsed.body.firstElementChild?.firstElementChild
  return element?.tagName.toLowerCase() === tagName
}

function sanitizeRawInlineToken(raw: string, sanitizer: MarkdownSanitizer): string {
  try {
    const closing = /^<\s*\/\s*([A-Za-z][A-Za-z0-9:-]*)\s*>$/.exec(raw)
    if (closing) {
      const tagName = closing[1]!.toLowerCase()
      return isAllowedClosingTag(tagName, sanitizer) ? `</${tagName}>` : ''
    }

    const opening = sanitizeOpeningTag(raw, sanitizer)
    if (opening) return opening.html

    /* Comments, declarations, malformed fragments, and forbidden tags all
       reach the shared policy as a safe fallback. Do not copy raw HTML here. */
    return sanitizeMarkmapRawHtml(raw, sanitizer)
  } catch {
    /* DOMParser failures are part of the raw-HTML boundary too: fail closed
       for that fragment without swallowing Transformer programming errors. */
    return ''
  }
}

/* markmap-lib's checkbox plugin replaces a leading `[x] ` / `[ ] ` with a
   trusted inline SVG before MarkdownIt's inline parser runs. The fragment
   consequently arrives as an html_inline token even though it did not come
   from author HTML. We carry a provenance marker on the parent and exempt
   only the generated checkbox child. Author HTML following the checkbox
   remains subject to the sanitizer. */
const TRUSTED_CHECKBOX_META = 'nuvynTrustedMarkmapCheckbox'
const TRUSTED_CHECKBOX_SVG_PREFIX = '<svg width="16" height="16" viewBox="0 -3 24 24">'
const TRUSTED_CHECKBOX_SVG_TOKEN_COUNT = 3

function markCheckboxParents(tokens: RawHtmlToken[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token?.type !== 'inline' || !token.content) continue
    const previousType = tokens[index - 1]?.type
    const previousPreviousType = tokens[index - 2]?.type
    const checkboxPosition =
      previousType === 'heading_open'
      || previousType === 'paragraph_open' && previousPreviousType === 'list_item_open'
    if (checkboxPosition && /^\[( |x)\] /.test(token.content)) {
      token.meta = { ...(token.meta ?? {}), [TRUSTED_CHECKBOX_META]: true }
    }
  }
}

function markTrustedCheckboxChildren(tokens: RawHtmlToken[]): void {
  for (const token of tokens) {
    if (token.type !== 'inline' || token.meta?.[TRUSTED_CHECKBOX_META] !== true || !token.children) continue
    /* markdown-it 14 exposes the generated SVG's three tag tokens as the
       leading html_inline children. Mark exactly that known Markmap 0.18.x
       output, so author HTML immediately after the checkbox label remains
       sanitized rather than becoming part of a broad SVG exemption. */
    if (!token.content.startsWith(TRUSTED_CHECKBOX_SVG_PREFIX)) continue
    for (const child of token.children.slice(0, TRUSTED_CHECKBOX_SVG_TOKEN_COUNT)) {
      if (child.type !== 'html_inline') break
      child.meta = { ...(child.meta ?? {}), [TRUSTED_CHECKBOX_META]: true }
    }
  }
}

function sanitizeRawHtmlTokens(tokens: RawHtmlToken[], sanitizer: MarkdownSanitizer): void {
  for (const token of tokens) {
    if (token.type === 'html_block') {
      token.content = sanitizeMarkmapRawHtml(token.content, sanitizer)
    } else if (token.type === 'html_inline' && token.meta?.[TRUSTED_CHECKBOX_META] !== true) {
      token.content = sanitizeRawInlineToken(token.content, sanitizer)
    }
    if (token.children) sanitizeRawHtmlTokens(token.children, sanitizer)
  }
}

export function installMarkmapSecurity(transformHooks: ITransformHooks): void {
  transformHooks.parser.tap((md) => {
    /* Create one sanitizer per Transformer/parser. The policy remains the
       shared Nuvyn Markdown policy; this entry point only narrows where it
       is applied. */
    let sanitizer: MarkdownSanitizer
    try {
      sanitizer = createMarkdownSanitizer()
    } catch {
      sanitizer = () => ''
    }

    /* The checkbox plugin mutates `[x]` / `[ ]` before inline parsing. Record
       that narrow provenance before its core rule, then identify its
       generated SVG child after parsing. KaTeX has not rendered yet, and
       its generated HTML therefore never passes through this raw boundary. */
    md.core.ruler.before('checkbox', 'nuvyn-markmap-prepare-checkbox', (state) => {
      markCheckboxParents(state.tokens as RawHtmlToken[])
    })
    /* Sanitize raw HTML token content now, before MarkdownIt's renderer and
       before KaTeX renderer output exists. Trusted checkbox SVG is carried by
       a marked inline token and is therefore not passed through this step. */
    md.core.ruler.after('inline', 'nuvyn-markmap-sanitize-raw-html', (state) => {
      sanitizeRawHtmlTokens(state.tokens as RawHtmlToken[], sanitizer)
    })
    /* Make the provenance-before-sanitizer ordering explicit. This is a
       parser-stage ordering concern, not a final-tree sanitizer exception. */
    md.core.ruler.before('nuvyn-markmap-sanitize-raw-html', 'nuvyn-markmap-mark-checkbox-output', (state) => {
      markTrustedCheckboxChildren(state.tokens as RawHtmlToken[])
    })
  })

  transformHooks.beforeParse.tap((_md, context) => {
    /* Markmap's npm-url plugin treats these frontmatter fields as author
       supplied assets. Nuvyn knowledge-base Markdown must not be able to
       execute arbitrary remote JavaScript or load arbitrary remote CSS.
       Built-in KaTeX/highlight assets are independent and remain available
       through Transformer.getUsedAssets(features). */
    const markmap = context.frontmatter?.markmap
    if (markmap && typeof markmap === 'object') {
      delete markmap.extraJs
      delete markmap.extraCss
    }
  })
}

export const nuvynMarkmapSecurityPlugin: ITransformPlugin = {
  name: 'nuvynSecurity',
  transform(transformHooks) {
    installMarkmapSecurity(transformHooks)
    return {}
  },
}
