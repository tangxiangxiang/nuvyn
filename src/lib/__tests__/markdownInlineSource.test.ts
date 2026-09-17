import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import {
  findMarkdownCodeInlineSourceRanges,
  findMarkdownInlineSourceOwnership,
} from '../markdownInlineSource'

const testMd = new MarkdownIt({ html: true })

function inlineChildren(source: string) {
  const inline = testMd.parse(source, {}).find((token) => token.type === 'inline')
  return inline?.children ?? []
}

function sourceRanges(source: string) {
  return findMarkdownCodeInlineSourceRanges(source, inlineChildren(source), {
    ...testMd.helpers,
    normalizeLink: testMd.normalizeLink.bind(testMd),
  })
}

function sourceOwnership(source: string) {
  return findMarkdownInlineSourceOwnership(source, inlineChildren(source), {
    ...testMd.helpers,
    normalizeLink: testMd.normalizeLink.bind(testMd),
  })
}

describe('MarkdownIt-guided code_inline source ranges', () => {
  it('maps single-line, multi-line, and variable-length spans', () => {
    const singleSource = '`one` and `two`'
    const singleChildren = inlineChildren(singleSource)
    const singleRanges = findMarkdownCodeInlineSourceRanges(singleSource, singleChildren, testMd.helpers)
    expect(singleRanges).toHaveLength(2)
    expect(singleRanges.every(Boolean)).toBe(true)

    const multilineSource = '`one\ntwo`'
    const multilineChildren = inlineChildren(multilineSource)
    const multilineRange = findMarkdownCodeInlineSourceRanges(multilineSource, multilineChildren, testMd.helpers)[0]
    expect(multilineRange).not.toBeNull()
    expect(multilineSource.slice(multilineRange!.start, multilineRange!.end)).toBe(multilineSource)

    const variableSource = '``literal\n` inside\nvalue``'
    const variableChildren = inlineChildren(variableSource)
    const variableRange = findMarkdownCodeInlineSourceRanges(variableSource, variableChildren, testMd.helpers)[0]
    expect(variableRange).not.toBeNull()
    expect(variableRange?.markerLength).toBe(2)
  })

  it('matches MarkdownIt code-span normalization for surrounding spaces', () => {
    const source = '` surrounding `'
    const children = inlineChildren(source)
    expect(children).toMatchObject([
      { type: 'code_inline', content: 'surrounding', markup: '`' },
    ])

    const range = findMarkdownCodeInlineSourceRanges(source, children, testMd.helpers)[0]
    expect(range).not.toBeNull()
    expect(source.slice(range!.start, range!.end)).toBe(source)
  })

  it('maps actual children despite unrelated raw backticks', () => {
    const source = '<span title="`not-code-inline`">x</span> `included\nroot`'
    const children = inlineChildren(source)
    expect(children.filter((child) => child.type === 'html_inline')).not.toHaveLength(0)
    expect(children.filter((child) => child.type === 'code_inline')).toHaveLength(1)

    const ranges = sourceRanges(source)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).not.toBeNull()
    expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('`included\nroot`')
  })

  it('lets html_inline ownership disambiguate identical multiline content', () => {
    const source = '<span title="`same content`">x</span> `same\ncontent`'
    const children = inlineChildren(source)
    expect(children.filter((child) => child.type === 'html_inline')).not.toHaveLength(0)
    expect(children.filter((child) => child.type === 'code_inline')).toHaveLength(1)

    const ranges = sourceRanges(source)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).not.toBeNull()
    expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('`same\ncontent`')
  })

  it('does not let an identical html_inline span impersonate a one-line code span', () => {
    const source = '<span title="`same`">x</span> `same`'
    const ranges = sourceRanges(source)

    expect(ranges).toHaveLength(1)
    expect(ranges[0]).not.toBeNull()
    expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('`same`')
    expect(ranges[0]!.start).toBe(source.lastIndexOf('`same`'))
  })

  it('maps repeated identical code_inline children in actual order', () => {
    const source = '<span title="`same`">x</span> `same` and `same`'
    const ranges = sourceRanges(source)

    expect(ranges).toHaveLength(2)
    expect(ranges.every(Boolean)).toBe(true)
    expect(ranges.map((range) => source.slice(range!.start, range!.end)))
      .toEqual(['`same`', '`same`'])
    expect(ranges[0]!.start).toBe(source.indexOf('`same`', source.indexOf('</span>')))
    expect(ranges[1]!.start).toBe(source.lastIndexOf('`same`'))
  })

  it('consumes multiple html_inline anchors before mapping a later code span', () => {
    const source = '<a title="`same`">a</a> <span title="`same`">b</span> `same`'
    const ranges = sourceRanges(source)

    expect(ranges).toHaveLength(1)
    expect(ranges[0]).not.toBeNull()
    expect(ranges[0]!.start).toBe(source.lastIndexOf('`same`'))
  })

  it('consumes Markdown link titles before matching a later same-content code span', () => {
    const source = '[x](foo "`same`") `same`'
    const children = inlineChildren(source)

    expect(children.filter((child) => child.type === 'link_open')).toHaveLength(1)
    expect(children.filter((child) => child.type === 'link_close')).toHaveLength(1)
    expect(children.filter((child) => child.type === 'code_inline')).toHaveLength(1)

    const ranges = sourceRanges(source)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).not.toBeNull()
    expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('`same`')
    expect(ranges[0]!.start).toBe(source.lastIndexOf('`same`'))
  })

  it('consumes multiline Markdown link titles before matching normalized code content', () => {
    const source = '[x](foo "`same content`") `same\ncontent`'
    const ranges = sourceRanges(source)

    expect(ranges).toHaveLength(1)
    expect(ranges[0]).not.toBeNull()
    expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('`same\ncontent`')
  })

  it('lets the actual child sequence consume a code span before finalizing the outer link label', () => {
    const source = '[x `](foo)`](foo) `same`'
    const children = inlineChildren(source)

    expect(children.map((child) => child.type)).toEqual([
      'link_open',
      'text',
      'code_inline',
      'link_close',
      'text',
      'code_inline',
    ])
    expect(children.filter((child) => child.type === 'code_inline').map((child) => child.content))
      .toEqual(['](foo)', 'same'])

    const ranges = sourceRanges(source)
    expect(ranges).toHaveLength(2)
    expect(ranges.every(Boolean)).toBe(true)
    expect(ranges.map((range) => source.slice(range!.start, range!.end)))
      .toEqual(['`](foo)`', '`same`'])
    expect(ranges[1]!.start).toBeGreaterThanOrEqual(ranges[0]!.end)
  })

  it('keeps later code spans mapped after nested non-code label formatting', () => {
    const source = '[x *em*](foo "`same`") `same`'
    const children = inlineChildren(source)
    expect(children.map((child) => child.type)).toEqual([
      'link_open',
      'text',
      'em_open',
      'text',
      'em_close',
      'link_close',
      'text',
      'code_inline',
    ])

    const ranges = sourceRanges(source)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).not.toBeNull()
    expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('`same`')
    expect(ranges[0]!.start).toBe(source.lastIndexOf('`same`'))
  })

  it('uses the same ownership boundary for image titles', () => {
    const source = '![x](image.png "`same`") `same`'
    const children = inlineChildren(source)
    expect(children.filter((child) => child.type === 'image')).toHaveLength(1)

    const ranges = sourceRanges(source)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).not.toBeNull()
    expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('`same`')
    expect(ranges[0]!.start).toBe(source.lastIndexOf('`same`'))
  })

  it('maps nested image-alt code_inline ranges to outer source coordinates', () => {
    const source = '![x `literal\n<<< @/examples/secret.ts\nliteral`](foo)'
    const children = inlineChildren(source)
    const image = children.find((child) => child.type === 'image')

    expect(image?.content).toBe('x `literal\n<<< @/examples/secret.ts\nliteral`')
    expect(image?.children?.filter((child) => child.type === 'code_inline')).toHaveLength(1)

    const ownership = sourceOwnership(source)
    expect(ownership.topLevelCodeRanges).toEqual([])
    expect(ownership.allCodeRanges).toHaveLength(1)
    expect(source.slice(ownership.allCodeRanges[0]!.start, ownership.allCodeRanges[0]!.end))
      .toBe('`literal\n<<< @/examples/secret.ts\nliteral`')
    expect(ownership.childSourceRanges[0]).not.toBeNull()
    expect(source.slice(
      ownership.childSourceRanges[0]!.start,
      ownership.childSourceRanges[0]!.end,
    )).toBe(source)
  })

  it('uses image children to protect an inner ](foo) and the later code span', () => {
    const source = '![x `](foo)`](foo) `same`'
    const children = inlineChildren(source)
    const image = children.find((child) => child.type === 'image')
    const ownership = sourceOwnership(source)

    expect(image?.children?.filter((child) => child.type === 'code_inline').map((child) => child.content))
      .toEqual(['](foo)'])
    expect(ownership.topLevelCodeRanges).toHaveLength(1)
    expect(ownership.allCodeRanges).toHaveLength(2)
    expect(ownership.allCodeRanges.map((range) => source.slice(range.start, range.end)))
      .toEqual(['`](foo)`', '`same`'])
    expect(ownership.childSourceRanges[0]).not.toBeNull()
    expect(ownership.allCodeRanges[1]!.start)
      .toBeGreaterThanOrEqual(ownership.childSourceRanges[0]!.end)
  })

  it('does not mask plain image alt source without an actual nested code child', () => {
    const source = '![plain alt\n<<< @/real.ts\n](foo)'
    const children = inlineChildren(source)
    const image = children.find((child) => child.type === 'image')

    expect(image?.children?.some((child) => child.type === 'code_inline')).toBe(false)
    expect(sourceOwnership(source).allCodeRanges).toEqual([])
  })

  it('does not manufacture a range for unmatched or unrelated blocks', () => {
    const unmatchedSource = '`unclosed opener'
    expect(sourceRanges(unmatchedSource)).toEqual([])

    const source = '`unclosed opener\n\n`real`'
    const blocks = new MarkdownIt({ html: true }).parse(source, {})
      .filter((token) => token.type === 'inline')
    expect(blocks).toHaveLength(2)
    expect(findMarkdownCodeInlineSourceRanges(blocks[0]!.content, blocks[0]!.children ?? [], testMd.helpers)).toEqual([])
    const ranges = findMarkdownCodeInlineSourceRanges(blocks[1]!.content, blocks[1]!.children ?? [], testMd.helpers)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).not.toBeNull()
  })
})
