// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { shallowRef } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import AiMarkdown from '../AiMarkdown.vue'
import { VaultContextKey } from '../../../composables/vault/context/vaultContext'

vi.mock('../../../composables/vault/useLinkIndex', () => ({
  getLinkIndex: () => shallowRef({ paths: new Set(['notes/target']) }),
}))

describe('AiMarkdown navigation', () => {
  it.each(['[[target#section|Note]]', '[Note](target.md#section)', '[Note](./target.md#section)'])(
    'opens an internal note in the workspace without browser navigation: %s', async content => {
      const openLink = vi.fn(async () => {})
      const wrapper = mount(AiMarkdown, {
        props: { content, sourcePath: 'notes/source' },
        global: { provide: { [VaultContextKey as symbol]: { editor: { openLink } } } },
      })
      const link = wrapper.get('a')
      expect(link.attributes('href')).toBe('/vault/notes/target#section')
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(openLink).toHaveBeenCalledWith('notes/target', 'section')
      wrapper.unmount()
    },
  )

  it('does not intercept external URLs', () => {
    const openLink = vi.fn()
    const wrapper = mount(AiMarkdown, {
      props: { content: '[Site](https://example.com)' },
      global: { provide: { [VaultContextKey as symbol]: { editor: { openLink } } } },
    })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    wrapper.get('a').element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(openLink).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
