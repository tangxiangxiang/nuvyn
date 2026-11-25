// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AiFinanceSkillsDialog from '../AiFinanceSkillsDialog.vue'
import { useI18n } from '../../../composables/useI18n'
import { getFinanceSkill, getFinanceSkills } from '../../../lib/ai-api'

vi.mock('../../../lib/ai-api', async original => ({
  ...await original<typeof import('../../../lib/ai-api')>(),
  getFinanceSkill: vi.fn(),
  getFinanceSkills: vi.fn(),
}))

const metadata = [
  { name: 'monthly-review' as const, description: 'Review the month.' },
  { name: 'spending-analysis' as const, description: 'Analyze spending.' },
  { name: 'debt-analysis' as const, description: 'Review debt.' },
  { name: 'cashflow-analysis' as const, description: 'Review cashflow.' },
  { name: 'financial-planning' as const, description: 'Plan finances.' },
]

const ModalStub = defineComponent({
  props: { show: Boolean },
  setup(props, { slots }) {
    return () => props.show ? h('div', { class: 'modal-stub' }, slots.default?.()) : null
  },
})

describe('AiFinanceSkillsDialog', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
    vi.clearAllMocks()
    vi.mocked(getFinanceSkills).mockResolvedValue(metadata)
    vi.mocked(getFinanceSkill).mockResolvedValue({ ...metadata[0]!, content: '# Monthly review\n\nReview current cashflow.' })
  })
  afterEach(() => useI18n().setLocale('zh'))

  it('lists the five read-only built-in skills and loads Markdown on demand', async () => {
    const wrapper = mount(AiFinanceSkillsDialog, {
      props: { open: true },
      global: { stubs: { NModal: ModalStub, NIcon: true, teleport: true } },
    })
    await flushPromises()
    expect(getFinanceSkills).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('Finance skills')
    expect(wrapper.text()).toContain('Monthly review')
    expect(wrapper.text()).toContain('Spending analysis')
    expect(wrapper.findAll('li')).toHaveLength(5)
    expect(wrapper.text()).not.toContain('Edit')

    await wrapper.get('li button').trigger('click')
    await flushPromises()
    expect(getFinanceSkill).toHaveBeenCalledWith('monthly-review')
    expect(wrapper.get('pre').text()).toContain('# Monthly review')
    expect(wrapper.find('li').exists()).toBe(false)
  })

  it('reports list and detail failures without inventing an empty list', async () => {
    vi.mocked(getFinanceSkills).mockRejectedValueOnce(new Error('offline'))
    const wrapper = mount(AiFinanceSkillsDialog, {
      props: { open: true },
      global: { stubs: { NModal: ModalStub, NIcon: true, teleport: true } },
    })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not load finance skills. Please try again.')
    expect(wrapper.findAll('li')).toHaveLength(0)
  })

  it('shows a settled empty state when the runtime registry has no usable skills', async () => {
    vi.mocked(getFinanceSkills).mockResolvedValueOnce([])
    const wrapper = mount(AiFinanceSkillsDialog, {
      props: { open: true },
      global: { stubs: { NModal: ModalStub, NIcon: true, teleport: true } },
    })
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe('No finance skills are currently available.')
    expect(wrapper.findAll('li')).toHaveLength(0)
  })

  it('shows a bounded load error when one available skill body fails to load', async () => {
    vi.mocked(getFinanceSkill).mockRejectedValueOnce(new Error('private filesystem path'))
    const wrapper = mount(AiFinanceSkillsDialog, {
      props: { open: true },
      global: { stubs: { NModal: ModalStub, NIcon: true, teleport: true } },
    })
    await flushPromises()
    await wrapper.get('li button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not load this skill. Please try again.')
    expect(wrapper.text()).not.toContain('private filesystem path')
    expect(wrapper.findAll('li')).toHaveLength(5)
  })
})
