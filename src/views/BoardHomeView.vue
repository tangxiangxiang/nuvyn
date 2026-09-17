<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NEmpty, NIcon, NInput, NModal, NPagination, NResult, NSelect, type InputInst, type SelectOption } from 'naive-ui'
import { LayoutGrid, Plus, Search } from '@vicons/tabler'
import BoardGallery from '../components/board/BoardGallery.vue'
import BoardFolderSection from '../components/board/BoardFolderSection.vue'
import {
  BoardApiError,
  createBoard,
  createBoardFolder,
  deleteBoard,
  deleteBoardFolder,
  moveBoard,
  renameBoard,
  renameBoardFolder,
} from '../features/board/api'
import { createIndexedDbBoardCheckpointStore } from '../features/board/checkpointStore'
import { boardFolderSource } from '../features/board/boardFolderSource'
import { boardMetadataSource } from '../features/board/boardMetadataSource'
import type { BoardFolderSummary, BoardMetadata } from '../../shared/boardProtocol'
import { useBoardFavorites } from '../composables/useBoardFavorites'
import { useConfirm } from '../composables/useConfirm'
import { useI18n } from '../composables/useI18n'
import { useToast } from '../composables/useToast'
import { nuvynBoardDragMime, readDataTransfer } from '../technicalNamespace'

const route = useRoute()
const router = useRouter()
const { confirm } = useConfirm()
const { locale, t } = useI18n()
const toast = useToast()
const { favoriteBoardIds, isFavorite, setFavorite } = useBoardFavorites()
const boards = computed(() => boardMetadataSource.getSnapshot())
const boardFolders = computed(() => boardFolderSource.getSnapshot())
const currentFolderId = computed(() => {
  const value = route.params.folderId
  return typeof value === 'string' && value.length > 0 ? value : null
})
const currentFolder = computed(() => currentFolderId.value
  ? boardFolders.value.find((folder) => folder.id === currentFolderId.value) ?? null
  : null)
const folderRouteRequested = computed(() => currentFolderId.value !== null)
const query = ref('')
const loading = ref(false)
const folderLoading = ref(false)
const loadError = ref('')
const folderLoadError = ref('')
const mutationKeys = ref<string[]>([])
const renameOpen = ref(false)
const renameBusy = ref(false)
const renameTitle = ref('')
const renameTarget = ref<BoardMetadata | null>(null)
const renameInput = ref<InputInst | null>(null)
const renameComposing = ref(false)
const folderModalOpen = ref(false)
const folderModalMode = ref<'create' | 'rename'>('create')
const folderModalBusy = ref(false)
const folderName = ref('')
const folderTarget = ref<BoardFolderSummary | null>(null)
const folderInput = ref<InputInst | null>(null)
const folderComposing = ref(false)
const moveOpen = ref(false)
const moveBusy = ref(false)
const ROOT_FOLDER_VALUE = '__board_root__'
const BOARD_DRAG_MIME = nuvynBoardDragMime('board-id')
const moveFolderId = ref<string>(ROOT_FOLDER_VALUE)
const moveTarget = ref<BoardMetadata | null>(null)
const draggingBoardId = ref<string | null>(null)
const dragOverFolderId = ref<string | null>(null)
const recoveryStore = createIndexedDbBoardCheckpointStore()

type BoardFilter = 'all' | 'favorites'
type BoardSortKey = 'recent' | 'updated' | 'name'

const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase())
const filterBy = ref<BoardFilter>('all')
const sortBy = ref<BoardSortKey>('recent')
const sortOptions = computed<SelectOption[]>(() => [
  { label: t('board.sort_recent'), value: 'recent' },
  { label: t('board.sort_updated'), value: 'updated' },
  { label: t('board.sort_name'), value: 'name' },
])
const sortCollator = computed(() => new Intl.Collator(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
  numeric: true,
  sensitivity: 'base',
}))
const scopedBoards = computed(() => currentFolderId.value
  ? boards.value.filter((board) => board.folderId === currentFolderId.value)
  : boards.value.filter((board) => board.folderId === null))
