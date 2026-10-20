import MarkdownIt from 'markdown-it'
import { markdownContainersPlugin } from './markdownContainers'
import { markdownCodeGroupsPlugin } from './markdownCodeGroups'
import { mathPlugin } from './math'

export const MARKDOWN_FOLDING_LIMIT = 500_000

export interface MarkdownFoldRange {
  start: number
  end: number
  kind: 'region' | 'comment'
}

// Source-only parsing: no HTML rendering, highlighting, Include fetches or YAML
// decoding. Use the same block rules as Reader, including opaque code groups.
const parser = new MarkdownIt({ html: true })
  .use(markdownContainersPlugin)
  .use(markdownCodeGroupsPlugin)
  .use(mathPlugin)

export function markdownFoldingRanges(source: string): MarkdownFoldRange[] {
  if (!source || source.length >= MARKDOWN_FOLDING_LIMIT) return []
  const lines = source.split(/\r\n|\r|\n/)
  let offset = 0
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close !== -1) offset = close + 1
  }
  const tokens = parser.parse(lines.slice(offset).join('\n'), {})
  const ranges: MarkdownFoldRange[] = []
  type Section = { level: number; start: number }
  type Scope = { end: number; sections: Section[] }
  const scopes: Scope[] = [{ end: lines.length, sections: [] }]
  function add(start: number, end: number) {
    while (end > start && !lines[end - 1]?.trim()) end -= 1
    if (start < end && start >= 1 && end <= lines.length) ranges.push({ start, end, kind: 'region' })
  }
  function closeSections(scope: Scope, end: number, level = 0) {
    while (scope.sections.length && scope.sections.at(-1)!.level >= level) {
      add(scope.sections.pop()!.start, end)
    }
  }
  for (const token of tokens) {
    if (token.nesting === -1) {
      const scope = scopes.pop()
      if (scope) closeSections(scope, scope.end)
      continue
    }
    const scope = scopes.at(-1)!
    const map = token.map
    if (map) {
      const start = offset + map[0] + 1
      const end = offset + map[1]
      if (token.type === 'heading_open') {
        const level = Number(token.tag.slice(1))
        closeSections(scope, start - 1, level)
        scope.sections.push({ start, level })
      }
      if (token.type === 'fence') add(start, end)
    }
    if (token.nesting === 1) {
      scopes.push({
        // A section inside a container cannot consume its closing delimiter.
        end: map ? Math.min(scope.end, offset + map[1] - (token.type.startsWith('nuvyn_') ? 1 : 0)) : scope.end,
        sections: [],
      })
    }
  }
  closeSections(scopes[0], lines.length)
  // Monaco allows only one region per start line; keep properly nested ranges.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const result: MarkdownFoldRange[] = []
  const stack: MarkdownFoldRange[] = []
  for (const range of ranges) {
    if (result.at(-1)?.start === range.start) continue
    while (stack.length && range.start > stack.at(-1)!.end) stack.pop()
    if (stack.length && range.end > stack.at(-1)!.end) continue
    result.push(range)
    stack.push(range)
  }
  return result
}
