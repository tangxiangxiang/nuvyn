// @vitest-environment jsdom
import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AiFinanceMemoryDialog from '../AiFinanceMemoryDialog.vue'
import { useI18n } from '../../../composables/useI18n'
import { addFinanceMemory, clearFinanceMemory, deleteFinanceMemory, getFinanceMemory, updateFinanceMemory } from '../../../lib/ai-api'

vi.mock('../../../lib/ai-api', async original => ({
  ...await original<typeof import('../../../lib/ai-api')>(),
  addFinanceMemory: vi.fn(),
  clearFinanceMemory: vi.fn(),
  deleteFinanceMemory: vi.fn(),
  getFinanceMemory: vi.fn(),
  updateFinanceMemory: vi.fn(),
}))

const state = {
  items: [
    { id: 1, kind: 'user' as const, content: 'Prioritize an emergency fund.', createdAt: 1, updatedAt: 1, revision: 1 },
    { id: 2, kind: 'agent' as const, content: 'Include repayments in cashflow.', createdAt: 2, updatedAt: 2, revision: 1 },
  ],
  usage: {
    user: { used: 29, limit: 2_000 },
    agent: { used: 33, limit: 3_000 },
    total: { used: 62, limit: 5_000 },
  },
}

function mountDialog(busy = false) {
  return mount(AiFinanceMemoryDialog, {
    props: { open: true, busy },
    global: { stubs: { NModal: true, NIcon: true, teleport: true } },
  })
}

describe('AiFinanceMemoryDialog', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
    vi.clearAllMocks()
    vi.mocked(getFinanceMemory).mockResolvedValue(structuredClone(state))
    vi.mocked(addFinanceMemory).mockResolvedValue({
      memory: { id: 3, kind: 'agent', content: 'State assumptions clearly.', createdAt: 3, updatedAt: 3, revision: 1 },
      usage: state.usage,
    })
    vi.mocked(updateFinanceMemory).mockImplementation(async (id, content) => ({
      memory: { ...state.items[0]!, id, content, updatedAt: 3, revision: 2 }, usage: state.usage,
    }))
    vi.mocked(deleteFinanceMemory).mockResolvedValue({ deleted: true, usage: state.usage })
    vi.mocked(clearFinanceMemory).mockResolvedValue({ cleared: true, usage: {
      user: { used: 0, limit: 2_000 }, agent: { used: 0, limit: 3_000 }, total: { used: 0, limit: 5_000 },
    } })
  })
  afterEach(() => {
    useI18n().setLocale('zh')
  })

  it('loads both memory groups, edits and deletes entries, and requires confirmation to clear all', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    expect(getFinanceMemory).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('User memory')
    expect(wrapper.text()).toContain('Analysis practices')
    expect(wrapper.text()).toContain('Prioritize an emergency fund.')

    await wrapper.get('[aria-label="Edit memory: Prioritize an emergency fund."]').trigger('click')
    await wrapper.get('textarea').setValue('Preserve an emergency fund first.')
    await wrapper.findAll('button').find(button => button.text().includes('Save'))!.trigger('click')
    await flushPromises()
    expect(updateFinanceMemory).toHaveBeenCalledWith(1, 'Preserve an emergency fund first.', 1)
    expect(wrapper.text()).toContain('Preserve an emergency fund first.')

    await wrapper.get('[aria-label="Delete memory: Include repayments in cashflow."]').trigger('click')
    await flushPromises()
    expect(deleteFinanceMemory).toHaveBeenCalledWith(2, 1)
    expect(wrapper.text()).not.toContain('Include repayments in cashflow.')

    await wrapper.findAll('button').find(button => button.text().includes('Clear all memories'))!.trigger('click')
    expect(wrapper.text()).toContain('This does not delete related content from the original chat.')
    expect(clearFinanceMemory).not.toHaveBeenCalled()
    const confirm = wrapper.findAll('button').filter(button => button.text().includes('Clear all memories')).at(-1)!
    await confirm.trigger('click')
    await flushPromises()
    expect(clearFinanceMemory).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('There are no long-term memories yet.')
  })

  it('disables edits and deletion while the Finance Agent is running', async () => {
    const wrapper = mountDialog(true)
    await flushPromises()
    await nextTick()
    expect(wrapper.get('[aria-label="Edit memory: Prioritize an emergency fund."]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[aria-label="Delete memory: Prioritize an emergency fund."]').attributes('disabled')).toBeDefined()
  })

  it('lets the user add a memory explicitly, including content previously removed by the Agent', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('[aria-label="Add finance memory"]').trigger('click')
    await wrapper.get('[aria-label="Memory type"]').setValue('agent')
    await wrapper.get('textarea[aria-label="Add finance memory"]').setValue('State assumptions clearly.')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(addFinanceMemory).toHaveBeenCalledWith('agent', 'State assumptions clearly.')
    expect(wrapper.text()).toContain('State assumptions clearly.')
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('updates an existing duplicate response by id instead of rendering a duplicate memory key', async () => {
    vi.mocked(addFinanceMemory).mockResolvedValueOnce({ memory: state.items[0]!, usage: state.usage })
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('[aria-label="Add finance memory"]').trigger('click')
    await wrapper.get('textarea[aria-label="Add finance memory"]').setValue(state.items[0]!.content)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.findAll('.ai-finance-memory-entry')).toHaveLength(2)
    expect(wrapper.findAll('.ai-finance-memory-entry').filter(entry => entry.text().includes(state.items[0]!.content))).toHaveLength(1)
    expect(wrapper.text()).toContain('29/2000')
  })

  it('shows a load error without presenting the failed request as an empty memory list', async () => {
    vi.mocked(getFinanceMemory).mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not load finance memories. Please try again.')
    expect(wrapper.text()).not.toContain('There are no long-term memories yet.')
  })

  it('reloads the latest revision after a concurrent edit without losing the local draft', async () => {
    vi.mocked(updateFinanceMemory).mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }))
    vi.mocked(getFinanceMemory)
      .mockResolvedValueOnce(structuredClone(state))
      .mockResolvedValueOnce({
        ...structuredClone(state),
        items: state.items.map(item => item.id === 1
          ? { ...item, content: 'Latest server preference.', revision: 2 }
          : item),
      })
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('[aria-label="Edit memory: Prioritize an emergency fund."]').trigger('click')
    await wrapper.get('textarea').setValue('My unsaved preference draft.')
    await wrapper.findAll('button').find(button => button.text().includes('Save'))!.trigger('click')
    await flushPromises()

    expect(wrapper.get('textarea').element.value).toBe('My unsaved preference draft.')
    expect(wrapper.text()).toContain('This memory changed elsewhere.')
    expect(wrapper.text()).toContain('Latest server preference.')
    await wrapper.findAll('button').find(button => button.text().includes('Save'))!.trigger('click')
    await flushPromises()
    expect(updateFinanceMemory).toHaveBeenLastCalledWith(1, 'My unsaved preference draft.', 2)
  })
})
