import { describe, expect, it, vi } from 'vitest'
import {
  filterMarkdownSlashCommands, indentMarkdownLine, MARKDOWN_SLASH_COMMANDS, MARKDOWN_WRAPS, markdownContinuation, markdownDecorationSpecs, markdownHeadingTargets, writingDiagnostics,
  advanceMarkdownFenceState, getEmojiCompletionContext, isInsideMarkdownInlineCode, isMarkdownFenceMarkerLine, markdownLinkFromPaste, MarkdownFenceStateCache, markdownWrapEdit, rankWikiTargets, toggleMarkdownWrap, wikiLinkAtColumn,
} from '../monacoMarkdown'

describe('Monaco Markdown helpers', () => {
  it('continues bullets, ordered lists, and task lists', () => {
    expect(markdownContinuation('- item')).toEqual({ insert: '\n- ' })
    expect(markdownContinuation('  3. item')).toEqual({ insert: '\n  4. ' })
    expect(markdownContinuation('- [x] done')).toEqual({ insert: '\n- [ ] ' })
  })

  it('exits an empty list item', () => {
    expect(markdownContinuation('  - ')).toEqual({ insert: '\n', removeMarkerFrom: 2 })
  })

  it('turns a URL pasted over selected text into a Markdown link', () => {
    expect(markdownLinkFromPaste('OpenAI', 'https://openai.com')).toBe('[OpenAI](https://openai.com)')
    expect(markdownLinkFromPaste('', 'https://openai.com')).toBeNull()
    expect(markdownLinkFromPaste('OpenAI', 'plain text')).toBeNull()
  })

  it('indents and outdents Markdown list lines', () => {
    expect(indentMarkdownLine('- item', false)).toBe('  - item')
    expect(indentMarkdownLine('  - item', true)).toBe('- item')
    expect(indentMarkdownLine('    - item', false)).toBe('        - item')
    expect(indentMarkdownLine('    - item', true)).toBe('- item')
    expect(indentMarkdownLine('\t- item', false)).toBe('\t\t- item')
    expect(indentMarkdownLine('\t- item', true)).toBe('- item')
  })

  it('filters slash commands by English labels and Chinese details', () => {
    expect(filterMarkdownSlashCommands('head').map((item) => item.label)).toEqual([
      'heading 1', 'heading 2', 'heading 3',
    ])
    expect(filterMarkdownSlashCommands('图表').map((item) => item.label)).toEqual(['mermaid'])
    expect(filterMarkdownSlashCommands('提示').map((item) => item.label)).toEqual(['callout'])
    expect(filterMarkdownSlashCommands('callout')).toEqual([
      { label: 'callout', detail: '提示块', insertText: '> [!NOTE]\n> ${1:Content}' },
    ])
    expect(filterMarkdownSlashCommands('math').map((item) => item.label)).toEqual(['inline math', 'math block'])
    expect(filterMarkdownSlashCommands('公式')).toEqual([
      { label: 'inline math', detail: '行内公式', insertText: '$${1:x + y}$' },
      { label: 'math block', detail: '块级公式', insertText: '$$\n${1:E = mc^2}\n$$' },
    ])
    expect(filterMarkdownSlashCommands('footnote').map((item) => item.label)).toEqual(['footnote'])
    expect(filterMarkdownSlashCommands('highlight').map((item) => item.label)).toEqual(['highlight'])
    expect(filterMarkdownSlashCommands('definition').map((item) => item.label)).toEqual(['definition list'])
    expect(filterMarkdownSlashCommands('wiki').map((item) => item.label)).toEqual(['wiki link'])
    expect(filterMarkdownSlashCommands('高亮').map((item) => item.label)).toEqual(['highlight'])
    expect(filterMarkdownSlashCommands('')).toHaveLength(MARKDOWN_SLASH_COMMANDS.length)
    expect(filterMarkdownSlashCommands('emoji')).toEqual([{
      label: 'emoji', detail: '表情', insertText: ':',
      command: { id: 'editor.action.triggerSuggest', title: 'Trigger Emoji completion' },
    }])
  })

  it('extracts safe Emoji completion context and suppresses colon noise', () => {
    expect(getEmojiCompletionContext(':smi', 5)).toMatchObject({
      query: 'smi', startColumn: 2, endColumn: 5, valid: true,
    })
    expect(getEmojiCompletionContext('今天 :rocket', 11)).toMatchObject({ query: 'rocket', valid: true })
    expect(getEmojiCompletionContext(':+1', 4)).toMatchObject({ query: '+1', valid: true })
    expect(getEmojiCompletionContext(':', 2)).toMatchObject({ valid: false, reason: 'empty-query' })
    expect(getEmojiCompletionContext(':', 2, { explicitInvocation: true })).toMatchObject({ valid: true, query: '' })

    for (const value of [
      'https://example.com/:rocket',
      '[https://example.com/:rocket',
      '<https://example.com/:rocket',
      '12:30',
      '2026-08-12T14:30',
      'key:value',
      'key: value',
      'foo::bar',
      '::1',
      'C:\\Users',
      'color: red',
    ]) {
      expect(getEmojiCompletionContext(value, value.length + 1).valid, value).toBe(false)
    }
  })

  it('guards inline code and bounded fenced-code contexts', () => {
    expect(isInsideMarkdownInlineCode('`foo :smi')).toBe(true)
    expect(isInsideMarkdownInlineCode('``foo :smi')).toBe(true)
    expect(isInsideMarkdownInlineCode('`foo` :smi')).toBe(false)
    expect(getEmojiCompletionContext('`foo :smi', 10)).toMatchObject({ valid: false, reason: 'inline-code' })
    expect(getEmojiCompletionContext(':smi', 5, { inFencedCode: true })).toMatchObject({ valid: false, reason: 'fenced-code' })
  })

  it('tracks Markdown fence state with CommonMark-compatible marker rules', () => {
    expect(advanceMarkdownFenceState('```js', null)).toEqual({ character: '`', length: 3 })
    expect(advanceMarkdownFenceState('~~~js', null)).toEqual({ character: '~', length: 3 })
    expect(advanceMarkdownFenceState('``', { character: '`', length: 3 })).toEqual({ character: '`', length: 3 })
    expect(advanceMarkdownFenceState('~~~', { character: '`', length: 3 })).toEqual({ character: '`', length: 3 })
    expect(advanceMarkdownFenceState('```not-close', { character: '`', length: 3 })).toEqual({ character: '`', length: 3 })
    expect(advanceMarkdownFenceState('````', { character: '`', length: 3 })).toBeNull()
    expect(advanceMarkdownFenceState('```  ', { character: '`', length: 3 })).toBeNull()
    expect(advanceMarkdownFenceState('~~~', { character: '~', length: 3 })).toBeNull()
    expect(isMarkdownFenceMarkerLine('```js')).toBe(true)
    expect(isMarkdownFenceMarkerLine('  ~~~')).toBe(true)
    expect(isMarkdownFenceMarkerLine('    ```js')).toBe(false)
  })

  it('caches fence state by line and invalidates only from the changed line', () => {
    const lines = ['```text', 'code', '```', ':smi']
    const cache = new MarkdownFenceStateCache()
    const getLineContent = vi.fn((lineNumber: number) => lines[lineNumber - 1] ?? '')

    expect(cache.isInsideOrOnFenceLine(2, getLineContent)).toBe(true)
    expect(cache.isInsideOrOnFenceLine(4, getLineContent)).toBe(false)
    const readsAfterFirstScan = getLineContent.mock.calls.length
    expect(cache.isInsideOrOnFenceLine(4, getLineContent)).toBe(false)
    expect(getLineContent).toHaveBeenCalledTimes(readsAfterFirstScan + 1)

    lines[2] = 'code'
    cache.invalidateFrom(3)
    expect(cache.isInsideOrOnFenceLine(4, getLineContent)).toBe(true)
    expect(cache.isInsideOrOnFenceLine(4, getLineContent)).toBe(true)
    expect(getLineContent.mock.calls.at(-1)?.[0]).toBe(3)
  })

  it('provides renderer-supported snippets for the missing Markdown structures', () => {
    expect(MARKDOWN_SLASH_COMMANDS.find((item) => item.label === 'footnote')).toEqual({
      label: 'footnote',
      detail: '脚注',
      insertText: '${1:Text}[^${2:1}]\n\n[^${2:1}]: ${3:Footnote content}',
    })
    expect(MARKDOWN_SLASH_COMMANDS.find((item) => item.label === 'highlight')).toEqual({
      label: 'highlight', detail: '高亮', insertText: '==${1:Highlighted text}==',
    })
    expect(MARKDOWN_SLASH_COMMANDS.find((item) => item.label === 'definition list')).toEqual({
      label: 'definition list', detail: '定义列表', insertText: '${1:Term}\n: ${2:Definition}',
    })
    expect(MARKDOWN_SLASH_COMMANDS.find((item) => item.label === 'wiki link')).toEqual({
      label: 'wiki link',
      detail: 'Wiki 链接',
      insertText: '[[',
      command: { id: 'editor.action.triggerSuggest', title: 'Trigger Wiki Link completion' },
    })
  })

  it('extracts preview-compatible heading anchors and ignores fenced code', () => {
    expect(markdownHeadingTargets('# Intro\n## 中文 标题\n## Intro\n```md\n# Hidden\n```')).toEqual([
      { title: 'Intro', anchor: 'intro', level: 1 },
      { title: '中文 标题', anchor: '中文-标题', level: 2 },
      { title: 'Intro', anchor: 'intro-2', level: 2 },
    ])
  })

  it('reports common English typos and spacing outside code fences', () => {
    expect(writingDiagnostics('The teh value , failed.  \n```text\nteh ,\n```')).toEqual([
      expect.objectContaining({ line: 1, message: 'Trailing whitespace' }),
      expect.objectContaining({ line: 1, message: 'Possible typo: teh → the' }),
      expect.objectContaining({ line: 1, message: 'Remove the space before “,”' }),
    ])
  })

  it('reports Chinese-Latin spacing and ASCII punctuation but ignores inline code', () => {
    const messages = writingDiagnostics('使用TypeScript编写,很好。`中文Code`').map((item) => item.message)
    expect(messages.filter((message) => message.includes('Chinese and Latin'))).toHaveLength(2)
    expect(messages).toContain('Use full-width punctuation in Chinese prose')
  })

  it('toggles Markdown formatting around selected text', () => {
    expect(toggleMarkdownWrap('text', MARKDOWN_WRAPS.bold)).toBe('**text**')
    expect(toggleMarkdownWrap('**text**', MARKDOWN_WRAPS.bold)).toBe('text')
  expect(toggleMarkdownWrap('', MARKDOWN_WRAPS.link)).toBe('[link text](https://)')
  expect(markdownWrapEdit('', MARKDOWN_WRAPS.bold)).toEqual({
    text: '**bold text**', selectionOffset: 2, selectionLength: 9,
  })
  })

  it('ranks Wiki Links by relevance and recent use', () => {
    const targets = [
      { path: 'archive/second-brain', title: 'Building a Second Brain' },
      { path: 'literature/brain', title: 'Brain Notes' },
      { path: 'archive/boxes', title: 'Archive vault' },
    ]
    expect(rankWikiTargets(targets, 'brain', [], '')[0].path).toBe('literature/brain')
    expect(rankWikiTargets(targets, '', ['archive/boxes'], '')[0].path).toBe('archive/boxes')
    expect(rankWikiTargets(targets, 'avb', [], '')[0].path).toBe('archive/boxes')
  })

  it('finds a Wiki Link target under the pointer', () => {
    expect(wikiLinkAtColumn('See [[notes/idea|Idea]] now', 10)).toBe('notes/idea')
    expect(wikiLinkAtColumn('See [[notes/idea#part]] now', 12)).toBe('notes/idea')
    expect(wikiLinkAtColumn('plain text', 3)).toBeNull()
  })

  it('marks the supported Markdown structures for Monaco', () => {
    const specs = markdownDecorationSpecs('---\ntitle: Note\n---\n# Heading\n> Quote\n**bold** and `code` and [[note]]')
    const classes = specs.flatMap((spec) => [spec.className, spec.inlineClassName]).filter(Boolean)
    expect(classes).not.toContain('monaco-md-frontmatter-key')
    expect(classes).not.toContain('monaco-md-frontmatter-value')
    expect(classes.some((name) => name?.includes('monaco-md-heading'))).toBe(false)
    expect(classes).not.toContain('monaco-md-quote')
    expect(classes).toContain('monaco-md-marker')
    expect(classes).toContain('monaco-md-strong')
    expect(classes).toContain('monaco-md-code')
    expect(classes).toContain('monaco-md-link')
  })

  it('decorates URLs with balanced parentheses in full', () => {
    const specs = markdownDecorationSpecs('See [Wikipedia](https://en.wikipedia.org/wiki/Link_(film)) and [plain](https://example.com).')
    const linkSpecs = specs.filter((spec) => spec.inlineClassName === 'monaco-md-link')
    expect(linkSpecs).toHaveLength(2)
    const lengths = linkSpecs.map((spec) => spec.endColumn - spec.startColumn)
    // First link contains 54 chars (label + URL with balanced parens).
    expect(lengths[0]).toBe(54)
    // Second link is the simple one.
    expect(lengths[1]).toBe(28)
  })

  it('marks unresolved Wiki Links separately', () => {
    const specs = markdownDecorationSpecs('[[known]] and [[missing]]', new Set(['known']))
    expect(specs.map((spec) => spec.inlineClassName)).toContain('monaco-md-link-invalid')
  })

  it('offsets decoration line numbers for visible-range scans', () => {
    const specs = markdownDecorationSpecs('## Visible heading', undefined, 99)
    expect(specs[0].startLineNumber).toBe(100)
  })

  it('handles a long Chinese document without losing line positions', () => {
    const document = Array.from({ length: 2_000 }, (_, index) =>
      index % 10 === 0 ? `## 第 ${index} 节` : `这是第 ${index} 行，包含中文标点（测试）。`,
    ).join('\n')
    const specs = markdownDecorationSpecs(document)
    const headingMarkers = specs.filter((spec) => spec.inlineClassName === 'monaco-md-marker')
    expect(headingMarkers).toHaveLength(200)
    expect(headingMarkers.at(-1)?.startLineNumber).toBe(1_991)
  })
})
