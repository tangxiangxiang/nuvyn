// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { flushPromises } from "@vue/test-utils"
import FileTree from '../FileTree.vue'
import type { TreeNode } from '../../../lib/api'
import * as api from '../../../lib/api'
import { installDialogMocks, makeDT, rowByLabel } from '../../../__test-helpers__/dialogs'

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
          { kind: 'file', name: 'markdown-syntax', path: 'inbox/markdown-syntax', title: 'Markdown Syntax', mtime: 0 },
        ],
      },
      { kind: 'folder', name: 'literature', path: 'literature', children: [] },
      { kind: 'folder', name: 'archive', path: 'archive', children: [] },
    ],
  },
]



describe('FileTree full drag flow (with bubbling)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('dragstart on a child file does NOT overwrite payload with the parent folder path', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    const mdRow = rowByLabel(w.findAll('li.tree-row'), 'markdown-syntax')
    const dt = makeDT()
    await mdRow.trigger('dragstart', { dataTransfer: dt })
    await w.vm.$nextTick()

    // The bug: dragstart bubbled to inbox and overwrote 'inbox/markdown-syntax'
    // with 'inbox', so onMove would think the user is trying to move the
    // protected folder. The fix: stopPropagation in onDragStart.
    expect(dt.getData('text/x-nuvyn-path')).toBe('inbox/markdown-syntax')
    w.unmount()
  })

  it('does not start a drag from a folder because folder re-parenting is unsupported', async () => {
    // Extend the tree with a sibling sub-folder to make the capability
    // boundary explicit without adding a folder move API.
    const TREE2: TreeNode[] = [
      {
        kind: 'folder', name: 'content', path: '', children: [
          {
            kind: 'folder', name: 'inbox', path: 'inbox', children: [
              {
                kind: 'folder', name: 'test', path: 'inbox/test', children: [],
              },
              {
                kind: 'folder', name: 'notes', path: 'inbox/notes', children: [],
              },
            ],
          },
          { kind: 'folder', name: 'literature', path: 'literature', children: [] },
          { kind: 'folder', name: 'archive', path: 'archive', children: [] },
        ],
      },
    ]
    const w = mount(FileTree, { props: { tree: TREE2, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    const testRow = rowByLabel(w.findAll('li.tree-row'), 'test')
    const dt = makeDT()
    await testRow.trigger('dragstart', { dataTransfer: dt })
    await w.vm.$nextTick()

    expect(dt.getData('text/x-nuvyn-path')).toBe('')
    w.unmount()
  })

  it('end-to-end: dragging markdown-syntax onto test results in the right PATCH', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/test/markdown-syntax', title: 'markdown-syntax',
      created: '', updated: '', tags: [], size: 0, mtime: 0,
    })
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    const mdRow = rowByLabel(w.findAll('li.tree-row'), 'markdown-syntax')
    const testRow = rowByLabel(w.findAll('li.tree-row'), 'test')

    const dt = makeDT()
    await mdRow.trigger('dragstart', { dataTransfer: dt })
    await w.vm.$nextTick()
    await testRow.trigger('dragenter', { dataTransfer: dt })
    await testRow.trigger('dragover', { dataTransfer: dt })
    await testRow.trigger('drop', { dataTransfer: dt })
    await mdRow.trigger('dragend', { dataTransfer: dt })
    await w.vm.$nextTick()
    await flushPromises()

    expect(patchSpy).toHaveBeenCalledWith('inbox/markdown-syntax', { targetPath: 'inbox/test/markdown-syntax' })
    w.unmount()
  })
})

