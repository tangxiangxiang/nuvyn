// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DiaryDayDialog from '../DiaryDayDialog.vue'
import type { DiaryDay } from '../../../../shared/diaryLife'

describe('DiaryDayDialog reading mode', () => {
  it('renders entries as plain text and hides editing controls', async () => {
    const maliciousLookingText = '<img src=x onerror=alert(1)>'
    const day: DiaryDay = {
      date: '2026-11-15', moodId: null, entries: [maliciousLookingText], version: 1, createdAt: 1, updatedAt: 1,
    }
    const wrapper = mount(DiaryDayDialog, {
      attachTo: document.body,
      props: {
        show: true,
        date: day.date,
        day,
        draft: { moodId: null, entries: [...day.entries] },
        mode: 'read',
      },
      global: {
        stubs: {
          NModal: { template: '<div><slot /></div>' },
          NCard: { template: '<section><slot name="header" /><slot /><slot name="footer" /></section>' },
          NButton: { template: '<button><slot /></button>' },
          NIcon: { template: '<i><slot /></i>' },
        },
      },
    })
    await nextTick()

    expect(document.body.querySelector('[data-testid="diary-bullet-reader"] li')?.textContent).toBe(maliciousLookingText)
    expect(document.body.querySelector('img')).toBeNull()
    expect(document.body.querySelector('textarea')).toBeNull()
    expect(document.body.querySelector('[data-testid="diary-save-entry"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="diary-bullet-add"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="diary-edit-entry"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="选择心情"]')).toBeNull()
    wrapper.unmount()
  })
})
