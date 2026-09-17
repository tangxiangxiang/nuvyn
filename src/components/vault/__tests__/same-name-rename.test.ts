// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { flushPromises } from "@vue/test-utils"
import { dialogStubs, installDialogMocks, resetDialogMocks, rowByLabel } from '../../../__test-helpers__/dialogs'
import FileTree from '../FileTree.vue'
import type { TreeNode } from '../../../lib/api'
import * as api from '../../../lib/api'

installDialogMocks()

// buildTree sorts folders-first then files, so when a file and a folder
// share a name in the same parent (e.g. `notes.md` and `notes/` both
// under `inbox/`), they appear in the tree as:
//
//   inbox.children = [
//     { kind: 'folder', name: 'notes', path: 'inbox/notes', children: [...] },
//     { kind: 'file',   name: 'notes', path: 'inbox/notes', title: '...', mtime: 0 },
//   ]
//
// Both nodes have the SAME path string. The previous path-only findNode
// would always return the folder (which appears first), so renaming the
// file would silently rename the folder instead. The fix threads `kind`
// through the rename emit and into findNode.
const TREE: TreeNode[] = [
  {
    kind: 'folder', name: 'content', path: '', children: [
      {
        kind: 'folder', name: 'inbox', path: 'inbox', children: [
          {
            kind: 'folder', name: 'notes', path: 'inbox/notes', children: [
              { kind: 'file', name: 'old', path: 'inbox/notes/old', title: 'Old', mtime: 0 },
            ],
          },
          { kind: 'file', name: 'notes', path: 'inbox/notes', title: 'Notes', mtime: 0 },
        ],
      },
      { kind: 'folder', name: 'literature', path: 'literature', children: [] },
      { kind: 'folder', name: 'archive', path: 'archive', children: [] },
    ],
  },
]

async function startRenameOn(row: any) {
  await row.trigger('contextmenu', { clientX: 10, clientY: 10 })
  await (row as any).vm?.$nextTick?.()
  // The context menu renders a "重命名" button. Pick the first one (files
  // and folders both expose the same button when not readonly).
  const btn = [...document.querySelectorAll<HTMLButtonElement>('.tree-context-menu button')]
    .find((b) => b.textContent?.includes('重命名'))
  expect(btn).toBeDefined()
  btn!.click()
  await flushPromises()
}

describe('FileTree rename collision (file and folder share a path)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetDialogMocks()
    vi.restoreAllMocks()
  })

  it('renaming the FILE calls patchPost, not renameFolder (does not rename the sibling folder)', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/notes-v2', title: 'notes-v2',
      created: '', updated: '', tags: [], size: 0, mtime: 0,
    })
    const renameFolderSpy = vi.spyOn(api, 'renameFolder')

    const w = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    await w.vm.$nextTick()

    // Expand inbox so the two `notes` rows are both in the DOM.
    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    // Pick the FILE row, not the folder. With same labels, the file row is
    // the *second* matching row (folder comes first after buildTree's
    // folders-first sort), but the helper accepts a `kind` filter so
    // we can target it unambiguously.
    const fileRow = rowByLabel(w.findAll('li.tree-row'), 'notes', 'file')
    expect(fileRow.exists()).toBe(true)
    expect(fileRow.classes('folder')).toBe(false)

    dialogStubs.prompt.mockResolvedValueOnce('notes-v2')
    await startRenameOn(fileRow)
    await flushPromises()

    // The bug: findNode returned the folder (first match in the
    // folders-first-sorted tree), so onRename routed to renameFolder and
    // the file's rename was lost. After the fix, the kind travels with
    // the emit and findNode resolves the file correctly.
    expect(renameFolderSpy).not.toHaveBeenCalled()
    expect(patchSpy).toHaveBeenCalledWith('inbox/notes', { name: 'notes-v2' })
  })

  it('renaming the FOLDER still calls renameFolder (kind filter must not break the folder path)', async () => {
    const renameFolderSpy = vi.spyOn(api, 'renameFolder').mockResolvedValue({
      path: 'inbox/notes-v2', moved: ['inbox/notes/old'],
    })
    const patchSpy = vi.spyOn(api, 'patchPost')

    const w = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    await w.vm.$nextTick()

    const inbox = rowByLabel(w.findAll('li.tree-row'), 'inbox')
    await inbox.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    // Pick the FOLDER row this time.
    const folderRow = rowByLabel(w.findAll('li.tree-row'), 'notes', 'folder')
    expect(folderRow.exists()).toBe(true)
    expect(folderRow.classes('folder')).toBe(true)

    dialogStubs.prompt.mockResolvedValueOnce('notes-v2')
    await startRenameOn(folderRow)
    await flushPromises()

    expect(patchSpy).not.toHaveBeenCalled()
    expect(renameFolderSpy).toHaveBeenCalledWith('inbox/notes', 'inbox/notes-v2')
  })
})
