// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createBoardReference, parseBoardReference } from '../boardReferences'
import { render } from '../markdown'

const id = '8a1c2544-dad0-4f20-a593-7bbc59882921'

describe('Board Markdown references', () => {
  it('round-trips a stable ID and escapes title syntax', async () => {
    const reference = createBoardReference(id.toUpperCase(), 'A [diagram] *test* <tag>\nB')
    expect(parseBoardReference(`board:${id.toUpperCase()}`)).toBe(id)
    const article = document.createElement('article')
    article.innerHTML = await render(reference, { sourcePath: 'inbox/test' })
    const placeholder = article.querySelector<HTMLElement>('.board-embed-mount')!
    expect(placeholder.dataset.target).toBe(id)
    expect(placeholder.title).toBe('A [diagram] *test* <tag> B')
    expect(placeholder.textContent).toBe(placeholder.title)
    expect(article.querySelector('img')).toBeNull()
    expect(article.querySelector('tag')).toBeNull()
  })

  it.each(['board:../secret', `board:${id}?other=1`, `board:${id}/scene`, `board://${id}`, 'https://example.com', 'board:invalid'])('rejects %s', (source) => {
    expect(parseBoardReference(source)).toBeNull()
  })

  it('does not turn code, ordinary links, or normal images into Board embeds', async () => {
    const html = await render([
      `\`![Diagram](board:${id})\``,
      '',
      `[Diagram](board:${id})`,
      '',
      '![Ordinary image](/logo.svg)',
    ].join('\n'))
    const article = document.createElement('article')
    article.innerHTML = html
    expect(article.querySelector('.board-embed-mount')).toBeNull()
    expect(article.querySelector('img')?.getAttribute('src')).toBe('/logo.svg')
  })

  it('works in lists and custom containers without resolving a vault image path', async () => {
    const html = await render(`- ${createBoardReference(id, 'List')}\n\n::: info\n${createBoardReference(id, 'Info')}\n:::`, { sourcePath: 'inbox/source' })
    const article = document.createElement('article')
    article.innerHTML = html
    expect(article.querySelectorAll('.board-embed-mount')).toHaveLength(2)
    expect(article.querySelector('li .board-embed-mount')).not.toBeNull()
    expect(article.querySelector('.markdown-container-info .board-embed-mount')).not.toBeNull()
    expect(html).not.toContain('/api/markdown-resources')
  })
})
