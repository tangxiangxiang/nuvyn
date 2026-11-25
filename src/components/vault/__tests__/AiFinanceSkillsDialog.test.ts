// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AiFinanceSkillsDialog from '../AiFinanceSkillsDialog.vue'
import { useI18n } from '../../../composables/useI18n'
import { createFinanceSkill, deleteFinanceSkill, getFinanceSkill, getFinanceSkills, updateFinanceSkill } from '../../../lib/ai-api'

vi.mock('../../../lib/ai-api', async original => ({
  ...await original<typeof import('../../../lib/ai-api')>(),
  getFinanceSkill: vi.fn(),
  getFinanceSkills: vi.fn(),
  createFinanceSkill: vi.fn(),
  updateFinanceSkill: vi.fn(),
  deleteFinanceSkill: vi.fn(),
}))

const metadata = [
  { name: 'monthly-review', title: 'monthly-review', description: 'Review the month.', source: 'builtin' as const },
  { name: 'spending-analysis', title: 'spending-analysis', description: 'Analyze spending.', source: 'builtin' as const },
  { name: 'debt-analysis', title: 'debt-analysis', description: 'Review debt.', source: 'builtin' as const },
  { name: 'cashflow-analysis', title: 'cashflow-analysis', description: 'Review cashflow.', source: 'builtin' as const },
  { name: 'financial-planning', title: 'financial-planning', description: 'Plan finances.', source: 'builtin' as const },
]

const customMetadata = { name: 'custom-monthly-report', title: 'Personal monthly review', description: 'Review finances in my preferred order.', source: 'custom' as const, revision: 1 }

const customSkill = {
  name: 'custom-monthly-report', title: 'Personal monthly review', description: 'Review finances in my preferred order.',
  source: 'custom' as const, revision: 1, content: '# Personal monthly review\n\nCompare the same period.',
}

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
  vi.mocked(createFinanceSkill).mockResolvedValue({ skill: customSkill, usage: { count: 1, countLimit: 10, contentCharacters: customSkill.content.length, contentLimit: 15_000 } })
  vi.mocked(updateFinanceSkill).mockResolvedValue({ skill: { ...customSkill, revision: 2, content: 'Updated procedure.' }, usage: { count: 1, countLimit: 10, contentCharacters: 19, contentLimit: 15_000 } })
  vi.mocked(deleteFinanceSkill).mockResolvedValue({ deleted: true })
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

  it('separates built-in and custom skills, lets users create a custom skill, and keeps the slug hidden', async () => {
    vi.mocked(getFinanceSkills).mockResolvedValueOnce([...metadata, customMetadata])
    const wrapper = mount(AiFinanceSkillsDialog, {
      props: { open: true },
      global: { stubs: { NModal: ModalStub, NIcon: true, teleport: true } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Built-in skills')
    expect(wrapper.text()).toContain('Custom skills')
    expect(wrapper.text()).toContain('Personal monthly review')

    await wrapper.get('[aria-label="Add skill"]').trigger('click')
    await wrapper.get('input').setValue('Personal monthly review')
    await wrapper.findAll('input')[1]!.setValue('Review finances in my preferred order.')
    await wrapper.get('textarea').setValue('# My analysis procedure')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(createFinanceSkill).toHaveBeenCalledWith('Personal monthly review', 'Review finances in my preferred order.', '# My analysis procedure')
    expect(wrapper.text()).toContain('# Personal monthly review')
    expect(wrapper.text()).not.toContain('custom-monthly-report')
  })

  it('preserves an edit draft on revision conflict and retries against the latest revision', async () => {
    vi.mocked(getFinanceSkills).mockResolvedValueOnce([...metadata, customMetadata])
    vi.mocked(getFinanceSkill)
      .mockResolvedValueOnce(customSkill)
      .mockResolvedValueOnce({ ...customSkill, title: 'Latest monthly review', revision: 2, content: 'Latest server procedure.' })
    vi.mocked(updateFinanceSkill)
      .mockRejectedValueOnce(Object.assign(new Error('Finance skill update failed: stale-revision'), { status: 409 }))
      .mockResolvedValueOnce({ skill: { ...customSkill, revision: 3, content: 'My unsaved procedure.' }, usage: { count: 1, countLimit: 10, contentCharacters: 23, contentLimit: 15_000 } })
    const wrapper = mount(AiFinanceSkillsDialog, {
      props: { open: true },
      global: { stubs: { NModal: ModalStub, NIcon: true, teleport: true } },
    })
    await flushPromises()
    await wrapper.findAll('.ai-finance-skills-list button').find(button => button.text().includes('Personal monthly review'))!.trigger('click')
    await flushPromises()
    await wrapper.findAll('.ai-finance-skill-actions button').find(button => button.text().includes('Edit skill'))!.trigger('click')
    await wrapper.get('textarea').setValue('My unsaved procedure.')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('textarea').element.value).toBe('My unsaved procedure.')
    expect(wrapper.text()).toContain('Latest server procedure.')
    expect(wrapper.text()).toContain('your draft was preserved')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(updateFinanceSkill).toHaveBeenLastCalledWith('custom-monthly-report', {
      title: 'Personal monthly review', description: 'Review finances in my preferred order.', content: 'My unsaved procedure.', expectedRevision: 2,
    })
  })

  it('requires a named confirmation before deleting only a custom skill', async () => {
    vi.mocked(getFinanceSkills).mockResolvedValueOnce([...metadata, customMetadata])
    vi.mocked(getFinanceSkill).mockResolvedValueOnce(customSkill)
    const wrapper = mount(AiFinanceSkillsDialog, {
      props: { open: true },
      global: { stubs: { NModal: ModalStub, NIcon: true, teleport: true } },
    })
    await flushPromises()
    await wrapper.findAll('.ai-finance-skills-list button').find(button => button.text().includes('Personal monthly review'))!.trigger('click')
    await flushPromises()
    await wrapper.findAll('.ai-finance-skill-actions button').find(button => button.text().includes('Delete skill'))!.trigger('click')
    expect(wrapper.text()).toContain('Delete “Personal monthly review”?')
    expect(deleteFinanceSkill).not.toHaveBeenCalled()
    await wrapper.findAll('button').find(button => button.text() === 'Delete skill')!.trigger('click')
    await flushPromises()
    expect(deleteFinanceSkill).toHaveBeenCalledWith('custom-monthly-report', 1)
    expect(wrapper.text()).toContain('Built-in skills')
  })
})
