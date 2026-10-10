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

export function renderAiMarkdown(source: string, options: { resolver?: Resolver; sourcePath?: string } = {}): string {
  const env: WikiLinkEnv = {
    wikiResolver: options.resolver,
    resourceSourcePathByLine: source.split('\n').map(() => options.sourcePath),
    deferWikiResolution: !!options.sourcePath,
  }
  return md.render(source, env)
}
