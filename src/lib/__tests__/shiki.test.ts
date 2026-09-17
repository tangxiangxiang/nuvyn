// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHighlighter, type Highlighter } from 'shiki'
import {
  __testing__,
  ensureShikiLanguage,
  extractFenceLanguageIdentifier,
  getGeneratedShikiCss,
  getShikiRuntime,
  getShikiStyleTransformer,
  highlightShikiFence,
  prepareShikiLanguages,
  resolveShikiLanguage,
  syncGeneratedShikiStylesheet,
} from '../shiki'
import { parseFenceMeta } from '../fenceMeta'

const fakeHighlighter = (): Highlighter => ({
  dispose: vi.fn(),
} as unknown as Highlighter)

type LanguageInput = Parameters<Highlighter['loadLanguage']>[0]
type CodeToHtmlOptions = Parameters<Highlighter['codeToHtml']>[1]

function fakeLanguageHighlighter(
  loadLanguage: (language: LanguageInput) => Promise<void>,
  loadedLanguages: string[] = [],
  codeToHtml: (source: string, options?: CodeToHtmlOptions) => string = (source) =>
    `<pre class="shiki"><code><span class="line">${source}</span></code></pre>`,
): Highlighter {
  return {
    dispose: vi.fn(),
    getLoadedLanguages: vi.fn(() => [...loadedLanguages]),
    loadLanguage: vi.fn(loadLanguage),
    codeToHtml: vi.fn(codeToHtml),
  } as unknown as Highlighter
}

function useFakeLanguageRuntime(runtime: Highlighter) {
  const factory = vi.fn<typeof createHighlighter>(() => Promise.resolve(runtime))
  __testing__.setHighlighterFactory(factory)
  return factory
}

beforeEach(() => {
  __testing__.reset()
})

