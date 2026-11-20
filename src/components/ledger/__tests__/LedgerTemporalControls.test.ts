// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NDatePicker } from 'naive-ui'
import LedgerDatePicker from '../LedgerDatePicker.vue'
import LedgerDateTimePicker from '../LedgerDateTimePicker.vue'

const mountedWrappers: VueWrapper[] = []

afterEach(() => {
  mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
})

describe('Ledger Naive temporal controls', () => {
  it('keeps a canonical date string in the public date picker contract', async () => {
    const wrapper = mount(LedgerDatePicker, {
      props: { modelValue: '2026-09-05', label: '查看日期', testId: 'ledger-date-test' },
    })
    const picker = wrapper.findComponent(NDatePicker)

    expect(picker.props('size')).toBe('medium')
    expect(picker.props('formattedValue')).toBe('2026-09-05')
    expect(picker.props('valueFormat')).toBe('yyyy-MM-dd')
    await picker.vm.$emit('update:formatted-value', '2026-09-06')
    expect(wrapper.emitted('update:modelValue')).toEqual([['2026-09-06']])
  })

  it('keeps date and time in one field without browser-local timestamp conversion', async () => {
    const wrapper = mount(LedgerDateTimePicker, {
      props: { modelValue: '2026-09-05T12:30', label: '发生时间', testId: 'ledger-datetime-test' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)
    await wrapper.get('button[aria-label="选择发生时间"]').trigger('click')
    await flushPromises()
    const picker = wrapper.findComponent(NDatePicker)

    expect(picker.props('type')).toBe('datetime')
    expect(picker.props('panel')).toBe(true)
    expect(picker.props('valueFormat')).toBe("yyyy-MM-dd'T'HH:mm")
    expect((wrapper.get('[data-testid="ledger-datetime-test"] input').element as HTMLInputElement).value).toBe('2026-09-05 12:30')

    await picker.vm.$emit('update:formatted-value', '2026-09-06T13:45')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    const confirm = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.trim() === '确认')
    expect(confirm).toBeDefined()
    confirm?.click()
    await flushPromises()

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['2026-09-06T13:45'])
    expect(wrapper.find('[data-testid="ledger-datetime-test"]').exists()).toBe(true)
  })

  it('cannot confirm an incomplete date and time', async () => {
    const wrapper = mount(LedgerDateTimePicker, {
      props: { modelValue: '2026-09-05T12:30', label: '发生时间' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)
    await wrapper.get('button[aria-label="选择发生时间"]').trigger('click')
    await flushPromises()
    const picker = wrapper.findComponent(NDatePicker)

    await picker.vm.$emit('update:formatted-value', null)
    await nextTick()

    const confirm = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.trim() === '确认')
    expect(confirm?.disabled).toBe(true)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('cancels calendar draft changes without committing them', async () => {
    const wrapper = mount(LedgerDateTimePicker, {
      props: { modelValue: '2026-09-05T12:30', label: '发生时间', testId: 'ledger-datetime-cancel-test' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)
    await wrapper.get('button[aria-label="选择发生时间"]').trigger('click')
    await flushPromises()
    await wrapper.findComponent(NDatePicker).vm.$emit('update:formatted-value', '2026-09-06T13:45')

    const cancel = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.trim() === '取消')
    expect(cancel).toBeDefined()
    cancel?.click()
    await flushPromises()

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect((wrapper.get('[data-testid="ledger-datetime-cancel-test"] input').element as HTMLInputElement).value).toBe('2026-09-05 12:30')
  })

  it('rejects invalid manual dates and restores the last valid value on blur', async () => {
    const wrapper = mount(LedgerDateTimePicker, {
      props: { modelValue: '2026-09-05T12:30', label: '发生时间', testId: 'ledger-datetime-invalid-test' },
    })
    const input = wrapper.get('[data-testid="ledger-datetime-invalid-test"] input')
    await input.setValue('2026-02-31 12:30')

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await input.trigger('blur')
    await nextTick()
    expect((input.element as HTMLInputElement).value).toBe('2026-09-05 12:30')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
