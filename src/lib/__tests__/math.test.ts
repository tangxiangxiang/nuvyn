// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mountMath } from '../../composables/useMathMount'
import { render } from '../markdown'
import type { Resolver as WikiResolver } from '../wikiLinks'

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function contents(doc: Document, selector: string): string[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(selector), (element) =>
    decodeURIComponent(element.dataset.content ?? ''))
}

describe('Markdown math placeholders', () => {
  it('emits an encoded inline placeholder', async () => {
    const html = await render('Euler: $e^{i\\pi} + 1 = 0$.')
    const doc = parse(html)
    const inline = doc.querySelector('.math-mount.math-inline')

    expect(inline).not.toBeNull()
    expect(contents(doc, '.math-inline')).toEqual(['e^{i\\pi} + 1 = 0'])
    expect(inline?.getAttribute('data-content')).not.toContain('\\')
    expect(html).not.toContain('<math')
    expect(html).not.toContain('<svg')
  })

  it('emits a multiline block placeholder and supports single-line $$ syntax', async () => {
    const html = await render([
      '$$',
      '\\frac{a}{b}',
      '$$',
      '',
      '$$E = mc^2$$',
    ].join('\n'))
    const doc = parse(html)

    expect(doc.querySelectorAll('.math-block')).toHaveLength(2)
    expect(contents(doc, '.math-block')).toEqual(['\\frac{a}{b}\n', 'E = mc^2'])
  })

  it('renders multiple inline formulas without swallowing surrounding prose', async () => {
    const html = await render('$x$ + $y$ = $z$')
    const doc = parse(html)

    expect(doc.querySelectorAll('.math-inline')).toHaveLength(3)
    expect(doc.body.textContent).toContain('+')
    expect(contents(doc, '.math-inline')).toEqual(['x', 'y', 'z'])
  })

  it('does not mistake ordinary currency or unmatched dollars for math', async () => {
    const html = await render([
      'Price is $100.',
      'The total is $10 and tax is $2.',
      'This is an unmatched $ symbol.',
    ].join('\n\n'))
    const doc = parse(html)

    expect(doc.querySelectorAll('.math-mount')).toHaveLength(0)
    expect(doc.body.textContent).toContain('$100.')
    expect(doc.body.textContent).toContain('$10 and tax is $2.')
  })

  it('does not allow inline math to cross a newline or use edge whitespace', async () => {
    const html = await render([
      '$x',
      'and y$',
      '',
      '$  x$',
      '',
      '$x  $',
    ].join('\n'))
    const doc = parse(html)

    expect(doc.querySelectorAll('.math-mount')).toHaveLength(0)
    expect(doc.body.textContent).toContain('$x')
    expect(doc.body.textContent).toContain('and y$')
  })

  it('preserves escaped dollars as literal text', async () => {
    const html = await render('Literal: \\$100 and \\$x\\$.')
    const doc = parse(html)

    expect(doc.querySelectorAll('.math-mount')).toHaveLength(0)
    expect(doc.body.textContent).toContain('Literal: $100 and $x$.')
  })

  it('leaves code spans and fenced code out of math parsing', async () => {
    const html = await render([
      '`$x$`',
      '',
      '```text',
      "const price = '$100'",
      'const formula = \'$x$\'',
      '$$',
      'not math',
      '$$',
      '```',
    ].join('\n'))
    const doc = parse(html)

    expect(doc.querySelectorAll('.math-mount')).toHaveLength(0)
    expect(doc.querySelector('code')?.textContent).toContain('$x$')
    expect(doc.querySelector('pre code')?.textContent).toContain('$$')
  })

  it('nests inline math with existing inline Markdown and Wiki Links', async () => {
    const resolver: WikiResolver = (ref) => ({ target: `notes/${ref}` })
    const html = await render('**$E = mc^2$** and ==$x^2$== with [[math-note]].', { resolver })
    const doc = parse(html)

    expect(doc.querySelector('strong .math-inline')).not.toBeNull()
    expect(doc.querySelector('mark .math-inline')).not.toBeNull()
    expect(doc.querySelector('a.wiki-link')?.getAttribute('href')).toBe('/vault/notes/math-note')
  })

  it('keeps math placeholders inside a callout', async () => {
    const html = await render([
      '> [!IMPORTANT]',
      '> Einstein: $E = mc^2$',
      '>',
      '> $$',
      '> c = \\sqrt{a^2 + b^2}',
      '> $$',
    ].join('\n'))
    const doc = parse(html)
    const callout = doc.querySelector('.callout-important')

    expect(callout).not.toBeNull()
    expect(callout?.querySelector('.math-inline')).not.toBeNull()
    expect(callout?.querySelector('.math-block')).not.toBeNull()
    expect(callout?.querySelectorAll('.math-mount')).toHaveLength(2)
  })

  it('keeps dangerous TeX out of the sanitized Markdown HTML', async () => {
    const html = await render(String.raw`Safe $\htmlStyle{color:red}{x}$ and $\htmlClass{evil}{y}$.`)

    expect(html).toContain('math-inline')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('style=')
  })

  it('renders invalid TeX as a local KaTeX error without breaking the article', () => {
    const root = document.createElement('article')
    const placeholder = document.createElement('span')
    placeholder.className = 'math-mount math-inline'
    placeholder.dataset.content = encodeURIComponent('\\frac{1}{')
    root.append(placeholder)

    expect(() => mountMath(root)).not.toThrow()
    expect(root.querySelector('.math-error')).not.toBeNull()
    expect(root.querySelector('.math-mount')?.getAttribute('data-math-state')).toBe('error')
    expect(root.textContent).toContain('\\frac{1}{')
  })
})
