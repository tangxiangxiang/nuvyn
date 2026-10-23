import { describe, expect, it, vi } from 'vitest'
import { markdownSyntaxDiagnostics as diagnose, MARKDOWN_SYNTAX_LIMIT } from '../markdownSyntaxDiagnostics'
import { parseFlexOptions } from '../markdownContainers'
import { parseMarkdownResourceDirective } from '../markdownResources'

const flex = (options = '') => `::: flex ${options}\n\nContent\n\n:::`
const group = (members: string) => `::: code-group\n\n${members}\n\n:::`
const fence = (info = 'java [Java]', code = 'System.out.println("Hello");') => `\`\`\`${info}\n${code}\n\`\`\``

describe('source-only Markdown syntax hints', () => {
  it.each([
    '', 'direction=row gap=16', 'direction=row-reverse wrap=wrap-reverse mobile=preserve',
    'direction=column justify=space-evenly items=first-baseline content=safe-center gap=0',
    'grow=4 shrink=0 basis=33.33% self=safe-self-start order=-3',
    'direction=column-reverse wrap=nowrap justify=unsafe-flex-end items=last-baseline content=space-around gap=32',
  ])('accepts production Flex options: %s', (options) => {
    expect(parseFlexOptions(options)).not.toBeNull()
    expect(diagnose(flex(options))).toEqual([])
  })

  it.each(['gap=7', 'direction=horizontal', 'mobile=invalid', 'unknown=value', 'grow=5', 'shrink=-1', 'basis=42%', 'order=4', 'self=invalid', 'gap:16'])('reports a closed invalid Flex: %s', (options) => {
    expect(parseFlexOptions(options)).toBeNull()
    expect(diagnose(flex(options))).toEqual([{
      line: 1, startColumn: 10, endColumn: 10 + options.length,
      message: expect.stringContaining(options),
    }])
  })

  it('uses the actual gap values and rejects only parser-rejected duplicates', () => {
    expect(diagnose(flex('gap=7'))[0]?.message).toContain('0、4、8、12、16、24、32')
    expect(diagnose(flex('gap=16 gap=16'))[0]?.message).toContain('重复')
    expect(diagnose(flex('direction=row direction=column'))[0]?.message).toContain('重复')
    expect(diagnose(flex('gap=16 direction='))).toEqual([])
  })

  it('accepts nested containers and longer colon fences without diagnosing other container types', () => {
    expect(diagnose(':::: flex\n::: flex mobile=preserve\na\n:::\n::::')).toEqual([])
    expect(diagnose('::: flex\n:::: flex\na\n::::\n:::')).toEqual([])
    expect(diagnose(':::: info Title\n::: flex gap=7\na\n:::\n::::')[0]).toMatchObject({ line: 2 })
    for (const type of ['info', 'tip', 'warning', 'danger', 'details']) expect(diagnose(`::: ${type} Title\ntext\n:::`)).toEqual([])
  })

  it('ignores unclosed containers, incomplete headers and closes owned by code', () => {
    for (const source of ['::: flex gap=7\ntext', '::: flex direction=', '::: code-group\n```java\ncode', '::: flex gap=7\n```md\n:::\n```']) {
      expect(diagnose(source)).toEqual([])
    }
  })

  it('accepts single and multiple labeled Code Group members, metadata and literal colons in code', () => {
    expect(diagnose(group(fence()))).toEqual([])
    expect(diagnose(group(`${fence('java:line-numbers=10 {1} [Java]', '::: flex gap=7\n:::')}\n\n${fence('python [Python]', 'print("hi")')}`))).toEqual([])
    expect(diagnose(group(fence('totally-unknown [Label]')))).toEqual([])
    expect(diagnose(group(fence('[Label]')))).toEqual([])
    expect(diagnose(group('<<< ./example.ts [Code]'))).toEqual([])
    expect(diagnose(group('<!--@include: ./members.md-->'))).toEqual([])
  })

  it.each(['java', 'java []', 'java [ ]'])('reports a missing/empty member label once: %s', (info) => {
    expect(diagnose(group(fence(info)))).toEqual([{
      line: 3, startColumn: 1, endColumn: info.length + 4,
      message: 'Code Group 中的代码块需要非空的 [Label]。',
    }])
  })

  it('locates invalid fence metadata, non-code members and empty groups', () => {
    expect(diagnose(group(fence('java:unknown [Java]')))[0]).toMatchObject({ line: 3, message: expect.stringContaining('元数据') })
    expect(diagnose(group(`Paragraph\n\n${fence()}`))).toEqual([expect.objectContaining({ line: 3, message: expect.stringContaining('只能包含') })])
    expect(diagnose(group(''))[0]?.message).toContain('至少一个')
    expect(diagnose(group(fence('java [Java] [Duplicate]')))[0]?.message).toContain('元数据')
  })

  it.each([
    '<<< ./example.ts', '<<< @/examples/demo.py{1,3-4}', '<<< ../demo.ts{3,}',
    '<<< ./demo.ts#region {1-3 typescript:line-numbers=10} [Code]',
    '<!--@include: ./part.md-->', '<!--@include: @/parts/a.md{1-3}-->',
    '<!--@include: ../part.md#intro-->',
  ])('accepts any directive accepted by the production format parser: %s', (source) => {
    expect(parseMarkdownResourceDirective(source)).not.toBeNull()
    expect(diagnose(source)).toEqual([])
  })

  it.each(['<<< ./demo.ts{3-}', '<<< ./demo.ts{0}', '<<< ./demo.ts{1 typescript:unknown}', '<!--@include: ./part.md{typescript}-->'])('reports only complete, clearly malformed resource syntax: %s', (source) => {
    expect(parseMarkdownResourceDirective(source)).toBeNull()
    expect(diagnose(source)).toHaveLength(1)
  })

  it('does not check file existence, permission, paths or resource loading', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    for (const source of ['<<< ./missing.ts', '<!--@include: @/missing.md-->', '<<< ./file.unsupported']) expect(diagnose(source)).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })

  it('does not diagnose ordinary prose, comments or unfinished metadata', () => {
    for (const source of ['<<< ordinary text', '<<<', '<!-- ordinary comment -->', '<!--@include: ./part.md', '<<< ./example.ts{', '<<< ./example.ts [', '<!--@include: ./part.md{typescript}--> <!-- other -->']) {
      expect(diagnose(source)).toEqual([])
    }
  })

  it.each([
    '```md\n::: flex gap=7\n\nContent\n\n:::\n<<< ./demo.ts{3-}\n```',
    '````md\n```\n::: flex gap=7\n:::\n```\n````',
    '~~~md\n<!--@include: ./part.md{typescript}-->\n~~~',
    '    ::: flex gap=7\n    Content\n    :::\n    <<< ./demo.ts{3-}',
    '`<<< ./demo.ts{3-}`', '`begin\n<<< ./demo.ts{3-}\nend`',
    '<div>\n::: flex gap=7\n:::\n<<< ./demo.ts{3-}\n</div>',
    '<!--\n::: flex gap=7\n:::\n<!--@include: ./part.md{typescript}-->\n-->',
    '> ::: flex gap=7\n> Content\n> :::\n> <<< ./demo.ts{3-}',
    '- item\n\n  ::: flex gap=7\n  text\n  :::\n  <<< ./demo.ts{3-}',
    'Term\n: definition\n\n  ::: flex gap=7\n  text\n  :::',
    'Text[^note]\n\n[^note]: note\n\n    <<< ./demo.ts{3-}',
    '$$\n<<< ./demo.ts{3-}\n::: flex gap=7\n::: \n$$',
    '---\ntitle: Example\n<<< ./demo.ts{3-}\n---\nContent',
    '---\ntitle: still editing\n<<< ./demo.ts{3-}',
    '::: details Title\n```md\n::: flex gap=7\n:::\n```\n:::',
  ])('respects Markdown ownership: %s', (source) => {
    expect(diagnose(source)).toEqual([])
  })

  it('preserves exact source coordinates with frontmatter, indentation and LF/CRLF', () => {
    const source = '---\ntitle: Test\n---\n\n  ::: flex direction=row gap=7\n\n  body\n\n  :::'
    const expected = [{ line: 5, startColumn: 26, endColumn: 31, message: expect.stringContaining('gap=7') }]
    expect(diagnose(source)).toEqual(expected)
    expect(diagnose(source.replaceAll('\n', '\r\n'))).toEqual(expected)
  })

  it('bounds output and skips protected large or excessively nested source', () => {
    expect(diagnose(Array.from({ length: 40 }, () => flex('gap=7')).join('\n\n'))).toHaveLength(30)
    expect(diagnose(`${flex('gap=7')}\n${'x'.repeat(MARKDOWN_SYNTAX_LIMIT)}`)).toEqual([])
    expect(diagnose(`${'::: flex\n'.repeat(129)}${':::\n'.repeat(129)}`)).toEqual([])
    // Unfinished nested containers can cause repeated production lookahead;
    // a per-analysis scan budget must stop it without waiting for a timer.
    expect(diagnose('::: flex\n'.repeat(120))).toEqual([])
    expect(diagnose('::: code-group\n'.repeat(120))).toEqual([])
    expect(diagnose('')).toEqual([])
  })
})
