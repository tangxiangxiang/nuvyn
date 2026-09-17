<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { NButton, NDropdown, NInput, NModal, NSpin, type DropdownOption } from 'naive-ui'
import type { BoardMaterial } from '../../../shared/boardMaterialProtocol'
import {
  BoardApiError,
  archiveBoardMaterial,
  createBoardMaterial,
  deleteBoardMaterial,
  renameBoardMaterial,
  restoreBoardMaterial,
} from '../../features/board/api'
import { boardMaterialSource } from '../../features/board/boardMaterialSource'
import {
  boardMaterialPreviewUrl,
  defaultBoardMaterialName,
  isBoardMaterialSvg,
} from '../../features/board/materialValidation'
import { useConfirm } from '../../composables/useConfirm'
import { useI18n } from '../../composables/useI18n'
import { useToast } from '../../composables/useToast'

const emit = defineEmits<{
  close: []
  insert: [material: BoardMaterial]
}>()

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirm()
const search = ref('')
const scope = ref<'active' | 'archived'>('active')
const loading = ref(false)
const loadError = ref(false)
const busyMaterialIds = ref<Set<string>>(new Set())
const editingId = ref<string | null>(null)
const editingName = ref('')
const composing = ref(false)
const showAddModal = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const selectedFileName = ref('')
const pendingSvg = ref('')
const draftName = ref('')
const addError = ref('')
const adding = ref(false)

const materials = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return boardMaterialSource.snapshot.value.filter((material) => {
    if (material.archived !== (scope.value === 'archived')) return false
    return !query || material.name.toLocaleLowerCase().includes(query)
  })
})

const isEmpty = computed(() => !loading.value && !loadError.value && materials.value.length === 0)

function materialPreview(material: BoardMaterial): string {
  return boardMaterialPreviewUrl(material.svg)
}

function menuOptions(material: BoardMaterial): DropdownOption[] {
  return material.archived
    ? [
        { label: t('board.materials_restore'), key: 'restore' },
        { label: t('board.materials_delete'), key: 'delete', props: { class: 'board-material-danger-option' } },
      ]
    : [
        { label: t('board.materials_rename'), key: 'rename' },
        { label: t('board.materials_archive'), key: 'archive' },
      ]
}

function isBusy(materialId: string): boolean {
  return busyMaterialIds.value.has(materialId)
}

function beginOperation(materialId: string): boolean {
  if (busyMaterialIds.value.has(materialId)) return false
  busyMaterialIds.value = new Set(busyMaterialIds.value).add(materialId)
  return true
}

function endOperation(materialId: string): void {
  if (!busyMaterialIds.value.has(materialId)) return
  const next = new Set(busyMaterialIds.value)
  next.delete(materialId)
  busyMaterialIds.value = next
}

function operationError(error: unknown, fallback: string): string {
  if (error instanceof BoardApiError) {
    switch (error.code) {
      case 'BOARD_MATERIAL_SVG_INVALID': return t('board.materials_invalid_svg')
      case 'BOARD_MATERIAL_SVG_TOO_LARGE': return t('board.materials_too_large')
      default: break
    }
  }
  return fallback
}

async function refreshAfterUncertain(error: unknown): Promise<void> {
  if (!(error instanceof BoardApiError) || !error.uncertain) return
  try {
    await boardMaterialSource.refresh()
  } catch {
    // Keep the mutation error visible and leave the source retryable.
  }
}

async function loadMaterials(): Promise<void> {
  loading.value = true
  loadError.value = false
  try {
    await boardMaterialSource.ensureLoaded()
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

function startRename(material: BoardMaterial): void {
  if (isBusy(material.id)) return
  editingId.value = material.id
  editingName.value = material.name
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('[data-material-rename-input]')
    input?.focus()
    input?.select()
  })
}

function cancelRename(): void {
  editingId.value = null
  editingName.value = ''
}

async function submitRename(material: BoardMaterial): Promise<void> {
  if (isBusy(material.id)) return
  const name = editingName.value.trim()
  if (!name || name === material.name) {
    cancelRename()
    return
  }
  if (name.length > 80) return
  if (!beginOperation(material.id)) return
  try {
    const renamed = await renameBoardMaterial(material.id, name)
    boardMaterialSource.upsert(renamed)
    cancelRename()
    toast.success(t('board.materials_renamed'))
  } catch (error) {
    await refreshAfterUncertain(error)
    toast.error(operationError(error, t('board.materials_rename_failed')))
  } finally {
    endOperation(material.id)
  }
}

