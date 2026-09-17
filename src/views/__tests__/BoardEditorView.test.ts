// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import BoardEditorView from '../BoardEditorView.vue'
import ExcalidrawHost from '../../components/board/ExcalidrawHost.vue'
import BoardMaterialPanel from '../../components/board/BoardMaterialPanel.vue'
import type { BoardAggregate } from '../../features/board/api'
import type { BoardScene } from '../../../shared/boardProtocol'
import { useI18n } from '../../composables/useI18n'
import { useConfirm } from '../../composables/useConfirm'
import { useBoardFavorites } from '../../composables/useBoardFavorites'
import { boardMetadataSource } from '../../features/board/metadataSource'
import { boardFolderSource } from '../../features/board/folderSource'
import { excalidrawAdapter } from '../../features/board/engine/excalidrawAdapter'
import * as boardExport from '../../features/board/boardExport'
import * as thumbnailSchedulerModule from '../../features/board/thumbnailScheduler'

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}))

vi.mock('../../composables/useToast', () => ({
  useToast: () => toast,
}))

const api = vi.hoisted(() => ({
  BoardApiError: class BoardApiError extends Error {
    status: number
    code: string
    uncertain: boolean
    constructor(message: string, status = 500, code = 'BOARD_API_ERROR', uncertain = true) {
      super(message)
      this.status = status
      this.code = code
      this.uncertain = uncertain
    }
  },
  listBoards: vi.fn(),
  getBoard: vi.fn(),
  getBoardMetadata: vi.fn(),
  createBoard: vi.fn(),
  renameBoard: vi.fn(),
  saveBoardScene: vi.fn(),
  setBoardThumbnail: vi.fn(),
  deleteBoard: vi.fn(),
  listBoardFolders: vi.fn(),
  listBoardMaterials: vi.fn(),
  createBoardMaterial: vi.fn(),
  renameBoardMaterial: vi.fn(),
  archiveBoardMaterial: vi.fn(),
  restoreBoardMaterial: vi.fn(),
  deleteBoardMaterial: vi.fn(),
}))

const recovery = vi.hoisted(() => {
  let checkpoint: unknown = null
  return {
    seed(value: unknown) { checkpoint = value },
    reset() { checkpoint = null },
    store: {
      get: vi.fn(async () => checkpoint),
      put: vi.fn(async (value: unknown) => { checkpoint = value }),
      delete: vi.fn(async () => { checkpoint = null }),
      putPendingAsset: vi.fn(async () => {}),
      getPendingAsset: vi.fn(async () => null),
      deletePendingAsset: vi.fn(async () => {}),
      listPendingAssets: vi.fn(async () => []),
      clearBoardRecovery: vi.fn(async () => { checkpoint = null }),
    },
    BoardRecoveryStoreError: class BoardRecoveryStoreError extends Error {
      code = 'BOARD_RECOVERY_OPERATION_FAILED'
    },
  }
})

const assetSession = vi.hoisted(() => {
  const session = {
    seedScene: vi.fn(),
    observeRuntimeAssets: vi.fn(async () => {}),
    ensureCheckpointAssetsDurable: vi.fn(async () => {}),
    ensureAssetReady: vi.fn(async () => {}),
    ensureSceneAssetsReady: vi.fn(async () => {}),
    resolveSceneAssets: vi.fn(async () => []),
    getFileMap: vi.fn(() => ({})),
    dispose: vi.fn(),
  }
  return {
    session,
    create: vi.fn(() => session),
    reset() {
      for (const method of Object.values(session)) method.mockReset()
      session.observeRuntimeAssets.mockResolvedValue(undefined)
      session.ensureCheckpointAssetsDurable.mockResolvedValue(undefined)
      session.ensureAssetReady.mockResolvedValue(undefined)
      session.ensureSceneAssetsReady.mockResolvedValue(undefined)
      session.resolveSceneAssets.mockResolvedValue([])
      session.getFileMap.mockReturnValue({})
    },
  }
})

vi.mock('../../features/board/api', () => api)
vi.mock('../../features/board/checkpointStore', () => ({
  createIndexedDbBoardCheckpointStore: () => recovery.store,
  BoardRecoveryStoreError: recovery.BoardRecoveryStoreError,
}))
vi.mock('../../features/board/assetSession', () => ({
  createBoardAssetSession: assetSession.create,
}))
vi.mock('../../components/board/ExcalidrawHost.vue', () => ({
  default: {
    name: 'ExcalidrawHost',
    props: ['initialScene', 'theme', 'langCode', 'editorMenu'],
    emits: ['change', 'assets-changed', 'asset-error', 'library-save-error', 'ready', 'error'],
    template: '<div data-testid="mock-excalidraw-host" />',
  },
}))

function emptyScene(): BoardScene {
  return { engineData: { elements: [], fileMap: {} }, persistentAppState: {}, assetRefs: [] }
}

