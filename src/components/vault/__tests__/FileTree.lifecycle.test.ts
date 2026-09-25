// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import FileTree from '../FileTree.vue'
import PromptHost from '../../PromptHost.vue'
import type { PostSummary, TreeNode } from '../../../lib/api'
import * as api from '../../../lib/api'
import * as aiApi from '../../../lib/ai-api'
import { flushPromises } from '@vue/test-utils'
import { installDialogMocks, resetDialogMocks } from '../../../__test-helpers__/dialogs'
import { useI18n } from '../../../composables/useI18n'
import { useScopeFilter } from '../../../composables/vault/useScopeFilter'
import { VaultContextKey } from '../../../composables/vault/context/vaultContext'
import { createVaultFileChanges } from '../../../composables/vault/context/fileChanges'

installDialogMocks()

const TREE: TreeNode[] = [{
  kind: 'folder', name: 'content', path: '', children: [
    {
      kind: 'folder', name: 'inbox', path: 'inbox', children: [
        {
          kind: 'folder', name: 'projects', path: 'inbox/projects', children: [
            { kind: 'file', name: 'child', path: 'inbox/projects/child', title: 'Child', mtime: 0 },
          ],
        },
        { kind: 'file', name: 'other', path: 'inbox/other', title: 'Other', mtime: 0 },
        { kind: 'file', name: 'to-archive', path: 'inbox/to-archive', title: 'To archive', mtime: 0 },
      ],
    },
    {
      kind: 'folder', name: 'archive', path: 'archive', children: [],
    },
    { kind: 'folder', name: 'literature', path: 'literature', children: [] },
  ],
}]

const RENAMED_TREE: TreeNode[] = [{
  kind: 'folder', name: 'content', path: '', children: [
    {
      kind: 'folder', name: 'inbox', path: 'inbox', children: [
        {
          kind: 'folder', name: 'renamed', path: 'inbox/renamed', children: [
            { kind: 'file', name: 'child', path: 'inbox/renamed/child', title: 'Child', mtime: 0 },
          ],
        },
        { kind: 'file', name: 'other', path: 'inbox/other', title: 'Other', mtime: 0 },
        { kind: 'file', name: 'to-archive', path: 'inbox/to-archive', title: 'To archive', mtime: 0 },
      ],
    },
    { kind: 'folder', name: 'archive', path: 'archive', children: [] },
    { kind: 'folder', name: 'literature', path: 'literature', children: [] },
  ],
}]

const ARCHIVED_TREE: TreeNode[] = [{
  kind: 'folder', name: 'content', path: '', children: [
    {
      kind: 'folder', name: 'inbox', path: 'inbox', children: [
        {
          kind: 'folder', name: 'projects', path: 'inbox/projects', children: [
            { kind: 'file', name: 'child', path: 'inbox/projects/child', title: 'Child', mtime: 0 },
          ],
        },
        { kind: 'file', name: 'other', path: 'inbox/other', title: 'Other', mtime: 0 },
      ],
    },
    {
      kind: 'folder', name: 'archive', path: 'archive', children: [
        { kind: 'file', name: 'to-archive', path: 'archive/to-archive', title: 'To archive', mtime: 0 },
      ],
    },
    { kind: 'folder', name: 'literature', path: 'literature', children: [] },
  ],
}]

const CREATED_POST: PostSummary = {
  path: 'inbox/final-title',
  title: 'final-title',
  created: '',
  updated: '',
  tags: [],
  size: 0,
  mtime: 0,
}

beforeEach(() => {
  localStorage.clear()
  useScopeFilter().activeScope.value = 'note'
  useI18n().setLocale('zh')
  resetDialogMocks()
})

