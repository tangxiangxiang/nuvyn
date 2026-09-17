// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { flushPromises } from "@vue/test-utils"
import FileTree from '../FileTree.vue'
import type { TreeNode } from '../../../lib/api'
import { installDialogMocks } from '../../../__test-helpers__/dialogs'
import { useScopeFilter } from '../../../composables/vault/useScopeFilter'

installDialogMocks()

const TREE: TreeNode[] = [
  {
    kind: 'folder', name: 'content', path: '', children: [
      {
        kind: 'folder', name: 'inbox', path: 'inbox', children: [
          { kind: 'file', name: 'hello', path: 'inbox/hello', title: 'Hello', mtime: 0 },
        ],
      },
      {
        kind: 'folder', name: 'literature', path: 'literature', children: [
          { kind: 'file', name: 'ahrens', path: 'literature/ahrens', title: 'Ahrens 2017', mtime: 0 },
        ],
      },
      {
        kind: 'folder', name: 'archive', path: 'archive', children: [
          { kind: 'file', name: 'permanent', path: 'archive/permanent', title: 'Permanent', mtime: 0 },
          {
            kind: 'folder', name: 'organized', path: 'archive/organized', children: [
              { kind: 'file', name: 'nested', path: 'archive/organized/nested', title: 'Nested', mtime: 0 },
            ],
          },
          // A user-defined folder that is not one of the three protected
          // roots. Its file must not receive the archive-note action.
          {
            kind: 'folder', name: 'projects', path: 'archive/projects', children: [
              { kind: 'file', name: 'old', path: 'archive/projects/old', title: 'Old', mtime: 0 },
            ],
          },
        ],
      },
    ],
  },
]

const DIARY_TREE: TreeNode[] = [
  {
    kind: 'folder', name: 'content', path: '', children: [
      {
        kind: 'folder', name: 'diary', path: 'diary', children: [
          { kind: 'file', name: '2026-08-24', path: 'diary/2026-08-24', title: 'Diary', mtime: 0 },
          { kind: 'file', name: 'legacy', path: 'diary/legacy', title: 'Legacy external file', mtime: 0 },
        ],
      },
    ],
  },
]

