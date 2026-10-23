// @vitest-environment jsdom
import guide from '../../../docs/user-guide/markdown.md?raw'
import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import { render } from '../markdown'
import { parseFenceMeta } from '../fenceMeta'
import { parseMarkdownResourceDirective, type MarkdownResourceResolver } from '../markdownResources'
import { __testing__ as headingTesting } from '../markdownHeadings'

// Extract the actual fenced examples with Markdown-it; all syntax assertions
// below use the production parsers/renderers, not a second grammar.
const examples = new MarkdownIt().parse(guide, {}).filter((token) => token.type === 'fence')
const markdownExamples = examples.filter((token) => token.info === 'md').map((token) => token.content)
function exampleContaining(text: string): string {
  const example = markdownExamples.find((example) => example.includes(text))
  expect(example, `Missing fenced Markdown example: ${text}`).toBeDefined()
  return example!
}
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}
const hello = 'first\nsecond\nthird\nfourth\nfifth'
const resolver: MarkdownResourceResolver = {
  async read({ kind, path }) {
    const files: Record<string, string> = {
      'guides/examples/hello.ts': hello,
      'guides/parts/intro.md': '## Included section\n\n[Details](./details.md)\n\n![Image](./diagram.svg)',
      'shared/intro.md': '## Shared section\nShared content',
    }
    if (!(path in files)) throw new Error('Resource not found')
    return { kind, path, content: files[path]! }
  },
}