function board(id: string, title = id, revision = 3, folderId: string | null = null): BoardAggregate {
  return {
    metadata: { id, title, thumbnailAssetId: null, folderId, createdAt: 1, updatedAt: 2, lastOpenedAt: null },
    sceneRecord: { boardId: id, engine: 'excalidraw', sceneVersion: 1, revision, scene: emptyScene() },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function mountEditor(boardId = 'a', attachTo?: Element) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/board', name: 'board', component: { template: '<div data-testid="board-home-route" />' } },
      { path: '/board/folder/:folderId', name: 'board-folder', component: { template: '<div data-testid="board-folder-route" />' } },
      { path: '/board/:boardId', name: 'board-editor', component: BoardEditorView },
    ],
  })
  await router.push(`/board/${boardId}`)
  await router.isReady()
  const wrapper = mount({ template: '<router-view />' }, {
    attachTo,
    global: { plugins: [router] },
  })
  return { wrapper, router }
}

describe('Board Editor B4 lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getBoard.mockReset()
    api.getBoardMetadata.mockReset()
    api.createBoard.mockReset()
    api.renameBoard.mockReset()
    api.saveBoardScene.mockReset()
    api.setBoardThumbnail.mockReset()
    api.deleteBoard.mockReset()
    api.listBoardFolders.mockReset()
    api.listBoardMaterials.mockReset()
    api.createBoardMaterial.mockReset()
    api.renameBoardMaterial.mockReset()
    api.archiveBoardMaterial.mockReset()
    api.restoreBoardMaterial.mockReset()
    api.deleteBoardMaterial.mockReset()
    recovery.reset()
    assetSession.reset()
    toast.error.mockReset()
    toast.info.mockReset()
    toast.success.mockReset()
    boardMetadataSource.invalidate()
    boardFolderSource.invalidate()
    useBoardFavorites().favoriteBoardIds.value = []
    useI18n().setLocale('en')
  })

  afterEach(() => {
    vi.useRealTimers()
    boardMetadataSource.invalidate()
    useI18n().setLocale('zh')
  })

  it('shows loading without mounting a canvas, then hydrates and becomes ready', async () => {
    const request = deferred<BoardAggregate>()
    api.getBoard.mockReturnValueOnce(request.promise)
    const { wrapper } = await mountEditor()
    expect(wrapper.find('[data-testid="board-editor-loading"]').exists()).toBe(true)
    expect(wrapper.findComponent(ExcalidrawHost).exists()).toBe(false)

    request.resolve(board('a', 'Alpha'))
    await flushPromises()
    expect(wrapper.findComponent(ExcalidrawHost).exists()).toBe(true)
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')
    await flushPromises()
    expect(wrapper.get('[data-testid="board-editor-status"]').text()).toContain('Ready')
    expect(wrapper.get('[data-testid="board-editor-status"]').attributes('data-save-status')).toBe('saved')
    expect(wrapper.findComponent(ExcalidrawHost).props('initialScene')).toEqual({ elements: [], appState: {}, files: {} })
    wrapper.unmount()
  })

  it('maps the Nuvyn locale into Excalidraw without changing scene revision or autosaving', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha'))
    const { wrapper } = await mountEditor()
    await flushPromises()

    const host = wrapper.findComponent(ExcalidrawHost)
    expect(host.props('langCode')).toBe('en')
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('0')

    useI18n().setLocale('zh')
    await flushPromises()

    expect(host.props('langCode')).toBe('zh-CN')
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('0')
    expect(api.saveBoardScene).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not mount an empty canvas for not-found or load failures', async () => {
    api.getBoard.mockRejectedValueOnce(new api.BoardApiError('missing', 404, 'BOARD_NOT_FOUND', false))
    const { wrapper } = await mountEditor()
    await flushPromises()
    expect(wrapper.find('[data-testid="board-editor-error"]').exists()).toBe(true)
    expect(wrapper.findComponent(ExcalidrawHost).exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps Board metadata visible when the persisted scene is corrupt', async () => {
    api.getBoard.mockRejectedValueOnce(new api.BoardApiError('scene damaged', 500, 'BOARD_SCENE_CORRUPT', false))
    api.getBoardMetadata.mockResolvedValueOnce(board('a', 'Recoverable title').metadata)
    const { wrapper } = await mountEditor()
    await flushPromises()

    expect(api.getBoardMetadata).toHaveBeenCalledWith('a')
    expect(wrapper.get('[data-testid="board-editor-error"]').text()).toContain('Recoverable title')
    expect(wrapper.get('[data-testid="board-error-board-title"]').text()).toBe('Recoverable title')
    wrapper.unmount()
  })

  it('fences stale route responses and keeps only the latest board', async () => {
    const first = deferred<BoardAggregate>()
    const second = deferred<BoardAggregate>()
    api.getBoard.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { wrapper, router } = await mountEditor('a')
    await router.push('/board/b')
    await flushPromises()
    second.resolve(board('b', 'Beta'))
    await flushPromises()
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')
    first.resolve(board('a', 'Alpha'))
    await flushPromises()
    expect(wrapper.findComponent(ExcalidrawHost).props('editorMenu')!.title).toBe('Beta')
    expect(api.getBoard).toHaveBeenCalledWith('a')
    expect(api.getBoard).toHaveBeenCalledWith('b')
    wrapper.unmount()
  })

  it('uses a zero-chrome canvas and exposes board identity and actions through the canvas menu', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha'))
    api.renameBoard.mockResolvedValueOnce({
      ...board('a', 'Renamed').metadata,
      updatedAt: 10,
    })
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    expect(wrapper.find('.board-editor-chrome').exists()).toBe(false)
    expect(wrapper.find('[data-testid="board-editor-save-notice"]').exists()).toBe(false)
    expect(document.title).toBe('Alpha · Nuvyn')
    expect(host.props('editorMenu')).toMatchObject({
      title: 'Alpha',
      saveStatusLabel: 'Saved',
      favorite: false,
      labels: { back: 'Back to boards', copy: 'Duplicate board' },
    })

    host.props('editorMenu')!.onToggleFavorite()
    await flushPromises()
    expect(host.props('editorMenu')!.favorite).toBe(true)

    await expect(host.props('editorMenu')!.onRename('Renamed')).resolves.toBe(true)
    await flushPromises()
    expect(api.renameBoard).toHaveBeenCalledWith('a', 'Renamed')
    expect(host.props('editorMenu')!.title).toBe('Renamed')
    expect(document.title).toBe('Renamed · Nuvyn')
    wrapper.unmount()
  })

  it('returns to Board with G B and ignores the sequence while typing, overlaid, or expired', async () => {
    vi.useFakeTimers()
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha'))
    const { wrapper, router } = await mountEditor('a')
    await flushPromises()
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')

    const press = (target: EventTarget, key: string) => target.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    }))

    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    press(input, 'g')
    press(input, 'b')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('board-editor')
    input.remove()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    press(window, 'g')
    press(window, 'b')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('board-editor')
    dialog.remove()

    const menu = document.createElement('div')
    menu.className = 'dropdown-menu'
    document.body.append(menu)
    press(window, 'g')
    press(window, 'b')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('board-editor')
    menu.remove()

    press(window, 'g')
    await vi.advanceTimersByTimeAsync(701)
    press(window, 'b')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('board-editor')

    press(window, 'G')
    press(window, 'B')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('board')
    wrapper.unmount()
  })

  it('keeps G B inside the editor while the Material panel is open', async () => {
    vi.useFakeTimers()
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha'))
    api.listBoardMaterials.mockResolvedValue([])
    const { wrapper, router } = await mountEditor('a', document.body)
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    host.props('editorMenu')!.onOpenMaterials()
    await flushPromises()
    expect(wrapper.find('[data-board-material-panel]').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', bubbles: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('board-editor')

    wrapper.findComponent(BoardMaterialPanel).vm.$emit('close')
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', bubbles: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('board')
    wrapper.unmount()
  })

  it('uses a localized fallback instead of exposing an internal material insertion error', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha'))
    api.listBoardMaterials.mockResolvedValue([])
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    host.props('editorMenu')!.onOpenMaterials()
    await flushPromises()
    const panel = wrapper.findComponent(BoardMaterialPanel)
    panel.vm.$emit('insert', {
      id: 'material-1',
      name: 'Arrow',
      kind: 'svg',
      svg: '<svg viewBox="0 0 16 16" />',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    })
    await flushPromises()

    expect(toast.error).toHaveBeenCalledWith('Could not insert the material. Please retry.')
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('Excalidraw'))
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
    wrapper.unmount()
  })

  it('returns to the current Folder with G B for a Folder Board', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha', 3, 'work'))
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', bubbles: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('board-folder')
    expect(router.currentRoute.value.params.folderId).toBe('work')
    wrapper.unmount()
  })

  it('flushes the latest canvas change before G B navigation completes', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha'))
    api.saveBoardScene.mockResolvedValueOnce({ revision: 4, updatedAt: 20 })
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    host.vm.$emit('change', {
      elements: [{ id: 'last-stroke', type: 'freedraw', version: 1, x: 1, y: 2, width: 3, height: 4 }],
      appState: {},
      files: {},
    })
    await flushPromises()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(api.saveBoardScene).toHaveBeenCalledWith('a', expect.objectContaining({
      expectedRevision: 3,
      scene: expect.objectContaining({
        engineData: expect.objectContaining({ elements: [expect.objectContaining({ id: 'last-stroke' })] }),
      }),
    }))
    expect(router.currentRoute.value.name).toBe('board')
    wrapper.unmount()
  })

  it('duplicates the latest canvas into an independent Board', async () => {
    const copied = board('copy', 'Alpha copy', 1)
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha')).mockResolvedValueOnce(copied)
    api.createBoard.mockResolvedValueOnce(copied)
    api.saveBoardScene
      .mockResolvedValueOnce({ revision: 2, updatedAt: 20 })
      .mockResolvedValueOnce({ revision: 4, updatedAt: 21 })
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-1', type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await flushPromises()

    host.props('editorMenu')!.onCopy()
    await flushPromises()

    await vi.waitFor(() => expect(api.createBoard).toHaveBeenCalledWith({
      title: 'Alpha copy',
      folderId: null,
    }))
    await flushPromises()
    expect(api.saveBoardScene).toHaveBeenCalledWith('copy', expect.objectContaining({
      expectedRevision: 1,
      scene: expect.objectContaining({
        engineData: expect.objectContaining({ elements: [expect.objectContaining({ id: 'rectangle-1' })] }),
      }),
    }))
    expect(router.currentRoute.value.params.boardId).toBe('copy')
    wrapper.unmount()
  })

  it('keeps a duplicated Folder Board in the same Folder', async () => {
    const copied = board('copy', 'Alpha copy', 1, 'work')
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha', 3, 'work')).mockResolvedValueOnce(copied)
    api.createBoard.mockResolvedValueOnce(copied)
    api.saveBoardScene.mockResolvedValueOnce({ revision: 2, updatedAt: 20 })
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    host.props('editorMenu')!.onCopy()
    await vi.waitFor(() => expect(api.createBoard).toHaveBeenCalledWith({
      title: 'Alpha copy',
      folderId: 'work',
    }))
    await flushPromises()

    expect(api.saveBoardScene).toHaveBeenCalledWith('copy', expect.objectContaining({ expectedRevision: 1 }))
    expect(router.currentRoute.value.params.boardId).toBe('copy')
    wrapper.unmount()
  })

  it('retries a failed load and mounts the successful result', async () => {
    api.getBoard.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(board('a', 'Retry'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    await wrapper.get('[data-testid="board-editor-error"] button').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent(ExcalidrawHost).exists()).toBe(true)
    expect(api.getBoard).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('starts at local revision zero and increments only for meaningful scene changes', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('0')

    const same = { elements: [], appState: {}, files: {} }
    host.vm.$emit('change', same)
    await flushPromises()
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('0')

    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-1', type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await flushPromises()
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('1')
    expect(api.getBoard).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('waits for a recovery choice before mounting and restores the checkpoint scene', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    recovery.seed({
      boardId: 'a',
      sceneVersion: 1,
      baseRevision: 3,
      localRevision: 5,
      scene: {
        engineData: { elements: [{ id: 'recovered', type: 'rectangle', version: 1, x: 1, y: 2, width: 3, height: 4 }], fileMap: {} },
        persistentAppState: {},
        assetRefs: [],
      },
      savedAt: 10,
    })
    const { wrapper } = await mountEditor()
    await flushPromises()

    expect(wrapper.find('[data-testid="board-editor-recovery"]').exists()).toBe(true)
    expect(wrapper.findComponent(ExcalidrawHost).exists()).toBe(false)
    await wrapper.get('[data-testid="board-editor-recovery"] button').trigger('click')
    await flushPromises()

    const host = wrapper.findComponent(ExcalidrawHost)
    expect(host.exists()).toBe(true)
    expect(host.props('initialScene')).toMatchObject({ elements: [{ id: 'recovered' }] })
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('5')
    wrapper.unmount()
  })

  it('keeps the ready editor and local session while the asset bridge is idle', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    host.vm.$emit('assets-changed', [])
    await flushPromises()

    expect(wrapper.get('[data-testid="board-editor-status"]').text()).toContain('Ready')
    expect(wrapper.findComponent(ExcalidrawHost).exists()).toBe(true)
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('0')
    wrapper.unmount()
  })

  it('does not write an image checkpoint until its Pending Blob intake is durable', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    const intake = deferred<void>()
    const assetId = '11111111-1111-4111-8111-111111111111'
    assetSession.session.getFileMap.mockReturnValue({ 'file-1': assetId })
    assetSession.session.observeRuntimeAssets.mockReturnValue(intake.promise)
    const image = {
      id: 'image-1',
      type: 'image',
      fileId: 'file-1',
      isDeleted: false,
      version: 1,
    }

    vi.useFakeTimers()
    host.vm.$emit('assets-changed', [{ engineFileId: 'file-1', mimeType: 'image/png', blob: new Blob(['image']) }])
    host.vm.$emit('change', { elements: [image], appState: {}, files: { 'file-1': {} } })
    await vi.advanceTimersByTimeAsync(250)
    expect(recovery.store.put).not.toHaveBeenCalled()

    intake.resolve()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    expect(recovery.store.put).toHaveBeenCalledWith(expect.objectContaining({
      scene: expect.objectContaining({
        engineData: expect.objectContaining({ fileMap: { 'file-1': assetId } }),
        assetRefs: [assetId],
      }),
    }))
    wrapper.unmount()
  })

  it('advances local revisions and checkpoints after a durable Pending Blob has an upload failure', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    const assetId = '11111111-1111-4111-8111-111111111111'
    assetSession.session.getFileMap.mockReturnValue({ 'file-1': assetId })
    assetSession.session.ensureCheckpointAssetsDurable.mockResolvedValue(undefined)
    const image = {
      id: 'image-1',
      type: 'image',
      fileId: 'file-1',
      isDeleted: false,
      version: 1,
    }

    vi.useFakeTimers()
    host.vm.$emit('assets-changed', [{ engineFileId: 'file-1', mimeType: 'image/png', blob: new Blob(['image']) }])
    host.vm.$emit('change', { elements: [image], appState: {}, files: { 'file-1': {} } })
    await flushPromises()

    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('1')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()
    expect(recovery.store.put).toHaveBeenCalledWith(expect.objectContaining({
      scene: expect.objectContaining({
        engineData: expect.objectContaining({ fileMap: { 'file-1': assetId } }),
        assetRefs: [assetId],
      }),
    }))

    host.vm.$emit('change', {
      elements: [image, { id: 'rectangle-1', type: 'rectangle', version: 1, x: 1, y: 2, width: 3, height: 4 }],
      appState: {},
      files: { 'file-1': {} },
    })
    await flushPromises()
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('2')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()
    expect(recovery.store.put).toHaveBeenLastCalledWith(expect.objectContaining({
      localRevision: 2,
      scene: expect.objectContaining({
        engineData: expect.objectContaining({ fileMap: { 'file-1': assetId } }),
        assetRefs: [assetId],
      }),
    }))
    wrapper.unmount()
  })

  it('does not advance local revisions when Pending Blob persistence fails', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    const assetIntake = Promise.reject(new Error('IndexedDB is unavailable'))
    assetSession.session.observeRuntimeAssets.mockReturnValue(assetIntake)
    assetSession.session.ensureCheckpointAssetsDurable.mockRejectedValue(new Error('Pending is not durable'))
    assetSession.session.getFileMap.mockReturnValue({ 'file-1': '11111111-1111-4111-8111-111111111111' })
    vi.useFakeTimers()
    host.vm.$emit('assets-changed', [{ engineFileId: 'file-1', mimeType: 'image/png', blob: new Blob(['image']) }])
    host.vm.$emit('change', {
      elements: [{ id: 'image-1', type: 'image', fileId: 'file-1', isDeleted: false, version: 1 }],
      appState: {},
      files: { 'file-1': {} },
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('0')
    expect(recovery.store.put).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ignores an intermediate image change until Excalidraw provides its file ID', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    host.vm.$emit('change', {
      elements: [{ id: 'image-1', type: 'image', fileId: null, isDeleted: false, version: 1 }],
      appState: {},
      files: {},
    })
    await flushPromises()

    expect(toast.error).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('0')

    const assetId = '11111111-1111-4111-8111-111111111111'
    const asset = { engineFileId: 'file-1', mimeType: 'image/png', blob: new Blob(['image']) }
    assetSession.session.getFileMap.mockReturnValue({ 'file-1': assetId })
    host.vm.$emit('assets-changed', [asset])
    host.vm.$emit('change', {
      elements: [{ id: 'image-1', type: 'image', fileId: 'file-1', isDeleted: false, version: 1 }],
      appState: {},
      files: { 'file-1': {} },
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('1')
    wrapper.unmount()
  })

  it('deduplicates one asset failure across intake and checkpoint callbacks, then allows a later failure', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    const assetId = '11111111-1111-4111-8111-111111111111'
    const failure = new (await import('../../features/board/assetClient')).BoardAssetError(
      'ASSET_PENDING_INVALID',
      'Pending asset is not durable',
    )
    const asset = { engineFileId: 'file-1', mimeType: 'image/png', blob: new Blob(['image']) }
    const image = { id: 'image-1', type: 'image', fileId: 'file-1', isDeleted: false, version: 1 }
    assetSession.session.getFileMap.mockReturnValue({ 'file-1': assetId })
    assetSession.session.observeRuntimeAssets.mockRejectedValue(failure)
    assetSession.session.ensureCheckpointAssetsDurable.mockRejectedValue(failure)

    host.vm.$emit('assets-changed', [asset])
    host.vm.$emit('change', { elements: [image], appState: {}, files: { 'file-1': {} } })
    await flushPromises()
    expect(toast.error).toHaveBeenCalledOnce()

    assetSession.session.observeRuntimeAssets.mockResolvedValue(undefined)
    assetSession.session.ensureCheckpointAssetsDurable.mockResolvedValue(undefined)
    host.vm.$emit('assets-changed', [asset])
    host.vm.$emit('change', { elements: [image], appState: {}, files: { 'file-1': {} } })
    await flushPromises()

    assetSession.session.observeRuntimeAssets.mockRejectedValue(failure)
    assetSession.session.ensureCheckpointAssetsDurable.mockRejectedValue(failure)
    host.vm.$emit('assets-changed', [asset])
    host.vm.$emit('change', { elements: [image], appState: {}, files: { 'file-1': {} } })
    await flushPromises()
    expect(toast.error).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('does not toast a host bridge error before the asset lifecycle reaches its authoritative gate', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    await flushPromises()

    host.vm.$emit('asset-error', new Error('intermediate BinaryFile snapshot'))
    await flushPromises()
    expect(toast.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('flushes a dirty Board before same-component boardId navigation', async () => {
    api.getBoard.mockResolvedValueOnce(board('a')).mockResolvedValueOnce(board('b'))
    api.saveBoardScene.mockResolvedValueOnce({ revision: 4, updatedAt: 20 })
    const { wrapper, router } = await mountEditor('a')
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-1', type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await flushPromises()

    await router.push('/board/b')
    await flushPromises()
    expect(api.saveBoardScene).toHaveBeenCalledWith('a', expect.objectContaining({ expectedRevision: 3 }))
    expect(router.currentRoute.value.params.boardId).toBe('b')
    expect(api.getBoard).toHaveBeenCalledWith('b')
    wrapper.unmount()
  })

  it('flushes a dirty Board when the editor component is unmounted', async () => {
    vi.useFakeTimers()
    api.getBoard.mockResolvedValueOnce(board('a', 'Alpha'))
    api.saveBoardScene.mockResolvedValueOnce({ revision: 4, updatedAt: 20 })
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    host.vm.$emit('change', {
      elements: [{ id: 'last-stroke', type: 'freedraw', version: 1, x: 1, y: 2, width: 3, height: 4 }],
      appState: {},
      files: {},
    })
    await flushPromises()

    wrapper.unmount()
    await flushPromises()

    expect(api.saveBoardScene).toHaveBeenCalledWith('a', expect.objectContaining({
      expectedRevision: 3,
      scene: expect.objectContaining({
        engineData: expect.objectContaining({ elements: [expect.objectContaining({ id: 'last-stroke' })] }),
      }),
    }))
  })

  it('keeps autosave alive when a later guard cancels after a successful flush', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    api.saveBoardScene
      .mockResolvedValueOnce({ revision: 4, updatedAt: 20 })
      .mockResolvedValueOnce({ revision: 5, updatedAt: 21 })
    const { wrapper, router } = await mountEditor('a')
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-1', type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await flushPromises()

    const removeGuard = router.beforeResolve(() => {
      removeGuard()
      return false
    })
    await router.push('/board/b')
    await flushPromises()

    expect(router.currentRoute.value.params.boardId).toBe('a')
    expect(api.saveBoardScene).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-2', type: 'rectangle', version: 1, x: 30, y: 30, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(api.saveBoardScene).toHaveBeenCalledTimes(2)
    expect(api.saveBoardScene).toHaveBeenLastCalledWith('a', expect.objectContaining({ expectedRevision: 4 }))
    wrapper.unmount()
  })

  it('blocks same-component boardId navigation when a failed flush is not confirmed', async () => {
    api.getBoard.mockResolvedValueOnce(board('a')).mockResolvedValueOnce(board('b'))
    api.saveBoardScene.mockRejectedValueOnce(new api.BoardApiError('save failed', 500, 'BOARD_INTERNAL_ERROR', false))
    const { wrapper, router } = await mountEditor('a')
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-1', type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await flushPromises()

    const navigation = router.push('/board/b')
    await flushPromises()
    const request = useConfirm().queue.value[0]
    expect(request?.message).toBe('Changes could not be safely saved')
    if (request) useConfirm().answer(request.id, false)
    await navigation
    expect(router.currentRoute.value.params.boardId).toBe('a')
    expect(api.getBoard).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps normal saves quiet and surfaces a persistent retryable failure', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    api.saveBoardScene.mockRejectedValueOnce(new api.BoardApiError('save failed', 500, 'BOARD_INTERNAL_ERROR', false))
    const { wrapper } = await mountEditor('a')
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    expect(wrapper.find('[data-testid="board-editor-save-notice"]').exists()).toBe(false)

    vi.useFakeTimers()
    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-1', type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(wrapper.get('[data-testid="board-editor-save-error"]').text()).toContain('Save failed')
    expect(wrapper.get('[data-testid="board-editor-save-error"] button').text()).toBe('Retry save')
    wrapper.unmount()
  })

  it('warns synchronously on beforeunload while a scene save is at risk', async () => {
    api.getBoard.mockResolvedValueOnce(board('a'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-1', type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await flushPromises()

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    wrapper.unmount()
  })

  it('passes the server Scene revision to the thumbnail scheduler', async () => {
    const schedule = vi.fn()
    const dispose = vi.fn()
    const createThumbnailScheduler = vi.spyOn(thumbnailSchedulerModule, 'createBoardThumbnailScheduler')
      .mockImplementation(() => ({ schedule, dispose }) as never)
    api.getBoard.mockResolvedValueOnce(board('a'))
    api.saveBoardScene.mockResolvedValueOnce({ revision: 9, updatedAt: 20 })
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')

    vi.useFakeTimers()
    for (const id of ['rectangle-1', 'rectangle-2', 'rectangle-3']) {
      host.vm.$emit('change', {
        elements: [{ id, type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
        appState: {},
        files: {},
      })
      await flushPromises()
    }
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(schedule).toHaveBeenCalledWith({
      runtimeScene: expect.objectContaining({
        elements: [expect.objectContaining({ id: 'rectangle-3' })],
      }),
      revision: 9,
    })
    expect(schedule).not.toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }))
    wrapper.unmount()
    createThumbnailScheduler.mockRestore()
  })

  it('opens the editor menu and exports the current runtime without persistence', async () => {
    api.getBoard.mockImplementationOnce(async () => {
      const result = board('a', 'My Board')
      return result
    })
    const exportPng = vi.spyOn(excalidrawAdapter, 'exportPng').mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    const download = vi.spyOn(boardExport, 'downloadBoardBlob').mockImplementation(() => {})
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    const currentRuntime = { elements: [{ id: 'shape-1' }], appState: {}, files: {} }
    host.vm.$emit('change', currentRuntime)
    await flushPromises()

    const menu = wrapper.findComponent(ExcalidrawHost).props('editorMenu')
    expect(menu!.labels).toMatchObject({ exportPng: 'Export PNG', exportSvg: 'Export SVG', delete: 'Delete board' })
    menu!.onExportPng()
    await flushPromises()

    expect(exportPng).toHaveBeenCalledWith(currentRuntime)
    expect(download).toHaveBeenCalledWith(expect.any(Blob), 'My Board.png')
    expect(api.saveBoardScene).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="board-local-revision"]').attributes('data-local-revision')).toBe('1')
    wrapper.unmount()
  })

  it('deletes the current Board only after confirmation and navigates after cleanup', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Delete me'))
    api.deleteBoard.mockResolvedValueOnce(undefined)
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')
    wrapper.findComponent(ExcalidrawHost).props('editorMenu')!.onDelete()
    await flushPromises()
    const request = useConfirm().queue.value[0]
    expect(request?.message).toBe('Delete “Delete me”?')
    if (request) useConfirm().answer(request.id, true)
    await flushPromises()

    expect(api.deleteBoard).toHaveBeenCalledWith('a')
    expect(recovery.store.clearBoardRecovery).toHaveBeenCalledWith('a')
    expect(boardMetadataSource.getSnapshot()).not.toContainEqual(expect.objectContaining({ id: 'a' }))
    expect(router.currentRoute.value.name).toBe('board')
    wrapper.unmount()
  })

  it('returns to the current Folder after deleting a Folder Board', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Delete me', 3, 'work'))
    api.deleteBoard.mockResolvedValueOnce(undefined)
    const invalidate = vi.spyOn(boardFolderSource, 'invalidate')
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')
    wrapper.findComponent(ExcalidrawHost).props('editorMenu')!.onDelete()
    await flushPromises()
    const request = useConfirm().queue.value[0]
    if (request) useConfirm().answer(request.id, true)
    await flushPromises()

    expect(api.deleteBoard).toHaveBeenCalledWith('a')
    expect(boardMetadataSource.getSnapshot()).not.toContainEqual(expect.objectContaining({ id: 'a' }))
    expect(invalidate).toHaveBeenCalledOnce()
    expect(router.currentRoute.value.name).toBe('board-folder')
    expect(router.currentRoute.value.params.folderId).toBe('work')
    invalidate.mockRestore()
    wrapper.unmount()
  })

  it('keeps the editor and recovery store intact when delete fails', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Keep me'))
    api.deleteBoard.mockRejectedValueOnce(new Error('delete failed'))
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')
    wrapper.findComponent(ExcalidrawHost).props('editorMenu')!.onDelete()
    await flushPromises()
    const request = useConfirm().queue.value[0]
    if (request) useConfirm().answer(request.id, true)
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('board-editor')
    expect(wrapper.find('[data-testid="board-editor-surface"]').exists()).toBe(true)
    expect(recovery.store.clearBoardRecovery).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('treats an uncertain delete followed by metadata 404 as a confirmed deletion', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Delete me', 3, 'work'))
    api.deleteBoard.mockRejectedValueOnce(new api.BoardApiError('network failed', 500, 'BOARD_API_ERROR', true))
    api.getBoardMetadata.mockRejectedValueOnce(new api.BoardApiError('missing', 404, 'BOARD_NOT_FOUND', false))
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')
    wrapper.findComponent(ExcalidrawHost).props('editorMenu')!.onDelete()
    await flushPromises()
    const request = useConfirm().queue.value[0]
    if (request) useConfirm().answer(request.id, true)
    await flushPromises()

    expect(api.getBoardMetadata).toHaveBeenCalledWith('a')
    expect(boardMetadataSource.getSnapshot()).not.toContainEqual(expect.objectContaining({ id: 'a' }))
    expect(recovery.store.clearBoardRecovery).toHaveBeenCalledWith('a')
    expect(router.currentRoute.value.name).toBe('board-folder')
    expect(router.currentRoute.value.params.folderId).toBe('work')
    wrapper.unmount()
  })

  it('keeps the editor when uncertain delete reconciliation confirms the Board still exists', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Keep me'))
    api.deleteBoard.mockRejectedValueOnce(new api.BoardApiError('network failed', 500, 'BOARD_API_ERROR', true))
    api.getBoardMetadata.mockResolvedValueOnce(board('a', 'Keep me').metadata)
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')
    wrapper.findComponent(ExcalidrawHost).props('editorMenu')!.onDelete()
    await flushPromises()
    const request = useConfirm().queue.value[0]
    if (request) useConfirm().answer(request.id, true)
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('board-editor')
    expect(wrapper.find('[data-testid="board-editor-surface"]').exists()).toBe(true)
    expect(recovery.store.clearBoardRecovery).not.toHaveBeenCalled()
    expect(boardMetadataSource.getSnapshot()).toContainEqual(expect.objectContaining({ id: 'a' }))
    wrapper.unmount()
  })

  it('keeps the editor and shows an uncertainty message when reconciliation is inconclusive', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Keep me'))
    api.deleteBoard.mockRejectedValueOnce(new api.BoardApiError('network failed', 500, 'BOARD_API_ERROR', true))
    api.getBoardMetadata.mockRejectedValueOnce(new api.BoardApiError('still offline', 500, 'BOARD_API_ERROR', true))
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    wrapper.findComponent(ExcalidrawHost).vm.$emit('ready')
    wrapper.findComponent(ExcalidrawHost).props('editorMenu')!.onDelete()
    await flushPromises()
    const request = useConfirm().queue.value[0]
    if (request) useConfirm().answer(request.id, true)
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('board-editor')
    expect(wrapper.find('[data-testid="board-editor-surface"]').exists()).toBe(true)
    expect(recovery.store.clearBoardRecovery).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Could not confirm whether the board was deleted. Check your connection and try again.')
    wrapper.unmount()
  })

  it('shows one library save warning without affecting the canvas', async () => {
    api.getBoard.mockResolvedValueOnce(board('a', 'Library board'))
    const { wrapper } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')
    host.vm.$emit('library-save-error', new Error('IndexedDB unavailable'))
    host.vm.$emit('library-save-error', new Error('IndexedDB unavailable'))
    await flushPromises()

    expect(toast.error).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith('Material library save failed. This change may not persist after a refresh.')
    expect(wrapper.find('[data-testid="board-editor-surface"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('prevents a late Scene save response from resurrecting metadata after delete success', async () => {
    const sceneSave = deferred<{ revision: number; updatedAt: number }>()
    const deleteRequest = deferred<void>()
    api.getBoard.mockResolvedValueOnce(board('a', 'Delete me'))
    api.saveBoardScene.mockReturnValueOnce(sceneSave.promise)
    api.deleteBoard.mockReturnValueOnce(deleteRequest.promise)
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')

    vi.useFakeTimers()
    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-1', type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()
    expect(api.saveBoardScene).toHaveBeenCalledOnce()

    wrapper.findComponent(ExcalidrawHost).props('editorMenu')!.onDelete()
    await flushPromises()
    const request = useConfirm().queue.value[0]
    if (request) useConfirm().answer(request.id, true)
    await flushPromises()

    expect(api.deleteBoard).toHaveBeenCalledWith('a')
    expect(router.currentRoute.value.name).toBe('board-editor')

    deleteRequest.resolve(undefined)
    await flushPromises()
    expect(boardMetadataSource.getSnapshot()).not.toContainEqual(expect.objectContaining({ id: 'a' }))

    sceneSave.resolve({ revision: 4, updatedAt: 999 })
    await flushPromises()

    expect(boardMetadataSource.getSnapshot()).not.toContainEqual(expect.objectContaining({ id: 'a' }))
    expect(router.currentRoute.value.name).toBe('board')
    wrapper.unmount()
  })

  it('keeps an in-flight Scene save authoritative when delete fails', async () => {
    const sceneSave = deferred<{ revision: number; updatedAt: number }>()
    api.getBoard.mockResolvedValueOnce(board('a', 'Keep me'))
    api.saveBoardScene
      .mockReturnValueOnce(sceneSave.promise)
      .mockResolvedValueOnce({ revision: 5, updatedAt: 21 })
    api.deleteBoard.mockRejectedValueOnce(new Error('delete failed'))
    const { wrapper, router } = await mountEditor()
    await flushPromises()
    const host = wrapper.findComponent(ExcalidrawHost)
    host.vm.$emit('ready')

    vi.useFakeTimers()
    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-1', type: 'rectangle', version: 1, x: 10, y: 10, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()
    expect(api.saveBoardScene).toHaveBeenCalledOnce()

    wrapper.findComponent(ExcalidrawHost).props('editorMenu')!.onDelete()
    await flushPromises()
    const request = useConfirm().queue.value[0]
    if (request) useConfirm().answer(request.id, true)
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('board-editor')
    expect(wrapper.find('[data-testid="board-editor-surface"]').exists()).toBe(true)
    expect(recovery.store.clearBoardRecovery).not.toHaveBeenCalled()

    sceneSave.resolve({ revision: 4, updatedAt: 20 })
    await flushPromises()
    expect(boardMetadataSource.getSnapshot()).toContainEqual(expect.objectContaining({ id: 'a', updatedAt: 20 }))

    host.vm.$emit('change', {
      elements: [{ id: 'rectangle-2', type: 'rectangle', version: 1, x: 30, y: 30, width: 20, height: 20 }],
      appState: {},
      files: {},
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(api.saveBoardScene).toHaveBeenCalledTimes(2)
    expect(api.saveBoardScene).toHaveBeenLastCalledWith('a', expect.objectContaining({ expectedRevision: 4 }))
    expect(router.currentRoute.value.name).toBe('board-editor')
    wrapper.unmount()
  })
})