describe('FileTree context menu', () => {
  beforeEach(() => {
    localStorage.clear()
    // Context-menu coverage exercises the unfiltered tree, including a
    // user-defined top-level folder outside the default note scope.
    useScopeFilter().activeScope.value = 'note'
    // The context menu is teleported to <body>, so it survives
    // w.unmount() and would leak into the next case's
    // document.querySelector('.tree-context-menu'). Wipe any leftover
    // menu before each case so the assertion always reads the menu the
    // current right-click produced, not the one from a prior case.
    document.querySelectorAll('.tree-context-menu').forEach((el) => el.remove())
  })

  it('right-click on inbox (protected root) shows a menu', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const inboxRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'inbox')!
    expect(inboxRow.exists()).toBe(true)

    await inboxRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()

    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    w.unmount()
  })

  it('right-click on a file inside inbox shows file actions without properties', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const inboxRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'inbox')!
    await inboxRow.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    const helloRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'hello')!
    expect(helloRow.exists()).toBe(true)

    await helloRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()

    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toContain('重命名')
    expect(menu!.textContent).toContain('查看文件历史')
    expect(menu!.textContent).toContain('导出 PDF')
    expect(menu!.textContent).not.toContain('文档属性')
    expect(menu!.textContent).toContain('删除')
    const exportPdf = Array.from(menu!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('导出 PDF')) as HTMLButtonElement
    exportPdf.click()
    await flushPromises()
    expect(w.emitted('export-pdf')).toEqual([['inbox/hello']])

    await helloRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()
    const reopenedMenu = document.querySelector('.tree-context-menu')!
    const history = Array.from(reopenedMenu.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('查看文件历史')) as HTMLButtonElement
    history.click()
    await flushPromises()
    expect(w.emitted('open-history')).toEqual([['inbox/hello']])

    w.unmount()
  })

  // Permission-split regression: protected roots (inbox / literature) keep
  // their names but their *children* are still user content. The original
  // menu gated everything on a single "readonly" boolean, so right-clicking
  // inbox/literature offered no way to add a child. These cases pin the
  // matrix: protected root → create-in, archive folder → full CRUD menu,
  // ordinary file → full menu.
  it('right-click on a protected root (inbox) shows create-in buttons but no rename/delete', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const inboxRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'inbox')!

    await inboxRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()

    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    // Create-in is now exposed on protected roots.
    expect(menu!.textContent).toContain('新建文件')
    expect(menu!.textContent).toContain('新建文件夹')
    // Name-modifying ops remain blocked — the folder name is pinned.
    expect(menu!.textContent).not.toContain('重命名')
    expect(menu!.textContent).not.toContain('删除')
    expect(menu!.textContent).not.toContain('查看文件历史')
    w.unmount()
  })

  it('closes the file context menu with Escape', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    const inboxRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'inbox')!
    await inboxRow.find('.chevron').trigger('click')
    const helloRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'hello')!
    await helloRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    expect(document.querySelector('.tree-context-menu')).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.querySelector('.tree-context-menu')).toBeNull()
    w.unmount()
  })

  it('right-click on archive shows both direct creation actions but no root rename/delete', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const archiveRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'archive')!

    await archiveRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()

    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    // Trim because each menu button inlines an icon SVG whose markup
    // contributes whitespace to textContent. Substring equality keeps
    // the test focused on the label rather than the SVG formatting.
    const labels = Array.from(menu!.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim())
    expect(labels).toContain('新建文件')
    expect(labels).toContain('新建文件夹')
    expect(labels).not.toContain('重命名')
    expect(labels).not.toContain('删除')
    w.unmount()
  })

  it('archive child file has ordinary rename/delete actions', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const archiveRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'archive')!
    await archiveRow.find('.chevron').trigger('click')
    await w.vm.$nextTick()
    const fileRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'permanent')!
    await fileRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()
    const menu = document.querySelector('.tree-context-menu')!
    expect(menu.textContent).toContain('重命名')
    expect(menu.textContent).toContain('删除')
    w.unmount()
  })

  it('archive child folder has ordinary CRUD actions', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const archiveRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'archive')!
    await archiveRow.find('.chevron').trigger('click')
    await w.vm.$nextTick()
    const folderRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'organized')!
    await folderRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()
    const menu = document.querySelector('.tree-context-menu')!
    expect(menu.textContent).toContain('新建文件')
    expect(menu.textContent).toContain('新建文件夹')
    expect(menu.textContent).toContain('重命名')
    expect(menu.textContent).toContain('删除')
    w.unmount()
  })

  it('protected root row is not draggable', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const inboxRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'inbox')!
    // A protected root cannot be re-parented, so the attribute is false.
    expect(inboxRow.attributes('draggable')).toBe('false')
    w.unmount()
  })

  it('archive child files are draggable but archive child folders are not', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    const archiveRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'archive')!
    await archiveRow.find('.chevron').trigger('click')
    await w.vm.$nextTick()

    const permanentRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'permanent')!
    expect(permanentRow.attributes('draggable')).toBe('true')
    const organizedRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === 'organized')!
    expect(organizedRow.attributes('draggable')).toBe('false')
    w.unmount()
  })
})