describe('FileTree lifecycle presentation', () => {
  it('preserves nested expansion and focused identity when a folder is renamed', async () => {
    vi.spyOn(api, 'getRenameImpact').mockResolvedValue({ path: 'inbox/projects', count: 0, sources: [] })
    let wrapper: any
    const renameFolder = vi.fn(async () => {
      await wrapper.setProps({ tree: RENAMED_TREE })
      return { path: 'inbox/renamed', moved: ['inbox/renamed/child'] }
    })
    wrapper = mount(FileTree, {
      props: { tree: TREE, currentPath: null },
      global: {
        provide: {
          [VaultContextKey as symbol]: {
            lifecycle: { renameFolder },
            fileChanges: createVaultFileChanges(),
          },
        },
      },
    })

    const inbox = wrapper.find('[data-tree-key="folder:inbox"]')
    await inbox.find('.chevron').trigger('click')
    const projects = wrapper.find('[data-tree-key="folder:inbox/projects"]')
    await projects.find('.chevron').trigger('click')
    await projects.trigger('focus')

    await (wrapper.vm as any).onRename('inbox/projects', 'renamed', 'folder')

    expect(renameFolder).toHaveBeenCalledWith(
      'inbox/projects',
      'inbox/renamed',
      ['inbox/projects/child'],
      false,
      [],
    )
    expect(wrapper.find('[data-tree-key="folder:inbox/renamed"]').exists()).toBe(true)
    expect(wrapper.find('[data-tree-key="file:inbox/renamed/child"]').exists()).toBe(true)
    expect(JSON.parse(localStorage.getItem('nuvyn.vault.expandedPaths') ?? '[]'))
      .toEqual(expect.arrayContaining(['inbox', 'inbox/renamed']))
    expect(JSON.parse(localStorage.getItem('nuvyn.vault.expandedPaths') ?? '[]'))
      .not.toContain('inbox/projects')
    expect(wrapper.find('[data-tree-key="folder:inbox/renamed"]').attributes('tabindex')).toBe('0')
    wrapper.unmount()
  })

  it('reveals an archived non-current note without changing the current selection', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn()
    let wrapper: any
    const renameFile = vi.fn(async () => {
      await wrapper.setProps({ tree: ARCHIVED_TREE })
      return { path: 'archive/to-archive', title: 'To archive' } as PostSummary
    })
    wrapper = mount(FileTree, {
      props: { tree: TREE, currentPath: 'inbox/other' },
      global: {
        provide: {
          [VaultContextKey as symbol]: {
            lifecycle: { renameFile },
            fileChanges: createVaultFileChanges(),
          },
        },
      },
    })

    await (wrapper.vm as any).onArchiveNote('inbox/to-archive')
    await nextTick()

    expect(renameFile).toHaveBeenCalledWith('inbox/to-archive', { targetPath: 'archive/to-archive' })
    expect(wrapper.find('[data-tree-key="file:archive/to-archive"]').exists()).toBe(true)
    expect(wrapper.find('[data-tree-key="file:inbox/other"]').classes()).toContain('active')
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(JSON.parse(localStorage.getItem('nuvyn.vault.expandedPaths') ?? '[]'))
      .toContain('archive')
    wrapper.unmount()
  })

  it('uses the edited slug as the title after a translated slug is changed', async () => {
    vi.spyOn(aiApi, 'suggestSlug').mockResolvedValue({ slug: 'generated-title' })
    const createPost = vi.spyOn(api, 'createPost').mockResolvedValue(CREATED_POST)
    const wrapper = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    const promptHost = mount(PromptHost, { attachTo: document.body })
    const pending = (wrapper.vm as any).onCreateIn('inbox', 'file')
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] input')).not.toBeNull())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const input = dialog.querySelector('input')!
    input.value = '原始标题'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const transformButton = dialog.querySelector<HTMLButtonElement>('button[aria-label]')!
    transformButton.click()
    await vi.waitFor(() => expect(input.value).toBe('generated-title'))
    await vi.waitFor(() => expect(transformButton.disabled).toBe(false))
    input.value = 'final-title'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.includes('确定'))!.click()
    await pending

    expect(createPost).toHaveBeenCalledWith({ path: 'inbox/final-title', title: 'final-title' })
    expect(wrapper.emitted('select')).toBeUndefined()
    promptHost.unmount()
    wrapper.unmount()
  })

  it('keeps the source title when the generated slug is accepted unchanged', async () => {
    vi.spyOn(aiApi, 'suggestSlug').mockResolvedValue({ slug: 'generated-title' })
    const createPost = vi.spyOn(api, 'createPost').mockResolvedValue(CREATED_POST)
    const wrapper = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    const promptHost = mount(PromptHost, { attachTo: document.body })
    const pending = (wrapper.vm as any).onCreateIn('inbox', 'file')
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] input')).not.toBeNull())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const input = dialog.querySelector('input')!
    input.value = '原始标题'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const transformButton = dialog.querySelector<HTMLButtonElement>('button[aria-label]')!
    transformButton.click()
    await vi.waitFor(() => expect(input.value).toBe('generated-title'))
    await vi.waitFor(() => expect(transformButton.disabled).toBe(false))
    await flushPromises()
    Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.includes('确定'))!.click()

    await pending

    expect(createPost).toHaveBeenCalledWith({ path: 'inbox/generated-title', title: '原始标题' })
    promptHost.unmount()
    wrapper.unmount()
  })
})
