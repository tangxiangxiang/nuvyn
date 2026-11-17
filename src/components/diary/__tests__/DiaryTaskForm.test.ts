// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryTaskForm from '../DiaryTaskForm.vue'
import type { TaskFields } from '../../../../shared/diaryTasks'

describe('DiaryTaskForm', () => {
  it('clears the due time together with a cleared due date', async () => {
    const initial: TaskFields = {
      title: '预约体检',
      description: '',
      dueDate: '2026-11-18',
      dueTime: '09:30',
    }
    const wrapper = mount(DiaryTaskForm, { props: { modelValue: initial } })

    await wrapper.get('input[type="date"]').setValue('')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      dueDate: null,
      dueTime: null,
    })
    wrapper.unmount()
  })
})
