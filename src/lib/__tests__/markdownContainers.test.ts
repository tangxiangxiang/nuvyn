// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Highlighter } from 'shiki'
import { render } from '../markdown'
import { __testing__ as containerTesting } from '../markdownContainers'
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
  it('renders titles only when an explicit alias is supplied', async () => {
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
    expect(doc.querySelector('.markdown-container-info')?.textContent?.trim()).toBe('Information.')
    expect(doc.querySelector('.markdown-container-info .markdown-container-title')).toBeNull()
    expect(doc.querySelector('.markdown-container-tip .markdown-container-title')?.innerHTML)
      .toContain('<strong>Custom</strong> Tip')
    expect(doc.querySelector('.markdown-container-warning .markdown-container-title')).toBeNull()
    expect(doc.querySelector('.markdown-container-danger .markdown-container-title')?.textContent)
      .toBe('STOP')
    expect(doc.querySelector('.markdown-container-details')?.tagName).toBe('DETAILS')
    expect(doc.querySelector('.markdown-container-details summary')?.textContent).toBe('Click me')
  })

  it.each(['info', 'tip', 'warning', 'danger', 'details'])(
    'omits the default %s title and its empty heading without losing the body',
    async (type) => {
      const doc = parse(await render(`::: ${type}   \n\n**Body** with content.\n\n:::`))
      const container = doc.querySelector(`.markdown-container-${type}`)!

      expect(container).not.toBeNull()
      expect(container.tagName).toBe('DIV')
      expect(container.querySelector('.markdown-container-title, summary, details')).toBeNull()
      expect(container.firstElementChild?.tagName).toBe('P')
      expect(container.querySelector('strong')?.textContent).toBe('Body')
      expect(container.textContent).toContain('with content.')
    },
  )

  it.each(['info', 'tip', 'warning', 'danger', 'details'])(
    'preserves an explicit %s alias and safe inline Markdown',
    async (type) => {
      const doc = parse(await render(`::: ${type} 自定义 **别名**\nBody.\n:::`))
      const container = doc.querySelector(`.markdown-container-${type}`)!

      expect(container.querySelector('.markdown-container-title')?.textContent).toBe('自定义 别名')
      expect(container.querySelector('.markdown-container-title strong')?.textContent).toBe('别名')
      expect(container.tagName).toBe(type === 'details' ? 'DETAILS' : 'DIV')
    },
  )

  it('shows an unnamed details body directly even when only the open modifier is supplied', async () => {
    const doc = parse(await render('::: details {open}\nAlways visible.\n:::'))
    const container = doc.querySelector('.markdown-container-details')!

    expect(container.tagName).toBe('DIV')
    expect(container.hasAttribute('open')).toBe(false)
    expect(container.querySelector('summary, .markdown-container-title')).toBeNull()
    expect(container.textContent).toContain('Always visible.')
  })

  it('uses one Flex container and makes each direct Markdown block an implicit item', async () => {
    const doc = parse(await render([
      '::: flex',
      '',
      '![Architecture A](a.png)',
      '',
      '![Architecture B](b.svg)',
      '',
      'A paragraph with a soft line break',
      'that remains in the same Markdown block.',
      '',
      'A second paragraph.',
      '',
      ':::',
    ].join('\n')))
    const flex = doc.querySelector<HTMLElement>('.nuvyn-flex')
    const children = Array.from(flex?.children ?? [])

    expect(flex).not.toBeNull()
    expect(children.map((child) => child.tagName)).toEqual(['P', 'P', 'P', 'P'])
    expect(children[0]?.querySelector('img')?.getAttribute('src')).toBe('a.png')
    expect(children[1]?.querySelector('img')?.getAttribute('src')).toBe('b.svg')
    expect(children[2]?.textContent).toMatch(/soft line break\s+that remains/u)
    expect(children[2]?.querySelectorAll('br')).toHaveLength(0)
    expect(children[3]?.textContent).toBe('A second paragraph.')
    expect(flex?.querySelector('.nuvyn-flex-item')).toBeNull()
  })

  it('keeps headings, lists, code, callouts, and tables as distinct automatic Flex items', async () => {
    const doc = parse(await render([
      '::: flex',
      '',
      '## Heading item',
      '',
      '- First list item',
      '- Second list item',
      '',
      '```text',
      'code item',
      '```',
      '',
      '::: tip',
      'Callout item',
      ':::',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      ':::',
    ].join('\n')))
    const flex = doc.querySelector<HTMLElement>('.nuvyn-flex')

    expect(Array.from(flex?.children ?? []).map((child) => child.tagName)).toEqual([
      'H2', 'UL', 'PRE', 'DIV', 'DIV',
    ])
    expect(flex?.children[0]?.textContent).toContain('Heading item')
    expect(flex?.children[3]?.textContent).toContain('Callout item')
    expect(flex?.children[4]?.querySelector('.table-scroll > table')).not.toBeNull()
  })

  it('does not activate the removed image-row syntax or lose its ordinary Markdown content', async () => {
    const doc = parse(await render([
      '::: image-row',
      '',
      '![A](a.png)',
      '',
      '![B](b.svg)',
      '',
      ':::',
    ].join('\n')))

    expect(doc.querySelector('.nuvyn-image-row, .nuvyn-flex')).toBeNull()
    expect(Array.from(doc.querySelectorAll('img')).map((image) => image.getAttribute('src')))
      .toEqual(['a.png', 'b.svg'])
    expect(doc.body.textContent).toContain('image-row')
  })

  it('uses native details state and accepts only the literal details {open} modifier', async () => {
    const closed = parse(await render('::: details Closed\nHidden\n:::'))
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

  it('renders Flexbox properties on one container and its nested Flex items', async () => {
    const doc = parse(await render([
      ':::: flex direction=row-reverse wrap=wrap-reverse justify=space-evenly items=first-baseline content=space-between gap=32 mobile=preserve',
      '',
      '::: flex direction=column grow=4 shrink=0 basis=33.33% self=flex-end order=-2',
      '',
      '## First item',
      '',
      'Multiple Markdown blocks stay inside this nested Flex.',
      ':::',
      '',
      '::: flex basis=50%',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      ':::',
      '::::',
    ].join('\n')))
    const flexes = Array.from(doc.querySelectorAll<HTMLElement>('.nuvyn-flex'))
    const outer = flexes[0]
    const firstNested = flexes[1]
    const firstScope = firstNested?.parentElement
    const secondNested = flexes[2]
    const secondScope = secondNested?.parentElement

    expect(flexes).toHaveLength(3)
    expect(outer?.classList.contains('nuvyn-flex-direction-row-reverse')).toBe(true)
    expect(outer?.classList.contains('nuvyn-flex-wrap-wrap-reverse')).toBe(true)
    expect(outer?.classList.contains('nuvyn-flex-justify-space-evenly')).toBe(true)
    expect(outer?.classList.contains('nuvyn-flex-items-first-baseline')).toBe(true)
    expect(outer?.classList.contains('nuvyn-flex-content-space-between')).toBe(true)
    expect(outer?.classList.contains('nuvyn-flex-gap-32')).toBe(true)
    expect(outer?.classList.contains('nuvyn-flex-mobile-preserve')).toBe(true)
    expect(firstNested?.children).toHaveLength(2)
    expect(firstNested?.querySelector('h2')?.textContent).toBe('First item')
    expect(firstNested?.querySelector('p')?.textContent).toContain('Multiple Markdown blocks')
    expect(firstScope?.classList.contains('nuvyn-flex-item-grow-4')).toBe(true)
    expect(firstScope?.classList.contains('nuvyn-flex-item-shrink-0')).toBe(true)
    expect(firstScope?.classList.contains('nuvyn-flex-item-basis-33-33')).toBe(true)
    expect(firstScope?.classList.contains('nuvyn-flex-item-self-flex-end')).toBe(true)
    expect(firstScope?.classList.contains('nuvyn-flex-item-order--2')).toBe(true)
    expect(secondNested?.querySelector('table')).not.toBeNull()
    expect(secondScope?.classList.contains('nuvyn-flex-item-basis-50')).toBe(true)
    expect(doc.querySelector('[data-nuvyn-flex-provenance], [data-nuvyn-flex-item-provenance]')).toBeNull()
  })

  it('applies CSS-standard defaults and allowlisted extended alignment values', async () => {
    const defaults = parse(await render('::: flex\nDefault direct item.\n:::'))
    const flex = defaults.querySelector<HTMLElement>('.nuvyn-flex')
    const scope = defaults.querySelector<HTMLElement>('.nuvyn-flex-scope')

    expect(flex?.classList.contains('nuvyn-flex-direction-row')).toBe(true)
    expect(flex?.classList.contains('nuvyn-flex-wrap-wrap')).toBe(true)
    expect(flex?.classList.contains('nuvyn-flex-justify-flex-start')).toBe(true)
    expect(flex?.classList.contains('nuvyn-flex-items-stretch')).toBe(true)
    expect(flex?.classList.contains('nuvyn-flex-content-stretch')).toBe(true)
    expect(flex?.classList.contains('nuvyn-flex-gap-16')).toBe(true)
    expect(flex?.classList.contains('nuvyn-flex-mobile-stack')).toBe(true)
    expect(scope?.classList.contains('nuvyn-flex-item-grow-0')).toBe(true)
    expect(scope?.classList.contains('nuvyn-flex-item-shrink-1')).toBe(true)
    expect(scope?.classList.contains('nuvyn-flex-item-basis-auto')).toBe(true)
    expect(scope?.classList.contains('nuvyn-flex-item-self-auto')).toBe(true)
    expect(scope?.classList.contains('nuvyn-flex-item-order-0')).toBe(true)

    const alignments = parse(await render([
      '::: flex justify=safe-center items=self-start content=first-baseline',
      'Custom alignment.',
      ':::',
    ].join('\n')))
    const alignedFlex = alignments.querySelector<HTMLElement>('.nuvyn-flex')
    expect(alignedFlex?.classList.contains('nuvyn-flex-justify-safe-center')).toBe(true)
    expect(alignedFlex?.classList.contains('nuvyn-flex-items-self-start')).toBe(true)
    expect(alignedFlex?.classList.contains('nuvyn-flex-content-first-baseline')).toBe(true)

    const safeAlignment = parse(await render([
      ':::: flex items=safe-self-start',
      '::: flex self=unsafe-flex-end',
      'Nested item.',
      ':::',
      '::::',
    ].join('\n')))
    expect(safeAlignment.querySelector('.nuvyn-flex-items-safe-self-start')).not.toBeNull()
    expect(safeAlignment.querySelector('.nuvyn-flex-item-self-unsafe-flex-end')).not.toBeNull()
  })

  it('accepts the full controlled CSS alignment keyword sets', () => {
    const values = {
      direction: ['row', 'row-reverse', 'column', 'column-reverse'],
      wrap: ['nowrap', 'wrap', 'wrap-reverse'],
      justify: [
        'normal', 'start', 'end', 'flex-start', 'flex-end', 'center', 'left', 'right', 'stretch',
        'space-between', 'space-around', 'space-evenly', 'safe-start', 'unsafe-start', 'safe-end',
        'unsafe-end', 'safe-flex-start', 'unsafe-flex-start', 'safe-flex-end', 'unsafe-flex-end',
        'safe-center', 'unsafe-center',
      ],
      items: [
        'normal', 'stretch', 'baseline', 'first-baseline', 'last-baseline', 'start', 'end',
        'self-start', 'self-end', 'flex-start', 'flex-end', 'center', 'safe-start', 'unsafe-start',
        'safe-end', 'unsafe-end', 'safe-flex-start', 'unsafe-flex-start', 'safe-flex-end',
        'unsafe-flex-end', 'safe-center', 'unsafe-center', 'safe-self-start', 'unsafe-self-start',
        'safe-self-end', 'unsafe-self-end',
      ],
      content: [
        'normal', 'stretch', 'baseline', 'first-baseline', 'last-baseline', 'start', 'end',
        'flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly',
        'safe-start', 'unsafe-start', 'safe-end', 'unsafe-end', 'safe-flex-start',
        'unsafe-flex-start', 'safe-flex-end', 'unsafe-flex-end', 'safe-center', 'unsafe-center',
      ],
      self: [
        'auto', 'stretch', 'start', 'end', 'self-start', 'self-end', 'flex-start', 'flex-end',
        'center', 'baseline', 'safe-start', 'unsafe-start', 'safe-end', 'unsafe-end',
        'safe-self-start', 'unsafe-self-start', 'safe-self-end', 'unsafe-self-end',
        'safe-flex-start', 'unsafe-flex-start', 'safe-flex-end', 'unsafe-flex-end', 'safe-center',
        'unsafe-center',
      ],
      gap: ['0', '4', '8', '12', '16', '24', '32'],
      grow: ['0', '1', '2', '3', '4'],
      shrink: ['0', '1', '2', '3', '4'],
      basis: ['auto', '0', '25%', '33.33%', '50%', '66.67%', '75%', '100%'],
      order: ['-3', '-2', '-1', '0', '1', '2', '3'],
      mobile: ['stack', 'preserve'],
    }

    for (const [name, allowedValues] of Object.entries(values)) {
      for (const value of allowedValues) {
        expect(containerTesting.parseFlexOptions(`${name}=${value}`), `${name}=${value}`).not.toBeNull()
      }
    }
  })

  it('supports nested Flex containers as automatic parent items', async () => {
    const doc = parse(await render([
      ':::: flex direction=row gap=16',
      '::: flex direction=column grow=1 basis=50%',
      'Outer item heading.',
      '::::: flex direction=row gap=8',
      'Nested item.',
      ':::::',
      ':::',
      '::::',
    ].join('\n')))
    const outer = doc.querySelector<HTMLElement>('.nuvyn-flex')
    const nested = outer?.querySelector<HTMLElement>('.nuvyn-flex')

    expect(doc.querySelectorAll('.nuvyn-flex')).toHaveLength(3)
    expect(doc.querySelectorAll('.nuvyn-flex-item')).toHaveLength(3)
    expect(nested?.classList.contains('nuvyn-flex-direction-column')).toBe(true)
    expect(nested?.parentElement?.classList.contains('nuvyn-flex-item-grow-1')).toBe(true)
    expect(nested?.querySelector('p')?.textContent).toBe('Outer item heading.')
    expect(nested?.querySelector(':scope > .nuvyn-flex-scope')).not.toBeNull()
    expect(nested?.textContent).toContain('Nested item.')
  })

  it('falls back to ordinary Markdown for invalid, empty, unclosed, or orphaned Flex syntax', async () => {
    const invalidSources = [
      ':::: flex\n::::',
      ':::: flex gap=12 gap=16\nOrdinary text.\n::::',
      ':::: flex direction=row;display:grid\nText\n::::',
      ':::: flex gap=calc(100%)\nText\n::::',
      ':::: flex grow=5\nText\n::::',
      ':::: flex basis=calc(100%)\nText\n::::',
      ':::: flex-item basis=50%\nText\n::::',
      ':::: flex\nMissing close.',
    ]

    for (const source of invalidSources) {
      const doc = parse(await render(source))
      expect(doc.querySelector('.nuvyn-flex')).toBeNull()
      expect(doc.querySelector('.nuvyn-flex-item')).toBeNull()
      expect(doc.body.textContent?.trim()).not.toBe('')
    }
  })

  it('keeps Flex classes parser-owned and isolates provenance across concurrent renders', async () => {
    const flexSource = [
      ':::: flex direction=row',
      '::: flex grow=1 basis=50%',
      'Trusted layout.',
      ':::',
      '::::',
    ].join('\n')
    const rawSource = [
      '<div class="nuvyn-flex nuvyn-flex-direction-row" data-nuvyn-flex-provenance="forged" style="display:flex" onclick="alert(1)">',
      'Untrusted layout.</div>',
      '<svg><rect width="1" height="1"></rect></svg>',
    ].join('\n')
    const [trustedHtml, rawHtml] = await Promise.all([render(flexSource), render(rawSource)])
    const trusted = parse(trustedHtml)
    const raw = parse(rawHtml)

    expect(trusted.querySelectorAll('.nuvyn-flex')).toHaveLength(2)
    expect(trusted.querySelectorAll('.nuvyn-flex-item')).toHaveLength(2)
    expect(raw.querySelector('.nuvyn-flex')).toBeNull()
    expect(raw.querySelector('[data-nuvyn-flex-provenance]')).toBeNull()
    expect(raw.querySelector('[style], [onclick], svg')).toBeNull()
    expect(raw.body.textContent).toContain('Untrusted layout.')
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
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('.markdown-container-info pre.shiki')?.getAttribute('data-language')).toBe('js')
  })
})