describe('FileTree context menu — Diary presentation guards', () => {
  beforeEach(() => {
    localStorage.clear()
    useScopeFilter().activeScope.value = 'diary'
    document.querySelectorAll('.tree-context-menu').forEach((el) => el.remove())
  })

  it('hides generic create actions at the Diary root', async () => {
    const w = mount(FileTree, { props: { tree: DIARY_TREE, currentPath: null }, attachTo: document.body })
    const diaryRow = w.findAll('li.tree-row').find((row: any) => row.find('.row-name')?.text() === 'diary')!
    await diaryRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()

    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).not.toContain('新建文件')
    expect(menu!.textContent).not.toContain('新建文件夹')
    expect(menu!.textContent).not.toContain('重命名')
    expect(menu!.textContent).not.toContain('删除')
    w.unmount()
  })

  it('hides managed Diary rename/history/move while retaining export and delete', async () => {
    const w = mount(FileTree, { props: { tree: DIARY_TREE, currentPath: null }, attachTo: document.body })
    const diaryRow = w.findAll('li.tree-row').find((row: any) => row.find('.row-name')?.text() === 'diary')!
    await diaryRow.find('.chevron').trigger('click')
    await w.vm.$nextTick()
    const managedRow = w.findAll('li.tree-row').find((row: any) => row.find('.row-name')?.text() === '2026-08-24')!
    await managedRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()

    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).not.toContain('重命名')
    expect(menu!.textContent).not.toContain('查看文件历史')
    expect(menu!.textContent).toContain('导出 PDF')
    expect(menu!.textContent).toContain('删除')
    expect(managedRow.attributes('draggable')).toBe('false')
    w.unmount()
  })

  it('keeps file history visible for an unmanaged diary file', async () => {
    const w = mount(FileTree, { props: { tree: DIARY_TREE, currentPath: null }, attachTo: document.body })
    const diaryRow = w.findAll('li.tree-row').find((row: any) => row.find('.row-name')?.text() === 'diary')!
    await diaryRow.find('.chevron').trigger('click')
    await w.vm.$nextTick()
    const legacyRow = w.findAll('li.tree-row').find((row: any) => row.find('.row-name')?.text() === 'legacy')!
    await legacyRow.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()

    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toContain('查看文件历史')
    w.unmount()
  })
})

// Archive action visibility. The action promotes a file directly from
// inbox/ or literature/ into archive/ — distinct from ordinary drag-and-drop
// moves. The menu button is gated
// by canArchive which restricts the action to source paths in those
// two roots, so these cases pin that matrix.
describe('FileTree context menu — archive-note visibility', () => {
  beforeEach(() => {
    localStorage.clear()
    useScopeFilter().activeScope.value = 'note'
    document.querySelectorAll('.tree-context-menu').forEach((el) => el.remove())
  })

  async function rightClickRow(label: string) {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await w.vm.$nextTick()
    // Expand the parent folders (inbox / literature / archive / projects)
    // so their file rows render. The expansion click is on the chevron.
    for (const parent of ['inbox', 'literature', 'archive', 'projects']) {
      const parentRow = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === parent)
      if (parentRow?.find('.chevron').exists()) {
        await parentRow.find('.chevron').trigger('click')
        await w.vm.$nextTick()
      }
    }
    const row = w.findAll('li.tree-row').find((r: any) => r.find('.row-name')?.text() === label)!
    expect(row.exists()).toBe(true)
    await row.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await w.vm.$nextTick()
    await flushPromises()
    return w
  }

  it('shows 归档 for a file under inbox/', async () => {
    const w = await rightClickRow('hello')
    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toContain('归档')
    w.unmount()
  })

  it('shows 归档 for a file under literature/', async () => {
    const w = await rightClickRow('ahrens')
    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toContain('归档')
    w.unmount()
  })

  it('hides 归档 for a file inside archive/', async () => {
    const w = await rightClickRow('permanent')
    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).not.toContain('文档属性')
    expect(menu!.textContent).not.toContain('归档')
    w.unmount()
  })

  it('hides 归档 for a file under a user-defined folder (not inbox/literature)', async () => {
    const w = await rightClickRow('old')
    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).not.toContain('归档')
    w.unmount()
  })

  it('hides 归档 when right-clicking a folder row', async () => {
    const w = await rightClickRow('inbox')
    const menu = document.querySelector('.tree-context-menu')
    expect(menu).not.toBeNull()
    // Folders see create-in / rename / delete, never the archive action.
    expect(menu!.textContent).not.toContain('归档')
    w.unmount()
  })
})
