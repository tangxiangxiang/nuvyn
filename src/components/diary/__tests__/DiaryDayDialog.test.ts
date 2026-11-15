// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DiaryDayDialog from '../DiaryDayDialog.vue'
import type { DiaryDay } from '../../../../shared/diaryLife'

const day: DiaryDay = {
  date: '2026-11-15', moodId: null, entries: ['一条记录'], version: 1, createdAt: 1, updatedAt: 1,
}

function mountDialog(mode: 'read' | 'edit', currentDay: DiaryDay | null) {
  return mount(DiaryDayDialog, {
    props: {
      show: true,
      date: day.date,
      day: currentDay,
      draft: { moodId: currentDay?.moodId ?? null, entries: [...(currentDay?.entries ?? [])] },
      mode,
    },
    attachTo: document.body,
    global: {
      stubs: {
        NModal: { template: '<div><slot /></div>' },
        NCard: { template: '<section><slot name="header" /><slot /><slot name="footer" /></section>' },
        NButton: { template: '<button><slot /></button>' },
        NIcon: { template: '<i><slot /></i>' },
      },
    },
  })
}

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
    expect(document.body.querySelector('[data-testid="diary-delete-entry"]')).toBeNull()
    expect(document.body.querySelector('.diary-day-actions')).toBeNull()
    expect(document.body.querySelector('[aria-label="选择心情"]')).toBeNull()
    wrapper.unmount()
  })

  it('keeps a mood-only day readable without turning mood selection into an edit control', () => {
    const wrapper = mount(DiaryDayDialog, {
      props: {
        show: true,
        date: day.date,
        day: { ...day, moodId: 'happy', entries: [] },
        draft: { moodId: 'happy', entries: [] },
        mode: 'read',
      },
      attachTo: document.body,
      global: {
        stubs: {
          NModal: { template: '<div><slot /></div>' },
          NCard: { template: '<section><slot name="header" /><slot /><slot name="footer" /></section>' },
          NButton: { template: '<button><slot /></button>' },
          NIcon: { template: '<i><slot /></i>' },
        },
      },
    })

    expect(document.body.querySelector('[data-testid="diary-day-mood"] img')?.getAttribute('src')).toBe('/emoji/开心.svg')
    expect(document.body.querySelector('[data-testid="diary-empty-reading"]')?.textContent).toBe('今天还没有文字记录。')
    expect(document.body.querySelector('[aria-label="选择心情"]')).toBeNull()
    expect(document.body.querySelector('.diary-day-actions')).toBeNull()
    wrapper.unmount()
  })

  it('shows delete only while editing an existing day and emits remove', async () => {
    const wrapper = mountDialog('edit', day)

    document.body.querySelector<HTMLButtonElement>('[data-testid="diary-delete-entry"]')!.click()
    await nextTick()

    expect(wrapper.emitted('remove')).toHaveLength(1)
    expect(document.body.querySelector('[data-testid="diary-save-entry"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('does not show delete while editing a new day', () => {
    const wrapper = mountDialog('edit', null)

    expect(document.body.querySelector('[data-testid="diary-delete-entry"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="diary-save-entry"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('keeps edit and cancel actions available without showing edit controls in read mode', async () => {
    const read = mountDialog('read', day)
    document.body.querySelector<HTMLButtonElement>('[data-testid="diary-edit-entry"]')!.click()
    await nextTick()
    expect(read.emitted('edit')).toHaveLength(1)
    expect(document.body.querySelector('textarea')).toBeNull()
    read.unmount()

    const edit = mountDialog('edit', day)
    document.body.querySelector<HTMLButtonElement>('[data-testid="diary-cancel-edit"]')!.click()
    document.body.querySelector<HTMLButtonElement>('[data-testid="diary-save-entry"]')!.click()
    await nextTick()
    expect(edit.emitted('cancel-edit')).toHaveLength(1)
    expect(edit.emitted('save')).toHaveLength(1)
    edit.unmount()
  })
})
