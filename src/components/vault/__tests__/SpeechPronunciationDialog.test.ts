// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SpeechPronunciationDialog from '../SpeechPronunciationDialog.vue'

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../../lib/ai-api', () => ({ getSpeechPronunciations: api.get, saveSpeechPronunciations: api.save }))
vi.mock('../../../composables/useToast', () => ({ useToast: () => ({ success: api.success, error: api.error }) }))
const Input = defineComponent({ props: ['value'], emits: ['update:value'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' })
const global = { stubs: {
  Modal: defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()) } }),
  Input,
  Button: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
} }
afterEach(() => vi.clearAllMocks())
const rule = { id: 'tianmu', text: '天姥', pinyin: 'tian1 mu3' }
const button = (wrapper: ReturnType<typeof mount>, label: RegExp) => wrapper.findAll('button').find((item) => label.test(item.text()))!

describe('SpeechPronunciationDialog', () => {
  it('loads saved rules and supports edit, delete and add with validation', async () => {
    api.get.mockResolvedValue([rule])
    api.save.mockImplementation(async (value) => value)
    const wrapper = mount(SpeechPronunciationDialog, { global })
    await flushPromises()
    expect(wrapper.text()).toContain('天姥 · tian1 mu3')
    await button(wrapper, /^(编辑|Edit)$/).trigger('click')
    const inputs = wrapper.findAll('input')
    expect(inputs[0]!.element.value).toBe('天姥')
    await inputs[1]!.setValue('tian1 lao3')
    await button(wrapper, /^(保存|Save)$/).trigger('click')
    await flushPromises()
    expect(api.save).toHaveBeenLastCalledWith([{ ...rule, pinyin: 'tian1 lao3' }], expect.any(AbortSignal))
    await button(wrapper, /^(删除|Delete)$/).trigger('click')
    await flushPromises()
    expect(api.save).toHaveBeenLastCalledWith([], expect.any(AbortSignal))
    await inputs[0]!.setValue('重庆')
    await inputs[1]!.setValue('chong2')
    await button(wrapper, /^(保存|Save)$/).trigger('click')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(api.save).toHaveBeenCalledTimes(2)
    await inputs[1]!.setValue('chong2 qing4')
    await button(wrapper, /^(保存|Save)$/).trigger('click')
    await flushPromises()
    expect(api.save).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('prefills a selected word, prevents duplicate submissions, retains errors for retry and cancels on unmount', async () => {
    api.get.mockResolvedValue([rule])
    let reject!: (reason: Error) => void
    api.save.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise }))
    const wrapper = mount(SpeechPronunciationDialog, { props: { initialText: '天姥' }, global })
    await flushPromises()
    expect(wrapper.findAll('input')[1]!.element.value).toBe('tian1 mu3')
    await button(wrapper, /^(保存|Save)$/).trigger('click')
    await button(wrapper, /^(保存|Save)$/).trigger('click')
    expect(api.save).toHaveBeenCalledTimes(1)
    reject(new Error('network'))
    await flushPromises()
    expect(api.error).toHaveBeenCalled()
    api.save.mockResolvedValue([rule])
    await button(wrapper, /^(保存|Save)$/).trigger('click')
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    const signal = api.get.mock.calls.at(-1)![0] as AbortSignal
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('does not save an empty replacement when loading fails and can retry loading', async () => {
    api.get.mockRejectedValueOnce(new Error('network')).mockResolvedValue([rule])
    const wrapper = mount(SpeechPronunciationDialog, { global })
    await flushPromises()
    expect(button(wrapper, /^(保存|Save)$/).attributes('disabled')).toBeDefined()
    await button(wrapper, /^(重试|Retry)$/).trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('天姥 · tian1 mu3')
    wrapper.unmount()
  })
})
