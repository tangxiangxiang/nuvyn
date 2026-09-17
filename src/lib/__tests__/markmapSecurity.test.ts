// @vitest-environment jsdom
// Real markmap-lib Transformer regression tests for the Markmap security
// boundary. These deliberately do not inject a fabricated root: the
// sanitizer must run on MarkdownIt's author raw-HTML token renderer before
// KaTeX/highlight/checkbox plugins contribute trusted output.
import { describe, expect, it } from 'vitest'
import { builtInPlugins, Transformer } from 'markmap-lib'
import { nuvynMarkmapSecurityPlugin, sanitizeMarkmapRawHtml } from '../markmapSecurity'

function makeTransformer() {
  return new Transformer([...builtInPlugins, nuvynMarkmapSecurityPlugin])
}

interface TestNode {
  content?: string
  children?: TestNode[]
}

function collectNodeHtml(node: TestNode): string {
  return [
    node.content ?? '',
    ...(node.children ?? []).map((child) => collectNodeHtml(child)),
  ].join('\n')
}

function transform(source: string) {
  const transformer = makeTransformer()
  const result = transformer.transform(source)
  return { transformer, ...result }
}

describe('Markmap raw HTML security boundary', () => {
  it('sanitizes author raw styles without stripping trusted KaTeX layout styles', () => {
    const { root, features } = transform([
      '# Mixed <script>alert(1)</script> <strong>safe</strong>',
      ' <img src="javascript:alert(1)" onerror="alert(1)">',
      ' <span style="color:red" onclick="alert(1)" onmouseover="alert(1)">text</span>',
      ' <a href="javascript:alert(1)">run</a>',
      '',
      '## Fraction $\\frac{a}{b}$',
    ].join('\n'))

    const html = collectNodeHtml(root)
    expect(features.katex).toBe(true)
    expect(html).toContain('<strong>safe</strong>')
    expect(html).toContain('class="katex"')
    expect(html).toMatch(/class="katex"[\s\S]*?\sstyle="[^"]+/)
    expect(html).not.toMatch(/<script\b/i)
    expect(html).not.toMatch(/\son(?:error|click|load|mouseover)\s*=/i)
    expect(html).not.toMatch(/style="color:red"/i)
  })

  it('removes dangerous URLs and preserves safe raw HTML', () => {
    const { root } = transform([
      '# Unsafe <img src="javascript:alert(1)" onerror="alert(1)"> <a href="javascript:alert(1)" onclick="alert(1)">run</a> <a href="https://example.com"><em>safe</em></a> <svg onload="alert(1)">bad</svg>',
    ].join('\n'))

    const html = collectNodeHtml(root)
    expect(html).toContain('<a href="https://example.com"><em>safe</em></a>')
    expect(html).toContain('>run</a>')
    expect(html).not.toMatch(/<script\b|<svg\b/i)
    expect(html).not.toMatch(/\son\w+\s*=/i)
    expect(html).not.toMatch(/javascript:/i)
  })

  it('keeps Markmap highlight and checkbox output intact', () => {
    const { root, features, transformer } = transform([
      '# Code `inline code`',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      '# Tasks',
      '',
      '- [x] <img src="javascript:alert(1)" onerror="alert(1)"> Done',
      '- [ ] Todo',
    ].join('\n'))

    const html = collectNodeHtml(root)
    const rendered = transformer.md.render([
      '```js',
      'const x = 1',
      '```',
    ].join('\n'))
    expect(features.hljs).toBe(true)
    expect(html).toContain('<code>inline code</code>')
    expect(rendered).toMatch(/class="[^"]*hljs[^"]*"/)
    /* Markmap's checkbox plugin deliberately emits trusted inline SVG, not
       an input element. This proves the old blanket sanitizer is gone. */
    expect(html).toContain('<svg')
    expect(html).not.toMatch(/javascript:|\sonerror\s*=/i)
  })

  it('keeps malformed author HTML inside the sanitized boundary', () => {
    const { root } = transform([
      '# Malformed <div><img src="javascript:alert(1)" onerror="alert(1)">',
      '<script>alert(1)</script><span style="color:red" onload="alert(1)">text',
    ].join('\n'))
    const html = collectNodeHtml(root)
    expect(html).not.toMatch(/<script\b|javascript:|\son(?:error|load|mouseover)\s*=/i)
    expect(html).not.toMatch(/style="color:red"/i)
  })

  it('sanitizes hand-written Markmap placeholders through the same component path', () => {
    const { root } = transform([
      '# Placeholder <div class="markmap-mount" data-content="safe" onload="alert(1)">',
      '<script>alert(1)</script>safe</div>',
    ].join('\n'))
    const html = collectNodeHtml(root)
    expect(html).toContain('class="markmap-mount"')
    expect(html).toContain('data-content="safe"')
    expect(html).not.toMatch(/<script\b|\sonload\s*=/i)
  })

  it('fails closed when the raw HTML sanitizer throws', () => {
    expect(sanitizeMarkmapRawHtml('<strong>safe</strong>', () => {
      throw new Error('sanitizer failure')
    })).toBe('')
  })

  it('blocks author extraJs and extraCss while retaining built-in KaTeX assets', () => {
    const { transformer, root, features, frontmatter } = transform([
      '---',
      'markmap:',
      '  extraJs:',
      '    - https://evil.example/payload.js',
      '  extraCss:',
      '    - https://evil.example/payload.css',
      '---',
      '# Formula $\\frac{a}{b}$',
    ].join('\n'))

    const assets = transformer.getUsedAssets(features)
    const assetText = JSON.stringify(assets)
    expect(frontmatter?.markmap?.extraJs).toBeUndefined()
    expect(frontmatter?.markmap?.extraCss).toBeUndefined()
    expect(assetText).not.toContain('evil.example')
    expect(features.katex).toBe(true)
    expect(collectNodeHtml(root)).toContain('class="katex"')
    expect(JSON.stringify(assets.styles)).toContain('katex')
  })

  it('uses KaTeX default-safe trust behavior', () => {
    const { root } = transform('# Safe link $\\href{javascript:alert(1)}{bad}$')
    const html = collectNodeHtml(root)
    expect(html).toContain('class="katex"')
    expect(html).not.toMatch(/<a\b[^>]*href=/i)
    expect(html).not.toMatch(/href="javascript:/i)
  })
})
