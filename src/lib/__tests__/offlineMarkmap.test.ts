// @vitest-environment jsdom
import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import { installOfflineMarkmapParser } from '../offlineMarkmap'

describe('offline MarkMap parser integration', () => {
  it('uses local KaTeX and renders math without a window/CDN runtime', () => {
    const md = new MarkdownIt({ html: true })
    installOfflineMarkmapParser(md)
    const rendered = md.render('# Formula $a^2$')
    expect(rendered).toContain('katex')
    expect(rendered).toContain('<math')
    expect(rendered).not.toContain('<script')
    expect(rendered).not.toContain('https:')
  })
  it('escapes unknown-language code rather than treating it as HTML', () => {
    const md = new MarkdownIt()
    installOfflineMarkmapParser(md)
    const rendered = md.render('```unknown\n<script>alert(1)</script>\n```')
    expect(rendered).toContain('&lt;script&gt;')
    expect(rendered).not.toContain('<script>')
  })
  it.each(['![image](https://invalid.example/a.png)', '<img src="https://invalid.example/a.png">'])('fails image-bearing labels before D3 inserts them', (source) => {
    const md = new MarkdownIt({ html: true })
    installOfflineMarkmapParser(md)
    expect(() => md.render(`# Root\n\n${source}`)).toThrow('MARKMAP_IMAGE_UNSUPPORTED')
  })
})
