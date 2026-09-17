// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LedgerAccountIcon, LedgerCategoryDto } from '../../../../shared/ledgerProtocol'
import { useConfirm } from '../../../composables/useConfirm'
import { useToast } from '../../../composables/useToast'
import { LedgerApiError } from '../../../features/ledger/ledgerErrors'
import SettingsLedgerCategoriesSection from '../SettingsLedgerCategoriesSection.vue'

const ledger = vi.hoisted(() => ({
  activeCategories: { value: [] as LedgerCategoryDto[] },
  archivedCategories: { value: [] as LedgerCategoryDto[] },
  categories: { value: [] as LedgerCategoryDto[] },
  bootstrap: vi.fn(),
  createCategory: vi.fn(),
  patchCategory: vi.fn(),
  archiveCategory: vi.fn(),
  restoreCategory: vi.fn(),
  deleteCategory: vi.fn(),
}))

vi.mock('../../../features/ledger/ledgerStore', () => ({
  useLedgerStore: () => ledger,
}))

const IconPickerStub = defineComponent({
  name: 'LedgerAccountIconPicker',
  props: { modelValue: { type: String, required: true }, disabled: Boolean },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('button', {
      class: 'icon-picker-stub',
      disabled: props.disabled,
      type: 'button',
      onClick: () => emit('update:modelValue', 'credit_card' satisfies LedgerAccountIcon),
    }, props.modelValue)
  },
})

function category(id: string, name: string, kind: 'income' | 'expense' = 'expense'): LedgerCategoryDto {
  return { id, kind, name, normalizedName: name, archivedAt: null, version: 3, createdAt: 1, updatedAt: 1 }
}

const wrappers: VueWrapper[] = []

