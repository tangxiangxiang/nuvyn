<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NDropdown, NIcon, type DropdownOption } from 'naive-ui'
import { Dots, Folder } from '@vicons/tabler'
import type { BoardFolderSummary } from '../../../shared/boardProtocol'
import { useI18n } from '../../composables/useI18n'

const props = withDefaults(defineProps<{
  folders?: readonly BoardFolderSummary[]
  dragOverFolderId?: string | null
}>(), {
  folders: () => [],
  dragOverFolderId: null,
})

const { t } = useI18n()
const menuOptions = computed<DropdownOption[]>(() => [
  { label: t('board.rename_folder'), key: 'rename' },
  { label: t('board.delete_folder'), key: 'delete' },
])

const emit = defineEmits<{
  open: [folder: BoardFolderSummary]
  rename: [folder: BoardFolderSummary]
  delete: [folder: BoardFolderSummary]
  dragenter: [folder: BoardFolderSummary, event: DragEvent]
  dragover: [folder: BoardFolderSummary, event: DragEvent]
  dragleave: [folder: BoardFolderSummary, event: DragEvent]
  drop: [folder: BoardFolderSummary, event: DragEvent]
}>()

function selectMenu(key: string | number, folder: BoardFolderSummary): void {
  if (key === 'rename') emit('rename', folder)
  if (key === 'delete') emit('delete', folder)
}

function onDragEnter(event: DragEvent, folder: BoardFolderSummary): void {
  event.preventDefault()
  emit('dragenter', folder, event)
}

function onDragOver(event: DragEvent, folder: BoardFolderSummary): void {
  event.preventDefault()
  emit('dragover', folder, event)
}

function onDragLeave(event: DragEvent, folder: BoardFolderSummary): void {
  const currentTarget = event.currentTarget
  const relatedTarget = event.relatedTarget
  if (currentTarget instanceof Node && relatedTarget instanceof Node && currentTarget.contains(relatedTarget)) return
  emit('dragleave', folder, event)
}

function onDrop(event: DragEvent, folder: BoardFolderSummary): void {
  event.preventDefault()
  emit('drop', folder, event)
}
</script>

<template>
  <section v-if="props.folders.length" class="board-folder-section" aria-labelledby="board-folders-heading">
    <div class="board-folder-heading">
      <h3 id="board-folders-heading" class="board-subsection-label">{{ t('board.folders') }}</h3>
    </div>
    <div class="board-folder-grid">
      <article
        v-for="folder in props.folders"
        :key="folder.id"
        :class="{ 'is-drag-over': props.dragOverFolderId === folder.id }"
        class="board-folder-card"
        :data-folder-id="folder.id"
        @dragenter="onDragEnter($event, folder)"
        @dragover="onDragOver($event, folder)"
        @dragleave="onDragLeave($event, folder)"
        @drop="onDrop($event, folder)"
      >
        <button type="button" class="board-folder-open" @click="emit('open', folder)">
          <NIcon class="board-folder-icon" aria-hidden="true"><Folder /></NIcon>
          <span class="board-folder-copy">
            <strong class="board-folder-name">{{ folder.name }}</strong>
            <span class="board-folder-count">{{ folder.boardCount }} {{ t('board.folder_count') }}</span>
          </span>
        </button>
        <NDropdown :options="menuOptions" size="small" trigger="click" @select="selectMenu($event, folder)">
          <NButton
            class="board-folder-menu"
            attr-type="button"
            size="small"
            quaternary
            :bordered="false"
            :aria-label="t('board.folder_menu', { name: folder.name })"
            :title="t('board.folder_menu', { name: folder.name })"
            @click.stop
            @keydown.stop
          >
            <NIcon aria-hidden="true"><Dots /></NIcon>
          </NButton>
        </NDropdown>
      </article>
    </div>
  </section>
</template>

<style scoped>
.board-folder-section { min-width: 0; }
.board-folder-heading { display: flex; min-height: 34px; margin: 14px 0 10px; align-items: center; }
.board-subsection-label { margin: 0; color: var(--text-muted); font-size: .82rem; font-weight: 650; letter-spacing: .01em; }
.board-folder-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; }
.board-folder-card {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 58px;
  box-sizing: border-box;
  align-items: center;
  gap: 10px;
  padding: 10px 42px 10px 12px;
  border: 1px solid color-mix(in srgb, var(--border) 64%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-soft) 32%, transparent);
  color: var(--text);
  outline: none;
  transition: border-color .15s ease, background .15s ease, transform .15s ease;
}
.board-folder-card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 5%, var(--bg-soft));
}
.board-folder-card:hover { transform: translateY(-1px); }
.board-folder-card.is-drag-over {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-soft));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
  transform: translateY(-1px);
}
.board-folder-open {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  outline: none;
}
.board-folder-open:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.board-folder-icon { flex: none; color: var(--accent); font-size: 20px; }
.board-folder-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.board-folder-name { overflow: hidden; color: var(--text-h); font-size: .84rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.board-folder-count { overflow: hidden; color: var(--text-muted); font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
.board-folder-menu { position: absolute; top: 50%; right: 8px; min-width: 30px; min-height: 30px; padding: 0; border-radius: 7px; color: var(--text-muted); transform: translateY(-50%); }
.board-folder-menu:hover { background: var(--bg-soft); color: var(--text-h); }
.board-folder-menu:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.board-folder-menu :deep(.n-icon) { font-size: 18px; }
@media (max-width: 1279px) { .board-folder-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 1023px) { .board-folder-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 767px) { .board-folder-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .board-folder-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
