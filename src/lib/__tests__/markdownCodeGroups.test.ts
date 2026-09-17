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

describe('Nuvyn code groups', () => {
  beforeEach(() => {
    installFakeShikiRuntime()
  })

  afterEach(() => {
    shikiTesting.reset()
  })

  it('renders labeled members as a static accessible tab/panel DOM', async () => {
    const html = await render([
      '::: code-group',
      '',
      '```ts [TypeScript]',
      'const value = 1',
      '```',
      '',
      '```js [JavaScript]',
      'console.log(value)',
      '```',
      '',
      ':::',
    ].join('\n'))
    const doc = parse(html)

    const group = doc.querySelector<HTMLElement>('.nuvyn-code-group')
    const tabs = Array.from(doc.querySelectorAll<HTMLElement>('[role="tab"]'))
    const panels = Array.from(doc.querySelectorAll<HTMLElement>('[role="tabpanel"]'))
    expect(group).not.toBeNull()
    expect(group?.querySelector('[role="tablist"]')).not.toBeNull()
    expect(tabs).toHaveLength(2)
    expect(panels).toHaveLength(2)
    expect(tabs.map((tab) => tab.textContent)).toEqual(['TypeScript', 'JavaScript'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[0]?.getAttribute('tabindex')).toBe('0')
    expect(tabs[1]?.getAttribute('tabindex')).toBe('-1')
    expect(panels[0]?.getAttribute('aria-hidden')).toBe('false')
    expect(panels[1]?.getAttribute('aria-hidden')).toBe('true')
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panels[0]?.id)
    expect(tabs[1]?.getAttribute('aria-controls')).toBe(panels[1]?.id)
    expect(panels[0]?.getAttribute('aria-labelledby')).toBe(tabs[0]?.id)
    expect(panels[1]?.getAttribute('aria-labelledby')).toBe(tabs[1]?.id)
    expect(panels.every((panel) => panel.querySelector('pre.shiki'))).toBe(true)
  })

  it('keeps group IDs isolated across renders and does not use labels as IDs', async () => {
    const first = parse(await render([
      '::: code-group',
      '```ts [<img src=x onerror=alert(1)>]',
      'const first = 1',
      '```',
      ':::',
    ].join('\n')))
    const second = parse(await render([
      '::: code-group',
      '```ts [Same Label]',
      'const second = 1',
      '```',
      ':::',
    ].join('\n')))

    const firstTab = first.querySelector<HTMLElement>('[role="tab"]')!
    const secondTab = second.querySelector<HTMLElement>('[role="tab"]')!
    expect(first.querySelector('img')).toBeNull()
    expect(firstTab.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(firstTab.id).not.toContain('img')
    expect(firstTab.id).not.toContain('Same')
    expect(firstTab.id).not.toBe(secondTab.id)
    expect(first.querySelector('[data-nuvyn-external-provenance]')).toBeNull()
  })

  it('allows duplicate and Unicode display labels without using either as identity', async () => {
    const doc = parse(await render([
      '::: code-group',
      '```js [Example]',
      'one()',
      '```',
      '```ts [Example]',
      'two()',
      '```',
      '```python [🐍 Python 示例]',
      'three()',
      '```',
      ':::',
    ].join('\n')))
    const tabs = Array.from(doc.querySelectorAll<HTMLElement>('[role="tab"]'))
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Example', 'Example', '🐍 Python 示例'])
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(3)
    expect(tabs.every((tab) => !tab.id.includes('Example') && !tab.id.includes('Python'))).toBe(true)
  })

  it('accepts empty code members and longer delimiter groups', async () => {
    const doc = parse(await render([
      ':::: code-group',
      '',
      '```txt [Empty]',
      '```',
      '',
      '```ts [Filled]',
      'const answer = 42',
      '```',
      '',
      '::::',
    ].join('\n')))

    expect(doc.querySelectorAll('.nuvyn-code-group')).toHaveLength(1)
    expect(doc.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(doc.querySelectorAll('[role="tabpanel"]')).toHaveLength(2)
    expect(doc.querySelectorAll('pre.shiki')).toHaveLength(2)
  })

  it('leaves unlabeled, mixed, titled, and unclosed groups in safe fallback', async () => {
    const cases = [
      [
        '::: code-group',
        '```ts',
        'const unlabeled = true',
        '```',
        ':::',
      ],
      [
        '::: code-group',
        'prose is not a member',
        '```ts [TypeScript]',
        'const mixed = true',
        '```',
        ':::',
      ],
      [
        '::: code-group Title is not supported',
        '```ts [TypeScript]',
        'const titled = true',
        '```',
        ':::',
      ],
      [
        '::: code-group',
        '```ts [TypeScript]',
        'const unclosed = true',
        '```',
      ],
    ]

    for (const source of cases) {
      const doc = parse(await render(source.join('\n')))
      expect(doc.querySelector('.nuvyn-code-group')).toBeNull()
    }
  })

  it('does not treat code-group as an arbitrary type or an early code-group', async () => {
    const doc = parse(await render([
      '::: success',
      'not an approved container',
      ':::',
      '',
      '::: code-group',
      '```js [JavaScript]',
      'console.log(1)',
      '```',
      ':::',
    ].join('\n')))

    expect(doc.querySelector('.markdown-container-success')).toBeNull()
    expect(doc.querySelector('.nuvyn-code-group')).not.toBeNull()
    expect(doc.querySelector('.nuvyn-code-group-success')).toBeNull()
  })

  it('keeps labeled Mermaid and MarkMap members on the ordinary fence path', async () => {
    const { loadLanguage } = installFakeShikiRuntime()
    const doc = parse(await render([
      '::: code-group',
      '```mermaid [Diagram]',
      'graph TD',
      'A --> B',
      '```',
      '',
      '```markmap [Map]',
      '# Root',
      '```',
      ':::',
    ].join('\n')))

    expect(doc.querySelector('.mermaid-mount')).toBeNull()
    expect(doc.querySelector('.markmap-mount')).toBeNull()
    expect(doc.querySelectorAll('.nuvyn-code-group-panel pre')).toHaveLength(2)
    expect(loadLanguage).toHaveBeenCalled()
  })

  it('works inside an existing Nuvyn container without changing its ownership', async () => {
    const doc = parse(await render([
      ':::: info Examples',
      '',
      '::: code-group',
      '```ts [TypeScript]',
      'const nested = true',
      '```',
      '```js [JavaScript]',
      'const nestedAgain = true',
      '```',
      ':::',
      '',
      '::::',
    ].join('\n')))

    const container = doc.querySelector('.markdown-container-info')
    expect(container?.querySelector('.nuvyn-code-group')).not.toBeNull()
    expect(container?.querySelectorAll('[role="tabpanel"]')).toHaveLength(2)
  })

  it('coexists with an existing blockquote callout when nested by normal Markdown rules', async () => {
    const doc = parse(await render([
      '> [!NOTE]',
      '>',
      '> ::: code-group',
      '> ```ts [TypeScript]',
      '> const insideCallout = true',
      '> ```',
      '> :::',
    ].join('\n')))

    const callout = doc.querySelector('.callout-note')
    expect(callout).not.toBeNull()
    expect(callout?.querySelector('.nuvyn-code-group')).not.toBeNull()
    expect(callout?.querySelector('[role="tabpanel"] pre.shiki')).not.toBeNull()
  })
})
