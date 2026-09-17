// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import MarkdownIt from 'markdown-it'
import { render } from '../markdown'
import { calloutPlugin } from '../callouts'
import type { Resolver as WikiResolver } from '../wikiLinks'

describe('GitHub-style Markdown Alerts', () => {
  it('preserves metadata supplied by another markdown-it core rule', () => {
    const md = new MarkdownIt()
    let seenOpenMeta: Record<string, unknown> | undefined
    let seenCloseMeta: Record<string, unknown> | undefined
    md.use(calloutPlugin)
    md.core.ruler.before('nuvyn-callouts', 'test-callout-meta', (state) => {
      for (const token of state.tokens) {
        if (token.type === 'blockquote_open' || token.type === 'blockquote_close') {
          token.meta = { fromOtherPlugin: true }
        }
      }
    })
    md.core.ruler.after('nuvyn-callouts', 'capture-callout-meta', (state) => {
      const open = state.tokens.find((token) => token.type === 'blockquote_open')
      const close = state.tokens.find((token) => token.type === 'blockquote_close')
      seenOpenMeta = open?.meta
      seenCloseMeta = close?.meta
    })

    md.render('> [!NOTE]\n> content')

    expect(seenOpenMeta).toMatchObject({ fromOtherPlugin: true, callout: { type: 'NOTE' } })
    expect(seenCloseMeta).toMatchObject({ fromOtherPlugin: true, callout: { type: 'NOTE' } })
  })

  it('renders exactly the five canonical Alert types with Chinese titles', async () => {
    const html = await render([
      '> [!NOTE]',
      '> note',
      '',
      '> [!TIP]',
      '> tip',
      '',
      '> [!IMPORTANT]',
      '> important',
      '',
      '> [!WARNING]',
      '> warning',
      '',
      '> [!CAUTION]',
      '> caution',
    ].join('\n'))
    const doc = new DOMParser().parseFromString(html, 'text/html')

    for (const type of ['note', 'tip', 'important', 'warning', 'caution']) {
      const alert = doc.querySelector(`.callout.callout-${type}`)
      expect(alert).not.toBeNull()
      expect(alert?.querySelector('.callout-title')).not.toBeNull()
      expect(alert?.querySelector('.callout-icon')).toBeNull()
    }
    expect(doc.querySelectorAll('.callout')).toHaveLength(5)
    expect(Array.from(doc.querySelectorAll('.callout-title-text')).map((node) => node.textContent))
      .toEqual(['注意', '提示', '重要', '警告', '小心'])
  })

  it('requires a marker-only canonical line and does not support custom titles', async () => {
    const canonical = new DOMParser().parseFromString(
      await render('> [!WARNING]\n> Back up first.'),
      'text/html',
    )
    const titled = new DOMParser().parseFromString(
      await render('> [!WARNING] Database migration\n> Back up first.'),
      'text/html',
    )

    expect(canonical.querySelector('.callout-warning .callout-title-text')?.textContent).toBe('警告')
    expect(titled.querySelector('.callout')).toBeNull()
    expect(titled.querySelector('blockquote')?.textContent).toContain('[!WARNING] Database migration')
  })

  it.each([
    'INFO', 'SUCCESS', 'QUESTION', 'DANGER', 'BUG', 'EXAMPLE', 'QUOTE',
    'ABSTRACT', 'SUMMARY', 'TLDR', 'TODO', 'HINT', 'CHECK', 'DONE', 'HELP',
    'FAQ', 'ATTENTION', 'ERROR', 'FAILURE', 'FAIL', 'MISSING', 'CITE',
    'WHATEVER', 'note', 'Tip', 'important',
  ])('keeps unsupported marker %s as an ordinary blockquote', async (type) => {
    const marker = `[!${type}]`
    const html = await render(`> ${marker}\n> Content`)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    expect(doc.querySelector('.callout')).toBeNull()
    expect(doc.querySelector('blockquote')?.textContent).toContain(marker)
  })

  it('does not partially implement malformed or folded marker text', async () => {
    const source = [
      '> [!NOTE',
      '> [!!NOTE]',
      '> [!NOTE]+',
      '> [!NOTE]-',
      '> [!NOTE foo]',
      '> [!NOTE" onclick="alert(1)]',
      '> Content',
    ].join('\n')
    const html = await render(source)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    expect(doc.querySelector('.callout')).toBeNull()
    expect(doc.querySelector('blockquote')?.textContent).toContain('[!NOTE]+')
    expect(doc.querySelector('blockquote')?.textContent).toContain('[!NOTE foo]')
    expect(doc.querySelector('[onclick]')).toBeNull()
  })

  it('keeps multiple paragraphs and lists inside the content wrapper', async () => {
    const html = await render([
      '> [!NOTE]',
      '> First paragraph.',
      '>',
      '> Second paragraph.',
      '>',
      '> - item 1',
      '> - item 2',
    ].join('\n'))
    const content = new DOMParser().parseFromString(html, 'text/html').querySelector('.callout-content')

    expect(content?.querySelectorAll(':scope > p')).toHaveLength(2)
    expect(content?.querySelectorAll(':scope > ul > li')).toHaveLength(2)
    expect(content?.textContent).toContain('First paragraph.')
    expect(content?.textContent).toContain('Second paragraph.')
  })

  it('keeps rich Markdown and the render-scoped Wiki resolver inside an Alert', async () => {
    const resolver: WikiResolver = (ref) => ({ target: `notes/${ref}` })
    const html = await render([
      '> [!TIP]',
      '> Use **bold**, `code`, ==highlight==, [external](https://example.com) and [[note]].',
      '>',
      '> - item 1',
      '> - item 2',
    ].join('\n'), { resolver })
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const content = doc.querySelector('.callout-content')

    expect(content?.querySelector('strong')?.textContent).toBe('bold')
    expect(content?.querySelector('code')?.textContent).toBe('code')
    expect(content?.querySelector('mark')?.textContent).toBe('highlight')
    expect(content?.querySelector('a[href="https://example.com"]')?.textContent).toBe('external')
    expect(content?.querySelector('a.wiki-link')?.getAttribute('href')).toBe('/vault/notes/note')
    expect(content?.querySelectorAll('ul > li')).toHaveLength(2)
  })

  it('preserves task-list checkbox and label output after sanitization', async () => {
    const html = await render([
      '> [!IMPORTANT]',
      '> - [x] Done',
      '> - [ ] Todo',
    ].join('\n'))
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const callout = doc.querySelector('.callout-important')
    const inputs = Array.from(callout?.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox') ?? [])
    const labels = Array.from(callout?.querySelectorAll('label') ?? [])

    expect(inputs).toHaveLength(2)
    expect(labels).toHaveLength(2)
    expect(inputs[0].checked).toBe(true)
    expect(inputs[0].hasAttribute('checked')).toBe(true)
    expect(inputs[1].checked).toBe(false)
    expect(inputs[1].hasAttribute('checked')).toBe(false)
    expect(inputs.every((input) => input.closest('label'))).toBe(true)
    expect(callout?.querySelector('ul.contains-task-list')).not.toBeNull()
  })

  it('keeps fenced code as code inside an Alert', async () => {
    const html = await render([
      '> [!TIP]',
      '>',
      '> ```ts',
      '> const x = 1',
      '> ```',
    ].join('\n'))
    const doc = new DOMParser().parseFromString(html, 'text/html')

    expect(doc.querySelector('.callout-tip pre code')?.textContent).toContain('const x = 1')
    expect(doc.querySelector('.callout-tip .callout-content')).not.toBeNull()
  })

  it('keeps nested canonical Alerts valid and independently typed', async () => {
    const html = await render([
      '> [!NOTE]',
      '> Outer content',
      '>',
      '> > [!WARNING]',
      '> > Inner content',
    ].join('\n'))
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const outer = doc.querySelector('.callout-note')
    const inner = outer?.querySelector('.callout-warning')

    expect(outer).not.toBeNull()
    expect(inner).not.toBeNull()
    expect(inner?.textContent).toContain('Inner content')
    expect(doc.querySelectorAll('.callout')).toHaveLength(2)
    expect(doc.querySelectorAll('blockquote')).toHaveLength(0)
  })

  it('sanitizes dangerous body HTML without changing Alert structure', async () => {
    const html = await render([
      '> [!WARNING]',
      '> <script>alert(1)</script>',
      '> <a href="javascript:alert(1)">Run</a>',
      '> Safe text',
    ].join('\n'))
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const alert = doc.querySelector('.callout-warning')

    expect(alert).not.toBeNull()
    expect(alert?.querySelector('.callout-title-text')?.textContent).toBe('警告')
    expect(alert?.querySelector('script, img')).toBeNull()
    expect(alert?.textContent).toContain('Safe text')
    expect(doc.querySelector('[onerror], [onclick], [onload]')).toBeNull()
    expect(html).not.toMatch(/<script\b/i)
    expect(doc.querySelector('a[href^="javascript:"]')).toBeNull()
  })

  it('keeps an ordinary blockquote unchanged', async () => {
    const html = await render('> Normal quote')
    const doc = new DOMParser().parseFromString(html, 'text/html')

    expect(doc.querySelector('blockquote')?.textContent).toContain('Normal quote')
    expect(doc.querySelector('.callout')).toBeNull()
  })

  it('uses the Nuvyn pastel-card Alert visual contract', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8')
    const start = styles.indexOf('/* ---------- Nuvyn notice cards: Alerts + Markdown Containers')
    const end = styles.indexOf('/* Nuvyn code groups', start)
    const noticeStyles = styles.slice(start, end)

    expect(noticeStyles).not.toMatch(/[ⓘ✦‼⚠⛔]/u)
    expect(noticeStyles).not.toContain('callout-icon')
    expect(noticeStyles).not.toContain('mask-image')
    expect(noticeStyles).not.toContain('--callout-color')
    expect(noticeStyles).not.toContain('--callout-fg-color')
    expect(noticeStyles).not.toContain('--callout-border-color')
    expect(noticeStyles).not.toContain('border-left')
    expect(noticeStyles).toContain('--notice-bg')
    expect(noticeStyles).toContain('border-radius: 0.75rem')
    expect(noticeStyles).toContain('background: var(--notice-bg)')
    expect(noticeStyles).toContain('box-shadow: none')
    expect(noticeStyles).toContain('padding: 0.75rem 1rem')
    expect(noticeStyles).toContain('font-size: 0.875rem')
    expect(noticeStyles).toContain('.article .callout,')
    expect(noticeStyles).toContain('.article .markdown-container')
  })
})