const filteredBoards = computed(() => {
  const favoriteFiltered = filterBy.value === 'favorites'
    ? scopedBoards.value.filter((board) => isFavorite(board.id))
    : scopedBoards.value
  if (!normalizedQuery.value) return favoriteFiltered
  return favoriteFiltered.filter((board) => board.title.toLocaleLowerCase().includes(normalizedQuery.value))
})
const sortedBoards = computed(() => [...filteredBoards.value].sort((left, right) => {
  if (sortBy.value === 'recent') {
    return boardActivityTimestamp(right) - boardActivityTimestamp(left)
      || right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
  }
  if (sortBy.value === 'name') {
    return sortCollator.value.compare(left.title, right.title) || right.updatedAt - left.updatedAt
  }
  return right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
}))
const boardPageSize = ref(5)
const boardPageSizeOptions = [5, 10, 25, 50]
const boardPage = ref(1)
const boardPageCount = computed(() => Math.max(1, Math.ceil(sortedBoards.value.length / boardPageSize.value)))
const canvasGalleryElement = ref<HTMLElement | null>(null)
const canvasGalleryHeight = ref<number | null>(null)
let canvasGalleryResizeObserver: ResizeObserver | null = null
const paginatedBoards = computed(() => {
  const start = (boardPage.value - 1) * boardPageSize.value
  return sortedBoards.value.slice(start, start + boardPageSize.value)
})
const canvasEmptyStyle = computed(() => canvasGalleryHeight.value === null
  ? undefined
  : { minHeight: `${canvasGalleryHeight.value}px` })
const hasContent = computed(() => boards.value.length > 0 || boardFolders.value.length > 0)
const showCanvasSection = computed(() => currentFolderId.value !== null
  || scopedBoards.value.length > 0
  || normalizedQuery.value.length > 0
  || filterBy.value === 'favorites')
const isInitialLoading = computed(() => (loading.value || folderLoading.value) && !hasContent.value)
const folderNotFound = computed(() => folderRouteRequested.value
  && !folderLoading.value
  && !folderLoadError.value
  && currentFolder.value === null)
const emptyBoardDescription = computed(() => {
  if (filterBy.value === 'favorites') return t('board.no_favorites')
  if (normalizedQuery.value) return t('board.no_results')
  if (currentFolder.value) return t('board.folder_empty')
  return t('board.empty')
})

watch(canvasGalleryElement, (element) => {
  canvasGalleryResizeObserver?.disconnect()
  canvasGalleryResizeObserver = null
  if (!element) return

  const syncHeight = () => {
    const height = element.getBoundingClientRect().height
    if (height > 0) canvasGalleryHeight.value = height
  }
  syncHeight()
  if (typeof ResizeObserver !== 'undefined') {
    canvasGalleryResizeObserver = new ResizeObserver(syncHeight)
    canvasGalleryResizeObserver.observe(element)
  }
}, { flush: 'post' })

onBeforeUnmount(() => canvasGalleryResizeObserver?.disconnect())
const moveFolderOptions = computed<SelectOption[]>(() => [
  { label: t('board.root_folder'), value: ROOT_FOLDER_VALUE },
  ...boardFolders.value
    .filter((folder) => folder.parentId === null)
    .map((folder) => ({ label: folder.name, value: folder.id })),
])

watch([query, filterBy, sortBy], () => { boardPage.value = 1 })
watch(boardPageSize, () => { boardPage.value = 1 })
watch(boardPageCount, () => {
  if (boardPage.value > boardPageCount.value) boardPage.value = boardPageCount.value
})
watch(currentFolderId, () => { boardPage.value = 1 })

function boardActivityTimestamp(board: BoardMetadata): number {
  return board.lastOpenedAt ?? board.updatedAt ?? board.createdAt
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof BoardApiError && error.message.trim() ? error.message : fallback
}

function invalidateIfUncertain(error: unknown, includeFolders = false): void {
  if (!(error instanceof BoardApiError) || !error.uncertain) return
  boardMetadataSource.invalidate()
  if (includeFolders) boardFolderSource.invalidate()
}

function invalidateFolderIfUncertain(error: unknown): void {
  if (error instanceof BoardApiError && error.uncertain) boardFolderSource.invalidate()
}

async function loadBoards(): Promise<void> {
  if (loading.value) return
  loading.value = true
  loadError.value = ''
  try {
    await boardMetadataSource.ensureLoaded()
  } catch (error) {
    loadError.value = messageFor(error, t('board.load_failed'))
  } finally {
    loading.value = false
  }
}

async function loadFolders(): Promise<void> {
  if (folderLoading.value) return
  folderLoading.value = true
  folderLoadError.value = ''
  try {
    await boardFolderSource.ensureLoaded()
  } catch (error) {
    folderLoadError.value = messageFor(error, t('board.load_failed'))
  } finally {
    folderLoading.value = false
  }
}

function retryLoad(): void {
  void Promise.all([loadBoards(), loadFolders()])
}

onMounted(() => { retryLoad() })

function setMutationBusy(key: string, busy: boolean): void {
  mutationKeys.value = busy
    ? [...new Set([...mutationKeys.value, key])]
    : mutationKeys.value.filter((item) => item !== key)
}

