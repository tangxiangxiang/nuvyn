// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, beforeEach } from 'vitest'
import OpenWorkspaceDocuments from '../OpenWorkspaceDocuments.vue'
import type { WorkspaceTab } from '../tabs'
import { deriveDocumentSavePresentation } from '../../../composables/vault/editor-tabs/savePresentation'
import { useI18n } from '../../../composables/useI18n'

function documentTab(id: string, mode: 'preview' | 'pinned' = 'pinned'): WorkspaceTab {
  return {
    id,
    label: id,
    title: id.split('/').at(-1) ?? id,
    kind: 'document',
    mode,
    documentPath: id,
    save: deriveDocumentSavePresentation(null),
  }
}

describe('OpenWorkspaceDocuments', () => {
  beforeEach(() => useI18n().setLocale('zh'))

  it('starts collapsed, shows the current count and presents Preview/Pin documents', async () => {
    const preview = documentTab('inbox/preview.md', 'preview')
    const pinned = documentTab('inbox/pinned.md')
    const wrapper = mount(OpenWorkspaceDocuments, {
      props: { tabs: [preview, pinned], activeId: preview.id },
    })

    const toggle = wrapper.get('[data-testid="open-workspace-documents"] > button')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.text()).toContain('2')
    expect(wrapper.find('.open-workspace-documents-list').exists()).toBe(false)

    await toggle.trigger('click')
    expect(wrapper.findAll('.open-workspace-document')).toHaveLength(2)
    expect(wrapper.get(`[data-workspace-document-id="${preview.id}"]`).classes()).toContain('active')
    expect(wrapper.get(`[data-workspace-document-id="${preview.id}"] .open-workspace-document-type`).text()).toBe('临时预览')
    expect(wrapper.get(`[data-workspace-document-id="${pinned.id}"] .open-workspace-document-type`).text()).toBe('已固定')
    expect(wrapper.get(`[data-workspace-document-id="${preview.id}"]`).find('.open-workspace-document-action').attributes('aria-label')).toBe('固定 preview')
    expect(wrapper.get(`[data-workspace-document-id="${pinned.id}"]`).find('.open-workspace-document-action').attributes('aria-label')).toBe('关闭 pinned')
    wrapper.unmount()
  })

  it('keeps Diff and Recovery reachable and emits existing workspace actions', async () => {
    const diff: WorkspaceTab = {
      id: 'diff:inbox/a', label: 'A (Changes)', title: 'A', kind: 'diff',
      save: deriveDocumentSavePresentation(null), documentPath: 'inbox/a',
    }
    const recovery: WorkspaceTab = {
      id: 'recovery:a', label: 'Recovered A', title: 'Recovered A', kind: 'recovery',
      save: deriveDocumentSavePresentation(null), documentPath: 'inbox/a',
    }
    const preview = documentTab('inbox/preview', 'preview')
    const wrapper = mount(OpenWorkspaceDocuments, {
      props: { tabs: [diff, recovery, preview], activeId: diff.id },
    })
    await wrapper.get('.open-workspace-documents-toggle').trigger('click')

    expect(wrapper.get(`[data-workspace-document-id="${diff.id}"] .open-workspace-document-type`).text()).toBe('差异')
    expect(wrapper.get(`[data-workspace-document-id="${recovery.id}"] .open-workspace-document-type`).text()).toBe('恢复')
    await wrapper.get(`[data-workspace-document-id="${preview.id}"] .open-workspace-document-select`).trigger('click')
    await wrapper.get(`[data-workspace-document-id="${preview.id}"] button[aria-label="固定 preview"]`).trigger('click')
    await wrapper.get(`[data-workspace-document-id="${recovery.id}"] button[aria-label="关闭 Recovered A"]`).trigger('click')

    expect(wrapper.emitted('select')).toEqual([[preview.id]])
    expect(wrapper.emitted('pin')).toEqual([[preview.id]])
    expect(wrapper.emitted('close')).toEqual([[recovery.id]])
    wrapper.unmount()
  })
})
