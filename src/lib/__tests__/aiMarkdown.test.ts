import { describe, expect, it } from 'vitest'
import { renderAiMarkdown } from '../aiMarkdown'

describe('renderAiMarkdown', () => {
  it('renders common assistant Markdown syntax', () => {
    const html = renderAiMarkdown('## Core\n\n**bold**\n\n- item\n\n```ts\nconst value = 1\n```')
    expect(html).toContain('<h2>Core</h2>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<li>item</li>')
    expect(html).toContain('<pre><code class="language-ts">')
  })

  it('escapes raw HTML from model output', () => {
    const html = renderAiMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('classifies wiki and Markdown note links with a render-scoped resolver', () => {
    const html = renderAiMarkdown('[[target#section|Note]] [Note](./target.md#section)', {
      sourcePath: 'notes/source',
      resolver: (_ref, _anchor, context) => ({ target: context?.sourcePath === 'notes/source' ? 'notes/target' : null }),
    })
    expect(html.match(/class="wiki-link"/g)).toHaveLength(2)
    expect(html.match(/data-target="notes\/target"/g)).toHaveLength(2)
    expect(html.match(/data-anchor="section"/g)).toHaveLength(2)
  })

  it('leaves external URLs and code examples alone and rejects unsafe schemes', () => {
    const html = renderAiMarkdown('[Site](https://example.com) `[[target]]` [Bad](javascript:alert(1))')
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain('class="wiki-link"')
    expect(html).toContain('<code>[[target]]</code>')
    expect(html).not.toContain('href="javascript:')
  })
})
