// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBoardEmbedMount } from '../useBoardEmbedMount'

const unmounted = vi.hoisted(() => vi.fn())
vi.mock('../../components/board/BoardEmbed.vue', async () => {
  const { defineComponent, h, onBeforeUnmount } = await import('vue')
  return { default: defineComponent({
    props: ['boardId', 'label', 'renderTheme'],
    setup(props) {
      onBeforeUnmount(unmounted)
      return () => h('span', { class: 'board-embed', 'data-board-state': 'ready' }, props.boardId)
    },
  }) }
})

const id = '8a1c2544-dad0-4f20-a593-7bbc59882921'
const Parent = defineComponent({
  props: { html: String },
  setup(props) {
    const article = ref<HTMLElement | null>(null)
    useBoardEmbedMount(article)
    return () => h('article', { ref: article, innerHTML: props.html })
  },
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => { vi.useRealTimers() })

describe('Board Markdown enhancement lifecycle', () => {
  it('mounts valid references and releases them when v-html replaces the document', async () => {
    const wrapper = mount(Parent, { props: { html: `<p><span class="board-embed-mount" data-target="${id}" title="Diagram"></span></p>` } })
    await flushPromises()
    expect(wrapper.find('.board-embed-host .board-embed').text()).toBe(id)
    await wrapper.setProps({ html: '<p>Another document</p>' })
    await vi.advanceTimersByTimeAsync(60)
    expect(unmounted).toHaveBeenCalledOnce()
    expect(wrapper.find('.board-embed-host').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not mount forged IDs or arbitrary resource paths', async () => {
    const wrapper = mount(Parent, { props: { html: '<span class="board-embed-mount" data-target="../secret">Invalid reference</span>' } })
    await flushPromises()
    expect(wrapper.find('.board-embed-host').exists()).toBe(false)
    expect(wrapper.text()).toBe('Invalid reference')
    wrapper.unmount()
  })

  it('unmounts every embed when its parent closes', async () => {
    const placeholder = `<span class="board-embed-mount" data-target="${id}"></span>`
    const wrapper = mount(Parent, { props: { html: placeholder.repeat(2) } })
    await flushPromises()
    expect(wrapper.findAll('.board-embed-host')).toHaveLength(2)
    wrapper.unmount()
    expect(unmounted).toHaveBeenCalledTimes(2)
  })
})
