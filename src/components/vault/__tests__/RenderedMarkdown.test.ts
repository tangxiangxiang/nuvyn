// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, provide } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { VaultContext } from '../../../composables/vault/context/types'
import { VaultContextKey } from '../../../composables/vault/context/vaultContext'
import RenderedMarkdown from '../RenderedMarkdown.vue'

vi.mock('../../../composables/useMarkmapMount', () => ({ useMarkmapMount: vi.fn() }))
vi.mock('../../../composables/useMermaidMount', () => ({ useMermaidMount: vi.fn() }))
vi.mock('../../../composables/useMathMount', () => ({ useMathMount: vi.fn() }))
vi.mock('../../../composables/useCodeGroupMount', () => ({ useCodeGroupMount: vi.fn() }))

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
