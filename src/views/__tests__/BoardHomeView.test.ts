// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NSelect } from 'naive-ui'
import BoardHomeView from '../BoardHomeView.vue'
import BoardGallery from '../../components/board/BoardGallery.vue'
import BoardFolderSection from '../../components/board/BoardFolderSection.vue'
import { boardMetadataSource } from '../../features/board/metadataSource'
import { boardFolderSource } from '../../features/board/folderSource'
import { makeDT } from '../../__test-helpers__/dialogs'
import type { BoardFolderSummary, BoardMetadata } from '../../../shared/boardProtocol'
import { useBoardFavorites } from '../../composables/useBoardFavorites'
import { useI18n } from '../../composables/useI18n'

const api = vi.hoisted(() => ({
  BoardApiError: class BoardApiError extends Error {
    uncertain: boolean
    constructor(message: string, uncertain = true) {
      super(message)
      this.uncertain = uncertain
    }
  },
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  listBoardFolders: vi.fn(),
  createBoardFolder: vi.fn(),
  renameBoardFolder: vi.fn(),
  deleteBoardFolder: vi.fn(),
  moveBoard: vi.fn(),
  renameBoard: vi.fn(),
  deleteBoard: vi.fn(),
  boardAssetUrl: vi.fn((assetId: string) => `/api/assets/${assetId}`),
}))

vi.mock('../../features/board/api', () => api)
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => true) }),
}))

function board(id: string, title: string, updatedAt = 1, lastOpenedAt: number | null = null): BoardMetadata {
  return { id, title, thumbnailAssetId: null, folderId: null, createdAt: updatedAt - 1, updatedAt, lastOpenedAt }
}

function folder(id: string, name: string, boardCount = 0): BoardFolderSummary {
  return { id, name, parentId: null, createdAt: 1, updatedAt: 1, boardCount }
}