function updateFolderCount(folderId: string | null, delta: number): void {
  if (folderId === null) return
  const folder = boardFolderSource.getSnapshot().find((item) => item.id === folderId)
  if (!folder) return
  boardFolderSource.upsert({ ...folder, boardCount: Math.max(0, folder.boardCount + delta) })
}

function draggedBoard(event: DragEvent): BoardMetadata | null {
  const boardId = readDataTransfer(event.dataTransfer, BOARD_DRAG_MIME) || draggingBoardId.value
  if (!boardId) return null
  return boards.value.find((board) => board.id === boardId) ?? null
}

function onBoardDragStart(board: BoardMetadata, event: DragEvent): void {
  if (currentFolderId.value !== null || board.folderId !== null || mutationKeys.value.includes(board.id)) {
    event.preventDefault()
    return
  }
  draggingBoardId.value = board.id
  if (event.dataTransfer) {
  event.dataTransfer.setData(BOARD_DRAG_MIME, board.id)
    event.dataTransfer.effectAllowed = 'move'
  }
}

function onBoardDragEnd(): void {
  draggingBoardId.value = null
  dragOverFolderId.value = null
}

function onFolderDragOver(folder: BoardFolderSummary, event: DragEvent): void {
  event.preventDefault()
  const board = draggedBoard(event)
  if (!board || board.folderId !== null || mutationKeys.value.includes(board.id)) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    if (dragOverFolderId.value === folder.id) dragOverFolderId.value = null
    return
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverFolderId.value = folder.id
}

function onFolderDragEnter(folder: BoardFolderSummary, event: DragEvent): void {
  onFolderDragOver(folder, event)
}

function onFolderDragLeave(folder: BoardFolderSummary): void {
  if (dragOverFolderId.value === folder.id) dragOverFolderId.value = null
}

async function moveBoardToFolder(target: BoardMetadata, folderId: string | null): Promise<boolean> {
  if (target.folderId === folderId || mutationKeys.value.includes(target.id)) return false
  setMutationBusy(target.id, true)
  try {
    const updated = await moveBoard(target.id, folderId)
    boardMetadataSource.upsert(updated)
    updateFolderCount(target.folderId, -1)
    updateFolderCount(updated.folderId, 1)
    toast.success(t('board.board_moved'))
    return true
  } catch (error) {
    invalidateIfUncertain(error, true)
    toast.error(messageFor(error, t('board.board_move_failed')))
    return false
  } finally {
    setMutationBusy(target.id, false)
  }
}

function onFolderDrop(folder: BoardFolderSummary, event: DragEvent): void {
  event.preventDefault()
  const board = draggedBoard(event)
  draggingBoardId.value = null
  dragOverFolderId.value = null
  if (!board || board.folderId !== null) return
  void moveBoardToFolder(board, folder.id)
}

async function newBoard(): Promise<void> {
  if (mutationKeys.value.includes('__create__')) return
  setMutationBusy('__create__', true)
  try {
    const aggregate = await createBoard({ folderId: currentFolderId.value })
    boardMetadataSource.upsert(aggregate.metadata)
    updateFolderCount(aggregate.metadata.folderId, 1)
    toast.success(t('board.created'))
    await router.push({ name: 'board-editor', params: { boardId: aggregate.metadata.id } })
  } catch (error) {
    invalidateIfUncertain(error, true)
    toast.error(messageFor(error, t('board.create_failed')))
  } finally {
    setMutationBusy('__create__', false)
  }
}

function openBoard(board: BoardMetadata): void {
  void router.push({ name: 'board-editor', params: { boardId: board.id } })
}

function openFolder(folder: BoardFolderSummary): void {
  void router.push({ name: 'board-folder', params: { folderId: folder.id } })
}

function toggleFavorite(board: BoardMetadata): void {
  const nextFavorite = !isFavorite(board.id)
  setFavorite(board.id, nextFavorite)
  toast.success(t(nextFavorite ? 'board.favorited' : 'board.unfavorited'))
}

async function submitRename(): Promise<void> {
  const target = renameTarget.value
  if (!target || renameBusy.value) return
  renameBusy.value = true
  setMutationBusy(target.id, true)
  try {
    const updated = await renameBoard(target.id, renameTitle.value)
    boardMetadataSource.upsert(updated)
    renameOpen.value = false
    toast.success(t('board.renamed'))
  } catch (error) {
    invalidateIfUncertain(error)
    toast.error(messageFor(error, t('board.rename_failed')))
  } finally {
    renameBusy.value = false
    setMutationBusy(target.id, false)
  }
}

function openRename(board: BoardMetadata): void {
  renameTarget.value = board
  renameTitle.value = board.title
  renameOpen.value = true
  void nextTick(() => renameInput.value?.focus())
}

