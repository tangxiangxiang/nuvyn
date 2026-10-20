// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, provide } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultContext } from '../../../composables/vault/context/types'
import { VaultContextKey } from '../../../composables/vault/context/vaultContext'
import RenderedMarkdown from '../RenderedMarkdown.vue'
import { copyTextToClipboard } from '../workspaceTabActions'
import { useI18n } from '../../../composables/useI18n'
import * as markdown from '../../../lib/markdown'

const feedback = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('../workspaceTabActions', () => ({ copyTextToClipboard: vi.fn(async () => true) }))
vi.mock('../../../composables/useToast', () => ({ useToast: () => feedback }))

vi.mock('../../../composables/useMarkmapMount', () => ({ useMarkmapMount: vi.fn() }))
vi.mock('../../../composables/useMermaidMount', () => ({ useMermaidMount: vi.fn() }))
vi.mock('../../../composables/useMathMount', () => ({ useMathMount: vi.fn() }))
vi.mock('../../../composables/useCodeGroupMount', () => ({ useCodeGroupMount: vi.fn() }))

function mountMarkdown(raw: string) {
  return mount(RenderedMarkdown, {
    props: { raw },
    global: { provide: { [VaultContextKey as symbol]: { editor: { openLink: vi.fn() } } } },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(() => vi.restoreAllMocks())

describe('RenderedMarkdown code copying', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(true)
    useI18n().setLocale('en')
  })

  it.each(['ts', 'ts:line-numbers=50'])('copies %s code without its language or line numbers', async (info) => {
    const source = '  const first = "<tag>"\n\nconst second = 2\n'
    const wrapper = mountMarkdown(`\`\`\`${info}\n${source}\`\`\``)
    await vi.waitFor(() => expect(wrapper.find('button.nuvyn-code-copy').exists()).toBe(true))
    const button = wrapper.get('button.nuvyn-code-copy')
    expect(button.text()).toBe('ts')
    expect(button.attributes('aria-label')).toBe('Copy code (ts)')
    await button.trigger('click')
    await flushPromises()
    expect(copyTextToClipboard).toHaveBeenCalledWith(source)
    expect(feedback.success).toHaveBeenCalledWith('Code copied')
    wrapper.unmount()
  })

  it('does not duplicate controls on locale changes and handles new Markdown', async () => {
    const wrapper = mountMarkdown('```java\nfirst();\n```')
    await flushPromises()
    useI18n().setLocale('zh')
    await flushPromises()
    expect(wrapper.findAll('button.nuvyn-code-copy')).toHaveLength(1)
    expect(wrapper.get('button').attributes('aria-label')).toBe('复制代码 (java)')
    await wrapper.setProps({ raw: '```js\nsecond();\n```' })
    await flushPromises()
    await wrapper.get('button.nuvyn-code-copy').trigger('click')
    await flushPromises()
    expect(copyTextToClipboard).toHaveBeenCalledWith('second();\n')
    wrapper.unmount()
  })

  it('reports failure and permits retry without navigating', async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce(false)
    const wrapper = mountMarkdown('```js\nvalue();\n```')
    await flushPromises()
    const button = wrapper.get('button.nuvyn-code-copy')
    await button.trigger('click')
    await flushPromises()
    expect(feedback.error).toHaveBeenCalledWith('Copy failed')
    expect((button.element as HTMLButtonElement).disabled).toBe(false)
    await button.trigger('click')
    await flushPromises()
    expect(feedback.success).toHaveBeenCalledWith('Code copied')
    wrapper.unmount()
  })

  it('prevents duplicate copies and suppresses feedback after unmount', async () => {
    let finish!: (value: boolean) => void
    vi.mocked(copyTextToClipboard).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const wrapper = mountMarkdown('```js\nvalue();\n```')
    await flushPromises()
    const button = wrapper.get('button.nuvyn-code-copy')
    await button.trigger('click')
    await button.trigger('click')
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1)
    expect((button.element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
    finish(true)
    await flushPromises()
    expect(feedback.success).not.toHaveBeenCalled()
  })

  it('does not turn inline code into a copy control', async () => {
    const wrapper = mountMarkdown('`const value = 1`')
    await flushPromises()
    expect(wrapper.findAll('button.nuvyn-code-copy')).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('RenderedMarkdown link navigation', () => {
  it('forwards the rendered wiki link target and final anchor to the workspace', async () => {
    const openLink = vi.fn(async () => {})
    const context = {
      editor: { openLink },
    } as unknown as VaultContext
    const Parent = defineComponent({
      setup() {
        provide(VaultContextKey, context)
        return () => h(RenderedMarkdown, {
          raw: '[[notes/target#custom-id]]',
          resolver: () => ({ target: 'notes/target' }),
          sourcePath: 'notes/source',
        })
      },
    })

    const wrapper = mount(Parent)
    await flushPromises()
    const link = wrapper.find('a.wiki-link')
    expect(link.exists()).toBe(true)
    expect(link.attributes('data-anchor')).toBe('custom-id')
    await link.trigger('click')
    expect(openLink).toHaveBeenCalledWith('notes/target', 'custom-id')
    wrapper.unmount()
  })
})

describe('RenderedMarkdown folding isolation', () => {
  it('leaves default/static render surfaces fully expanded and free of folding controls', async () => {
    const wrapper = mountMarkdown('## A\nbody\n\n```ts\nconst a = 1\n```')
    await flushPromises()
    expect(wrapper.findAll('.nuvyn-fold-toggle')).toHaveLength(0)
    expect(wrapper.findAll('[hidden]')).toHaveLength(0)
    expect(wrapper.text()).toContain('body')
    wrapper.unmount()
  })

  it('cleans old state on document changes and restores content when folding is disabled', async () => {
    const wrapper = mountMarkdown('## A\nbody')
    await wrapper.setProps({ foldingEnabled: true, sourcePath: 'inbox/a' })
    await flushPromises()
    await wrapper.get('h2 > .nuvyn-fold-toggle').trigger('click')
    expect(wrapper.get('p').attributes('hidden')).toBeDefined()
    await wrapper.setProps({ raw: '## B\nnew body', sourcePath: 'inbox/b' })
    await flushPromises()
    expect(wrapper.get('h2 > .nuvyn-fold-toggle').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('p').attributes('hidden')).toBeUndefined()
    await wrapper.get('h2 > .nuvyn-fold-toggle').trigger('click')
    await wrapper.setProps({ foldingEnabled: false })
    await flushPromises()
    expect(wrapper.findAll('.nuvyn-fold-toggle')).toHaveLength(0)
    expect(wrapper.get('p').attributes('hidden')).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps code copying functional without adding code folding controls', async () => {
    const wrapper = mountMarkdown('```ts\nconst a = 1\n```')
    await wrapper.setProps({ foldingEnabled: true })
    await flushPromises()
    expect(wrapper.findAll('pre > .nuvyn-fold-toggle')).toHaveLength(0)
    expect(wrapper.get('pre > code').attributes('hidden')).toBeUndefined()
    await wrapper.get('.nuvyn-code-copy').trigger('click')
    expect(copyTextToClipboard).toHaveBeenLastCalledWith('const a = 1\n')
    wrapper.unmount()
  })

  async function foldedMarkdown() {
    const wrapper = mountMarkdown('## A\nbody')
    await wrapper.setProps({ foldingEnabled: true, tag: 'article' })
    await flushPromises()
    const root = wrapper.get('article').element
    const body = root.querySelector('p')!
    const button = root.querySelector<HTMLButtonElement>('.nuvyn-fold-toggle')!
    button.click()
    expect(body.hidden).toBe(true)
    const removeListener = vi.spyOn(root, 'removeEventListener')
    const expectReleased = () => {
      expect(button.parentNode).toBeNull()
      expect(body.classList.contains('nuvyn-fold-hidden')).toBe(false)
      expect(body.hidden).toBe(false)
      expect(body.id).toBe('')
      expect(removeListener).toHaveBeenCalledWith('click', expect.any(Function))
    }
    return { wrapper, root, body, button, expectReleased }
  }

  it('releases detached A nodes when B replaces the article content', async () => {
    const { wrapper, expectReleased } = await foldedMarkdown()
    await wrapper.setProps({ raw: '## B\nnew body', sourcePath: 'inbox/b' })
    await flushPromises()
    expectReleased()
    expect(wrapper.findAll('.nuvyn-fold-toggle')).toHaveLength(1)
    expect(wrapper.get('p').attributes('hidden')).toBeUndefined()
    wrapper.unmount()
  })

  it('releases a failed render and recovers with a fresh article', async () => {
    const { wrapper, root, button, expectReleased } = await foldedMarkdown()
    const pending = deferred<string>()
    vi.spyOn(markdown, 'render').mockImplementationOnce(() => pending.promise)
    await wrapper.setProps({ raw: '## B\nfailed body' })
    expect(root.querySelector('.nuvyn-fold-toggle')).toBe(button)
    pending.reject(new Error('render failed'))
    await flushPromises()
    expect(wrapper.get('.render-error').text()).toBe('render failed')
    expect(wrapper.find('article').exists()).toBe(false)
    expectReleased()
    await wrapper.setProps({ raw: '## C\nrecovered body' })
    await flushPromises()
    expect(wrapper.get('article').element).not.toBe(root)
    expect(wrapper.findAll('.nuvyn-fold-toggle')).toHaveLength(1)
    expect(wrapper.get('p').attributes('hidden')).toBeUndefined()
    wrapper.unmount()
  })

  it('immediately disables folding during a pending render and re-enables on success', async () => {
    const { wrapper, expectReleased } = await foldedMarkdown()
    const pending = deferred<string>()
    vi.spyOn(markdown, 'render').mockImplementationOnce(() => pending.promise)
    await wrapper.setProps({ raw: '## B\nnew body' })
    await wrapper.setProps({ foldingEnabled: false })
    expectReleased()
    await wrapper.setProps({ foldingEnabled: true })
    expect(wrapper.findAll('.nuvyn-fold-toggle')).toHaveLength(0)
    pending.resolve('<h2 id="b">B</h2><p>new body</p>')
    await flushPromises()
    expect(wrapper.findAll('.nuvyn-fold-toggle')).toHaveLength(1)
    expect(wrapper.get('p').attributes('hidden')).toBeUndefined()
    wrapper.unmount()
  })

  it('releases an article removed during a pending render while the component survives', async () => {
    const { wrapper, root, expectReleased } = await foldedMarkdown()
    const pending = deferred<string>()
    vi.spyOn(markdown, 'render').mockImplementationOnce(() => pending.promise)
    await wrapper.setProps({ raw: '## B\nnew body' })
    await wrapper.setProps({ tag: 'div' })
    expect(root.parentNode).toBeNull()
    expectReleased()
    expect(wrapper.findAll('.nuvyn-fold-toggle')).toHaveLength(0)
    pending.resolve('<h2 id="b">B</h2><p>new body</p>')
    await flushPromises()
    expect(wrapper.findAll('.nuvyn-fold-toggle')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps valid folding during ordinary async rendering without duplicating controls', async () => {
    const html = await markdown.render('## A\nbody')
    const { wrapper, body, button } = await foldedMarkdown()
    const pending = deferred<string>()
    vi.spyOn(markdown, 'render').mockImplementationOnce(() => pending.promise)
    await wrapper.setProps({ raw: '## A\nbody\n' })
    expect(wrapper.get('.nuvyn-fold-toggle').element).toBe(button)
    expect(body.hidden).toBe(true)
    pending.resolve(html)
    await flushPromises()
    expect(wrapper.findAll('.nuvyn-fold-toggle')).toHaveLength(1)
    expect(wrapper.get('.nuvyn-fold-toggle').element).toBe(button)
    expect(body.hidden).toBe(true)
    wrapper.unmount()
  })

  it('ignores obsolete renders and releases pending work on unmount', async () => {
    const { wrapper, root, expectReleased } = await foldedMarkdown()
    const stale = deferred<string>()
    const current = deferred<string>()
    vi.spyOn(markdown, 'render')
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise)
    await wrapper.setProps({ raw: '## B\nold request' })
    await wrapper.setProps({ raw: '## C\ncurrent request' })
    stale.resolve('<h2 id="b">B</h2><p>old request</p>')
    await flushPromises()
    expect(wrapper.text()).not.toContain('old request')
    wrapper.unmount()
    expectReleased()
    current.resolve('<h2 id="c">C</h2><p>current request</p>')
    await flushPromises()
    expect(root.querySelector('.nuvyn-fold-toggle')).toBeNull()
    expect(root.textContent).not.toContain('current request')
  })
})