function mountSection(): VueWrapper {
  const wrapper = mount(SettingsLedgerCategoriesSection, {
    attachTo: document.body,
    global: {
      stubs: {
        LedgerAccountIconPicker: IconPickerStub,
        Modal: defineComponent({
          props: { show: Boolean },
          setup(props, { slots }) {
            return () => props.show ? h('div', { class: 'n-modal-stub' }, slots.default?.()) : null
          },
        }),
        Card: defineComponent({
          setup(_, { slots }) {
            return () => h('div', { class: 'n-card-stub' }, [
              slots.header?.(),
              slots['header-extra']?.(),
              slots.default?.(),
            ])
          },
        }),
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  localStorage.clear()
  ledger.activeCategories.value = [category('food', '餐饮'), category('salary', '工资', 'income')]
  ledger.archivedCategories.value = []
  ledger.categories.value = ledger.activeCategories.value
  ledger.bootstrap.mockResolvedValue(undefined)
  ledger.patchCategory.mockResolvedValue(category('food', '通勤'))
  ledger.archiveCategory.mockResolvedValue({ ...category('food', '餐饮'), archivedAt: 2 })
  ledger.restoreCategory.mockResolvedValue(category('food', '餐饮'))
  ledger.deleteCategory.mockImplementation(async (id: string) => {
    ledger.categories.value = ledger.categories.value.filter((item) => item.id !== id)
    ledger.activeCategories.value = ledger.activeCategories.value.filter((item) => item.id !== id)
    ledger.archivedCategories.value = ledger.archivedCategories.value.filter((item) => item.id !== id)
    return { deleted: true, id }
  })
  ledger.createCategory.mockResolvedValue(category('travel', '交通'))
  useConfirm().queue.value = []
})

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('SettingsLedgerCategoriesSection', () => {
  it('enters management after a 550ms hold and exits from the empty grid area', async () => {
    const wrapper = mountSection()
    const item = wrapper.get('.settings-ledger-category-option')

    await item.trigger('pointerdown')
    await vi.advanceTimersByTimeAsync(549)
    expect(item.classes()).not.toContain('managing')
    await vi.advanceTimersByTimeAsync(1)
    expect(item.classes()).toContain('managing')

    await wrapper.get('.settings-ledger-category-options').trigger('click')
    expect(item.classes()).not.toContain('managing')
  })

  it('renames and moves an unused category to the recycle bin', async () => {
    const wrapper = mountSection()
    const item = wrapper.get('[data-category-kind="expense"] .settings-ledger-category-option')
    await item.trigger('contextmenu')
    await item.get('.settings-ledger-category-label').trigger('dblclick')

    const input = item.get<HTMLInputElement>('.settings-ledger-category-name-input')
    expect(input.attributes('class')).not.toContain('n-input')
    await input.setValue('通勤')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(ledger.patchCategory).toHaveBeenCalledWith('food', { expectedVersion: 3, name: '通勤' })

    await item.get('.settings-ledger-category-delete').trigger('click')
    const { queue, answer } = useConfirm()
    expect(queue.value).toHaveLength(1)
    answer(queue.value[0]!.id, true)
    await flushPromises()
    expect(ledger.archiveCategory).toHaveBeenCalledWith('food', 3)
    expect(ledger.deleteCategory).not.toHaveBeenCalled()
    expect(useToast().toasts.value.at(-1)?.message).toBe('分类已移入回收站')
  })

  it('rejects moving a category with history to the recycle bin', async () => {
    ledger.archiveCategory.mockRejectedValueOnce(new LedgerApiError(
      'category has history',
      409,
      'ledger-category-has-history',
    ))
    const wrapper = mountSection()
    const item = wrapper.get('[data-category-kind="expense"] .settings-ledger-category-option')
    await item.trigger('contextmenu')
    await item.get('[aria-label="删除分类：餐饮"]').trigger('click')

    const { queue, answer } = useConfirm()
    expect(queue.value).toHaveLength(1)
    answer(queue.value[0]!.id, true)
    await flushPromises()

    expect(ledger.archiveCategory).toHaveBeenCalledWith('food', 3)
    expect(ledger.deleteCategory).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('已有交易记录，不能删除')
  })

  it('opens archived categories in a modal and restores them', async () => {
    const archived = { ...category('old-food', 'pingguo'), archivedAt: 2 }
    ledger.archivedCategories.value = [archived]
    ledger.categories.value = [...ledger.activeCategories.value, archived]
    const wrapper = mountSection()
    await wrapper.get('[data-testid="settings-ledger-archived-open"]').trigger('click')
    const section = wrapper.get('[data-testid="settings-ledger-archived-categories"]')

    expect(section.text()).toContain('回收站')

    await wrapper.get('[aria-label="恢复分类：pingguo"]').trigger('click')
    await flushPromises()

    expect(ledger.restoreCategory).toHaveBeenCalledWith('old-food', 3)
    expect(useToast().toasts.value.at(-1)?.message).toBe('分类已恢复')
  })

  it('shows an empty state when the archived categories modal is opened', async () => {
    const wrapper = mountSection()
    expect(wrapper.find('[data-testid="settings-ledger-archived-categories"]').exists()).toBe(false)

    await wrapper.get('[data-testid="settings-ledger-archived-open"]').trigger('click')
    const openedSection = wrapper.get('[data-testid="settings-ledger-archived-categories"]')
    expect(openedSection.text()).toContain('回收站为空')
  })

  it('permanently deletes an archived category after confirmation', async () => {
    const archived = { ...category('old-food', 'pingguo'), archivedAt: 2 }
    ledger.archivedCategories.value = [archived]
    ledger.categories.value = [...ledger.activeCategories.value, archived]
    const wrapper = mountSection()

    await wrapper.get('[data-testid="settings-ledger-archived-open"]').trigger('click')
    await wrapper.get('[aria-label="永久删除分类：pingguo"]').trigger('click')
    const { queue, answer } = useConfirm()
    expect(queue.value).toHaveLength(1)
    expect(queue.value[0]!.message).toContain('永久删除分类')
    answer(queue.value[0]!.id, true)
    await flushPromises()

    expect(ledger.deleteCategory).toHaveBeenCalledWith('old-food', 3)
    expect(useToast().toasts.value.at(-1)?.message).toBe('分类已永久删除')
  })

  it('keeps an archived category when permanent deletion is rejected for history', async () => {
    const archived = { ...category('old-food', 'pingguo'), archivedAt: 2 }
    ledger.archivedCategories.value = [archived]
    ledger.categories.value = [...ledger.activeCategories.value, archived]
    ledger.deleteCategory.mockRejectedValueOnce(new LedgerApiError(
      'category has history',
      409,
      'ledger-category-has-history',
    ))
    const wrapper = mountSection()

    await wrapper.get('[data-testid="settings-ledger-archived-open"]').trigger('click')
    await wrapper.get('[aria-label="永久删除分类：pingguo"]').trigger('click')
    const { queue, answer } = useConfirm()
    answer(queue.value[0]!.id, true)
    await flushPromises()

    expect(ledger.archiveCategory).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('有历史记录，不能永久删除')
  })

  it('does not expose a delete action for protected system categories', async () => {
    const protectedCategory = {
      ...category('interest', '利息'),
      systemKey: 'interest' as const,
      protected: true,
      icon: 'credit_card' as const,
    }
    ledger.activeCategories.value = [protectedCategory]
    ledger.categories.value = [protectedCategory]
    const wrapper = mountSection()
    await wrapper.get('.settings-ledger-category-option').trigger('contextmenu')

    expect(wrapper.find('.settings-ledger-category-delete').exists()).toBe(false)
  })

  it('does not start the hold gesture when the category icon is operated', async () => {
    const wrapper = mountSection()
    const item = wrapper.get('[data-category-kind="expense"] .settings-ledger-category-option')
    const picker = item.get('.icon-picker-stub')

    await picker.trigger('pointerdown')
    await vi.advanceTimersByTimeAsync(600)
    expect(item.classes()).not.toContain('managing')

    await picker.trigger('click')
    expect(ledger.patchCategory).toHaveBeenCalledWith('food', { expectedVersion: 3, icon: 'credit_card' })
  })

  it('creates an expense category directly from an uploaded SVG', async () => {
    const wrapper = mountSection()
    const expenseUpload = wrapper.find('input[type="file"]')
    Object.defineProperty(expenseUpload.element, 'files', { value: [new File(['<svg></svg>'], 'travel.svg', { type: 'image/svg+xml' })] })
    await expenseUpload.trigger('change')
    await flushPromises()

    expect(ledger.createCategory).toHaveBeenCalledWith({ kind: 'expense', name: 'travel', icon: expect.stringMatching(/^custom_/) })
  })

  it('reports a failed direct upload creation', async () => {
    ledger.createCategory.mockRejectedValueOnce(new Error('failed'))
    const wrapper = mountSection()
    const expenseUpload = wrapper.find('input[type="file"]')
    Object.defineProperty(expenseUpload.element, 'files', { value: [new File(['<svg></svg>'], 'failed.svg', { type: 'image/svg+xml' })] })
    await expenseUpload.trigger('change')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).not.toBe('')
  })
})