describe('Markdown user-guide examples', () => {
  it('renders the complete Code Group and accepts one labeled member', async () => {
    const example = exampleContaining('::: code-group')
    const doc = parse(await render(example))
    expect(Array.from(doc.querySelectorAll('[role="tab"]'), (tab) => tab.textContent)).toEqual(['Java', 'Python'])
    expect(doc.querySelectorAll('[role="tabpanel"]')).toHaveLength(2)
    const member = new MarkdownIt().parse(example, {}).find((token) => token.type === 'fence')!
    const single = `::: code-group\n\`\`\`${member.info}\n${member.content}\`\`\`\n:::`
    expect(parse(await render(single)).querySelectorAll('[role="tab"]')).toHaveLength(1)
    expect(parse(await render(example.replace('[Python]', ''))).querySelector('.nuvyn-code-group')).toBeNull()
  })

  it('selects Snippet lines, named regions, language, numbering and labels from the published examples', async () => {
    const simplest = parse(await render(exampleContaining('<<< ./examples/hello.ts\n'), { sourcePath: 'guides/page.md', resourceResolver: resolver }))
    expect(simplest.querySelector('code')?.textContent?.trim()).toBe(hello)
    const selected = parse(await render(exampleContaining('<<< ./examples/hello.ts{2-4}'), { sourcePath: 'guides/page.md', resourceResolver: resolver }))
    expect(Array.from(selected.querySelectorAll('code'), (code) => code.textContent?.trim())).toEqual([
      'second\nthird\nfourth', 'first\nthird\nfourth', 'third\nfourth\nfifth',
    ])
    const region = examples.find((token) => token.info === 'ts' && token.content.startsWith('// #region greeting'))!
    expect(region).toBeDefined()
    const regionDoc = parse(await render(exampleContaining('<<< ./examples/hello.ts#greeting'), {
      sourcePath: 'guides/page.md', resourceResolver: { async read({ kind, path }) { return { kind, path, content: region.content } } },
    }))
    expect(regionDoc.querySelector('code')?.textContent).toContain('export function greet()')
    expect(regionDoc.querySelector('code')?.textContent).not.toContain('#region')
    const annotated = exampleContaining('<<< ./examples/hello.ts{2-4 typescript:line-numbers=10} [Greeting]')
    expect(parseMarkdownResourceDirective(annotated.trim())).toMatchObject({
      explicitLanguage: 'typescript', fenceModifiers: [':line-numbers=10'], label: 'Greeting',
      selection: { ranges: [{ start: 2, end: 4 }] },
    })
    const annotatedDoc = parse(await render(annotated, { sourcePath: 'guides/page.md', resourceResolver: resolver }))
    // Shiki also numbers the final empty line produced by the fence newline.
    expect(Array.from(annotatedDoc.querySelectorAll('.nuvyn-line-number'), (line) => line.textContent)).toEqual(['10', '11', '12', '13'])
    const grouped = parse(await render(`::: code-group\n${annotated.trim()}\n:::`, { sourcePath: 'guides/page.md', resourceResolver: resolver }))
    expect(grouped.querySelector('[role="tab"]')?.textContent).toBe('Greeting')
  })

  it('expands Include examples and resolves their headings, links and images at the included source', async () => {
    const seenSources: string[] = []
    const doc = parse(await render(exampleContaining('<!--@include: ./parts/intro.md-->'), {
      sourcePath: 'guides/page.md', resourceResolver: resolver,
      resolver: (ref, _anchor, context) => {
        seenSources.push(context?.sourcePath ?? '')
        return { target: ref }
      },
    }))
    expect(doc.querySelector('h2')?.id).toBe('included-section')
    expect(seenSources).toContain('guides/parts/intro.md')
    const image = doc.querySelector('img')!
    expect(new URL(image.getAttribute('src')!, 'https://nuvyn.test').searchParams.get('path')).toBe('guides/parts/diagram.svg')
    const root = parse(await render(exampleContaining('<!--@include: @/shared/intro.md-->'), { sourcePath: 'guides/page.md', resourceResolver: resolver }))
    expect(root.querySelector('h2')?.id).toBe('shared-section')
  })

  it('renders documented fence metadata and source annotations without widening their grammar', async () => {
    const example = exampleContaining('ts:line-numbers=10 {2,4-5} [example.ts]')
    const fences = new MarkdownIt().parse(example, {}).filter((token) => token.type === 'fence')
    expect(parseFenceMeta(fences[0]!.info)).toMatchObject({ language: 'ts', lineNumberStart: 10, highlightRanges: [2, 4, 5], label: 'example.ts', malformed: [] })
    expect(parseFenceMeta(fences[1]!.info)).toMatchObject({ lineNumbers: 'off', malformed: [] })
    const doc = parse(await render(example))
    expect(Array.from(doc.querySelectorAll('.nuvyn-line-number'), (line) => line.textContent)).toEqual(['10', '11', '12', '13', '14', '15'])
    expect(doc.querySelectorAll('.line.highlighted')).toHaveLength(3)
    const notation = parse(await render(exampleContaining('const oldValue = 1 // [!code --]')))
    expect(notation.querySelectorAll('.line.diff.remove')).toHaveLength(1)
    expect(notation.querySelectorAll('.line.diff.add')).toHaveLength(1)
    expect(notation.querySelectorAll('.line.focused')).toHaveLength(2)
    expect(notation.querySelectorAll('.line.highlighted')).toHaveLength(1)
    expect(notation.querySelector('code')?.textContent).not.toContain('[!code --]')
    for (const invalid of ['ts {3-1}', 'ts {0}', 'ts:line-numbers=0']) expect(parseFenceMeta(invalid).malformed.length).toBeGreaterThan(0)
  })

  it('uses the documented heading ID and keeps invalid markers as visible text', async () => {
    const doc = parse(await render(exampleContaining('## 数据库事务 {#database-transaction}')))
    expect(doc.querySelector('h2')?.id).toBe('database-transaction')
    expect(doc.querySelector('h2')?.textContent).toBe('数据库事务')
    expect(doc.querySelector('a[href="#database-transaction"]')).not.toBeNull()
    expect(doc.querySelector('.wiki-link')?.getAttribute('data-anchor')).toBe('database-transaction')
    for (const text of ['Title {#123}', 'Title{#stable}']) {
      expect(headingTesting.parseCustomAnchorSource(text)).toBeNull()
      expect(parse(await render(`## ${text}`)).querySelector('h2')?.textContent).toBe(text)
    }
  })
})
