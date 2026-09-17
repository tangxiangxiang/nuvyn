<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NDropdown, NIcon, type DropdownOption } from 'naive-ui'
import { Dots } from '@vicons/tabler'
import type { BoardMetadata } from '../../../shared/boardProtocol'
import { boardAssetUrl } from '../../features/board/api'
import { useI18n } from '../../composables/useI18n'
import { nuvynBoardDragMime } from '../../technicalNamespace'

const props = withDefaults(defineProps<{
  board: BoardMetadata
  favorite?: boolean
  busy?: boolean
  draggable?: boolean
}>(), {
  favorite: false,
  busy: false,
  draggable: true,
})

const emit = defineEmits<{
  open: [board: BoardMetadata]
  favorite: [board: BoardMetadata]
  move: [board: BoardMetadata]
  rename: [board: BoardMetadata]
  delete: [board: BoardMetadata]
  dragstart: [board: BoardMetadata, event: DragEvent]
  dragend: [board: BoardMetadata, event: DragEvent]
}>()

const { t } = useI18n()
const thumbnailFailed = ref(false)
const isDragging = ref(false)
const menuOptions = computed<DropdownOption[]>(() => [
  { label: props.favorite ? t('board.unfavorite') : t('board.favorite'), key: 'favorite' },
  { label: t('board.move_to_folder'), key: 'move' },
  { label: t('board.rename'), key: 'rename' },
  { label: t('board.delete'), key: 'delete' },
])
const thumbnailUrl = computed(() => props.board.thumbnailAssetId
  ? boardAssetUrl(props.board.thumbnailAssetId)
  : '')
const updatedLabel = computed(() => {
  const date = new Date(props.board.updatedAt)
  if (Number.isNaN(date.getTime())) return String(props.board.updatedAt)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
})

watch(() => props.board.thumbnailAssetId, () => { thumbnailFailed.value = false })

function selectMenu(key: string | number): void {
  if (key === 'favorite') emit('favorite', props.board)
  if (key === 'move') emit('move', props.board)
  if (key === 'rename') emit('rename', props.board)
  if (key === 'delete') emit('delete', props.board)
}

function onDragStart(event: DragEvent): void {
  if (!props.draggable || props.busy) {
    event.preventDefault()
    return
  }
  if (event.dataTransfer) {
  event.dataTransfer.setData(nuvynBoardDragMime('board-id'), props.board.id)
    event.dataTransfer.effectAllowed = 'move'
  }
  isDragging.value = true
  emit('dragstart', props.board, event)
}

function onDragEnd(event: DragEvent): void {
  isDragging.value = false
  emit('dragend', props.board, event)
}
</script>

<template>
  <article
    :class="['board-card', { 'is-busy': busy, 'is-dragging': isDragging }]"
    :data-board-id="board.id"
    :draggable="draggable && !busy"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
  >
    <button
      class="board-card-open"
      type="button"
      :aria-label="t('board.open', { title: board.title })"
      :disabled="busy"
      @click="emit('open', board)"
    >
      <span class="board-card-thumbnail" aria-hidden="true">
        <img
          v-if="thumbnailUrl && !thumbnailFailed"
          :src="thumbnailUrl"
          :alt="t('board.thumbnail_alt', { title: board.title })"
          loading="lazy"
          @error="thumbnailFailed = true"
        />
        <span v-else class="board-card-placeholder">{{ board.title.slice(0, 1).toUpperCase() || 'B' }}</span>
      </span>
      <span class="board-card-copy">
        <strong class="board-card-title" data-testid="board-card-title" :title="board.title">{{ board.title }}</strong>
        <span class="board-card-updated" :title="t('board.updated', { date: updatedLabel })">{{ t('board.updated', { date: updatedLabel }) }}</span>
      </span>
    </button>
    <NDropdown :options="menuOptions" size="small" trigger="click" @select="selectMenu">
      <NButton
        class="board-card-menu"
        attr-type="button"
        size="small"
        quaternary
        :bordered="false"
        :disabled="busy"
        :aria-label="t('board.card_menu', { title: board.title })"
        :title="t('board.card_menu', { title: board.title })"
        @click.stop
        @dragstart.prevent.stop
      >
        <NIcon aria-hidden="true"><Dots /></NIcon>
      </NButton>
    </NDropdown>
  </article>
</template>

<style scoped>
.board-card {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 14px;
  background: var(--bg);
  box-shadow: none;
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
}
.board-card:hover,
.board-card:focus-within {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  box-shadow: 0 4px 12px color-mix(in srgb, var(--text-h) 7%, transparent);
  transform: translateY(-1px);
}
.board-card.is-busy { opacity: .64; }
.board-card.is-dragging { opacity: .52; cursor: grabbing; }
.board-card[draggable="true"] { cursor: grab; }
.board-card[draggable="true"]:active { cursor: grabbing; }
.board-card-open {
  display: flex;
  width: 100%;
  min-width: 0;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.board-card-open:disabled { cursor: default; }
.board-card-open:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
.board-card-thumbnail {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 11px;
  background-color: var(--bg-soft);
  background-image:
    linear-gradient(color-mix(in srgb, var(--accent) 3%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 3%, transparent) 1px, transparent 1px),
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, var(--bg-soft)), var(--bg-soft));
  background-size: 18px 18px, 18px 18px, 100% 100%;
  color: var(--accent);
}
.board-card-open {
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 0;
}
.board-card-thumbnail {
  width: calc(100% - 24px);
  margin: 12px 12px 0;
  aspect-ratio: 16 / 10;
}
.board-card-thumbnail img { display: block; width: 100%; height: 100%; object-fit: contain; }
.board-card-placeholder { color: color-mix(in srgb, var(--accent) 75%, var(--text-muted)); font-size: 1.5rem; font-weight: 600; line-height: 1; opacity: .78; }
.board-card-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  flex: none;
  padding: 12px 46px 14px 14px;
  border-top: 1px solid color-mix(in srgb, var(--border) 62%, transparent);
}
.board-card-title { overflow: hidden; color: var(--text-h); font-size: .94rem; font-weight: 650; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
.board-card-updated { overflow: hidden; color: var(--text-muted); font-size: .78rem; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
.board-card-menu {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 1;
  min-width: 30px;
  min-height: 30px;
  padding: 0;
  border-radius: 7px;
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  color: var(--text-muted);
  opacity: .68;
  transition: opacity .15s ease, color .15s ease, background .15s ease;
}
.board-card-menu:focus-visible { opacity: 1; outline: 2px solid var(--accent); outline-offset: 1px; }
.board-card-menu:hover { background: var(--bg-soft); color: var(--text-h); opacity: 1; }
.board-card-menu :deep(.n-icon) { font-size: 18px; }
@media (hover: hover) and (pointer: fine) {
  .board-card-menu { opacity: 0; }
  .board-card:hover .board-card-menu,
  .board-card:focus-within .board-card-menu { opacity: .82; }
}
@media (max-width: 600px) {
  .board-card-thumbnail { width: calc(100% - 20px); margin: 10px 10px 0; }
  .board-card-copy { padding: 12px 42px 14px 12px; }
}
</style>