async function mountHome(initialPath = '/board'): Promise<{ wrapper: VueWrapper; router: ReturnType<typeof createRouter> }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/board', name: 'board', component: BoardHomeView },
      { path: '/board/folder/:folderId', name: 'board-folder', component: BoardHomeView },
      { path: '/board/:boardId', name: 'board-editor', component: { template: '<div />' } },
    ],
  })
  await router.push(initialPath)
  await router.isReady()
  const wrapper = mount(BoardHomeView, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('Board Gallery Home', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
    useBoardFavorites().favoriteBoardIds.value = []
    vi.clearAllMocks()
    api.listBoardFolders.mockResolvedValue([])
    boardMetadataSource.invalidate()
    boardFolderSource.invalidate()
  })

  afterEach(() => {
    boardMetadataSource.invalidate()
    boardFolderSource.invalidate()
    useBoardFavorites().favoriteBoardIds.value = []
    useI18n().setLocale('zh')
    document.body.innerHTML = ''
  })

  it('loads metadata in the canvas grid and filters titles locally', async () => {
    api.listBoards.mockResolvedValue([
      board('older', 'Reading List', 10),
      board('newer', 'Project Atlas', 20),
    ])
    const { wrapper } = await mountHome()

    expect(api.listBoards).toHaveBeenCalledOnce()
    expect(wrapper.findAll('[data-testid="board-card-title"]').map((item) => item.text())).toEqual([
      'Project Atlas',
      'Reading List',
    ])

    await wrapper.find('.board-search-input input').setValue('atlas')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="board-card-title"]').map((item) => item.text())).toEqual([
      'Project Atlas',
    ])
    wrapper.unmount()
  })

  it('shows Board as the eyebrow and Idea canvas as the page title', async () => {
    api.listBoards.mockResolvedValue([])
    const { wrapper } = await mountHome()

    expect(wrapper.get('.board-home-eyebrow').text()).toBe('Board')
    expect(wrapper.get('.board-home-header h1').text()).toBe('Idea canvas')
    wrapper.unmount()
  })

  it('removes Quick Access and keeps the complete canvas grid as the only gallery', async () => {
    api.listBoards.mockResolvedValue([
      board('older', 'Reading List', 10),
      board('newer', 'Project Atlas', 30),
      board('middle', 'Sketch Notes', 20),
      board('fourth', 'Flow Map', 15),
      board('fifth', 'Product Plan', 12),
      board('sixth', 'Meeting Notes', 8),
    ])
    const { wrapper } = await mountHome()

    expect(wrapper.findAll('.board-all-section .board-card')).toHaveLength(5)
    expect(wrapper.find('.board-all-section .board-gallery').classes()).toContain('is-grid')
    expect(wrapper.find('.board-recent-section').exists()).toBe(false)
    expect(wrapper.find('[data-testid="board-quick-tab-recent"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="board-quick-tab-favorites"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="board-toolbar"]').exists()).toBe(true)
    expect(wrapper.find('.board-all-search').exists()).toBe(true)
    expect(wrapper.find('.board-filter').exists()).toBe(true)
    expect(wrapper.find('.board-sort-select').exists()).toBe(true)
    expect(wrapper.find('.board-folder-section').exists()).toBe(false)
    expect(wrapper.get('.board-canvas-section .board-subsection-label').text()).toBe('Canvases')
    wrapper.unmount()
  })

  it('filters the complete grid to favorite Boards and persists the existing favorite state', async () => {
    api.listBoards.mockResolvedValue([
      board('older', 'Reading List', 10),
      board('newer', 'Project Atlas', 30),
      board('middle', 'Sketch Notes', 20),
    ])
    const { wrapper, router } = await mountHome()

    await wrapper.get('.board-all-section .board-card-menu').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('board')
    const favoriteOption = Array.from(document.body.querySelectorAll<HTMLElement>('.n-dropdown-option'))
      .find((element) => element.textContent?.trim() === 'Add to favorites')
    favoriteOption?.querySelector<HTMLElement>('.n-dropdown-option-body')?.click()
    await flushPromises()

    await wrapper.get('[data-testid="board-filter-favorites"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('.board-home-eyebrow').text()).toBe('Board')
    expect(wrapper.find('.board-recent-section').exists()).toBe(false)
    expect(wrapper.get('[data-testid="board-filter-favorites"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('.board-all-section [data-testid="board-card-title"]').map((item) => item.text())).toEqual([
      'Project Atlas',
    ])
    expect(JSON.parse(localStorage.getItem('nuvyn.board.favorites') ?? '[]')).toEqual(['newer'])
    wrapper.unmount()
  })

  it('does not limit the favorite filter to the old Quick Access row', async () => {
    api.listBoards.mockResolvedValue([
      board('one', 'Board 1', 1),
      board('two', 'Board 2', 2),
      board('three', 'Board 3', 3),
      board('four', 'Board 4', 4),
      board('five', 'Board 5', 5),
      board('six', 'Board 6', 6),
    ])
    useBoardFavorites().favoriteBoardIds.value = ['one', 'two', 'three', 'four', 'five', 'six']
    const { wrapper } = await mountHome()

    await wrapper.get('[data-testid="board-filter-favorites"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.board-all-section [data-testid="board-card-title"]')).toHaveLength(5)
    const pageTwo = Array.from((wrapper.element as HTMLElement).querySelectorAll('.n-pagination-item--clickable'))
      .find((item) => item.textContent?.trim() === '2') as HTMLElement | undefined
    expect(pageTwo).toBeDefined()
    pageTwo?.click()
    await flushPromises()
    expect(wrapper.findAll('.board-all-section [data-testid="board-card-title"]').map((item) => item.text())).toEqual(['Board 1'])
    expect(wrapper.find('.board-recent-section').exists()).toBe(false)
    wrapper.unmount()
  })

  it('uses last opened time for the default Recent sort and supports Recently modified', async () => {
    api.listBoards.mockResolvedValue([
      board('recently-edited', 'Recently edited', 100, 10),
      board('recently-opened', 'Recently opened', 20, 90),
    ])
    const { wrapper } = await mountHome()

    expect(wrapper.findAll('.board-all-section [data-testid="board-card-title"]').map((item) => item.text())).toEqual([
      'Recently opened',
      'Recently edited',
    ])

    await wrapper.find('.board-sort-select').findComponent(NSelect).vm.$emit('update:value', 'updated')
    await flushPromises()

    expect(wrapper.findAll('.board-all-section [data-testid="board-card-title"]').map((item) => item.text())).toEqual([
      'Recently edited',
      'Recently opened',
    ])
    wrapper.unmount()
  })

  it('resets pagination after search and sort changes', async () => {
    api.listBoards.mockResolvedValue(Array.from({ length: 11 }, (_, index) => (
      board(`board-${index}`, `Board ${index}`, index + 1)
    )))
    const { wrapper } = await mountHome()

    const pageThree = Array.from((wrapper.element as HTMLElement).querySelectorAll('.n-pagination-item--clickable'))
      .find((item) => item.textContent?.trim() === '3') as HTMLElement | undefined
    expect(pageThree).toBeDefined()
    pageThree?.click()
    await flushPromises()
    expect(wrapper.find('.n-pagination-item--active').text()).toBe('3')

    await wrapper.find('.board-search-input input').setValue('Board 1')
    await flushPromises()
    expect(wrapper.find('.n-pagination-item--active').text()).toBe('1')

    await wrapper.find('.board-search-input input').setValue('')
    await flushPromises()
    const pageTwoAgain = Array.from((wrapper.element as HTMLElement).querySelectorAll('.n-pagination-item--clickable'))
      .find((item) => item.textContent?.trim() === '2') as HTMLElement | undefined
    pageTwoAgain?.click()
    await flushPromises()
    await wrapper.find('.board-sort-select').findComponent(NSelect).vm.$emit('update:value', 'name')
    await flushPromises()

    expect(wrapper.find('.n-pagination-item--active').text()).toBe('1')
    expect(wrapper.find('.board-all-section [data-testid="board-card-title"]').text()).toBe('Board 0')
    wrapper.unmount()
  })

  it('resets pagination after the favorite filter changes', async () => {
    api.listBoards.mockResolvedValue(Array.from({ length: 11 }, (_, index) => (
      board(`board-${index}`, `Board ${index}`, index + 1)
    )))
    useBoardFavorites().favoriteBoardIds.value = ['board-0']
    const { wrapper } = await mountHome()

    const pageTwo = Array.from((wrapper.element as HTMLElement).querySelectorAll('.n-pagination-item--clickable'))
      .find((item) => item.textContent?.trim() === '2') as HTMLElement | undefined
    pageTwo?.click()
    await flushPromises()
    expect(wrapper.find('.n-pagination-item--active').text()).toBe('2')

    await wrapper.get('[data-testid="board-filter-favorites"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.n-pagination-item--active').text()).toBe('1')
    expect(wrapper.find('.board-all-section [data-testid="board-card-title"]').text()).toBe('Board 0')
    wrapper.unmount()
  })

  it('moves back to the previous page after deleting its last Board', async () => {
    api.listBoards.mockResolvedValue(Array.from({ length: 11 }, (_, index) => (
      board(`board-${index}`, `Board ${index}`, 100 - index)
    )))
    api.deleteBoard.mockResolvedValueOnce(undefined)
    const { wrapper } = await mountHome()

    const pageTwo = Array.from((wrapper.element as HTMLElement).querySelectorAll('.n-pagination-item--clickable'))
      .find((item) => item.textContent?.trim() === '2') as HTMLElement | undefined
    pageTwo?.click()
    await flushPromises()
    const lastCard = wrapper.get('.board-all-section .board-card')
    const lastBoard = boardMetadataSource.getSnapshot().find((item) => item.id === lastCard.attributes('data-board-id'))
    expect(lastBoard).toBeDefined()
    wrapper.find('.board-all-section').findComponent(BoardGallery).vm.$emit('delete', lastBoard)
    await flushPromises()

    expect(api.deleteBoard).toHaveBeenCalledWith(lastBoard!.id)
    expect(wrapper.find('.n-pagination-item--active').text()).toBe('2')
    expect(wrapper.findAll('.board-all-section .board-card')).toHaveLength(5)
    wrapper.unmount()
  })

  it('shows folders separately and scopes the root and folder routes to their Boards', async () => {
    api.listBoards.mockResolvedValue([
      board('root', 'Root canvas', 30),
      { ...board('work-board', 'Work canvas', 20), folderId: 'work' },
      { ...board('learning-board', 'Learning canvas', 10), folderId: 'learning' },
    ])
    api.listBoardFolders.mockResolvedValue([folder('work', 'Work', 1), folder('learning', 'Learning', 1)])
    const { wrapper, router } = await mountHome()

    expect(wrapper.findAll('.board-folder-card')).toHaveLength(2)
    const folderCard = wrapper.get('[data-folder-id="work"]')
    expect(folderCard.attributes('role')).toBeUndefined()
    expect(folderCard.attributes('tabindex')).toBeUndefined()
    expect(folderCard.get('.board-folder-open').element.tagName).toBe('BUTTON')
    expect(folderCard.get('.board-folder-menu').element.tagName).toBe('BUTTON')
    expect(wrapper.findAll('.board-all-section [data-testid="board-card-title"]').map((item) => item.text())).toEqual(['Root canvas'])

    await wrapper.get('[data-folder-id="work"] .board-folder-open').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('board-folder')
    expect(wrapper.get('.board-all-section h2').text()).toContain('All boards / Work')
    expect(wrapper.findAll('.board-all-section [data-testid="board-card-title"]').map((item) => item.text())).toEqual(['Work canvas'])
    expect(wrapper.find('.board-folder-section').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hides the root canvas section when all canvases are in folders', async () => {
    api.listBoards.mockResolvedValue([
      { ...board('work-board', 'Work canvas', 20), folderId: 'work' },
    ])
    api.listBoardFolders.mockResolvedValue([folder('work', 'Work', 1)])
    const { wrapper } = await mountHome()

    expect(wrapper.find('.board-folder-section').exists()).toBe(true)
    expect(wrapper.find('.board-canvas-section').exists()).toBe(false)
    expect(wrapper.find('.board-pagination').exists()).toBe(false)
    wrapper.unmount()
  })

  it('moves an unclassified canvas into a folder when dropped on its card', async () => {
    const rootBoard = board('root', 'Root canvas', 30)
    const movedBoard = { ...rootBoard, folderId: 'work' }
    api.listBoards.mockResolvedValue([rootBoard])
    api.listBoardFolders.mockResolvedValue([folder('work', 'Work')])
    api.moveBoard.mockResolvedValue(movedBoard)
    const { wrapper } = await mountHome()

    const dataTransfer = makeDT()
    const sourceCard = wrapper.get('[data-board-id="root"]')
    const folderCard = wrapper.get('[data-folder-id="work"]')
    await sourceCard.trigger('dragstart', { dataTransfer })
    await folderCard.trigger('dragenter', { dataTransfer })
    await folderCard.trigger('dragover', { dataTransfer })

    expect(sourceCard.attributes('draggable')).toBe('true')
    expect(folderCard.classes()).toContain('is-drag-over')

    await folderCard.trigger('drop', { dataTransfer })
    await flushPromises()

    expect(api.moveBoard).toHaveBeenCalledWith('root', 'work')
    expect(boardMetadataSource.getSnapshot()).toContainEqual(expect.objectContaining({ id: 'root', folderId: 'work' }))
    expect(boardFolderSource.getSnapshot()).toContainEqual(expect.objectContaining({ id: 'work', boardCount: 1 }))
    expect(wrapper.find('[data-board-id="root"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens folder actions without entering the folder and creates a folder from the modal', async () => {
    api.listBoards.mockResolvedValue([])
    api.listBoardFolders.mockResolvedValue([folder('work', 'Work')])
    api.createBoardFolder.mockResolvedValue(folder('new', 'Projects'))
    const { wrapper, router } = await mountHome()

    await wrapper.get('[data-folder-id="work"] .board-folder-menu').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('board')

    expect(wrapper.find('.board-folder-heading .board-folder-create').exists()).toBe(false)
    expect(wrapper.find('.board-home-actions .board-new-folder-button').exists()).toBe(true)
    await wrapper.get('.board-new-folder-button').trigger('click')
    await flushPromises()
    const inputs = document.body.querySelectorAll<HTMLInputElement>('input')
    const input = inputs[inputs.length - 1]
    expect(input).toBeDefined()
    input.value = 'Projects'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()

    expect(api.createBoardFolder).toHaveBeenCalledWith('Projects')
    expect(wrapper.find('[data-folder-id="new"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('renames and deletes a folder while preserving its Boards in the root scope', async () => {
    const inFolder = { ...board('inside', 'Inside', 10), folderId: 'work' }
    api.listBoards.mockResolvedValue([inFolder])
    api.listBoardFolders.mockResolvedValue([folder('work', 'Work', 1)])
    api.renameBoardFolder.mockResolvedValue(folder('work', 'Projects', 1))
    api.deleteBoardFolder.mockResolvedValue(undefined)
    const { wrapper, router } = await mountHome()

    wrapper.findComponent(BoardFolderSection).vm.$emit('rename', folder('work', 'Work', 1))
    await flushPromises()
    const renameInputs = document.body.querySelectorAll<HTMLInputElement>('input')
    const renameInput = renameInputs[renameInputs.length - 1]
    renameInput.value = 'Projects'
    renameInput.dispatchEvent(new Event('input', { bubbles: true }))
    renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(api.renameBoardFolder).toHaveBeenCalledWith('work', 'Projects')

    await router.push('/board/folder/work')
    await flushPromises()
    expect(wrapper.get('.board-all-section h2').text()).toContain('Projects')

    await router.push('/board')
    await flushPromises()
    wrapper.findComponent(BoardFolderSection).vm.$emit('delete', folder('work', 'Projects', 1))
    await flushPromises()
    expect(api.deleteBoardFolder).toHaveBeenCalledWith('work')
    expect(router.currentRoute.value.name).toBe('board')
    expect(boardMetadataSource.getSnapshot().find((item) => item.id === 'inside')?.folderId).toBeNull()
    wrapper.unmount()
  })

  it('creates a new Board directly in the current folder', async () => {
    api.listBoards.mockResolvedValue([])
    api.listBoardFolders.mockResolvedValue([folder('work', 'Work')])
    const created = { ...board('created', 'Untitled Board', 30), folderId: 'work' }
    api.createBoard.mockResolvedValue({ metadata: created, sceneRecord: {} })
    const { wrapper, router } = await mountHome('/board/folder/work')

    await wrapper.get('.board-new-button').trigger('click')
    await flushPromises()

    expect(api.createBoard).toHaveBeenCalledWith({ folderId: 'work' })
    expect(router.currentRoute.value.name).toBe('board-editor')
    wrapper.unmount()
  })

  it('creates a board through the metadata source and opens the editor route', async () => {
    api.listBoards.mockResolvedValue([])
    const created = board('created', 'Untitled Board', 30)
    api.createBoard.mockResolvedValue({ metadata: created, sceneRecord: {} })
    const { wrapper, router } = await mountHome()

    await wrapper.get('.board-new-button').trigger('click')
    await flushPromises()

    expect(api.createBoard).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-testid="board-card-title"]').text()).toBe('Untitled Board')
    expect(router.currentRoute.value.name).toBe('board-editor')
    expect(router.currentRoute.value.params.boardId).toBe('created')
    wrapper.unmount()
  })

  it('opens the thin Board Editor route from a card', async () => {
    api.listBoards.mockResolvedValue([board('atlas', 'Project Atlas')])
    const { wrapper, router } = await mountHome()

    await wrapper.get('.board-card-open').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('board-editor')
    expect(router.currentRoute.value.params.boardId).toBe('atlas')
    wrapper.unmount()
  })

  it('invalidates metadata after an uncertain create transport failure', async () => {
    api.listBoards.mockResolvedValue([board('existing', 'Existing')])
    api.createBoard.mockRejectedValue(new api.BoardApiError('network failed', true))
    const { wrapper } = await mountHome()

    await wrapper.get('.board-new-button').trigger('click')
    await flushPromises()

    expect(boardMetadataSource.getSnapshot()).toEqual([])
    wrapper.unmount()
  })

  it('invalidates metadata after uncertain rename and delete failures', async () => {
    api.listBoards.mockResolvedValue([board('existing', 'Existing')])
    api.renameBoard.mockRejectedValue(new api.BoardApiError('network failed', true))
    api.deleteBoard.mockRejectedValue(new api.BoardApiError('network failed', true))
    const { wrapper } = await mountHome()
    const invalidateFolders = vi.spyOn(boardFolderSource, 'invalidate')

    wrapper.findComponent(BoardGallery).vm.$emit('rename', board('existing', 'Existing'))
    await flushPromises()
    const renameSubmit = document.body.querySelector('[data-testid="board-rename-submit"]') as HTMLElement | null
    expect(renameSubmit).not.toBeNull()
    renameSubmit?.click()
    await flushPromises()
    expect(boardMetadataSource.getSnapshot()).toEqual([])

    boardMetadataSource.upsert(board('existing', 'Existing'))
    await flushPromises()
    wrapper.findComponent(BoardGallery).vm.$emit('delete', board('existing', 'Existing'))
    await flushPromises()
    expect(api.deleteBoard).toHaveBeenCalledOnce()
    expect(boardMetadataSource.getSnapshot()).toEqual([])
    expect(invalidateFolders).toHaveBeenCalled()
    invalidateFolders.mockRestore()
    wrapper.unmount()
  })

  it('keeps metadata loaded after a definite Board API failure', async () => {
    api.listBoards.mockResolvedValue([board('existing', 'Existing')])
    api.renameBoard.mockRejectedValue(new api.BoardApiError('invalid title', false))
    const { wrapper } = await mountHome()

    wrapper.findComponent(BoardGallery).vm.$emit('rename', board('existing', 'Existing'))
    await flushPromises()
    const renameSubmit = document.body.querySelector('[data-testid="board-rename-submit"]') as HTMLElement | null
    expect(renameSubmit).not.toBeNull()
    renameSubmit?.click()
    await flushPromises()

    expect(boardMetadataSource.getSnapshot()).toHaveLength(1)
    wrapper.unmount()
  })
})
