// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, provide } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultContext } from '../../../composables/vault/context/types'
import { VaultContextKey } from '../../../composables/vault/context/vaultContext'
import RenderedMarkdown from '../RenderedMarkdown.vue'
import { copyTextToClipboard } from '../workspaceTabActions'
import { useI18n } from '../../../composables/useI18n'

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