async function archive(material: BoardMaterial): Promise<void> {
  if (!beginOperation(material.id)) return
  try {
    const archived = await archiveBoardMaterial(material.id)
    boardMaterialSource.upsert(archived)
    toast.success(t('board.materials_archived_success'))
  } catch (error) {
    await refreshAfterUncertain(error)
    toast.error(operationError(error, t('board.materials_archive_failed')))
  } finally {
    endOperation(material.id)
  }
}

async function restore(material: BoardMaterial): Promise<void> {
  if (!beginOperation(material.id)) return
  try {
    const restored = await restoreBoardMaterial(material.id)
    boardMaterialSource.upsert(restored)
    toast.success(t('board.materials_restored'))
  } catch (error) {
    await refreshAfterUncertain(error)
    toast.error(operationError(error, t('board.materials_restore_failed')))
  } finally {
    endOperation(material.id)
  }
}

async function permanentlyDelete(material: BoardMaterial): Promise<void> {
  if (isBusy(material.id)) return
  const confirmed = await confirm(
    t('board.materials_delete_title', { name: material.name }),
    t('board.materials_delete_detail'),
    { confirmLabel: t('board.materials_delete'), cancelLabel: t('common.cancel'), destructive: true },
  )
  if (!confirmed) return
  if (!beginOperation(material.id)) return
  try {
    await deleteBoardMaterial(material.id)
    boardMaterialSource.remove(material.id)
    toast.success(t('board.materials_deleted'))
  } catch (error) {
    await refreshAfterUncertain(error)
    toast.error(operationError(error, t('board.materials_delete_failed')))
  } finally {
    endOperation(material.id)
  }
}

function selectMenu(key: string | number, material: BoardMaterial): void {
  if (key === 'rename') startRename(material)
  if (key === 'archive') void archive(material)
  if (key === 'restore') void restore(material)
  if (key === 'delete') void permanentlyDelete(material)
}

function insertMaterial(material: BoardMaterial): void {
  if (material.archived || isBusy(material.id)) return
  emit('insert', material)
}

function resetAddForm(): void {
  selectedFileName.value = ''
  pendingSvg.value = ''
  draftName.value = ''
  addError.value = ''
  if (fileInput.value) fileInput.value.value = ''
}

function openAddModal(): void {
  resetAddForm()
  showAddModal.value = true
}

function closeAddModal(): void {
  if (adding.value) return
  showAddModal.value = false
}

function chooseFile(): void {
  if (!adding.value) fileInput.value?.click()
}

async function onFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  selectedFileName.value = file.name
  addError.value = ''
  if (!file.name.toLocaleLowerCase().endsWith('.svg') && file.type !== 'image/svg+xml') {
    pendingSvg.value = ''
    draftName.value = ''
    addError.value = t('board.materials_invalid_file')
    return
  }
  try {
    const svg = await file.text()
    if (!isBoardMaterialSvg(svg)) {
      pendingSvg.value = ''
      draftName.value = ''
      addError.value = new TextEncoder().encode(svg).byteLength > 2 * 1024 * 1024
        ? t('board.materials_too_large')
        : t('board.materials_invalid_svg')
      return
    }
    pendingSvg.value = svg
    draftName.value = defaultBoardMaterialName(file.name)
  } catch {
    pendingSvg.value = ''
    draftName.value = ''
    addError.value = t('board.materials_invalid_file')
  }
}

function handleAddDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeAddModal()
  }
}

function handleAddNameKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || composing.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void submitAdd()
}

async function submitAdd(): Promise<void> {
  if (adding.value) return
  const name = draftName.value.trim()
  if (!pendingSvg.value) {
    addError.value = t('board.materials_no_file')
    return
  }
  if (!name) {
    addError.value = t('board.materials_invalid_file')
    return
  }
  if (name.length > 80) {
    addError.value = t('board.materials_name_too_long')
    return
  }
  adding.value = true
  addError.value = ''
  try {
    const material = await createBoardMaterial(name, pendingSvg.value)
    boardMaterialSource.upsert(material)
    showAddModal.value = false
    toast.success(t('board.materials_created'))
  } catch (error) {
    await refreshAfterUncertain(error)
    addError.value = operationError(error, t('board.materials_create_failed'))
  } finally {
    adding.value = false
  }
}

onMounted(() => { void loadMaterials() })
</script>

