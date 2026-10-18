import type MarkdownIt from 'markdown-it'
import katex from 'katex'
import { mathPlugin } from './math'
import { highlightShikiFence } from './shiki'

/** Reuse the existing MarkMap parser, local KaTeX and Shiki instead of its
 * browser plugins' CDN autoloaders. Reader and PDF keep their current plugins. */
export function installOfflineMarkmapParser(md: MarkdownIt): void {
  md.use(mathPlugin)
  for (const kind of ['math_inline', 'math_block']) {
    md.renderer.rules[kind] = (tokens, index) => katex.renderToString(tokens[index].content, {
      displayMode: kind === 'math_block', trust: false, throwOnError: true,
    })
  }
  md.set({ highlight: (source, language) => highlightShikiFence(source, language) ?? md.utils.escapeHtml(source) })
  // D3 inserts node labels outside the main article image deferral. Reject
  // unsupported image-bearing labels before insertion, never after a request.
  md.core.ruler.after('inline', 'nuvyn-offline-images', (state) => {
    const inspect = (tokens: typeof state.tokens): void => {
      for (const token of tokens) {
        if (token.type === 'image' || (token.type.startsWith('html_') && /<\s*(?:img|image|iframe)\b/iu.test(token.content))) throw new Error('HTML_EXPORT_MARKMAP_IMAGE_UNSUPPORTED')
        if (token.children) inspect(token.children)
      }
    }
    inspect(state.tokens)
  })
}
