// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import { NDatePicker } from 'naive-ui'
import LedgerDatePicker from '../LedgerDatePicker.vue'
import LedgerDateTimePicker from '../LedgerDateTimePicker.vue'

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
    })
    await wrapper.get('[data-testid="ledger-datetime-test"] input').trigger('click')
    await nextTick()
    const picker = wrapper.findComponent(NDatePicker)

    expect(picker.props('type')).toBe('datetime')
    expect(picker.props('panel')).toBe(true)
    expect(picker.props('valueFormat')).toBe("yyyy-MM-dd'T'HH:mm")
    expect((wrapper.get('[data-testid="ledger-datetime-test"] input').element as HTMLInputElement).value).toBe('2026-09-05 12:30')

    await picker.vm.$emit('update:formatted-value', '2026-09-06T13:45')
    await nextTick()

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['2026-09-06T13:45'])
    expect(wrapper.find('[data-testid="ledger-datetime-test"]').exists()).toBe(true)
  })

  it('clears the canonical model until both fields are complete', async () => {
    const wrapper = mount(LedgerDateTimePicker, {
      props: { modelValue: '2026-09-05T12:30', label: '发生时间' },
    })
    await wrapper.find('input').trigger('click')
    await nextTick()
    const picker = wrapper.findComponent(NDatePicker)

    await picker.vm.$emit('update:formatted-value', null)
    await nextTick()

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([''])
  })
})