function closeRename(): void {
  if (renameBusy.value) return
  renameOpen.value = false
  renameTarget.value = null
  renameComposing.value = false
}

function onRenameKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeRename()
    return
  }
  if (event.key !== 'Enter' || renameComposing.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void submitRename()
}

function openCreateFolder(): void {
  folderModalMode.value = 'create'
  folderTarget.value = null
  folderName.value = ''
  folderModalOpen.value = true
  void nextTick(() => folderInput.value?.focus())
}

function openRenameFolder(folder: BoardFolderSummary): void {
  folderModalMode.value = 'rename'
  folderTarget.value = folder
  folderName.value = folder.name
  folderModalOpen.value = true
  void nextTick(() => folderInput.value?.focus())
}

function closeFolderModal(): void {
  if (folderModalBusy.value) return
  folderModalOpen.value = false
  folderTarget.value = null
  folderComposing.value = false
}

function validateFolderName(): string | null {
  const normalized = folderName.value.trim()
  if (!normalized) {
    toast.error(t('board.folder_name_required'))
    return null
  }
  if (normalized.length > 80) {
    toast.error(t('board.folder_name_too_long'))
    return null
  }
  return normalized
}

async function submitFolder(): Promise<void> {
  if (folderModalBusy.value) return
  const normalized = validateFolderName()
  if (!normalized) return
  const target = folderTarget.value
  const mutationKey = target?.id ?? '__folder__'
  folderModalBusy.value = true
  setMutationBusy(mutationKey, true)
  try {
    const updated = folderModalMode.value === 'create'
      ? await createBoardFolder(normalized)
      : await renameBoardFolder(target!.id, normalized)
    boardFolderSource.upsert(updated)
    folderModalOpen.value = false
    folderTarget.value = null
    toast.success(t(folderModalMode.value === 'create' ? 'board.folder_created' : 'board.folder_renamed'))
  } catch (error) {
    invalidateFolderIfUncertain(error)
    toast.error(messageFor(error, t(folderModalMode.value === 'create' ? 'board.folder_create_failed' : 'board.folder_rename_failed')))
  } finally {
    folderModalBusy.value = false
    setMutationBusy(mutationKey, false)
  }
}

function onFolderKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeFolderModal()
    return
  }
  if (event.key !== 'Enter' || folderComposing.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void submitFolder()
}

async function removeFolder(folder: BoardFolderSummary): Promise<void> {
  if (mutationKeys.value.includes(folder.id)) return
  const confirmed = await confirm(
    t('board.folder_delete_title', { name: folder.name }),
    t('board.folder_delete_detail'),
    { destructive: true },
  )
  if (!confirmed) return

  setMutationBusy(folder.id, true)
  try {
    await deleteBoardFolder(folder.id)
    boardFolderSource.remove(folder.id)
    for (const board of boards.value.filter((item) => item.folderId === folder.id)) {
      boardMetadataSource.upsert({ ...board, folderId: null })
    }
    if (currentFolderId.value === folder.id) await router.replace({ name: 'board' })
    toast.success(t('board.folder_deleted'))
  } catch (error) {
    invalidateIfUncertain(error, true)
    toast.error(messageFor(error, t('board.folder_delete_failed')))
  } finally {
    setMutationBusy(folder.id, false)
  }
}

function openMove(board: BoardMetadata): void {
  moveTarget.value = board
  moveFolderId.value = board.folderId ?? ROOT_FOLDER_VALUE
  moveOpen.value = true
}

function closeMove(): void {
  if (moveBusy.value) return
  moveOpen.value = false
  moveTarget.value = null
}

async function submitMove(): Promise<void> {
  const target = moveTarget.value
  if (!target || moveBusy.value) return
  const selectedFolderId = moveFolderId.value === ROOT_FOLDER_VALUE ? null : moveFolderId.value
  if (target.folderId === selectedFolderId) {
    closeMove()
    return
  }
  moveBusy.value = true
  try {
    const moved = await moveBoardToFolder(target, selectedFolderId)
    if (moved) {
      moveOpen.value = false
      moveTarget.value = null
    }
  } finally {
    moveBusy.value = false
  }
}

async function removeBoard(board: BoardMetadata): Promise<void> {
  if (mutationKeys.value.includes(board.id)) return
  const confirmed = await confirm(
    t('board.delete_title', { title: board.title }),
    t('board.delete_detail'),
    { destructive: true },
  )
  if (!confirmed) return

  setMutationBusy(board.id, true)
  try {
    await deleteBoard(board.id)
    boardMetadataSource.remove(board.id)
    updateFolderCount(board.folderId, -1)
    setFavorite(board.id, false)
    try {
      await recoveryStore.clearBoardRecovery(board.id)
    } catch {
      toast.error(t('board.recovery_cleanup_failed'))
    }
    toast.success(t('board.deleted'))
  } catch (error) {
    invalidateIfUncertain(error, true)
    toast.error(messageFor(error, t('board.delete_failed')))
  } finally {
    setMutationBusy(board.id, false)
  }
}
</script>

