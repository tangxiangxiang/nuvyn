import { describe, expect, it } from 'vitest'
import { markdownFoldingRanges, MARKDOWN_FOLDING_LIMIT } from '../markdownFolding'

const pairs = (source: string) => markdownFoldingRanges(source).map(({ start, end }) => [start, end])

describe('Markdown source folding', () => {
  it('uses heading hierarchy, including H1–H6, Setext and custom anchors', () => {
    expect(pairs('# A\nbody\n## B {#id}\nchild\n### C\nleaf\n# D\nend'))
      .toEqual([[1, 6], [3, 6], [5, 6], [7, 8]])
    expect(pairs('标题\n====\n正文\n\n中文\n----\n内容\n###### Six\nlast'))
      .toEqual([[1, 9], [5, 9], [8, 9]])
  })

  it('ignores pseudo headings in fenced and indented code and raw HTML', () => {
    expect(pairs('```md\n# fake\n~~~\n```\n\n    # code\n    more\n\n<div>\n# HTML\n</div>'))
      .toEqual([[1, 4]])
    expect(pairs('~~~md\n# fake\ntext')).toEqual([[1, 3]])
    expect(pairs('`# inline`')).toEqual([])
    expect(pairs('$$\n# not a heading\n$$')).toEqual([])
  })

  it('does not add dedicated folds for lists, tasks or multi-paragraph items', () => {
    const source = '- [ ] parent\n  - child\n    continuation\n\n  paragraph\n- [x] next\n\n1. first\n2. second'
    expect(pairs(source)).toEqual([])
    expect(pairs('- one')).toEqual([])
    expect(pairs('* one\n* two\n\n+ three\n+ four')).toEqual([])
  })

  it('does not add dedicated folds for quotes or Alerts', () => {
    expect(pairs('> [!NOTE]\n> first\n>\n> > inner\n> > second\n>\n> tail'))
      .toEqual([])
  })

  it('respects extension boundaries and ignores syntax inside fences', () => {
    const source = ':::: flex\n::: info Title\n## Inside\nbody\n:::\n::::\n\n## Outside\ntext'
    expect(pairs(source)).toEqual([[3, 4], [8, 9]])
    expect(pairs('::: code-group\n```ts [A]\na\n```\n```js [B]\nb\n```\n:::'))
      .toEqual([[2, 4], [5, 7]])
    expect(pairs('```md\n::: info\n# fake\n:::\n```')).toEqual([[1, 5]])
    expect(pairs('::: info\nbody')).toEqual([])
  })

  it('excludes Frontmatter without losing source line offsets', () => {
    expect(pairs('---\ntitle: Test\n# not a heading\n---\n# Body\ncontent'))
      .toEqual([[5, 6]])
  })

  it('returns legal, nested ranges and identical LF/CRLF results', () => {
    const source = '# A\n\n> ## Quote\n>\n> body\n\n# B\n\n::: details title\nbody\n:::'
    const ranges = markdownFoldingRanges(source)
    expect(markdownFoldingRanges(source.replaceAll('\n', '\r\n'))).toEqual(ranges)
    expect(new Set(ranges.map((range) => range.start)).size).toBe(ranges.length)
    for (const range of ranges) {
      expect(range.end).toBeGreaterThan(range.start)
      expect(range.end).toBeLessThanOrEqual(source.split('\n').length)
      for (const later of ranges.filter((candidate) => candidate.start > range.start && candidate.start <= range.end)) {
        expect(later.end).toBeLessThanOrEqual(range.end)
      }
    }
  })

  it('does not parse empty, single-line or protected large documents', () => {
    expect(pairs('')).toEqual([])
    expect(pairs('# Only')).toEqual([])
    expect(pairs(`# A\n${'x'.repeat(MARKDOWN_FOLDING_LIMIT)}`)).toEqual([])
  })
})
