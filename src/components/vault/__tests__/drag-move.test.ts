// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { flushPromises } from "@vue/test-utils"
import { dialogStubs, installDialogMocks, makeDT, rowByLabel } from '../../../__test-helpers__/dialogs'
import { useScopeFilter } from '../../../composables/vault/useScopeFilter'
import FileTree from '../FileTree.vue'
import TreeRow from '../TreeRow.vue'
import type { TreeNode } from '../../../lib/api'
import * as api from '../../../lib/api'

installDialogMocks()

const TREE: TreeNode[] = [
  {
    kind: 'folder', name: 'content', path: '', children: [
      {
        kind: 'folder', name: 'inbox', path: 'inbox', children: [
          {
            kind: 'folder', name: 'test', path: 'inbox/test', children: [
              { kind: 'file', name: 'test1', path: 'inbox/test/test1', title: 'Test1', mtime: 0 },
            ],
          },
        ],
      },
      {
        kind: 'folder', name: 'literature', path: 'literature', children: [
          { kind: 'folder', name: 'reference', path: 'literature/reference', children: [] },
        ],
      },
      {
        kind: 'folder', name: 'archive', path: 'archive', children: [
          { kind: 'file', name: 'permanent', path: 'archive/permanent', title: 'Permanent', mtime: 0 },
          { kind: 'folder', name: 'concepts', path: 'archive/concepts', children: [] },
        ],
      },
      {
        kind: 'folder', name: 'diary', path: 'diary', children: [],
      },
    ],
  },
]



