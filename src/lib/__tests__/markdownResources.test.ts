// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import MarkdownIt from 'markdown-it'
import {
  expandMarkdownResources,
  MAX_INCLUDE_BYTES,
  MAX_EXPANDED_MARKDOWN_BYTES,
  MAX_SNIPPET_BYTES,
  parseMarkdownResourceDirective,
  parseResourceRanges,
  resolveLogicalResourceReference,
  type MarkdownResourceResolver,
} from '../markdownResources'
import { render } from '../markdown'

function resolverFor(files: Record<string, string>): MarkdownResourceResolver & { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async ({ path, kind }: { path: string; kind: string }) => {
    const content = files[path]
    if (content === undefined) throw new Error(`missing ${path}`)
    return { path, kind: kind as 'snippet' | 'include', content }
  })
  return { read }
}

describe('Markdown resource logical resolution and expansion', () => {
  it('normalizes source-relative paths before the physical boundary', () => {
    expect(resolveLogicalResourceReference('guides/java/index.md', '../shared/demo.ts'))
      .toBe('guides/shared/demo.ts')
    expect(resolveLogicalResourceReference('guides/java/index', './parts/details.md'))
      .toBe('guides/java/parts/details.md')
    expect(resolveLogicalResourceReference(undefined, '@/examples/demo.ts'))
      .toBe('examples/demo.ts')

    expect(resolveLogicalResourceReference('guides/index.md', '../../../etc/passwd')).toBeNull()
    expect(resolveLogicalResourceReference('guides/index.md', '/etc/passwd')).toBeNull()
    expect(resolveLogicalResourceReference('guides/index.md', 'C:\\secret.ts')).toBeNull()
    expect(resolveLogicalResourceReference('guides/index.md', 'https://example.test/x.ts')).toBeNull()
    expect(resolveLogicalResourceReference('guides/index.md', 'file:///etc/passwd')).toBeNull()
  })

  it('parses bounded inclusive ranges including an open end', () => {
    expect(parseResourceRanges('2,4-6')).toEqual([
      { start: 2, end: 2 },
      { start: 4, end: 6 },
    ])
    expect(parseResourceRanges('3,')).toEqual([{ start: 3 }])
    expect(parseResourceRanges('2')).toEqual([{ start: 2, end: 2 }])
    expect(parseResourceRanges('0')).toBeNull()
    expect(parseResourceRanges('3-2')).toBeNull()
    expect(parseResourceRanges('3-')).toBeNull()
    expect(parseResourceRanges('-1')).toBeNull()
  })

  it('applies single-line, closed, mixed, and open-ended ranges to final output', async () => {
    const source = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6'].join('\n')
    const resolver = resolverFor({ 'examples/part.md': source, 'examples/demo.ts': source })

    const single = await expandMarkdownResources(
      '<!--@include: @/examples/part.md{2}-->',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(single.markdown).toBe('line2')

    const closed = await expandMarkdownResources(
      '<!--@include: @/examples/part.md{2-4}-->',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(closed.markdown).toBe('line2\nline3\nline4')

    const mixed = await expandMarkdownResources(
      '<!--@include: @/examples/part.md{2,4-6}-->',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(mixed.markdown).toBe('line2\nline4\nline5\nline6')

    const open = await expandMarkdownResources(
      '<!--@include: @/examples/part.md{3,}-->',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(open.markdown).toBe('line3\nline4\nline5\nline6')

    const snippet = await expandMarkdownResources(
      '<<< @/examples/demo.ts{2}',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(snippet.markdown).toContain('line2')
    expect(snippet.markdown).not.toContain('line1')
    expect(snippet.markdown).not.toContain('line3')
  })

  it('rejects malformed and out-of-bounds range syntax', async () => {
    expect(parseResourceRanges('100001')).toBeNull()
    expect(parseResourceRanges('3-')).toBeNull()
    const resolver = resolverFor({ 'examples/part.ts': 'line1\nline2\nline3' })
    const malformed = await expandMarkdownResources(
      '<<< @/examples/part.ts{3-}',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(malformed.markdown).toContain('markdown-resource-error')
  })

  it('charges exact final UTF-8 bytes, including line separators', async () => {
    const exact = 'x'.repeat(MAX_EXPANDED_MARKDOWN_BYTES)
    const atLimit = await expandMarkdownResources(exact, {
      md: new MarkdownIt({ html: true }),
    })
    expect(new TextEncoder().encode(atLimit.markdown).byteLength).toBe(MAX_EXPANDED_MARKDOWN_BYTES)

    await expect(expandMarkdownResources(`${exact}x`, {
      md: new MarkdownIt({ html: true }),
    })).rejects.toMatchObject({ code: 'expanded-size-limit' })
  })

  it('counts newline amplification on repeated cached includes', async () => {
    const lines = Array.from({ length: 512 }, (_, index) => 'x'.repeat(index === 0 ? 1024 : 1023))
    const repeated = lines.join('\n')
    const resolver = resolverFor({ 'examples/repeated.md': repeated })
    const expanded = await expandMarkdownResources([
      '<!--@include: @/examples/repeated.md-->',
      '<!--@include: @/examples/repeated.md-->',
      '<!--@include: @/examples/repeated.md-->',
      '<!--@include: @/examples/repeated.md-->',
    ].join('\n'), {
      md: new MarkdownIt({ html: true }),
      resourceResolver: resolver,
    })

    expect(resolver.read).toHaveBeenCalledTimes(1)
    expect(expanded.markdown).toContain('markdown-resource-error')
    expect(new TextEncoder().encode(expanded.markdown).byteLength)
      .toBeLessThanOrEqual(MAX_EXPANDED_MARKDOWN_BYTES)
  })

  it('bounds duplicate and overlapping selections without deduplicating valid output', async () => {
    const resolver = resolverFor({
      'examples/repeated.ts': 'x'.repeat(1024),
      'examples/overlap.ts': Array.from({ length: 512 }, () => 'x'.repeat(400)).join('\n'),
      'examples/part.md': 'line1\nline2\nline3',
    })
    const duplicateRanges = Array.from({ length: 1_000 }, () => '1').join(',')
    const duplicate = await expandMarkdownResources(
      `<<< @/examples/repeated.ts{${duplicateRanges}}`,
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(duplicate.markdown).toContain('markdown-resource-error')

    const overlapping = await expandMarkdownResources(
      '<<< @/examples/overlap.ts{1-256,129-384,257-512}',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(overlapping.markdown).toContain('markdown-resource-error')

    const repeated = await expandMarkdownResources(
      '<!--@include: @/examples/part.md{1,1,2}-->',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(repeated.markdown).toBe('line1\nline1\nline2')

    const overlap = await expandMarkdownResources(
      '<!--@include: @/examples/part.md{1-2,2-3}-->',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(overlap.markdown).toBe('line1\nline2\nline2\nline3')
  })

  it('enforces exact per-kind UTF-8 selection limits before materializing output', async () => {
    const multibyteLine = '界'.repeat(Math.floor(MAX_SNIPPET_BYTES / 3)) + 'a'
    expect(new TextEncoder().encode(multibyteLine).byteLength).toBe(MAX_SNIPPET_BYTES)
    expect(multibyteLine.length).toBeLessThan(MAX_SNIPPET_BYTES)

    const resolver = resolverFor({
      'examples/exact.ts': multibyteLine,
      'examples/over.ts': `${multibyteLine}b`,
      'examples/separator.ts': `${'s'.repeat(MAX_SNIPPET_BYTES - 1)}\n`,
      'examples/exact.md': 'y'.repeat(MAX_INCLUDE_BYTES),
      'examples/over.md': `${'y'.repeat(MAX_INCLUDE_BYTES)}z`,
    })
    const exactSnippet = await expandMarkdownResources(
      '<<< @/examples/exact.ts{1}',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(exactSnippet.markdown).toContain(multibyteLine)
    expect(exactSnippet.markdown).not.toContain('markdown-resource-error')

    const overSnippet = await expandMarkdownResources(
      '<<< @/examples/over.ts{1}',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(overSnippet.markdown).toContain('markdown-resource-error')

    const exactWithSeparator = await expandMarkdownResources(
      '<<< @/examples/separator.ts{1-2}',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(exactWithSeparator.markdown).not.toContain('markdown-resource-error')

    const overWithSeparator = await expandMarkdownResources(
      '<<< @/examples/separator.ts{1-2,2}',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(overWithSeparator.markdown).toContain('markdown-resource-error')

    const exactInclude = await expandMarkdownResources(
      '<!--@include: @/examples/exact.md-->',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(exactInclude.markdown).toBe('y'.repeat(MAX_INCLUDE_BYTES))

    const overInclude = await expandMarkdownResources(
      '<!--@include: @/examples/over.md-->',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(overInclude.markdown).toContain('markdown-resource-error')
  })

  it('counts repeated empty lines and their LF separators toward selection limits', async () => {
    const source = Array.from({ length: 1_000 }, () => '').join('\n')
    const ranges = Array.from({ length: 1_000 }, () => '1-1000').join(',')
    const resolver = resolverFor({ 'examples/empty.ts': source })
    const expanded = await expandMarkdownResources(
      `<<< @/examples/empty.ts{${ranges}}`,
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )

    expect(expanded.markdown).toContain('markdown-resource-error')
  })

  it('applies the same bounded discipline to overlapping named regions', async () => {
    const body = 'z'.repeat(140 * 1024)
    const source = [
      '// #region target',
      '// #region target',
      body,
      '// #endregion target',
      '// #endregion target',
    ].join('\n')
    const resolver = resolverFor({ 'examples/regions.ts': source })
    const expanded = await expandMarkdownResources(
      '<<< @/examples/regions.ts#target',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )

    expect(expanded.markdown).toContain('markdown-resource-error')
  })

  it('keeps directives inside fences and indented code opaque', async () => {
    const resolver = resolverFor({ 'examples/demo.ts': 'const value = 1' })
    const source = [
      '```md',
      '<<< @/examples/demo.ts',
      '```',
      '',
      '    <!--@include: @/examples/demo.md-->',
    ].join('\n')
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      resourceResolver: resolver,
    })
    expect(expanded.markdown).toBe(source)
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('keeps one-line and multi-line inline code-span directives literal', async () => {
    const resolver = resolverFor({
      'examples/secret.ts': 'const secret = true',
      'examples/secret.md': '# Secret',
    })
    const sources = [
      '`<<< @/examples/secret.ts`',
      [
        'before',
        '',
        '`literal',
        '<<< @/examples/secret.ts',
        'literal`',
        '',
        'after',
      ].join('\n'),
      [
        '``literal',
        '` inside',
        '<<< @/examples/secret.ts',
        'literal``',
      ].join('\n'),
      [
        '`literal',
        '<!--@include: ./secret.md{not-valid}-->',
        'literal`',
      ].join('\n'),
    ]

    for (const source of sources) {
      const expanded = await expandMarkdownResources(source, {
        md: new MarkdownIt({ html: true }),
        sourcePath: 'docs/index',
        resourceResolver: resolver,
      })
      expect(expanded.markdown).toBe(source)
    }
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('does not let same-content html_inline backticks impersonate a real resource code span', async () => {
    const resolver = resolverFor({ 'examples/secret.ts': 'const secret = true' })
    const source = '<span title="`literal <<< @/examples/secret.ts literal`">x</span> `literal\n<<< @/examples/secret.ts\nliteral`'
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })

    expect(expanded.markdown).toBe(source)
    expect(expanded.markdown).not.toContain('markdown-resource-error')
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('keeps malformed same-content resource syntax literal inside the real code span', async () => {
    const resolver = resolverFor({ 'examples/secret.ts': 'const secret = true' })
    const source = '<span title="`literal <<< @/examples/secret.ts{3-} literal`">x</span> `literal\n<<< @/examples/secret.ts{3-}\nliteral`'
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })

    expect(expanded.markdown).toBe(source)
    expect(expanded.markdown).not.toContain('markdown-resource-error')
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('does not let a Markdown link title impersonate a later resource code span', async () => {
    const resolver = resolverFor({ 'examples/secret.ts': 'const secret = true' })
    const source = '[x](foo "`literal <<< @/examples/secret.ts literal`") `literal\n<<< @/examples/secret.ts\nliteral`'
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })

    expect(expanded.markdown).toBe(source)
    expect(expanded.markdown).not.toContain('markdown-resource-error')
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('keeps malformed link-title resource syntax literal before parser ownership', async () => {
    const resolver = resolverFor({ 'examples/secret.ts': 'const secret = true' })
    const source = '[x](foo "`literal <<< @/examples/secret.ts{3-} literal`") `literal\n<<< @/examples/secret.ts{3-}\nliteral`'
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })

    expect(expanded.markdown).toBe(source)
    expect(expanded.markdown).not.toContain('markdown-resource-error')
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('keeps resource-looking lines inside image-alt code literal', async () => {
    const resolver = resolverFor({ 'examples/secret.ts': 'const secret = true' })
    const source = '![x `literal\n<<< @/examples/secret.ts\nliteral`](foo)'
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })

    expect(expanded.markdown).toBe(source)
    expect(expanded.markdown).not.toContain('markdown-resource-error')
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('keeps malformed resource syntax literal inside image-alt code', async () => {
    const resolver = resolverFor({ 'examples/secret.ts': 'const secret = true' })
    const source = '![x `literal\n<<< @/examples/secret.ts{3-}\nliteral`](foo)'
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })

    expect(expanded.markdown).toBe(source)
    expect(expanded.markdown).not.toContain('markdown-resource-error')
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('keeps a resource-looking directive literal after a code span inside a link label', async () => {
    const resolver = resolverFor({ 'examples/secret.ts': 'const secret = true' })
    const source = '[x `](foo)`](foo) `literal\n<<< @/examples/secret.ts\nliteral`'
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })

    expect(expanded.markdown).toBe(source)
    expect(expanded.markdown).not.toContain('markdown-resource-error')
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('keeps malformed resource syntax literal after a code span inside a link label', async () => {
    const resolver = resolverFor({ 'examples/secret.ts': 'const secret = true' })
    const source = '[x `](foo)`](foo) `literal\n<<< @/examples/secret.ts{3-}\nliteral`'
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })

    expect(expanded.markdown).toBe(source)
    expect(expanded.markdown).not.toContain('markdown-resource-error')
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('does not let backticks across MarkdownIt blocks suppress a real directive', async () => {
    const resolver = resolverFor({
      'examples/demo.ts': 'const loaded = true',
      'docs/part.md': '# Included part',
    })
    const snippetSource = [
      '`unclosed opener',
      '',
      '<<< @/examples/demo.ts',
      '',
      'later closer`',
    ].join('\n')
    const snippet = await expandMarkdownResources(snippetSource, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })
    expect(resolver.read).toHaveBeenCalledTimes(1)
    expect(snippet.markdown).toContain('const loaded = true')
    expect(snippet.markdown).not.toContain('markdown-resource-error')

    const includeSource = [
      '`unclosed opener',
      '',
      'paragraph text',
      '',
      '<!--@include: @/docs/part.md-->',
      '',
      'later closer`',
    ].join('\n')
    const include = await expandMarkdownResources(includeSource, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })
    expect(resolver.read).toHaveBeenCalledTimes(2)
    expect(include.markdown).toContain('# Included part')
    expect(include.markdown).not.toContain('markdown-resource-error')
  })

  it('still expands an ordinary standalone directive outside code spans', async () => {
    const resolver = resolverFor({ 'examples/demo.ts': 'const value = 1' })
    const expanded = await expandMarkdownResources('<<< @/examples/demo.ts', {
      md: new MarkdownIt({ html: true }),
      resourceResolver: resolver,
    })

    expect(resolver.read).toHaveBeenCalledTimes(1)
    expect(expanded.markdown).toContain('const value = 1')
  })

  it('keeps malformed resource syntax literal when a real code span owns it', async () => {
    const resolver = resolverFor({ 'examples/demo.ts': 'const loaded = true' })
    const source = [
      '`literal',
      '<<< @/examples/demo.ts{3-}',
      'literal`',
    ].join('\n')
    const expanded = await expandMarkdownResources(source, {
      md: new MarkdownIt({ html: true }),
      sourcePath: 'docs/index',
      resourceResolver: resolver,
    })

    expect(expanded.markdown).toBe(source)
    expect(expanded.markdown).not.toContain('markdown-resource-error')
    expect(resolver.read).not.toHaveBeenCalled()
  })

  it('expands nested includes with local source context and a per-render cache', async () => {
    const resolver = resolverFor({
      'docs/parts.md': '# Part\n\n[[child]]\n\n<!--@include: ./nested.md-->',
      'docs/nested.md': '## Nested\n',
    })
    const expanded = await expandMarkdownResources(
      '# Root\n\n<!--@include: ./parts.md-->',
      { md: new MarkdownIt({ html: true }), sourcePath: 'docs/index', resourceResolver: resolver },
    )
    expect(expanded.markdown).toContain('# Part')
    expect(expanded.markdown).toContain('## Nested')
    const partLine = expanded.markdown.split('\n').findIndex((line) => line === '[[child]]')
    expect(expanded.sourcePathByLine[partLine]).toBe('docs/parts.md')
    expect(resolver.read).toHaveBeenCalledTimes(2)
    expect(resolver.read).toHaveBeenCalledWith(expect.objectContaining({ path: 'docs/parts.md', kind: 'include' }))
    expect(resolver.read).toHaveBeenCalledWith(expect.objectContaining({ path: 'docs/nested.md', kind: 'include' }))
  })

  it('selects named regions and returns a local placeholder for a missing region', async () => {
    const resolver = resolverFor({
      'examples/demo.ts': [
        '// #region one',
        'const first = 1',
        '// #endregion one',
        '// #region two',
        'const second = 2',
        '// #endregion two',
      ].join('\n'),
    })
    const expanded = await expandMarkdownResources(
      '<<< @/examples/demo.ts#one',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(expanded.markdown).toContain('const first = 1')
    expect(expanded.markdown).not.toContain('#region')

    const missing = await expandMarkdownResources(
      '<<< @/examples/demo.ts#missing',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(missing.markdown).toContain('markdown-resource-error')
  })

  it('expands before final Shiki discovery and keeps included link/image context', async () => {
    const resolver = resolverFor({
      'docs/parts.md': '[Child](./child.md)\n\n[[wiki-child]]\n\n![Logo](./logo.png)\n\n```python\nprint(1)\n```',
    })
    const wikiResolver = vi.fn((ref: string, _anchor?: string, context?: { sourcePath?: string }) => ({
      target: `${context?.sourcePath ?? 'unknown'}:${ref}`,
    }))
    const html = await render(
      '<!--@include: ./parts.md-->',
      {
        sourcePath: 'docs/index',
        resourceResolver: resolver,
        resolver: wikiResolver,
      },
    )
    expect(html).toContain('class="shiki')
    expect(html).toContain('print')
    expect(html).toContain('/vault/docs/parts.md:wiki-child')
    expect(html).toContain('/api/markdown-resources?kind=image&amp;path=docs%2Flogo.png')
    expect(wikiResolver).toHaveBeenCalledWith('wiki-child', undefined, { sourcePath: 'docs/parts.md' })
  })

  it('keeps root/include/root source context across one merged paragraph', async () => {
    const resolver = resolverFor({
      'docs/part.md': [
        '[Included](./included.md) ![Included image](./included.png)  ',
        '[[included-wiki]]',
      ].join('\n'),
    })
    const wikiResolver = vi.fn((ref: string, _anchor?: string, context?: { sourcePath?: string }) => ({
      target: `${context?.sourcePath ?? 'unknown'}:${ref}`,
    }))
    const html = await render([
      '[Root Before](./root-before.md) ![Root image](./root-before.png)  ',
      '<!--@include: ./part.md-->',
      '[Root After](./root-after.md) ![Root image](./root-after.png)',
    ].join('\n'), {
      sourcePath: 'docs/root',
      resourceResolver: resolver,
      resolver: wikiResolver,
    })

    expect(wikiResolver.mock.calls.map(([ref, _anchor, context]) => ({
      ref,
      sourcePath: context?.sourcePath,
    }))).toEqual([
      { ref: './root-before', sourcePath: 'docs/root.md' },
      { ref: './included', sourcePath: 'docs/part.md' },
      { ref: 'included-wiki', sourcePath: 'docs/part.md' },
      { ref: './root-after', sourcePath: 'docs/root.md' },
    ])
    expect(html).toContain('path=docs%2Froot-before.png')
    expect(html).toContain('path=docs%2Fincluded.png')
    expect(html).toContain('path=docs%2Froot-after.png')
    expect(html).toContain('/vault/docs/part.md:included-wiki')
  })

  it('tracks source context when an included line opens a code span and root closes it', async () => {
    const resolver = resolverFor({ 'docs/part.md': '`included code' })
    const wikiResolver = vi.fn((ref: string, _anchor?: string, context?: { sourcePath?: string }) => ({
      target: `${context?.sourcePath ?? 'unknown'}:${ref}`,
    }))
    const html = await render([
      '<!--@include: ./part.md-->',
      'root code` [Root Link](./root.md) [[root-wiki]] ![Root image](./root.png)',
    ].join('\n'), {
      sourcePath: 'docs/root',
      resourceResolver: resolver,
      resolver: wikiResolver,
    })

    expect(wikiResolver.mock.calls.map(([ref, _anchor, context]) => ({
      ref,
      sourcePath: context?.sourcePath,
    }))).toEqual([
      { ref: './root', sourcePath: 'docs/root.md' },
      { ref: 'root-wiki', sourcePath: 'docs/root.md' },
    ])
    expect(html).toContain('path=docs%2Froot.png')
  })

  it('tracks source context when root opens a code span and an included line closes it', async () => {
    const resolver = resolverFor({
      'docs/part.md': 'included code` [Included Link](./included.md) [[included-wiki]] ![Included image](./included.png)',
    })
    const wikiResolver = vi.fn((ref: string, _anchor?: string, context?: { sourcePath?: string }) => ({
      target: `${context?.sourcePath ?? 'unknown'}:${ref}`,
    }))
    const html = await render([
      '`root code',
      '<!--@include: ./part.md-->',
    ].join('\n'), {
      sourcePath: 'docs/root',
      resourceResolver: resolver,
      resolver: wikiResolver,
    })

    expect(wikiResolver.mock.calls.map(([ref, _anchor, context]) => ({
      ref,
      sourcePath: context?.sourcePath,
    }))).toEqual([
      { ref: './included', sourcePath: 'docs/part.md' },
      { ref: 'included-wiki', sourcePath: 'docs/part.md' },
    ])
    expect(html).toContain('path=docs%2Fincluded.png')
  })

  it('does not leak malformed directives or cyclic includes into a render error', async () => {
    const resolver = resolverFor({ 'a.md': '<!--@include: ./a.md-->' })
    const expanded = await expandMarkdownResources(
      '<!--@include: ./a.md-->',
      { md: new MarkdownIt({ html: true }), sourcePath: 'root.md', resourceResolver: resolver },
    )
    expect(expanded.markdown).toContain('markdown-resource-error')
    expect(expanded.markdown).not.toContain('/Users/')

    const malformed = await expandMarkdownResources(
      '<<< @/examples/demo.ts{not-a-range}',
      { md: new MarkdownIt({ html: true }), resourceResolver: resolver },
    )
    expect(malformed.markdown).toContain('markdown-resource-error')
  })

  it('propagates AbortSignal cancellation instead of turning it into article content', async () => {
    const controller = new AbortController()
    const resolver: MarkdownResourceResolver = {
      read: ({ signal }) => new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        controller.abort()
      }),
    }
    await expect(expandMarkdownResources('<!--@include: @/slow.md-->', {
      md: new MarkdownIt({ html: true }),
      resourceResolver: resolver,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('recognizes only the approved directive shapes', () => {
    expect(parseMarkdownResourceDirective('<<< @/examples/demo.ts{2,4-6 ts:line-numbers} [demo]'))
      .toMatchObject({ kind: 'snippet', pathReference: '@/examples/demo.ts', explicitLanguage: 'ts', label: 'demo' })
    expect(parseMarkdownResourceDirective('<!--@include: ./parts/details.md-->'))
      .toMatchObject({ kind: 'include', pathReference: './parts/details.md' })
    expect(parseMarkdownResourceDirective('ordinary text')).toBeNull()
  })
})