describe('Shiki H1 runtime foundation', () => {
  it('shares one highlighter promise across concurrent callers', async () => {
    let resolveRuntime: ((runtime: Highlighter) => void) | undefined
    const pendingRuntime = new Promise<Highlighter>((resolve) => {
      resolveRuntime = resolve
    })
    const runtime = fakeHighlighter()
    const factory = vi.fn<typeof createHighlighter>(() => pendingRuntime)
    __testing__.setHighlighterFactory(factory)

    const calls = [getShikiRuntime(), getShikiRuntime(), getShikiRuntime()]

    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith({
      themes: ['github-light', 'github-dark'],
      langs: [],
    })

    resolveRuntime?.(runtime)
    const resolved = await Promise.all(calls)

    expect(resolved).toEqual([runtime, runtime, runtime])
    expect(await getShikiRuntime()).toBe(runtime)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('retries after initialization failure instead of caching a rejection', async () => {
    const runtime = fakeHighlighter()
    const factory = vi.fn<typeof createHighlighter>()
      .mockRejectedValueOnce(new Error('initialization failed'))
      .mockResolvedValueOnce(runtime)
    __testing__.setHighlighterFactory(factory)

    await expect(getShikiRuntime()).rejects.toThrow('initialization failed')
    await expect(getShikiRuntime()).resolves.toBe(runtime)

    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('loads both themes without eagerly loading application languages', async () => {
    const runtime = await getShikiRuntime()

    expect(runtime.getLoadedThemes()).toEqual(['github-light', 'github-dark'])
    expect(runtime.getLoadedLanguages()).toEqual([])
  })

  it('returns one transformer instance with a class-based CSS snapshot', async () => {
    const transformer = getShikiStyleTransformer()

    expect(transformer).toBe(getShikiStyleTransformer())
    expect(getGeneratedShikiCss()).toBe('')

    // Compatibility probe only: H1 tests the Shiki/transformer pair with one
    // JavaScript grammar, but the production H1 runtime remains langs: [].
    const probeHighlighter = await createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: ['javascript'],
    })
    try {
      const html = probeHighlighter.codeToHtml('const answer = 42', {
        lang: 'javascript',
        themes: {
          light: 'github-light',
          dark: 'github-dark',
        },
        defaultColor: false,
        transformers: [transformer],
      })

      expect(html).toContain('nuvyn-shiki-')
      expect(html).not.toContain(' style=')
      expect(getGeneratedShikiCss()).toContain('.nuvyn-shiki-')
      expect(getGeneratedShikiCss()).toContain('--shiki-light:')
      expect(getGeneratedShikiCss()).toContain('--shiki-dark:')
    } finally {
      probeHighlighter.dispose()
    }
  })

  it('does not create a DOM stylesheet owner', async () => {
    const documentBefore = globalThis.document
    const styleCount = documentBefore?.querySelectorAll('style').length

    await getShikiRuntime()

    expect(globalThis.document).toBe(documentBefore)
    if (documentBefore) {
      expect(documentBefore.querySelector('#nuvyn-shiki-generated-styles')).toBeNull()
      expect(documentBefore.querySelectorAll('style')).toHaveLength(styleCount)
    }
  })

  it('does not require document to initialize or read the CSS snapshot', async () => {
    vi.stubGlobal('document', undefined)
    try {
      const runtime = await getShikiRuntime()

      expect(runtime.getLoadedThemes()).toEqual(['github-light', 'github-dark'])
      expect(getGeneratedShikiCss()).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Shiki H2 language preparation', () => {
  it('extracts only the first info token and resolves official aliases', () => {
    expect(extractFenceLanguageIdentifier('  js title=demo  ')).toBe('js')
    expect(extractFenceLanguageIdentifier('python linenums')).toBe('python')
    expect(extractFenceLanguageIdentifier('   ')).toBe('')

    const javascript = resolveShikiLanguage('js')
    const javascriptLong = resolveShikiLanguage('JavaScript')
    const python = resolveShikiLanguage('py')
    const yaml = resolveShikiLanguage('YML')

    expect(javascript).toMatchObject({ kind: 'language', normalizedId: 'js', canonicalId: 'javascript' })
    expect(javascriptLong).toMatchObject({ kind: 'language', normalizedId: 'javascript', canonicalId: 'javascript' })
    expect(python).toMatchObject({ kind: 'language', normalizedId: 'py', canonicalId: 'python' })
    expect(yaml).toMatchObject({ kind: 'language', normalizedId: 'yml', canonicalId: 'yaml' })
  })

  it('keeps the full official registry available beyond the short acceptance list', () => {
    const identifiers = [
      'tsx',
      'jsx',
      'vue',
      'html',
      'css',
      'scss',
      'json',
      'java',
      'sql',
      'powershell',
      'c',
      'cpp',
      'csharp',
      'go',
      'rust',
      'php',
      'kotlin',
      'docker',
      'dockerfile',
      'xml',
      'diff',
    ]

    expect(identifiers.every((identifier) => resolveShikiLanguage(identifier).kind === 'language')).toBe(true)
  })

  it('checks exact Nuvyn special fences before case-normalized registry lookup', () => {
    expect(resolveShikiLanguage('markmap')).toMatchObject({ kind: 'special', specialFence: 'markmap' })
    expect(resolveShikiLanguage('mermaid')).toMatchObject({ kind: 'special', specialFence: 'mermaid' })
    expect(resolveShikiLanguage('MARKMAP')).toMatchObject({ kind: 'unsupported', normalizedId: 'markmap' })
    expect(resolveShikiLanguage('Mermaid')).toMatchObject({ kind: 'language', canonicalId: 'mermaid' })
    expect(resolveShikiLanguage('mmap').kind).toBe('unsupported')
    expect(resolveShikiLanguage('merm').kind).toBe('unsupported')
    expect(resolveShikiLanguage('mark-map').kind).toBe('unsupported')
    expect(resolveShikiLanguage('mer-maid').kind).toBe('unsupported')
  })

  it('skips empty, special, and unknown identifiers without creating Shiki', async () => {
    const runtime = fakeLanguageHighlighter(async () => {})
    const factory = useFakeLanguageRuntime(runtime)

    const results = await prepareShikiLanguages([
      '',
      '   ',
      'markmap',
      'mermaid',
      'definitely-not-a-language',
    ])

    expect(results.map((result) => [result.resolution.kind, result.status])).toEqual([
      ['empty', 'skipped'],
      ['special', 'skipped'],
      ['special', 'skipped'],
      ['unsupported', 'skipped'],
    ])
    expect(factory).not.toHaveBeenCalled()
    expect((runtime.loadLanguage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('deduplicates repeated identifiers and official aliases by canonical language', async () => {
    const loadLanguage = vi.fn(async (_language: LanguageInput) => {})
    const runtime = fakeLanguageHighlighter(loadLanguage)
    const factory = useFakeLanguageRuntime(runtime)

    const results = await prepareShikiLanguages([
      'js',
      'javascript',
      'js title=demo',
      'py',
      'python',
      'yml',
      'yaml',
    ])

    expect(results).toHaveLength(3)
    expect(results.map((result) => result.resolution.kind === 'language'
      ? result.resolution.canonicalId
      : undefined)).toEqual([
      'javascript',
      'python',
      'yaml',
    ])
    expect(loadLanguage).toHaveBeenCalledTimes(3)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight load across same-language and alias concurrency', async () => {
    let resolveLoad: (() => void) | undefined
    const loadLanguage = vi.fn((_language: LanguageInput) => new Promise<void>((resolve) => {
      resolveLoad = resolve
    }))
    const runtime = fakeLanguageHighlighter(loadLanguage)
    const factory = useFakeLanguageRuntime(runtime)

    const preparation = Promise.all([
      ensureShikiLanguage('js'),
      ensureShikiLanguage('javascript'),
      ensureShikiLanguage('js'),
    ])
    for (let attempt = 0; attempt < 5 && loadLanguage.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve()
    }

    expect(loadLanguage).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
    resolveLoad?.()
    expect((await preparation).map((result) => result.status)).toEqual(['loaded', 'loaded', 'loaded'])
  })

  it('loads different canonical languages concurrently', async () => {
    let activeLoads = 0
    let maxActiveLoads = 0
    const loadLanguage = vi.fn(async (_language: LanguageInput) => {
      activeLoads += 1
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads)
      await Promise.resolve()
      activeLoads -= 1
    })
    const runtime = fakeLanguageHighlighter(loadLanguage)
    useFakeLanguageRuntime(runtime)

    await prepareShikiLanguages(['js', 'java', 'python'])

    expect(loadLanguage).toHaveBeenCalledTimes(3)
    expect(maxActiveLoads).toBe(3)
  })

  it('seeds canonical loaded state from the runtime and retries transient failures', async () => {
    const alreadyLoaded = vi.fn(async (_language: LanguageInput) => {})
    useFakeLanguageRuntime(fakeLanguageHighlighter(alreadyLoaded, ['javascript', 'js']))

    await expect(ensureShikiLanguage('js')).resolves.toMatchObject({ status: 'already-loaded' })
    expect(alreadyLoaded).not.toHaveBeenCalled()

    __testing__.reset()
    const loadLanguage = vi.fn()
      .mockRejectedValueOnce(new Error('temporary grammar failure'))
      .mockResolvedValueOnce(undefined)
    const runtime = fakeLanguageHighlighter(loadLanguage)
    const factory = useFakeLanguageRuntime(runtime)

    await expect(ensureShikiLanguage('typescript')).resolves.toMatchObject({ status: 'unavailable' })
    await expect(ensureShikiLanguage('ts')).resolves.toMatchObject({ status: 'loaded' })
    expect(loadLanguage).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(1)
    await expect(getShikiRuntime()).resolves.toBe(runtime)
  })

  it('propagates runtime initialization failure and retries language preparation', async () => {
    const healthyLoadLanguage = vi.fn(async (_language: LanguageInput) => {})
    const healthyRuntime = fakeLanguageHighlighter(healthyLoadLanguage)
    const factory = vi.fn<typeof createHighlighter>()
      .mockRejectedValueOnce(new Error('runtime initialization failed'))
      .mockResolvedValueOnce(healthyRuntime)
    __testing__.setHighlighterFactory(factory)

    await expect(ensureShikiLanguage('js')).rejects.toThrow('runtime initialization failed')
    expect(factory).toHaveBeenCalledTimes(1)
    expect(healthyLoadLanguage).not.toHaveBeenCalled()

    await expect(ensureShikiLanguage('js')).resolves.toMatchObject({ status: 'loaded' })
    expect(factory).toHaveBeenCalledTimes(2)
    expect(healthyLoadLanguage).toHaveBeenCalledTimes(1)
  })

  it('keeps the real runtime lazy and prepares only the requested grammar', async () => {
    const runtime = await getShikiRuntime()
    expect(runtime.getLoadedLanguages()).toEqual([])

    await expect(ensureShikiLanguage('javascript')).resolves.toMatchObject({ status: 'loaded' })

    const loaded = runtime.getLoadedLanguages()
    expect(loaded).toContain('javascript')
    expect(loaded).not.toContain('java')
    expect(loaded.length).toBeLessThan(20)
  })

  it('does not let a reset during a pending load leak into the next runtime', async () => {
    let resolveLoad: (() => void) | undefined
    const firstLoad = vi.fn((_language: LanguageInput) => new Promise<void>((resolve) => {
      resolveLoad = resolve
    }))
    const firstRuntime = fakeLanguageHighlighter(firstLoad)
    useFakeLanguageRuntime(firstRuntime)

    const firstPreparation = ensureShikiLanguage('js')
    for (let attempt = 0; attempt < 5 && firstLoad.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve()
    }
    __testing__.reset()
    resolveLoad?.()
    await expect(firstPreparation).resolves.toMatchObject({ status: 'unavailable' })

    const secondLoad = vi.fn(async (_language: LanguageInput) => {})
    const secondRuntime = fakeLanguageHighlighter(secondLoad)
    useFakeLanguageRuntime(secondRuntime)
    await expect(ensureShikiLanguage('js')).resolves.toMatchObject({ status: 'loaded' })
    expect(secondLoad).toHaveBeenCalledTimes(1)
  })
})

describe('Shiki H3 synchronous fence rendering', () => {
  it('returns synchronous HTML from the ready runtime without initializing in the callback', async () => {
    const codeToHtml = vi.fn((source: string) =>
      `<pre class="shiki"><code><span class="line">${source}</span></code></pre>`,
    )
    const runtime = fakeLanguageHighlighter(async () => {}, [], codeToHtml)
    const factory = useFakeLanguageRuntime(runtime)

    await expect(ensureShikiLanguage('js')).resolves.toMatchObject({ status: 'loaded' })

    const result = highlightShikiFence('const answer = 42', 'js')
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toContain('class="shiki"')
    expect(codeToHtml).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('returns fallback-required for an unprepared language without loading it', async () => {
    const codeToHtml = vi.fn((source: string) => source)
    const loadLanguage = vi.fn(async (_language: LanguageInput) => {})
    const runtime = fakeLanguageHighlighter(loadLanguage, [], codeToHtml)
    useFakeLanguageRuntime(runtime)

    await getShikiRuntime()

    expect(highlightShikiFence('const answer = 42', 'js')).toBeNull()
    expect(loadLanguage).not.toHaveBeenCalled()
    expect(codeToHtml).not.toHaveBeenCalled()
  })

  it('passes the frozen annotation pipeline and a safe meta range to codeToHtml', async () => {
    const optionsSeen: CodeToHtmlOptions[] = []
    const codeToHtml = vi.fn((source: string, options?: CodeToHtmlOptions) => {
      if (!options) throw new Error('H3 test expected codeToHtml options')
      optionsSeen.push(options)
      return `<pre class="shiki"><code><span class="line">${source}</span></code></pre>`
    })
    const runtime = fakeLanguageHighlighter(async () => {}, [], codeToHtml)
    useFakeLanguageRuntime(runtime)

    await expect(ensureShikiLanguage('ts')).resolves.toMatchObject({ status: 'loaded' })
    const meta = parseFenceMeta('ts {1,3-5}:line-numbers [config.ts]')
    expect(highlightShikiFence('const value = 1', meta)).toContain('class="shiki"')

    const transformers = optionsSeen[0]?.transformers ?? []
    expect(transformers.map((transformer) => transformer.name)).toEqual([
      '@shikijs/transformers:meta-highlight',
      'nuvyn:source-notation-scope-gate',
      '@shikijs/transformers:notation-highlight',
      '@shikijs/transformers:notation-focus',
      '@shikijs/transformers:notation-diff',
      '@shikijs/transformers:notation-error-level',
      'nuvyn:source-notation-scope-restore',
      'nuvyn:line-numbers',
      '@shikijs/transformers:style-to-class',
    ])
    expect(transformers.at(-1)).toBe(getShikiStyleTransformer())
    expect(optionsSeen[0]?.meta).toEqual({ __raw: '{1,3-5}' })
  })

  it('uses official classes for approved notation while keeping highlight:N deferred', async () => {
    await expect(ensureShikiLanguage('typescript')).resolves.toMatchObject({ status: 'loaded' })
    const html = highlightShikiFence([
      'const highlighted = 1 // [!code highlight]',
      'const focused = 2 // [!code focus:2]',
      'const added = 3 // [!code ++]',
      'const removed = 4 // [!code --]',
      'const warning = 5 // [!code warning]',
      'const error = 6 // [!code error]',
      'const info = 7 // [!code info]',
      'const deferred = 8 // [!code highlight:2]',
      'const invalid = 9 // [!code focus:1001]',
    ].join('\n'), parseFenceMeta('ts {1}'))
    if (!html) throw new Error('H3 expected Shiki HTML')

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const lines = Array.from(doc.querySelectorAll('pre.shiki .line'))
    expect(lines[0]?.classList.contains('highlighted')).toBe(true)
    expect(lines[1]?.classList.contains('focused')).toBe(true)
    expect(lines[2]?.classList.contains('focused')).toBe(true)
    expect(lines[2]?.classList.contains('diff')).toBe(true)
    expect(lines[3]?.classList.contains('diff')).toBe(true)
    expect(lines[4]?.classList.contains('warning')).toBe(true)
    expect(lines[5]?.classList.contains('error')).toBe(true)
    expect(lines[6]?.classList.contains('info')).toBe(true)
    expect(lines[7]?.classList.contains('highlighted')).toBe(false)
    expect(lines[8]?.classList.contains('focused')).toBe(false)
    expect(lines[7]?.textContent).toContain('[!code highlight:2]')
    expect(lines[8]?.textContent).toContain('[!code focus:1001]')
    expect(html).not.toMatch(/\sstyle=/i)
  })

  it('applies fence-info ranges through the official meta transformer', async () => {
    await expect(ensureShikiLanguage('ts')).resolves.toMatchObject({ status: 'loaded' })
    const html = highlightShikiFence([
      'const first = 1',
      'const second = 2',
    ].join('\n'), parseFenceMeta('ts {1}'))
    if (!html) throw new Error('H3 expected Shiki HTML')

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const lines = Array.from(doc.querySelectorAll('pre.shiki .line'))
    expect(lines[0]?.classList.contains('highlighted')).toBe(true)
    expect(lines[1]?.classList.contains('highlighted')).toBe(false)
  })

  it('wraps enabled Shiki lines without moving annotation classes or token children', async () => {
    await expect(ensureShikiLanguage('ts')).resolves.toMatchObject({ status: 'loaded' })
    const html = highlightShikiFence([
      'const first = 1',
      'const second = 2 // [!code error]',
    ].join('\n'), parseFenceMeta('ts {2}:line-numbers=98'))
    if (!html) throw new Error('MD-EXT-4 expected Shiki HTML')

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const pre = doc.querySelector('pre.shiki.nuvyn-line-numbers')
    const lines = Array.from(doc.querySelectorAll('pre.shiki.nuvyn-line-numbers .line'))
    expect(pre).not.toBeNull()
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.querySelector('.nuvyn-line-number')?.textContent))
      .toEqual(['98', '99'])
    expect(lines.every((line) => line.querySelectorAll('.nuvyn-line-number').length === 1)).toBe(true)
    expect(lines.every((line) => line.querySelectorAll('.nuvyn-line-content').length === 1)).toBe(true)
    expect(lines[1]?.classList.contains('highlighted')).toBe(true)
    expect(lines[1]?.classList.contains('error')).toBe(true)
    expect(lines[1]?.querySelector('[class^="nuvyn-shiki-"]')).not.toBeNull()
    expect(lines.every((line) => line.querySelector('.nuvyn-line-number')?.getAttribute('aria-hidden') === 'true'))
      .toBe(true)
    expect(html).not.toMatch(/\sstyle=/i)
  })

  it('matches Shiki logical-line semantics for empty and trailing-newline sources', async () => {
    await expect(ensureShikiLanguage('ts')).resolves.toMatchObject({ status: 'loaded' })
    const cases = [
      { source: 'alpha\nbeta', count: 2 },
      { source: 'alpha\nbeta\n', count: 3 },
      { source: '', count: 1 },
      { source: 'alpha\r\nbeta\r\n', count: 3 },
    ]

    for (const testCase of cases) {
      const html = highlightShikiFence(testCase.source, parseFenceMeta('ts:line-numbers=100000'))
      if (!html) throw new Error('MD-EXT-4 expected Shiki HTML')
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const lines = Array.from(doc.querySelectorAll('pre.shiki.nuvyn-line-numbers .line'))
      expect(lines, testCase.source).toHaveLength(testCase.count)
      expect(lines[0]?.querySelector('.nuvyn-line-number')?.textContent, testCase.source).toBe('100000')
      expect(lines.at(-1)?.querySelector('.nuvyn-line-number')?.textContent, testCase.source)
        .toBe(String(100000 + testCase.count - 1))
      expect(doc.querySelector('.nuvyn-line-content')?.textContent).not.toContain('\r')
    }
  })

  it('keeps malformed and deferred source notation as ordinary source', async () => {
    await expect(ensureShikiLanguage('ts')).resolves.toMatchObject({ status: 'loaded' })
    const markers = [
      '[!code highlight:0]',
      '[!code highlight:-1]',
      '[!code highlight:abc]',
      '[!code highlight:999999]',
      '[!code focus:0]',
      '[!code focus:-1]',
      '[!code focus:abc]',
      '[!code focus:1001]',
      '[!code WARNING]',
      '[!code info:2]',
    ]
    const html = highlightShikiFence(
      markers.map((marker, index) => `const line${index} = ${index} // ${marker}`).join('\n'),
      parseFenceMeta('ts'),
    )
    if (!html) throw new Error('H3 expected Shiki HTML')

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const lines = Array.from(doc.querySelectorAll('pre.shiki .line'))
    expect(lines).toHaveLength(markers.length)
    for (const [index, marker] of markers.entries()) {
      expect(lines[index]?.classList.contains('highlighted'), marker).toBe(false)
      expect(lines[index]?.classList.contains('focused'), marker).toBe(false)
      expect(lines[index]?.textContent, marker).toContain(marker)
    }
  })

  it('preserves author-authored sentinel-like source while gating deferred notation', async () => {
    await expect(ensureShikiLanguage('ts')).resolves.toMatchObject({ status: 'loaded' })
    const source = [
      '// [!code nuvyn-deferred-notation hello]',
      'const literal = "[!code nuvyn-deferred-notation highlight:2]"',
      'const deferred = 1 // [!code highlight:2]',
      'const invalid = 2 // [!code focus:1001]',
    ].join('\n')
    const html = highlightShikiFence(source, parseFenceMeta('ts'))
    if (!html) throw new Error('H3 expected Shiki HTML')

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const lines = Array.from(doc.querySelectorAll('pre.shiki .line'))
    const text = lines.map((line) => line.textContent ?? '').join('\n')
    expect(text).toContain('[!code nuvyn-deferred-notation hello]')
    expect(text).toContain('[!code nuvyn-deferred-notation highlight:2]')
    expect(text).toContain('[!code highlight:2]')
    expect(text).toContain('[!code focus:1001]')
    expect(lines[2]?.classList.contains('highlighted')).toBe(false)
    expect(lines[3]?.classList.contains('focused')).toBe(false)
    expect(html).not.toContain('nuvyn-deferred-notation-0-')
  })

  it('chooses another invocation-local sentinel when the first candidate is in source', async () => {
    await expect(ensureShikiLanguage('ts')).resolves.toMatchObject({ status: 'loaded' })
    const source = [
      'const literal = "[!code nuvyn-deferred-notation-0- hello]"',
      'const deferred = 1 // [!code highlight:2]',
    ].join('\n')
    const html = highlightShikiFence(source, parseFenceMeta('ts'))
    if (!html) throw new Error('H3 expected Shiki HTML')

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const text = Array.from(doc.querySelectorAll('pre.shiki .line'))
      .map((line) => line.textContent ?? '')
      .join('\n')
    expect(text).toContain('[!code nuvyn-deferred-notation-0- hello]')
    expect(text).toContain('[!code highlight:2]')
    expect(html).not.toContain('nuvyn-deferred-notation-1-')
  })

  it('keeps invocation-local deferred markers isolated across concurrent calls', async () => {
    await expect(ensureShikiLanguage('ts')).resolves.toMatchObject({ status: 'loaded' })
    const sourceA = 'const a = "[!code nuvyn-deferred-notation-0- hello]"\nconst x = 1 // [!code highlight:2]'
    const sourceB = 'const b = 1 // [!code focus:1001]'
    const [htmlA, htmlB] = await Promise.all([
      Promise.resolve().then(() => highlightShikiFence(sourceA, parseFenceMeta('ts'))),
      Promise.resolve().then(() => highlightShikiFence(sourceB, parseFenceMeta('ts'))),
    ])
    if (!htmlA || !htmlB) throw new Error('H3 expected Shiki HTML')

    expect(htmlA).toContain('[!code nuvyn-deferred-notation-0- hello]')
    expect(htmlA).toContain('[!code highlight:2]')
    expect(htmlB).toContain('[!code focus:1001]')
    expect(htmlA).not.toContain('nuvyn-deferred-notation-1-')
    expect(htmlB).not.toContain('nuvyn-deferred-notation-')
  })
})

describe('Shiki H4 style-to-class and stylesheet ownership', () => {
  it('passes the one shared transformer to production codeToHtml', async () => {
    const optionsSeen: CodeToHtmlOptions[] = []
    const codeToHtml = vi.fn((source: string, options?: CodeToHtmlOptions) => {
      if (!options) throw new Error('H4 test expected codeToHtml options')
      optionsSeen.push(options)
      return `<pre class="shiki"><code><span class="line">${source}</span></code></pre>`
    })
    const runtime = fakeLanguageHighlighter(async () => {}, [], codeToHtml)
    const factory = useFakeLanguageRuntime(runtime)

    await expect(ensureShikiLanguage('js')).resolves.toMatchObject({ status: 'loaded' })
    const html = highlightShikiFence('const answer = 42', 'js')

    expect(html).toContain('class="shiki"')
    expect(optionsSeen).toHaveLength(1)
    expect(optionsSeen[0]?.transformers?.at(-1)).toBe(getShikiStyleTransformer())
    expect(optionsSeen[0]?.transformers?.map((transformer) => transformer.name)).toContain(
      '@shikijs/transformers:notation-focus',
    )
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('emits class-based production HTML and one reusable complete CSS owner', async () => {
    await expect(ensureShikiLanguage('javascript')).resolves.toMatchObject({ status: 'loaded' })
    const javascriptHtml = highlightShikiFence('const answer = 42', 'javascript')
    expect(javascriptHtml).toContain('nuvyn-shiki-')
    expect(javascriptHtml).not.toMatch(/\sstyle=/i)

    const initialCss = getGeneratedShikiCss()
    expect(initialCss).toContain('.nuvyn-shiki-')
    expect(initialCss).toContain('--shiki-light:')
    expect(initialCss).toContain('--shiki-dark:')

    syncGeneratedShikiStylesheet()
    const firstOwner = document.head.querySelector('style#nuvyn-shiki-generated-styles')
    expect(firstOwner).not.toBeNull()
    expect(firstOwner?.parentElement).toBe(document.head)
    expect(firstOwner?.textContent).toBe(initialCss)

    // Re-syncing the same snapshot must preserve both owner identity and the
    // exact full stylesheet text rather than append duplicate rules.
    syncGeneratedShikiStylesheet()
    expect(document.head.querySelectorAll('style#nuvyn-shiki-generated-styles')).toHaveLength(1)
    expect(document.head.querySelector('style#nuvyn-shiki-generated-styles')).toBe(firstOwner)
    expect(firstOwner?.textContent).toBe(initialCss)

    // A stale owner is replaced by the complete current snapshot.
    if (!firstOwner) throw new Error('H4 stylesheet owner was not created')
    firstOwner.textContent = 'STALE_CSS_SENTINEL'
    syncGeneratedShikiStylesheet()
    expect(firstOwner.textContent).toBe(initialCss)
    expect(firstOwner.textContent).not.toContain('STALE_CSS_SENTINEL')

    await expect(ensureShikiLanguage('python')).resolves.toMatchObject({ status: 'loaded' })
    await expect(ensureShikiLanguage('java')).resolves.toMatchObject({ status: 'loaded' })
    expect(highlightShikiFence('print(1)', 'python')).toContain('nuvyn-shiki-')
    expect(highlightShikiFence('class Demo {}', 'java')).toContain('nuvyn-shiki-')
    const expandedCss = getGeneratedShikiCss()
    syncGeneratedShikiStylesheet()

    expect(expandedCss).toContain('.nuvyn-shiki-')
    expect(firstOwner.textContent).toBe(expandedCss)
    expect(document.head.querySelectorAll('style#nuvyn-shiki-generated-styles')).toHaveLength(1)
  })

  it('does not require document to read CSS or synchronize the stylesheet', async () => {
    await expect(ensureShikiLanguage('javascript')).resolves.toMatchObject({ status: 'loaded' })
    expect(highlightShikiFence('const answer = 42', 'javascript')).toContain('nuvyn-shiki-')
    const css = getGeneratedShikiCss()
    expect(css).not.toBe('')

    vi.stubGlobal('document', undefined)
    try {
      expect(() => syncGeneratedShikiStylesheet()).not.toThrow()
      expect(getGeneratedShikiCss()).toBe(css)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('treats a missing head or DOM write failure as a safe stylesheet no-op', async () => {
    await expect(ensureShikiLanguage('javascript')).resolves.toMatchObject({ status: 'loaded' })
    expect(highlightShikiFence('const answer = 42', 'javascript')).toContain('nuvyn-shiki-')

    vi.stubGlobal('document', { head: undefined } as unknown as Document)
    try {
      expect(() => syncGeneratedShikiStylesheet()).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }

    const appendChild = vi.spyOn(document.head, 'appendChild').mockImplementationOnce(() => {
      throw new Error('head is temporarily unwritable')
    })
    try {
      expect(() => syncGeneratedShikiStylesheet()).not.toThrow()
      expect(document.head.querySelector('style#nuvyn-shiki-generated-styles')).toBeNull()
    } finally {
      appendChild.mockRestore()
    }
  })

  it('test reset removes only the managed head owner', async () => {
    await expect(ensureShikiLanguage('javascript')).resolves.toMatchObject({ status: 'loaded' })
    expect(highlightShikiFence('const answer = 42', 'javascript')).toContain('nuvyn-shiki-')
    syncGeneratedShikiStylesheet()

    const unrelatedOwner = document.createElement('style')
    unrelatedOwner.id = 'unrelated-style-owner'
    unrelatedOwner.textContent = 'body { color: red; }'
    document.head.appendChild(unrelatedOwner)

    __testing__.reset()

    expect(document.head.querySelector('style#nuvyn-shiki-generated-styles')).toBeNull()
    expect(document.head.querySelector('style#unrelated-style-owner')).toBe(unrelatedOwner)
    unrelatedOwner.remove()
  })
})