<template>
  <div class="board-home" data-testid="board-home">
    <div class="board-home-content">
      <header class="board-home-header">
        <div class="board-home-heading">
          <p class="board-home-eyebrow">{{ t('board.title') }}</p>
          <h1>{{ t('board.workspace_label') }}</h1>
          <p class="board-home-subtitle">{{ t('board.subtitle') }}</p>
        </div>
        <div class="board-home-actions">
          <NButton
            v-if="!currentFolderId"
            class="board-new-folder-button"
            attr-type="button"
            size="small"
            secondary
            :disabled="folderLoading"
            @click="openCreateFolder"
          >
            <NIcon aria-hidden="true"><Plus /></NIcon>
            {{ t('board.new_folder') }}
          </NButton>
          <NButton
            class="board-new-button"
            attr-type="button"
            size="small"
            type="primary"
            :loading="mutationKeys.includes('__create__')"
            :disabled="mutationKeys.includes('__create__') || folderLoading || folderNotFound"
            @click="newBoard"
          >
            <NIcon aria-hidden="true"><Plus /></NIcon>
            {{ t('board.new') }}
          </NButton>
        </div>
      </header>

      <section v-if="isInitialLoading" class="board-loading" data-testid="board-loading" role="status" aria-live="polite" :aria-label="t('board.loading')">
        <div class="board-skeleton-grid" aria-hidden="true">
          <span v-for="index in 5" :key="index" class="board-skeleton-card">
            <span class="board-skeleton-preview" />
            <span class="board-skeleton-lines"><i /><i /><i /></span>
          </span>
        </div>
      </section>

      <section v-else-if="folderRouteRequested && folderLoadError" class="board-state board-error" data-testid="board-folder-error" role="alert">
        <NResult size="small" status="error" :title="t('board.load_failed')" :description="folderLoadError">
          <template #footer>
            <NButton attr-type="button" size="small" type="primary" @click="loadFolders">{{ t('common.retry') }}</NButton>
          </template>
        </NResult>
      </section>

      <section v-else-if="folderNotFound" class="board-state board-folder-not-found" data-testid="board-folder-not-found" role="alert">
        <NResult size="small" status="404" :title="t('board.folder_not_found')">
          <template #footer>
            <NButton attr-type="button" size="small" type="primary" @click="router.replace({ name: 'board' })">{{ t('board.back_to_all') }}</NButton>
          </template>
        </NResult>
      </section>

      <section v-else-if="loadError && !hasContent" class="board-state board-error" data-testid="board-error" role="alert">
        <NResult size="small" status="error" :title="t('board.load_failed')" :description="loadError">
          <template #footer>
            <NButton attr-type="button" size="small" type="primary" @click="loadBoards">{{ t('common.retry') }}</NButton>
          </template>
        </NResult>
      </section>

      <template v-else-if="hasContent">
        <p v-if="loadError || folderLoadError" class="board-inline-error" role="alert">{{ loadError || folderLoadError }}</p>

        <section id="board-all-section" class="board-section board-all-section" aria-labelledby="board-all-heading">
          <div class="board-section-heading board-all-section-heading" data-testid="board-toolbar">
            <h2 id="board-all-heading">
              <template v-if="currentFolder">
                <RouterLink class="board-breadcrumb-link" :to="{ name: 'board' }">{{ t('board.all_boards') }}</RouterLink>
                <span class="board-breadcrumb-separator" aria-hidden="true"> / </span>
                <span>{{ currentFolder.name }}</span>
              </template>
              <template v-else>{{ t('board.all_boards') }}</template>
            </h2>
            <div class="board-all-heading-controls">
              <NInput
                v-model:value="query"
                class="board-search-input board-all-search"
                clearable
                size="small"
                type="text"
                :placeholder="t('board.search_placeholder')"
                :input-props="{ 'aria-label': t('board.search_label'), autocomplete: 'off' }"
              >
                <template #prefix><NIcon aria-hidden="true"><Search /></NIcon></template>
              </NInput>
              <div class="board-filter" role="group" :aria-label="t('board.filter_label')">
                <button
                  class="board-filter-button"
                  :class="{ 'is-active': filterBy === 'all' }"
                  type="button"
                  :aria-pressed="filterBy === 'all'"
                  data-testid="board-filter-all"
                  @click="filterBy = 'all'"
                >
                  {{ t('board.filter_all') }}
                </button>
                <button
                  class="board-filter-button"
                  :class="{ 'is-active': filterBy === 'favorites' }"
                  type="button"
                  :aria-pressed="filterBy === 'favorites'"
                  data-testid="board-filter-favorites"
                  @click="filterBy = 'favorites'"
                >
                  {{ t('board.favorites') }}
                </button>
              </div>
              <NSelect
                v-model:value="sortBy"
                class="board-sort-select"
                size="small"
                :options="sortOptions"
                :aria-label="t('board.sort_label')"
              />
            </div>
          </div>

          <BoardFolderSection
            v-if="!currentFolderId"
            :folders="boardFolders"
            :drag-over-folder-id="dragOverFolderId"
            @open="openFolder"
            @rename="openRenameFolder"
            @delete="removeFolder"
            @dragenter="onFolderDragEnter"
            @dragover="onFolderDragOver"
            @dragleave="onFolderDragLeave"
            @drop="onFolderDrop"
          />

          <div v-if="showCanvasSection" class="board-canvas-section" aria-labelledby="board-canvas-heading">
            <h3 id="board-canvas-heading" class="board-subsection-label">{{ t('board.canvases') }}</h3>
            <div v-if="paginatedBoards.length" ref="canvasGalleryElement" class="board-canvas-gallery">
              <BoardGallery
                layout="grid"
                :boards="paginatedBoards"
                :favorite-board-ids="favoriteBoardIds"
                :busy-board-ids="mutationKeys"
                :draggable="!currentFolderId"
                @open="openBoard"
                @favorite="toggleFavorite"
                @move="openMove"
                @rename="openRename"
                @delete="removeBoard"
                @dragstart="onBoardDragStart"
                @dragend="onBoardDragEnd"
              />
            </div>
            <NEmpty v-else class="board-canvas-empty" :style="canvasEmptyStyle" size="small" :description="emptyBoardDescription">
              <template #extra>
                <NButton
                  v-if="currentFolder && !normalizedQuery && filterBy === 'all'"
                  attr-type="button"
                  size="small"
                  type="primary"
                  @click="newBoard"
                >
                  <NIcon aria-hidden="true"><Plus /></NIcon>
                  {{ t('board.new') }}
                </NButton>
              </template>
            </NEmpty>
          </div>
          <div v-if="showCanvasSection" class="board-pagination">
            <div class="board-pagination-meta">共 {{ sortedBoards.length }} 条</div>
            <NPagination
              v-model:page="boardPage"
              v-model:page-size="boardPageSize"
              :item-count="sortedBoards.length"
              :page-sizes="boardPageSizeOptions"
              show-size-picker
              size="medium"
              :aria-label="t('board.all_boards')"
            />
          </div>
        </section>
      </template>

      <template v-else>
        <BoardFolderSection
          v-if="!currentFolderId"
          :folders="boardFolders"
          :drag-over-folder-id="dragOverFolderId"
          @open="openFolder"
          @rename="openRenameFolder"
          @delete="removeFolder"
          @dragenter="onFolderDragEnter"
          @dragover="onFolderDragOver"
          @dragleave="onFolderDragLeave"
          @drop="onFolderDrop"
        />
        <section class="board-empty" data-testid="board-empty">
          <span class="board-empty-icon" aria-hidden="true"><NIcon><LayoutGrid /></NIcon></span>
          <h2>{{ t('board.empty') }}</h2>
          <p>{{ t('board.empty_detail') }}</p>
          <NButton attr-type="button" size="small" type="primary" @click="newBoard">
            <NIcon aria-hidden="true"><Plus /></NIcon>
            {{ t('board.create_first') }}
          </NButton>
        </section>
      </template>
    </div>

    <NModal
      v-model:show="renameOpen"
      preset="dialog"
      size="small"
      :title="t('board.rename_title')"
      :show-icon="false"
      :closable="!renameBusy"
      :mask-closable="!renameBusy"
      :close-on-esc="!renameBusy"
      :on-mask-click="closeRename"
    >
      <NInput
        ref="renameInput"
        v-model:value="renameTitle"
        size="small"
        :disabled="renameBusy"
        :placeholder="t('board.title_placeholder')"
        :input-props="{ 'aria-label': t('board.title_label'), autocomplete: 'off' }"
        @compositionstart="renameComposing = true"
        @compositionend="renameComposing = false"
        @keydown="onRenameKeydown"
      />
      <template #action>
        <NButton attr-type="button" size="small" :disabled="renameBusy" @click="closeRename">{{ t('common.cancel') }}</NButton>
        <NButton data-testid="board-rename-submit" attr-type="button" size="small" type="primary" :loading="renameBusy" @click="submitRename">{{ t('common.save') }}</NButton>
      </template>
    </NModal>

    <NModal
      v-model:show="folderModalOpen"
      preset="dialog"
      size="small"
      :title="t(folderModalMode === 'create' ? 'board.new_folder_title' : 'board.rename_folder_title')"
      :show-icon="false"
      :closable="!folderModalBusy"
      :mask-closable="!folderModalBusy"
      :close-on-esc="!folderModalBusy"
      :on-mask-click="closeFolderModal"
    >
      <NInput
        ref="folderInput"
        v-model:value="folderName"
        size="small"
        maxlength="80"
        :disabled="folderModalBusy"
        :placeholder="t('board.folder_name_placeholder')"
        :input-props="{ 'aria-label': t('board.folder_name_label'), autocomplete: 'off' }"
        @compositionstart="folderComposing = true"
        @compositionend="folderComposing = false"
        @keydown="onFolderKeydown"
      />
      <template #action>
        <NButton attr-type="button" size="small" :disabled="folderModalBusy" @click="closeFolderModal">{{ t('common.cancel') }}</NButton>
        <NButton data-testid="board-folder-submit" attr-type="button" size="small" type="primary" :loading="folderModalBusy" @click="submitFolder">{{ folderModalMode === 'create' ? t('common.create') : t('common.save') }}</NButton>
      </template>
    </NModal>

    <NModal
      v-model:show="moveOpen"
      preset="dialog"
      size="small"
      :title="t('board.move_board_title')"
      :show-icon="false"
      :closable="!moveBusy"
      :mask-closable="!moveBusy"
      :close-on-esc="!moveBusy"
      :on-mask-click="closeMove"
    >
      <p class="board-move-detail">{{ t('board.move_board_detail') }}</p>
      <NSelect
        v-model:value="moveFolderId"
        data-testid="board-move-select"
        size="small"
        :options="moveFolderOptions"
        :disabled="moveBusy"
        :aria-label="t('board.move_board_title')"
      />
      <template #action>
        <NButton attr-type="button" size="small" :disabled="moveBusy" @click="closeMove">{{ t('common.cancel') }}</NButton>
        <NButton data-testid="board-move-submit" attr-type="button" size="small" type="primary" :loading="moveBusy" @click="submitMove">{{ t('board.move') }}</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.board-home {
  min-height: calc(100vh - var(--navbar-h, 36px));
  box-sizing: border-box;
  padding: 42px 0 0;
  background: var(--bg);
  color: var(--text);
}
.board-home-content {
  width: min(100%, 1240px);
  margin: 0 auto;
  padding-inline: 28px;
  box-sizing: border-box;
  container-type: inline-size;
}
.board-home-header {
  display: flex;
  margin: 0 0 20px;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
}
.board-home-heading { min-width: 0; }
.board-home-actions { display: flex; flex: none; align-items: center; gap: 8px; }
.board-home-eyebrow { margin: 0 0 7px; color: var(--accent); font-size: .7rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
.board-home-header h1 { margin: 0; color: var(--text-h); font-size: clamp(1.85rem, 3vw, 2.35rem); font-weight: 720; letter-spacing: -.035em; line-height: 1.16; }
.board-home-subtitle { margin: 8px 0 0; color: var(--text-muted); font-size: .78rem; line-height: 1.45; }
.board-new-folder-button,
.board-new-button {
  min-height: 34px;
  box-sizing: border-box;
  padding: 6px 12px;
  border-radius: 8px;
  font: inherit;
  font-size: .78rem;
  font-weight: 650;
  margin-top: 0;
}
.board-new-folder-button :deep(.n-icon),
.board-new-button :deep(.n-icon) { margin-right: 2px; }
.board-search-input { width: min(100%, 280px); min-width: 0; flex: 0 1 280px; border-radius: 10px; }
.board-search-input :deep(.n-input__prefix) { color: var(--text-muted); font-size: 19px; }
.board-search-input :deep(.n-input__input) { font-size: .9rem; }
.board-all-section-heading { align-items: center; }
.board-all-heading-controls { display: flex; min-width: 0; align-items: center; gap: 8px; }
.board-all-search { width: min(100%, 280px); flex: 0 1 280px; }
.board-sort-select { width: 148px; }
.board-sort-select :deep(.n-base-selection) { border-radius: 10px; }
.board-section { margin: 0 0 18px; }
.board-all-section { margin-bottom: 0; }
.board-canvas-section { min-width: 0; }
.board-canvas-gallery { min-width: 0; }
.board-canvas-empty { min-height: 208px; box-sizing: border-box; justify-content: center; }
.board-subsection-label { margin: 20px 0 10px; color: var(--text-muted); font-size: .82rem; font-weight: 650; letter-spacing: .01em; }
.board-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 18px;
  padding: 12px 0;
  border-top: 1px solid color-mix(in srgb, var(--border) 62%, transparent);
  background: color-mix(in srgb, var(--bg) 14%, transparent);
}
.board-pagination-meta { color: var(--text-muted); font-size: .74rem; }
.board-section-heading { display: flex; min-height: 34px; margin-bottom: 16px; align-items: center; justify-content: space-between; gap: 16px; }
.board-section-heading h2 { margin: 0; color: var(--text-h); font-size: 1.18rem; font-weight: 650; letter-spacing: -.02em; }
.board-breadcrumb-link { color: inherit; text-decoration: none; }
.board-breadcrumb-link:hover { color: var(--accent); }
.board-breadcrumb-link:focus-visible { border-radius: 3px; outline: 2px solid var(--accent); outline-offset: 2px; }
.board-breadcrumb-separator { color: var(--text-muted); font-weight: 450; }
.board-filter {
  display: inline-flex;
  height: 28px;
  box-sizing: border-box;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--bg-soft) 44%, transparent);
}
.board-filter-button {
  display: inline-flex;
  min-width: 58px;
  height: 100%;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: .82rem;
  white-space: nowrap;
  cursor: pointer;
}
.board-filter-button:hover { color: var(--text-h); }
.board-filter-button.is-active { background: color-mix(in srgb, var(--accent) 10%, var(--bg)); color: var(--accent); font-weight: 650; }
.board-filter-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.board-state { display: grid; min-height: 300px; place-items: center; gap: 12px; margin: 0 auto; color: var(--text-muted); text-align: center; }
.board-error { max-width: 620px; place-items: stretch; text-align: left; }
.board-error :deep(.n-result) { padding: 0; }
.board-inline-error { margin: -12px 0 20px; color: var(--nuvyn-negative, #b42318); font-size: .85rem; }
.board-empty { display: flex; min-height: 310px; box-sizing: border-box; align-items: center; justify-content: center; flex-direction: column; gap: 8px; padding: 40px 20px; border: 1px dashed color-mix(in srgb, var(--border) 92%, transparent); border-radius: 16px; color: var(--text-muted); text-align: center; }
.board-empty-icon { display: grid; width: 52px; height: 52px; margin-bottom: 6px; place-items: center; border-radius: 15px; background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); font-size: 26px; }
.board-empty h2 { margin: 0; color: var(--text-h); font-size: 1.15rem; }
.board-empty p { margin: 0 0 10px; font-size: .85rem; }
.board-move-detail { margin: 0 0 10px; color: var(--text-muted); font-size: .85rem; }
.board-loading { display: grid; gap: 32px; }
.board-skeleton-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; }
.board-skeleton-card { display: grid; min-width: 0; overflow: hidden; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--border) 80%, transparent); border-radius: 14px; background: var(--bg); }
.board-skeleton-preview { width: calc(100% - 24px); margin: 12px 12px 0; aspect-ratio: 16 / 10; border-radius: 11px; background: var(--bg-soft); }
.board-skeleton-lines { display: grid; gap: 9px; padding: 13px 14px 16px; border-top: 1px solid color-mix(in srgb, var(--border) 74%, transparent); }
.board-skeleton-lines i { display: block; height: 10px; border-radius: 5px; background: var(--bg-soft); }
.board-skeleton-lines i:first-child { width: 76%; height: 14px; }
.board-skeleton-lines i:last-child { width: 48%; }
@media (max-width: 1279px) { .board-skeleton-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 1023px) { .board-skeleton-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 767px) {
  .board-home { padding-top: 30px; }
  .board-home-content { padding-inline: 16px; }
  .board-skeleton-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .board-home-header { align-items: stretch; flex-direction: column; }
  .board-home-subtitle { max-width: 32rem; }
  .board-home-actions { width: 100%; }
  .board-new-folder-button,
  .board-new-button { flex: 1; }
  .board-all-section-heading { align-items: stretch; flex-direction: column; gap: 10px; }
  .board-all-heading-controls { width: 100%; flex-wrap: wrap; }
  .board-all-search { width: auto; flex: 1 1 auto; }
  .board-skeleton-grid { display: flex; overflow-x: hidden; }
  .board-skeleton-card { flex: 0 0 calc((100% - 18px) / 2); }
  .board-pagination { align-items: stretch; flex-direction: column; }
  .board-pagination-meta { order: 2; }
  .board-pagination :deep(.n-pagination) { justify-content: space-between; }
}
@media (max-width: 440px) { .board-home-header h1 { font-size: 1.75rem; } }
</style>
