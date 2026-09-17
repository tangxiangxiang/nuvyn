// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryWorkspace from '../DiaryWorkspace.vue'

describe('DiaryWorkspace shell', () => {
  it('shows the Calendar Home slot while HOME is primary', () => {
    const wrapper = mount(DiaryWorkspace, {
      props: { eligible: true, visible: true, mode: 'home' },
      slots: { home: '<div data-testid="calendar-slot">calendar</div>' },
    })

    expect(wrapper.get('[data-testid="diary-workspace-shell"]').attributes('data-presentation-mode')).toBe('home')
    expect(wrapper.get('[data-testid="calendar-slot"]').isVisible()).toBe(true)
  })

  it('keeps Calendar mounted but hides the shell for native DOCUMENT', async () => {
    const wrapper = mount(DiaryWorkspace, {
      props: { eligible: true, visible: true, mode: 'home' },
      slots: { home: '<div data-testid="calendar-slot">calendar</div>' },
    })

    await wrapper.setProps({ visible: false, mode: 'document' })
    expect(wrapper.find('[data-testid="calendar-slot"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="diary-workspace-shell"]').isVisible()).toBe(false)
  })

  it('has no Reader or Editor presentation slots', () => {
    const wrapper = mount(DiaryWorkspace, {
      props: { eligible: true, visible: true, mode: 'home' },
      slots: {
        home: '<div data-testid="calendar-slot">calendar</div>',
        reader: '<div data-testid="reader-slot">reader</div>',
        editor: '<div data-testid="editor-slot">editor</div>',
      },
    })

    expect(wrapper.find('[data-testid="reader-slot"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-slot"]').exists()).toBe(false)
  })

  it('hides the whole shell when Diary presentation is ineligible', () => {
    const wrapper = mount(DiaryWorkspace, {
      props: { eligible: false, visible: false, mode: 'home' },
      slots: { home: '<div data-testid="calendar-slot">calendar</div>' },
    })

    expect(wrapper.get('[data-testid="diary-workspace-shell"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-testid="calendar-slot"]').exists()).toBe(true)
  })
})
