// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryTaskRows from '../DiaryTaskRows.vue'

describe('DiaryTaskRows', () => {
  it('shows skipped status without labeling the task overdue', () => {
    const task = {
      kind: 'recurring' as const,
      id: 'series:2026-11-14',
      seriesId: 'series',
      occurrenceDate: '2026-11-14',
      effectiveFrom: '2026-11-14',
      recurrence: { frequency: 'daily' as const, startDate: '2026-11-14', untilDate: null },
      seriesVersion: 1,
      occurrenceVersion: 1,
      title: '跳过的待办',
      description: '',
      dueDate: '2026-11-14',
      dueTime: null,
      completedAt: null,
      skipped: true,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const wrapper = mount(DiaryTaskRows, { props: { items: [task], today: '2026-11-18' } })

    expect(wrapper.get('.diary-task-row').classes()).toContain('is-skipped')
    expect(wrapper.text()).toContain('本次已跳过')
    expect(wrapper.text()).not.toContain('已逾期')
    wrapper.unmount()
  })
})
