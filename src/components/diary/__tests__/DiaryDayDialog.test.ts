// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DiaryDayDialog from '../DiaryDayDialog.vue'
import type { DiaryDay } from '../../../../shared/diaryLife'
import type { DiaryAttachment } from '../../../../shared/diaryAttachments'

const day: DiaryDay = {
  date: '2026-11-15', moodId: null, entries: ['一条记录'], version: 1, createdAt: 1, updatedAt: 1,
}
const image: DiaryAttachment = {
  id: '92f3bb2b-2ded-43f3-8db2-dc77954bc918', date: day.date, name: 'breakfast.png',
  mimeType: 'image/png', size: 12, createdAt: 1, order: 0,
}
const pdf: DiaryAttachment = {
  ...image,
  id: '7be4f457-e73f-4e7c-8ea2-85ce5b17c7f4',
  name: 'memory.pdf',
  mimeType: 'application/pdf',
}

afterEach(() => {
  document.body.replaceChildren()
})

function mountMixed(mode: 'read' | 'edit', currentDay: DiaryDay, attachments: DiaryAttachment[]) {
  return mount(DiaryDayDialog, {
    props: {
      show: true,
      date: currentDay.date,
      day: currentDay,
      attachments,
      draft: {
        moodId: currentDay.moodId,
        entries: [...currentDay.entries],
        ...(currentDay.entryIds ? { entryIds: [...currentDay.entryIds] } : {}),
        ...(currentDay.imageGroups ? { imageGroups: currentDay.imageGroups.map(group => ({ ...group, attachmentIds: [...group.attachmentIds] })) } : {}),
      },
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

function mountDialog(mode: 'read' | 'edit', currentDay: DiaryDay | null) {
  return mount(DiaryDayDialog, {
    props: {
      show: true,
      date: day.date,
      day: currentDay,
      attachments: [],
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
  it('renders each placed image group immediately after its stable text entry', async () => {
    const entryIds = ['08a5c822-0d61-4e6c-a62c-1931a4da0771', '08a5c822-0d61-4e6c-a62c-1931a4da0772']
    const mappedDay: DiaryDay = {
      ...day,
      entries: ['早上吃南瓜饼', '晚上背单词'],
      entryIds,
      imageGroups: [{ entryId: entryIds[0]!, attachmentIds: [image.id] }],
    }
    const wrapper = mountMixed('read', mappedDay, [image])
    await nextTick()
    const rows = document.body.querySelectorAll('[data-testid="diary-bullet-reader"] li')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelector('[data-testid="diary-attachment-gallery"]')).not.toBeNull()
    expect(rows[1]?.querySelector('[data-testid="diary-attachment-gallery"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="diary-attachments"] .diary-attachment-name')).toBeNull()
    wrapper.unmount()
  })

  it('places legacy and unassigned images at the end and supports photo-only days', async () => {
    const legacyDay: DiaryDay = { ...day, entries: ['旧日记'] }
    const wrapper = mountMixed('read', legacyDay, [image])
    await nextTick()
    const stream = document.body.querySelector('[data-testid="diary-attachments"]')!
    expect(stream.querySelector('[data-testid="diary-bullet-reader"] li [data-testid="diary-attachment-gallery"]')).toBeNull()
    expect(stream.querySelector(':scope > [data-testid="diary-attachment-gallery"]')).not.toBeNull()
    wrapper.unmount()

    const photoDay: DiaryDay = { ...day, entries: [] }
    const photoOnly = mountMixed('read', photoDay, [image])
    await nextTick()
    expect(document.body.querySelector('[data-testid="diary-empty-reading"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="预览 breakfast.png"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="diary-bullet-editor"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="diary-add-attachment"]')).toBeNull()
    photoOnly.unmount()
  })

  it('keeps exactly one general attachment entry at the end for every attachment mix', async () => {
    const entryId = '08a5c822-0d61-4e6c-a62c-1931a4da0771'
    const manyImages = Array.from({ length: 10 }, (_, index): DiaryAttachment => ({
      ...image,
      id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `photo-${index + 1}.png`,
      order: index,
    }))
    const cases: Array<{ label: string; currentDay: DiaryDay; attachments: DiaryAttachment[] }> = [
      { label: 'empty', currentDay: day, attachments: [] },
      { label: 'images', currentDay: day, attachments: [image] },
      { label: 'PDF', currentDay: day, attachments: [pdf] },
      { label: 'mixed', currentDay: day, attachments: [image, pdf] },
      {
        label: 'multiple end groups',
        currentDay: {
          ...day,
          entryIds: [entryId],
          imageGroups: [
            { entryId: null, attachmentIds: manyImages.slice(0, 9).map(item => item.id) },
            { entryId: null, attachmentIds: manyImages.slice(9).map(item => item.id) },
          ],
        },
        attachments: manyImages,
      },
    ]

    for (const scenario of cases) {
      const wrapper = mountMixed('edit', scenario.currentDay, scenario.attachments)
      await nextTick()
      const addButtons = document.body.querySelectorAll('[data-testid="diary-add-attachment"]')
      expect(addButtons, scenario.label).toHaveLength(1)
      const generalSection = addButtons[0]?.closest('section')
      expect(generalSection?.getAttribute('data-testid')).toBe('diary-attachment-gallery')
      expect(generalSection?.querySelectorAll('[data-testid="diary-attachment-input"]'), scenario.label).toHaveLength(1)
      expect(document.body.querySelectorAll('[data-testid="diary-add-entry-image"]'), scenario.label)
        .toHaveLength(scenario.currentDay.entryIds ? 1 : 0)

      if (scenario.label === 'mixed') {
        const accept = document.body.querySelector<HTMLInputElement>('[data-testid="diary-attachment-input"]')?.accept ?? ''
        expect(accept).toContain('image/png')
        expect(accept).toContain('application/pdf')
      }

      if (scenario.label === 'multiple end groups') {
        await wrapper.setProps({ attachmentBusy: true, attachmentError: '上传失败' })
        expect(document.body.querySelectorAll('[role="status"]')).toHaveLength(1)
        expect(document.body.querySelectorAll('[role="alert"]')).toHaveLength(1)
      }
      wrapper.unmount()
      document.body.replaceChildren()
    }
  })

  it('keeps per-entry image upload separate and hides all upload controls in reading mode', async () => {
    const entryId = '08a5c822-0d61-4e6c-a62c-1931a4da0771'
    const entryDay: DiaryDay = { ...day, entryIds: [entryId] }
    const editor = mountMixed('edit', entryDay, [])
    await nextTick()
    expect(document.body.querySelectorAll('[data-testid="diary-add-entry-image"]')).toHaveLength(1)
    expect(document.body.querySelectorAll('[data-testid="diary-add-attachment"]')).toHaveLength(1)
    expect(document.body.querySelectorAll('[data-testid="diary-attachment-input"]')).toHaveLength(2)
    editor.unmount()
    document.body.replaceChildren()

    const reader = mountMixed('read', entryDay, [image, pdf])
    await nextTick()
    expect(document.body.querySelector('[data-testid="diary-add-entry-image"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="diary-add-attachment"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="diary-attachment-input"]')).toBeNull()
    reader.unmount()
  })

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
        attachments: [],
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
        attachments: [],
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