<template>
  <aside
    class="board-material-panel"
    data-testid="board-material-panel"
    data-board-material-panel
    aria-labelledby="board-material-panel-title"
    tabindex="-1"
    @keydown.esc="emit('close')"
  >
    <header class="board-material-panel-header">
      <h2 id="board-material-panel-title">{{ t('board.materials_title') }}</h2>
      <NButton
        class="board-material-close"
        quaternary
        circle
        size="small"
        :aria-label="t('board.materials_close')"
        @click="emit('close')"
      >×</NButton>
    </header>

    <NInput v-model:value="search" clearable :placeholder="t('board.materials_search')" :aria-label="t('board.materials_search')" />
    <div class="board-material-scope" role="tablist" :aria-label="t('board.materials_title')">
      <button
        type="button"
        role="tab"
        :aria-selected="scope === 'active'"
        :class="{ 'is-active': scope === 'active' }"
        @click="scope = 'active'"
      >{{ t('board.materials_all') }}</button>
      <button
        type="button"
        role="tab"
        :aria-selected="scope === 'archived'"
        :class="{ 'is-active': scope === 'archived' }"
        @click="scope = 'archived'"
      >{{ t('board.materials_archived') }}</button>
    </div>

    <div class="board-material-panel-body" aria-live="polite">
      <div v-if="loading" class="board-material-state" role="status">
        <NSpin size="small" />
        <span>{{ t('board.materials_loading') }}</span>
      </div>
      <div v-else-if="loadError" class="board-material-state">
        <p>{{ t('board.materials_load_failed') }}</p>
        <NButton size="small" secondary @click="loadMaterials">{{ t('board.materials_retry') }}</NButton>
      </div>
      <div v-else-if="isEmpty" class="board-material-state">
        <p>{{ search ? t('board.materials_no_match') : (scope === 'archived' ? t('board.materials_archived_empty') : t('board.materials_empty')) }}</p>
        <span v-if="scope === 'active' && !search">{{ t('board.materials_empty_detail') }}</span>
      </div>
      <div v-else class="board-material-grid" role="list">
        <article v-for="material in materials" :key="material.id" class="board-material-card" :data-material-id="material.id" role="listitem">
          <template v-if="editingId === material.id">
            <div class="board-material-edit">
              <img :src="materialPreview(material)" alt="" draggable="false">
              <input
                :data-material-rename-input="material.id"
                v-model="editingName"
                class="board-material-rename-input"
                :aria-label="t('board.materials_name')"
                maxlength="80"
                @compositionstart="composing = true"
                @compositionend="composing = false"
                @keydown="(event) => { if (event.key === 'Escape') { event.preventDefault(); cancelRename() } else if (event.key === 'Enter' && !composing && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void submitRename(material) } }"
                @blur="submitRename(material)"
              >
            </div>
          </template>
          <button
            v-else
            type="button"
            class="board-material-card-open"
            :disabled="material.archived || isBusy(material.id)"
            :aria-label="t('board.materials_insert', { name: material.name })"
            @click="insertMaterial(material)"
          >
            <span class="board-material-preview"><img :src="materialPreview(material)" alt="" draggable="false"></span>
            <span class="board-material-card-footer">
              <strong :title="material.name">{{ material.name }}</strong>
              <small>{{ material.archived ? t('board.materials_archived') : 'SVG' }}</small>
            </span>
          </button>
          <NDropdown :options="menuOptions(material)" size="small" trigger="click" @select="selectMenu($event, material)">
            <NButton
              class="board-material-menu"
              quaternary
              circle
              size="small"
              attr-type="button"
              :disabled="isBusy(material.id)"
              :aria-label="`${t('board.materials_title')}：${material.name}`"
              @click.stop
              @keydown.stop
            >⋯</NButton>
          </NDropdown>
        </article>
      </div>
    </div>

    <footer class="board-material-panel-footer">
      <NButton type="primary" block :disabled="adding" @click="openAddModal">＋ {{ t('board.materials_add') }}</NButton>
    </footer>
  </aside>

  <NModal v-model:show="showAddModal" :mask-closable="false" :auto-focus="false">
    <div class="board-material-add-modal" role="dialog" aria-modal="true" aria-labelledby="board-material-add-title" @keydown="handleAddDialogKeydown">
      <header class="board-material-add-header">
        <h2 id="board-material-add-title">{{ t('board.materials_add_title') }}</h2>
        <NButton quaternary circle size="small" :aria-label="t('board.materials_close')" @keydown.enter.stop.prevent="closeAddModal" @click="closeAddModal">×</NButton>
      </header>
      <input ref="fileInput" class="board-material-file-input" type="file" accept=".svg,image/svg+xml" @change="onFileSelected">
      <NButton data-testid="board-material-choose-file" secondary block :disabled="adding" @keydown.enter.stop @click="chooseFile">{{ selectedFileName || t('board.materials_choose_file') }}</NButton>
      <div v-if="pendingSvg" class="board-material-add-preview"><img :src="boardMaterialPreviewUrl(pendingSvg)" alt=""></div>
      <NInput
        v-model:value="draftName"
        maxlength="80"
        :placeholder="t('board.materials_name_placeholder')"
        :aria-label="t('board.materials_name')"
        :disabled="adding"
        @compositionstart="composing = true"
        @compositionend="composing = false"
        @keydown="handleAddNameKeydown"
      />
      <p v-if="addError" class="board-material-error" role="alert">{{ addError }}</p>
      <div class="board-material-add-actions">
        <NButton data-testid="board-material-add-cancel" :disabled="adding" @keydown.enter.stop.prevent="closeAddModal" @click="closeAddModal">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="adding" @click="submitAdd">{{ adding ? t('board.materials_uploading') : t('board.materials_upload') }}</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.board-material-panel { position: absolute; z-index: 20; top: 16px; left: 16px; display: flex; width: min(420px, calc(100% - 32px)); max-height: calc(100% - 32px); box-sizing: border-box; flex-direction: column; gap: 12px; padding: 14px; overflow: hidden; border: 1px solid var(--border, #d9dce5); border-radius: 14px; background: var(--surface, var(--bg)); color: var(--text); box-shadow: 0 16px 48px rgb(0 0 0 / 18%); }
.board-material-panel-header, .board-material-add-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.board-material-panel-header h2, .board-material-add-header h2 { margin: 0; color: var(--text-h, var(--text)); font-size: 1rem; font-weight: 700; }
.board-material-close { color: var(--text-muted); }
.board-material-scope { display: flex; width: fit-content; align-items: center; gap: 2px; padding: 3px; border: 1px solid color-mix(in srgb, var(--border) 78%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--bg-soft) 65%, transparent); }
.board-material-scope button { min-height: 28px; padding: 3px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; font: inherit; font-size: .78rem; }
.board-material-scope button:hover, .board-material-scope button:focus-visible { color: var(--text); }
.board-material-scope button.is-active { background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--accent); font-weight: 650; }
.board-material-scope button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.board-material-panel-body { min-height: 140px; overflow-y: auto; overscroll-behavior: contain; }
.board-material-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.board-material-card { position: relative; min-width: 0; overflow: hidden; border: 1px solid color-mix(in srgb, var(--border) 78%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--bg-soft) 40%, transparent); }
.board-material-card:hover, .board-material-card:focus-within { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.board-material-card-open { display: flex; width: 100%; min-width: 0; flex-direction: column; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
.board-material-card-open:disabled { cursor: default; opacity: .72; }
.board-material-card-open:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.board-material-preview, .board-material-edit > img { display: grid; width: 100%; aspect-ratio: 1.25; place-items: center; overflow: hidden; background: color-mix(in srgb, var(--accent) 5%, var(--bg-soft)); }
.board-material-preview img, .board-material-edit > img { width: 100%; height: 100%; object-fit: contain; }
.board-material-card-footer { display: flex; min-width: 0; box-sizing: border-box; flex-direction: column; gap: 2px; padding: 8px 30px 8px 9px; }
.board-material-card-footer strong { overflow: hidden; color: var(--text-h, var(--text)); font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.board-material-card-footer small { color: var(--text-muted); font-size: .68rem; }
.board-material-menu { position: absolute; top: 5px; right: 5px; color: var(--text-muted); }
.board-material-menu:hover { color: var(--text-h, var(--text)); }
.board-material-edit { display: flex; min-height: 100%; flex-direction: column; gap: 8px; padding: 8px; }
.board-material-edit > img { aspect-ratio: 1.25; border-radius: 6px; }
.board-material-rename-input { width: 100%; box-sizing: border-box; padding: 6px 7px; border: 1px solid var(--accent); border-radius: 6px; outline: none; background: var(--surface, var(--bg)); color: var(--text); font: inherit; font-size: .78rem; }
.board-material-state { display: grid; min-height: 140px; place-content: center; justify-items: center; gap: 7px; color: var(--text-muted); text-align: center; }
.board-material-state p, .board-material-state span { margin: 0; font-size: .8rem; }
.board-material-error { margin: 0; color: var(--nuvyn-negative, #c43c3c); font-size: .75rem; line-height: 1.4; }
.board-material-panel-footer { padding-top: 2px; }
.board-material-file-input { display: none; }
.board-material-add-modal { display: grid; width: min(380px, calc(100vw - 32px)); box-sizing: border-box; gap: 14px; padding: 18px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface, var(--bg)); color: var(--text); box-shadow: 0 18px 52px rgb(0 0 0 / 22%); }
.board-material-add-preview { display: grid; height: 150px; place-items: center; overflow: hidden; border: 1px solid color-mix(in srgb, var(--border) 72%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--accent) 5%, var(--bg-soft)); }
.board-material-add-preview img { width: 100%; height: 100%; object-fit: contain; }
.board-material-add-actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 520px) { .board-material-panel { top: 8px; left: 8px; width: calc(100% - 16px); max-height: calc(100% - 16px); } }
</style>