describe('FileTree drag-move (sub-documents)', () => {
  beforeEach(() => {
    localStorage.clear()
    useScopeFilter().activeScope.value = 'note'
    vi.restoreAllMocks()
    dialogStubs.toast.error.mockClear()
  })

  it('does not expose folder re-parent drag for ordinary or archive folders', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()

    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    const literature = rowByLabel(w.findAll('li.tree-row'), 'literature')
    const archive = rowByLabel(w.findAll('li.tree-row'), 'archive')
    await inbox.find('.chevron').trigger('click')
    await literature.find('.chevron').trigger('click')
    await archive.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    expect(rowByLabel(w.findAll('li.tree-row'), 'test', 'folder').attributes('draggable')).toBe('false')
    expect(rowByLabel(w.findAll('li.tree-row'), 'reference', 'folder').attributes('draggable')).toBe('false')
    expect(rowByLabel(w.findAll('li.tree-row'), 'concepts', 'folder').attributes('draggable')).toBe('false')
    expect(inbox.attributes('draggable')).toBe('false')
    expect(archive.attributes('draggable')).toBe('false')
    expect(rowByLabel(w.findAll('li.tree-row'), 'permanent', 'file').attributes('draggable')).toBe('true')
    w.unmount()
  })

  it('drops a sub-document onto its top-level inbox folder', async () => {
    // Simulate the round-trip so the move is observable without a server.
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/test1',
      title: 'test1',
      created: '',
      updated: '',
      tags: [],
      size: 0,
      mtime: 0,
    })

    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()

    // Expand inbox -> test so the file is in the DOM and its <li> is the drag source.
    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.find('.chevron').trigger('click')
    await w.vm.$nextTick()
    const testFolder = rowByLabel(w.findAll('li.tree-row'), 'test')
    await testFolder.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    // Fire a drop on the inbox row directly. This is what would happen if the
    // user dragged the file from inbox/test/ up to the inbox row in the tree.
    await inbox.trigger('drop', {
      dataTransfer: {
        getData: (k: string) => {
          if (k === 'text/x-nuvyn-path') return 'inbox/test/test1'
          if (k === 'text/x-nuvyn-kind') return 'file'
          return ''
        },
      },
    })
    await w.vm.$nextTick()
    await flushPromises()

    expect(patchSpy).toHaveBeenCalledWith('inbox/test/test1', { targetPath: 'inbox/test1' })
    w.unmount()
  })

  it('allows dropping a note directly onto the archive root', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/test1', title: 'test1', created: '', updated: '', tags: [], size: 0, mtime: 0,
    })
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()

    // Expand inbox -> test so the file is in the DOM.
    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.find('.chevron').trigger('click')
    await w.vm.$nextTick()
    const testFolder = rowByLabel(w.findAll('li.tree-row'), 'test')
    await testFolder.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    const archive = rowByLabel(w.findAll('li.tree-row'), 'archive')
    await archive.trigger('drop', {
      dataTransfer: {
        getData: (k: string) => {
          if (k === 'text/x-nuvyn-path') return 'inbox/test/test1'
          if (k === 'text/x-nuvyn-kind') return 'file'
          return ''
        },
      },
    })
    await w.vm.$nextTick()
    await flushPromises()

    expect(patchSpy).toHaveBeenCalledWith('inbox/test/test1', { targetPath: 'archive/test1' })
    w.unmount()
  })

  it('allows classifying an inbox note by dropping it onto a archive subfolder', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/concepts/test1', title: 'test1', created: '', updated: '', tags: [], size: 0, mtime: 0,
    })
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()

    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.find('.chevron').trigger('click')
    await w.vm.$nextTick()
    const testFolder = rowByLabel(w.findAll('li.tree-row'), 'test')
    await testFolder.find('.chevron').trigger('click')
    await w.vm.$nextTick()
    const archive = rowByLabel(w.findAll('li.tree-row'), 'archive')
    await archive.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    const concepts = rowByLabel(w.findAll('li.tree-row'), 'concepts')
    await concepts.trigger('drop', {
      dataTransfer: {
        getData: (k: string) => {
          if (k === 'text/x-nuvyn-path') return 'inbox/test/test1'
          if (k === 'text/x-nuvyn-kind') return 'file'
          return ''
        },
      },
    })
    await w.vm.$nextTick()
    await flushPromises()

    expect(patchSpy).toHaveBeenCalledWith('inbox/test/test1', { targetPath: 'archive/concepts/test1' })
    w.unmount()
  })

  it('allows moving an existing archive note into a archive subfolder', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/concepts/permanent', title: 'permanent', created: '', updated: '', tags: [], size: 0, mtime: 0,
    })
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()

    const archive = rowByLabel(w.findAll('li.tree-row'), 'archive')
    await archive.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    const concepts = rowByLabel(w.findAll('li.tree-row'), 'concepts')
    await concepts.trigger('drop', {
      dataTransfer: {
        getData: (k: string) => {
          if (k === 'text/x-nuvyn-path') return 'archive/permanent'
          if (k === 'text/x-nuvyn-kind') return 'file'
          return ''
        },
      },
    })
    await w.vm.$nextTick()
    await flushPromises()

    expect(patchSpy).toHaveBeenCalledWith('archive/permanent', { targetPath: 'archive/concepts/permanent' })
    w.unmount()
  })

  it('allows moving an archive note out to inbox', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/permanent', title: 'permanent', created: '', updated: '', tags: [], size: 0, mtime: 0,
    })
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()

    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.trigger('drop', {
      dataTransfer: {
        getData: (k: string) => {
          if (k === 'text/x-nuvyn-path') return 'archive/permanent'
          if (k === 'text/x-nuvyn-kind') return 'file'
          return ''
        },
      },
    })
    await w.vm.$nextTick()
    await flushPromises()

    expect(patchSpy).toHaveBeenCalledWith('archive/permanent', { targetPath: 'inbox/permanent' })
    w.unmount()
  })

  it('blocks moves of a protected root itself (cannot re-parent inbox)', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'literature/inbox', title: 'inbox', created: '', updated: '', tags: [], size: 0, mtime: 0,
    })
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()

    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    const literature = rowByLabel(w.findAll('li.tree-row'), 'literature')

    // Try to drag the inbox row itself onto literature.
    await literature.trigger('drop', {
      dataTransfer: {
        getData: (k: string) => {
          if (k === 'text/x-nuvyn-path') return 'inbox'
          if (k === 'text/x-nuvyn-kind') return 'folder'
          return ''
        },
      },
    })
    await w.vm.$nextTick()
    await flushPromises()

    expect(patchSpy).not.toHaveBeenCalled()
    void inbox
    w.unmount()
  })

  it('blocks an ordinary file dropped onto the Diary root before calling the rename API', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'diary/test1', title: 'test1', created: '', updated: '', tags: [], size: 0, mtime: 0,
    })
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()

    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.find('.chevron').trigger('click')
    await w.vm.$nextTick()
    const testFolder = rowByLabel(w.findAll('li.tree-row'), 'test')
    await testFolder.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    // Diary is a separate exactly-one scope. Switch after preparing the
    // ordinary source path so the reserved Diary root becomes visible without
    // weakening the default note-scope contract.
    useScopeFilter().activeScope.value = 'diary'
    await w.vm.$nextTick()
    const diary = rowByLabel(w.findAll('li.tree-row'), 'diary')

    const dataTransfer = makeDT()
    dataTransfer.setData('text/x-nuvyn-path', 'inbox/test/test1')
    dataTransfer.setData('text/x-nuvyn-kind', 'file')
    await diary.trigger('dragenter', { dataTransfer })
    await diary.trigger('dragover', { dataTransfer })
    expect(diary.classes()).not.toContain('drop-target')
    expect((dataTransfer as { dropEffect: string }).dropEffect).toBe('none')
    await diary.trigger('drop', { dataTransfer })
    await w.vm.$nextTick()
    await flushPromises()

    expect(patchSpy).not.toHaveBeenCalled()
    const diaryComponent = w.findAllComponents(TreeRow)
      .find((component) => component.attributes('data-tree-path') === 'diary')
    expect(diaryComponent).toBeDefined()
    diaryComponent!.vm.$emit('move', 'inbox/test/test1', 'diary', 'file')
    await flushPromises()
    expect(patchSpy).not.toHaveBeenCalled()
    expect(dialogStubs.toast.error).toHaveBeenCalledWith('普通文件不能移动到 Diary 目录；Diary 只能通过日期命令创建。')
    w.unmount()
  })

  it('blocks a root drop whose filename would become the Diary root', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost')
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()

    await w.find('.file-tree').trigger('drop', {
      dataTransfer: {
        getData: (key: string) => key === 'text/x-nuvyn-path' ? 'inbox/diary' : 'file',
      },
    })
    await w.vm.$nextTick()
    await flushPromises()

    expect(patchSpy).not.toHaveBeenCalled()
    w.unmount()
  })
})
