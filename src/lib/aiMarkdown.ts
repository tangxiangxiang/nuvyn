import MarkdownIt from 'markdown-it'

// AI output is model-generated and may echo text from files or tool results.
// Keep raw HTML disabled here; this is intentionally stricter than the
// document renderer's allowlisted HTML + sanitizer pipeline.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
})

export function renderAiMarkdown(source: string): string {
  return md.render(source)
}
