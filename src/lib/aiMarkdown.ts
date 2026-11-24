import MarkdownIt from 'markdown-it'
import { wikiLinkPlugin, type Resolver, type WikiLinkEnv } from './wikiLinks'

// AI output is model-generated and may echo text from files or tool results.
// Keep raw HTML disabled here; this is intentionally stricter than the
// document renderer's allowlisted HTML + sanitizer pipeline.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
})
md.use(wikiLinkPlugin)
md.renderer.rules.table_open = (tokens, index, options, env, renderer) =>
  ((env as AiMarkdownEnv).finance ? '<div class="ai-table-scroll" tabindex="0">' : '') +
  renderer.renderToken(tokens, index, options)
md.renderer.rules.table_close = (tokens, index, options, env, renderer) =>
  renderer.renderToken(tokens, index, options) + ((env as AiMarkdownEnv).finance ? '</div>' : '')

md.renderer.rules.td_open = (tokens, index, options, env, renderer) => {
  const cell = tokens[index]
  const text = tokens[index + 1]?.content.replace(/\*\*/g, '').trim()
  // Respect explicit Markdown alignment and align standalone amounts and percentages.
  if ((env as AiMarkdownEnv).finance && !cell.attrGet('style') &&
      text && /^[+−-]?[¥￥$€£]?[+−-]?\d[\d,]*(?:\.\d+)?(?:%|％)?$/u.test(text)) {
    cell.attrSet('class', 'ai-finance-number')
  }
  return renderer.renderToken(tokens, index, options)
}

interface AiMarkdownEnv extends WikiLinkEnv {
  finance?: boolean
}

export function renderAiMarkdown(source: string, options: { resolver?: Resolver; sourcePath?: string; finance?: boolean } = {}): string {
  const env: AiMarkdownEnv = {
    finance: options.finance,
    wikiResolver: options.resolver,
    resourceSourcePathByLine: source.split('\n').map(() => options.sourcePath),
    deferWikiResolution: !!options.sourcePath,
  }
  return md.render(source, env)
}
