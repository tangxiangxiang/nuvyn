<script setup lang="ts">
import { computed } from 'vue'
import BoardCard from './BoardCard.vue'
import type { BoardMetadata } from '../../../shared/boardProtocol'

type BoardGalleryLayout = 'grid'

const props = withDefaults(defineProps<{
  boards: readonly BoardMetadata[]
  layout?: BoardGalleryLayout
  favoriteBoardIds?: readonly string[]
  busyBoardIds?: readonly string[]
  draggable?: boolean
}>(), {
  layout: 'grid',
  favoriteBoardIds: () => [],
  busyBoardIds: () => [],
  draggable: true,
})

const layout = computed<BoardGalleryLayout>(() => props.layout)

const emit = defineEmits<{
  open: [board: BoardMetadata]
  favorite: [board: BoardMetadata]
  move: [board: BoardMetadata]
  rename: [board: BoardMetadata]
  delete: [board: BoardMetadata]
  dragstart: [board: BoardMetadata, event: DragEvent]
  dragend: [board: BoardMetadata, event: DragEvent]
}>()

function emitDragStart(board: BoardMetadata, event: DragEvent): void {
  emit('dragstart', board, event)
}

function emitDragEnd(board: BoardMetadata, event: DragEvent): void {
  emit('dragend', board, event)
}
</script>

<template>
  <div :class="['board-gallery', `is-${layout}`]">
    <BoardCard
      v-for="board in boards"
      :key="board.id"
      :board="board"
      :favorite="favoriteBoardIds.includes(board.id)"
      :busy="busyBoardIds.includes(board.id)"
      :draggable="draggable"
      @open="emit('open', $event)"
      @favorite="emit('favorite', $event)"
      @move="emit('move', $event)"
      @rename="emit('rename', $event)"
      @delete="emit('delete', $event)"
      @dragstart="emitDragStart"
      @dragend="emitDragEnd"
    />
  </div>
</template>

<style scoped>
.board-gallery {
  display: grid;
  min-width: 0;
  gap: 16px;
}
.board-gallery.is-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
@media (max-width: 1279px) {
  .board-gallery.is-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (max-width: 1023px) {
  .board-gallery.is-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 767px) {
  .board-gallery.is-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .board-gallery.is-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
