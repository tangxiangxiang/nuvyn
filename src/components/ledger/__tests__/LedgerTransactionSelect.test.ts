// @vitest-environment jsdom
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { h, nextTick, type VNodeChild } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NSelect, type SelectGroupOption, type SelectOption } from 'naive-ui'
import type { LedgerAccountDto } from '../../../../shared/ledgerProtocol'
import LedgerTransactionSelect from '../LedgerTransactionSelect.vue'
import { ledgerAccountSelectOptions, renderLedgerAccountLabel } from '../ledgerSelectRenderers'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
})

const accounts: LedgerAccountDto[] = [
  {
    id: 'asset-1', name: '日常账户', type: 'bank', nature: 'asset', openingBalanceMinor: 100_000,
    openingDate: '2026-01-01', currency: 'CNY', currencyExponent: 2, note: '', archivedAt: null,
    version: 1, createdAt: 1, updatedAt: 1, currentBalanceMinor: 123_456,
  },
  {
    id: 'liability-1', name: '信用账户', type: 'credit_card', nature: 'liability', openingBalanceMinor: 0,
    openingDate: '2026-01-01', currency: 'CNY', currencyExponent: 2, note: '', archivedAt: null,
    version: 1, createdAt: 1, updatedAt: 1, currentBalanceMinor: -50_000,
  },
]

function mountSelect(options: Array<SelectOption | SelectGroupOption>, optionsOverride: Partial<{
  label: string
  optionLayout: 'list' | 'grid'
  disabled: boolean
  renderLabel: (option: SelectOption | SelectGroupOption, selected?: boolean) => VNodeChild
}> = {}, modelValue = '') {
  const wrapper = mount(LedgerTransactionSelect, {
    attachTo: document.body,
    props: {
      modelValue,
      label: '账户',
      id: 'account-id',
      name: 'accountId',
      placeholder: '请选择账户',
      options,
      ...optionsOverride,
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

async function openSelect(wrapper: VueWrapper, label = '账户'): Promise<DOMWrapper<Element>> {
  await wrapper.findComponent(NSelect).vm.$emit('update:show', true)
  await nextTick()
  await flushPromises()
  const dialog = new DOMWrapper(document.body).find(`[role="dialog"][aria-label="选择${label}"]`)
  expect(dialog.exists()).toBe(true)
  expect(dialog.isVisible()).toBe(true)
  return dialog
}

describe('LedgerTransactionSelect', () => {
  it('opens grouped account options, renders balances and commits the selected account ID', async () => {
    const options = ledgerAccountSelectOptions(accounts, { showBalance: true })
    const wrapper = mountSelect(options, { renderLabel: (option) => renderLedgerAccountLabel(option, accounts) }, 'asset-1')

    const dialog = await openSelect(wrapper)
    expect(dialog.text()).toContain('资产账户')
    expect(dialog.text()).toContain('负债账户')
    expect(dialog.text()).toContain('日常账户')
    expect(dialog.text()).toContain('¥1,234.56')
    expect(dialog.text()).toContain('信用账户')
    expect(dialog.get('[data-ledger-option="liability-1"] .ledger-account-select-balance').text()).toBe('-¥500.00')

    const selected = dialog.find('[data-ledger-option="asset-1"]')
    expect(selected.attributes('aria-selected')).toBe('true')
    expect(selected.find('.ledger-option-picker-check').exists()).toBe(true)

    await dialog.get('[data-ledger-option="liability-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toEqual([['liability-1']])
    expect(dialog.isVisible()).toBe(false)
  })

  it('uses the grid layout and custom label renderer for category options', async () => {
    const options: Array<SelectOption | SelectGroupOption> = [
      { type: 'group', key: 'recent', label: '最近常用', children: [{ value: 'food', label: '餐饮' }] },
      { value: 'travel', label: '旅行' },
    ]
    const renderLabel = (option: SelectOption | SelectGroupOption, selected?: boolean) => h('span', {
      'data-custom-option': String(option.value ?? option.key),
    }, `${String(option.label)}${selected ? '（已选）' : ''}`)
    const wrapper = mountSelect(options, { label: '分类', optionLayout: 'grid', renderLabel }, 'food')
    const dialog = await openSelect(wrapper, '分类')

    expect(dialog.classes()).toContain('ledger-option-picker-dialog--grid')
    expect(dialog.text()).toContain('最近常用')
    expect(dialog.find('[data-custom-option="food"]').text()).toBe('餐饮（已选）')
    expect(dialog.find('[data-ledger-option="food"]').attributes('aria-selected')).toBe('true')
    await dialog.get('[data-ledger-option="travel"]').trigger('click')
    await nextTick()
    expect(wrapper.emitted('update:modelValue')).toEqual([['travel']])
  })

  it('keeps disabled options unselectable and supports an empty state', async () => {
    const wrapper = mountSelect([
      { value: 'locked', label: '已停用', disabled: true },
      { value: 'available', label: '可用' },
    ])
    const dialog = await openSelect(wrapper)
    expect(dialog.get('[data-ledger-option="locked"]').attributes('disabled')).toBeDefined()
    await dialog.get('[data-ledger-option="locked"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await dialog.get('[data-ledger-option="available"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['available']])

    const empty = mountSelect([], { label: '空列表' })
    const emptyDialog = await openSelect(empty, '空列表')
    expect(emptyDialog.text()).toContain('暂无可选项')
  })

  it('closes from the overlay or Escape without changing the current value', async () => {
    const wrapper = mountSelect([{ value: 'asset-1', label: '日常账户' }], {}, 'asset-1')
    const dialog = await openSelect(wrapper)
    const overlay = new DOMWrapper(document.body).find('.n-modal-mask')
    expect(overlay.exists()).toBe(true)
    await overlay.trigger('mousedown')
    await overlay.trigger('mouseup')
    await flushPromises()
    expect(dialog.isVisible()).toBe(false)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await openSelect(wrapper)
    await dialog.trigger('keydown', { key: 'Escape', code: 'Escape' })
    await flushPromises()
    expect(dialog.isVisible()).toBe(false)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('opens from the keyboard and closes after a rapid selection and reopen', async () => {
    const wrapper = mountSelect([
      { type: 'group', key: 'asset', label: '资产账户', children: [{ value: 'a', label: '账户 A' }, { value: 'b', label: '账户 B' }] },
    ] satisfies Array<SelectOption | SelectGroupOption>)
    await wrapper.get('.n-base-selection').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    let dialog = new DOMWrapper(document.body).find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    await dialog.get('[data-ledger-option="a"]').trigger('click')
    await flushPromises()
    dialog = await openSelect(wrapper)
    expect(dialog.exists()).toBe(true)
    await dialog.get('[data-ledger-option="b"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['a'], ['b']])
  })
})
