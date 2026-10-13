// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Highlighter } from 'shiki'
import { render } from '../markdown'
import { __testing__ as shikiTesting } from '../shiki'

function installFakeShikiRuntime() {
  const loadLanguage = vi.fn(async () => {})
  const codeToHtml = vi.fn((source: string) => (
    `<pre class="shiki"><code><span class="line">${source}</span></code></pre>`
  ))
  const runtime = {
    dispose: vi.fn(),
    getLoadedLanguages: vi.fn(() => []),
    loadLanguage,
    codeToHtml,
  } as unknown as Highlighter
  const factory = vi.fn(() => Promise.resolve(runtime))
  shikiTesting.setHighlighterFactory(factory)
  return { factory, loadLanguage, codeToHtml }
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

describe('Nuvyn custom Markdown containers', () => {
  it('renders the five allowlisted types with default and custom titles', async () => {
    const doc = parse(await render([
      '::: info',
      'Information.',
      ':::',
      '',
      '::: tip **Custom** Tip',
      'Helpful.',
      ':::',
      '',
      '::: warning',
      'Caution.',
      ':::',
      '',
      '::: danger STOP',
      'Danger.',
      ':::',
      '',
      '::: details Click `me`',
      'Hidden.',
      ':::',
    ].join('\n')))

    expect(doc.querySelectorAll('.markdown-container')).toHaveLength(5)
    expect(doc.querySelector('.markdown-container-info')?.textContent).toContain('Info')
    expect(doc.querySelector('.markdown-container-tip .markdown-container-title')?.innerHTML)
      .toContain('<strong>Custom</strong> Tip')
    expect(doc.querySelector('.markdown-container-warning .markdown-container-title')?.textContent)
      .toBe('Warning')
    expect(doc.querySelector('.markdown-container-danger .markdown-container-title')?.textContent)
      .toBe('STOP')
    expect(doc.querySelector('.markdown-container-details')?.tagName).toBe('DETAILS')
    expect(doc.querySelector('.markdown-container-details summary')?.textContent).toBe('Click me')
  })

  it('renders image-row as a plain responsive wrapper around standard Markdown image tokens', async () => {
    const doc = parse(await render([
      '::: image-row',
      '',
      '![Architecture A](a.png)',
      '',
      '![Architecture B](b.svg)',
      '',
      ':::',
    ].join('\n')))
    const row = doc.querySelector<HTMLElement>('.nuvyn-image-row')
    const images = Array.from(row?.querySelectorAll<HTMLImageElement>('img') ?? [])

    expect(row).not.toBeNull()
    expect(row?.className).toBe('nuvyn-image-row')
    expect(row?.classList.contains('markdown-container')).toBe(false)
    expect(row?.querySelector('.markdown-container-title')).toBeNull()
    expect(images.map((image) => image.getAttribute('src')))
      .toEqual(['a.png', 'b.svg'])
    expect(images.map((image) => image.getAttribute('alt'))).toEqual(['Architecture A', 'Architecture B'])
    expect(images.every((image) => image.getAttribute('loading') === 'lazy')).toBe(true)

    for (const imageCount of [3, 4, 5]) {
      const source = [
        '::: image-row',
        '',
        ...Array.from({ length: imageCount }, (_, index) => `![Image ${index + 1}](image-${index + 1}.png)`),
        '',
        ':::',
      ].join('\n')
      const rendered = parse(await render(source))
      expect(rendered.querySelectorAll('.nuvyn-image-row')).toHaveLength(1)
      expect(rendered.querySelectorAll('.nuvyn-image-row img')).toHaveLength(imageCount)
    }
  })

  it('preserves invalid image-row source instead of swallowing content or changing normal images', async () => {
    const invalidSources = [
      '::: image-row\n\n:::',
      '::: image-row\n\n![Only](only.png)\n\n:::',
      '::: image-row\n\n![A](a.png)\n\nKeep this text.\n\n![B](b.png)\n\n:::',
      '::: image-row\n\n![A](a.png)\n\n```text\ncode\n```\n\n![B](b.png)\n\n:::',
      '::: image-row\n\n![A](a.png)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![B](b.png)\n\n:::',
      '::: image-row Custom title\n\n![A](a.png)\n\n![B](b.png)\n\n:::',
      '::: image-row\n\n![A](a.png)\n\n![B](b.png)',
      '::: image-row\n\n![A](a.png)\n\n::: info nested\ntext\n:::\n\n![B](b.png)\n\n:::',
    ]

    for (const source of invalidSources) {
      const doc = parse(await render(source))
      expect(doc.querySelector('.nuvyn-image-row')).toBeNull()
      expect(doc.body.textContent).toContain('image-row')
    }

    const ordinary = parse(await render('![Standalone](image.png)'))
    expect(ordinary.querySelector('.nuvyn-image-row')).toBeNull()
    expect(ordinary.querySelector('p > img')?.getAttribute('alt')).toBe('Standalone')
  })

  it('keeps image-row fenced as code and composes with existing containers', async () => {
    const doc = parse(await render([
      ':::: info Images',
      '',
      '::: image-row',
      '',
      '![A](a.png)',
      '',
      '![B](b.svg)',
      '',
      ':::',
      '',
      '```md',
      '::: image-row',
      '![Code](code.png)',
      ':::',
      '```',
      '',
      '::::',
    ].join('\n')))

    expect(doc.querySelector('.markdown-container-info .nuvyn-image-row img[src="a.png"]')).not.toBeNull()
    expect(doc.querySelector('.markdown-container-info pre code')?.textContent)
      .toContain('::: image-row\n![Code](code.png)\n:::')
    expect(doc.querySelectorAll('.nuvyn-image-row')).toHaveLength(1)
  })

  it('keeps the image-row class parser-owned and preserves the existing sanitizer boundary', async () => {
    const doc = parse(await render([
      '::: image-row',
      '',
      '![A](a.png)',
      '',
      '![B](b.svg)',
      '',
      ':::',
      '',
      '<div class="nuvyn-image-row" style="display:flex" onclick="alert(1)">',
      '<img src="javascript:alert(1)" onerror="alert(1)">',
      '</div>',
      '',
      '<svg><rect width="1" height="1"></rect></svg>',
    ].join('\n')))

    expect(doc.querySelectorAll('.nuvyn-image-row')).toHaveLength(1)
    expect(doc.querySelector('.nuvyn-image-row img')?.getAttribute('src')).toBe('a.png')
    expect(doc.querySelector('[style]')).toBeNull()
    expect(doc.querySelector('[onclick], [onerror]')).toBeNull()
    expect(doc.querySelector('img[src^="javascript:"]')).toBeNull()
    expect(doc.querySelector('svg')).toBeNull()
  })

  it('uses native details state and accepts only the literal details {open} modifier', async () => {
    const closed = parse(await render('::: details\nHidden\n:::'))
    const opened = parse(await render('::: details Open {open}\nVisible\n:::'))
    const invalid = parse(await render([
      '::: details {OPEN}',
      'Upper case.',
      ':::',
      '',
      '::: details { open }',
      'Spaced.',
      ':::',
      '',
      '::: details {open=true}',
      'Assigned.',
      ':::',
      '',
      '::: info {open}',
      'Not details.',
      ':::',
    ].join('\n')))

    expect(closed.querySelector<HTMLDetailsElement>('details')?.open).toBe(false)
    expect(opened.querySelector<HTMLDetailsElement>('details')?.open).toBe(true)
    expect(opened.querySelector('details')?.getAttribute('open')).toBe('open')
    expect(invalid.querySelectorAll('details[open]')).toHaveLength(0)
    expect(invalid.querySelector('.markdown-container-info')?.hasAttribute('open')).toBe(false)
  })

  it('keeps nested containers owned by delimiter length, including same-type nesting', async () => {
    const doc = parse(await render([
      ':::: warning Outer',
      '',
      '::: details Inner',
      'Nested body.',
      ':::',
      '',
      '::::',
      '',
      ':::: info Outer info',
      '::: info Inner info',
      'Same type.',
      ':::',
      '::::',
    ].join('\n')))

    const outerWarning = doc.querySelector('.markdown-container-warning')
    const innerDetails = outerWarning?.querySelector('.markdown-container-details')
    expect(innerDetails?.parentElement).toBe(outerWarning)
    expect(outerWarning?.textContent).toContain('Nested body.')

    const infoContainers = Array.from(doc.querySelectorAll('.markdown-container-info'))
    expect(infoContainers).toHaveLength(2)
    expect(infoContainers[1]?.parentElement).toBe(infoContainers[0])
    expect(infoContainers[0]?.textContent).toContain('Same type.')
  })

  it('does not treat container-looking lines inside fenced code as delimiters', async () => {
    const doc = parse(await render([
      ':::: info Code sample',
      '',
      '```text',
      '::: warning',
      '::::',
      '```',
      '',
      'After the code fence.',
      '::::',
    ].join('\n')))

    expect(doc.querySelectorAll('.markdown-container')).toHaveLength(1)
    expect(doc.querySelector('.markdown-container-warning')).toBeNull()
    expect(doc.querySelector('.markdown-container-info pre code')?.textContent)
      .toContain('::: warning\n::::\n')
    expect(doc.querySelector('.markdown-container-info')?.textContent)
      .toContain('After the code fence.')
  })

  it('does not treat delimiter-looking lines inside raw HTML blocks as closes', async () => {
    const doc = parse(await render([
      ':::: info HTML example',
      '',
      '<div>',
      '::::',
      '</div>',
      '',
      'After HTML.',
      '',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    expect(doc.querySelectorAll('.markdown-container')).toHaveLength(1)
    expect(container?.textContent).toContain('After HTML.')
    expect(container?.querySelector('.markdown-container')).toBeNull()
    expect(container?.querySelector('div:not(.markdown-container-title)')?.textContent)
      .toContain('::::')
  })

  it('does not treat HTML type 7 as opaque while a paragraph is open', async () => {
    const doc = parse(await render([
      ':::: info Paragraph context',
      'Before',
      '<span>inline</span>',
      '::::',
      '',
      'After container',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    const after = Array.from(doc.querySelectorAll('p'))
      .find((paragraph) => paragraph.textContent?.includes('After container'))

    expect(container).not.toBeNull()
    expect(container?.querySelector('span')?.textContent).toBe('inline')
    expect(container?.querySelector('p')?.textContent).toContain('Before')
    expect(after?.closest('.markdown-container')).toBeNull()
  })

  it('protects HTML type 7 at a real block boundary', async () => {
    const doc = parse(await render([
      ':::: info HTML boundary',
      '',
      '## Heading',
      '<span>',
      '::::',
      '</span>',
      '',
      'After HTML block',
      '',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    expect(doc.querySelectorAll('.markdown-container')).toHaveLength(1)
    expect(container?.querySelector('h2')?.textContent).toBe('Heading')
    expect(container?.querySelector('span')).not.toBeNull()
    expect(container?.textContent).toContain('::::')
    expect(container?.textContent).toContain('After HTML block')
  })

  it('keeps paragraph-interrupting HTML block ownership for type 1-6', async () => {
    const doc = parse(await render([
      ':::: info HTML paragraph interrupt',
      'Before',
      '<div>',
      '::::',
      '</div>',
      '',
      'After HTML',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    expect(doc.querySelectorAll('.markdown-container')).toHaveLength(1)
    expect(container?.querySelector('div:not(.markdown-container-title)')?.textContent)
      .toContain('::::')
    expect(container?.textContent).toContain('After HTML')
  })

  it('keeps nested-container-looking lines inside raw HTML ownership', async () => {
    const doc = parse(await render([
      ':::: warning HTML boundary',
      '',
      '<section>',
      '::: details',
      'Not a Nuvyn container here.',
      ':::',
      '</section>',
      '',
      'After raw HTML.',
      '',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-warning')
    expect(doc.querySelectorAll('.markdown-container')).toHaveLength(1)
    expect(container?.textContent).toContain('Not a Nuvyn container here.')
    expect(container?.textContent).toContain('After raw HTML.')
    expect(container?.querySelector('.markdown-container-details')).toBeNull()
  })

  it('keeps raw HTML ownership while preserving the sanitizer boundary', async () => {
    const doc = parse(await render([
      ':::: info Sanitized HTML',
      '',
      '<div onclick="alert(1)">',
      '::::',
      '</div>',
      '',
      'After unsafe HTML.',
      '',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    expect(container?.textContent).toContain('After unsafe HTML.')
    expect(container?.querySelector('[onclick]')).toBeNull()
  })

  it('keeps closer-looking lines inside Nuvyn math blocks', async () => {
    const doc = parse(await render([
      ':::: info Math boundary',
      '',
      '$$',
      'a = 1',
      '::::',
      'b = 2',
      '$$',
      '',
      'After math.',
      '',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    expect(doc.querySelectorAll('.markdown-container')).toHaveLength(1)
    expect(container?.textContent).toContain('After math.')
    expect(container?.querySelector('.math-mount')).not.toBeNull()
    const mathContent = container?.querySelector('.math-mount')?.getAttribute('data-content') ?? ''
    expect(decodeURIComponent(mathContent)).toContain('::::')
  })

  it('does not grant paragraph-continuation $$ a math-block range', async () => {
    const doc = parse(await render([
      ':::: info Math paragraph context',
      'Before',
      '$$',
      '::::',
      '$$',
      '',
      'After math continuation',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    const after = Array.from(doc.querySelectorAll('p'))
      .find((paragraph) => paragraph.textContent?.includes('After math continuation'))

    expect(container?.querySelector('.math-mount')).toBeNull()
    expect(container?.querySelector('p')?.textContent).toContain('Before')
    expect(container?.querySelector('p')?.textContent).toContain('$$')
    expect(after?.closest('.markdown-container')).toBeNull()
  })

  it('keeps closer-looking lines inside indented code blocks', async () => {
    const doc = parse(await render([
      ':::: info Indented code',
      '',
      '    ::::',
      '    literal code',
      '',
      'After code.',
      '',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    expect(doc.querySelectorAll('.markdown-container')).toHaveLength(1)
    expect(container?.textContent).toContain('::::\nliteral code')
    expect(container?.textContent).toContain('After code.')
  })

  it('keeps an indented lazy continuation in the open paragraph', async () => {
    const doc = parse(await render([
      ':::: info Indented paragraph context',
      'Before',
      '    indented continuation',
      '::::',
      '',
      'After paragraph',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    const after = Array.from(doc.querySelectorAll('p'))
      .find((paragraph) => paragraph.textContent?.includes('After paragraph'))

    expect(container?.querySelector('pre')).toBeNull()
    expect(container?.querySelector('p')?.textContent).toContain('Before')
    expect(container?.querySelector('p')?.textContent).toContain('indented continuation')
    expect(after?.closest('.markdown-container')).toBeNull()
  })

  it('keeps closer-looking lines inside tilde fenced code', async () => {
    const doc = parse(await render([
      ':::: info Tilde fence',
      '',
      '~~~text',
      '::::',
      '~~~',
      '',
      'After tilde fence.',
      '',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    expect(doc.querySelectorAll('.markdown-container')).toHaveLength(1)
    expect(container?.querySelector('pre code')?.textContent).toContain('::::')
    expect(container?.textContent).toContain('After tilde fence.')
  })

  it('supports three-level nesting without a module-global container stack', async () => {
    const [htmlA, htmlB] = await Promise.all([
      render([
        '::::: danger Outer',
        ':::: tip Middle',
        '::: info Inner',
        'A',
        ':::',
        '::::',
        ':::::',
      ].join('\n')),
      render('::: details\nB\n:::'),
    ])

    const docA = parse(htmlA)
    expect(docA.querySelector('.markdown-container-danger .markdown-container-tip .markdown-container-info'))
      .not.toBeNull()
    expect(parse(htmlB).querySelector('.markdown-container-details')?.textContent).toContain('B')
  })

  it('does not swallow the document tail for unclosed or unknown syntax', async () => {
    const unclosed = parse(await render([
      '::: info',
      'This is ordinary fallback text.',
      '',
      '## Tail heading',
      '',
      'Tail paragraph.',
    ].join('\n')))
    const unknown = parse(await render([
      '::: success',
      'Unknown body.',
      ':::',
      '',
      '::: code-group',
      '',
      '```js',
      'const value = 1',
      '```',
      '',
      ':::',
    ].join('\n')))

    expect(unclosed.querySelector('.markdown-container')).toBeNull()
    expect(unclosed.querySelector('h2')?.textContent).toContain('Tail heading')
    expect(unclosed.body.textContent).toContain('Tail paragraph.')
    expect(unknown.querySelector('.markdown-container-success')).toBeNull()
    expect(unknown.querySelector('.markdown-container-code-group')).toBeNull()
  })

  it('keeps normal Markdown, anchors, links, images, and callouts in the same body flow', async () => {
    const doc = parse(await render([
      '::: info Container',
      '## Nested {#nested}',
      '',
      '> [!NOTE]',
      '> Existing callout.',
      '',
      '[External](https://example.com)',
      '',
      '![Lazy](image.png)',
      ':::',
    ].join('\n')))

    expect(doc.querySelector('.markdown-container-info')).not.toBeNull()
    expect(doc.querySelector('.markdown-container-info h2#nested')).not.toBeNull()
    expect(doc.querySelector('.nuvyn-toc')).toBeNull()
    expect(doc.querySelector('.markdown-container-info .callout-note')).not.toBeNull()
    expect(doc.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')?.target).toBe('_blank')
    expect(doc.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')?.rel)
      .toBe('noopener noreferrer')
    expect(doc.querySelector('img')?.getAttribute('loading')).toBe('lazy')
  })

  it('supports a custom container inside an existing callout when blockquote nesting permits it', async () => {
    const doc = parse(await render([
      '> [!NOTE]',
      '> Callout body.',
      '>',
      '> ::: tip',
      '> Nested container.',
      '> :::',
    ].join('\n')))

    const callout = doc.querySelector('.callout-note')
    expect(callout).not.toBeNull()
    expect(callout?.querySelector('.markdown-container-tip')?.textContent).toContain('Nested container.')
  })

  it('preserves Shiki, Mermaid, MarkMap, and math inside a container', async () => {
    installFakeShikiRuntime()
    const doc = parse(await render([
      '::: info Mixed body',
      '',
      '```js',
      'const value = 1',
      '```',
      '',
      '```mermaid',
      'graph TD',
      'A --> B',
      '```',
      '',
      '```markmap',
      '# Root',
      '```',
      '',
      '$E = mc^2$',
      ':::',
    ].join('\n')))

    expect(doc.querySelector('.markdown-container-info pre.shiki')).not.toBeNull()
    expect(doc.querySelector('.markdown-container-info .mermaid-mount')).not.toBeNull()
    expect(doc.querySelector('.markdown-container-info .markmap-mount')).not.toBeNull()
    expect(doc.querySelector('.markdown-container-info .math-inline')).not.toBeNull()
  })

  it('does not turn titles or metadata into generic attributes or unsafe HTML', async () => {
    const doc = parse(await render([
      '::: info {#foo} <img src=x onerror="alert(1)"> <script>alert(2)</script>',
      'Body.',
      ':::',
      '',
      '::: warning {style="color:red" onclick="alert(3)"}',
      'Body.',
      ':::',
    ].join('\n')))

    expect(doc.querySelector('.markdown-container-info')?.getAttribute('id')).toBeNull()
    expect(doc.querySelector('.markdown-container-info')?.getAttribute('style')).toBeNull()
    expect(doc.querySelector('.markdown-container-warning')?.getAttribute('onclick')).toBeNull()
    expect(doc.querySelectorAll('[onerror], [onclick], [style], script')).toHaveLength(0)
    expect(doc.querySelector('.markdown-container-info img')?.getAttribute('onerror')).toBeNull()
  })
})

describe('custom container Shiki preparation', () => {
  beforeEach(() => {
    shikiTesting.reset()
  })

  afterEach(() => {
    shikiTesting.reset()
  })

  it('discovers a nested fence through the existing preparation path', async () => {
    const { factory, loadLanguage, codeToHtml } = installFakeShikiRuntime()
    const html = await render('::: info\n\n```js\nconst value = 1\n```\n\n:::')

    expect(factory).toHaveBeenCalledTimes(1)
    expect(loadLanguage).toHaveBeenCalledTimes(1)
    expect(codeToHtml).toHaveBeenCalledTimes(1)
    expect(html).toContain('markdown-container-info')
    expect(html).toContain('class="shiki"')
  })
})
