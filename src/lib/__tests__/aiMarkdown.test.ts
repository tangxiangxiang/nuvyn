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
})
