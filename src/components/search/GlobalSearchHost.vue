<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CommandPalette from '../vault/CommandPalette.vue'
import { createDocumentSearchProvider, type SearchResult } from '../../lib/searchResults'
import { documentSearchSource } from '../../lib/documentSearchSource'
import { boardMetadataSource } from '../../features/board/boardMetadataSource'
import { createBoardSearchProvider, type BoardSearchPayload } from '../../features/board/searchProvider'
import { isNuvynShortcutBlocked } from '../../lib/keyboard'
import { workspaceKindForPath, type WorkspaceKind } from '../../lib/workspace'

const router = useRouter()
const route = useRoute()
const paletteRef = ref<InstanceType<typeof CommandPalette> | null>(null)
const documentProvider = createDocumentSearchProvider(documentSearchSource)
const boardProvider = createBoardSearchProvider(boardMetadataSource)
const workspaceKind = computed<WorkspaceKind>(() => (
  route.meta.workspaceKind !== undefined
    ? route.meta.workspaceKind
    : workspaceKindForPath(route.path)
))
const providers = computed(() => {
  if (workspaceKind.value === 'board') return [boardProvider]
  if (workspaceKind.value === 'vault') return [documentProvider]
  return []
})
const canOpen = computed(() => (
  route.meta.workspace === true
  && route.meta.chromeStyle !== 'immersive'
  && workspaceKind.value !== 'ledger'
))

function show(): void {
  if (!canOpen.value) return
  paletteRef.value?.show()
}

function hide(): void {
  paletteRef.value?.hide()
}

watch(canOpen, (allowed) => {
  if (!allowed) hide()
})

function commit(result: SearchResult): void {
  if (result.type === 'file') {
    const path = (result.payload as { path?: unknown }).path
    if (typeof path === 'string' && path.length > 0) {
      void router.push({ name: 'vault-doc', params: { pathMatch: path.split('/') } })
    }
    return
  }
  if (result.type === 'board') {
    const boardId = (result.payload as Partial<BoardSearchPayload>).boardId
    if (typeof boardId === 'string' && boardId.length > 0) {
      void router.push({ name: 'board-editor', params: { boardId } })
    }
  }
}

function onKeydown(event: KeyboardEvent): void {
  const modifier = event.metaKey || event.ctrlKey
  if (!isNuvynShortcutBlocked(event) && canOpen.value && modifier && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    show()
  }
}

watch([boardMetadataSource.snapshot, documentSearchSource.snapshot], () => {
  if (paletteRef.value) void paletteRef.value.refresh()
}, { deep: false })

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

defineExpose({ show, hide })
</script>

<template>
  <CommandPalette
    ref="paletteRef"
    :providers="providers"
    :keyboard-shortcut="false"
    :allow-create="false"
    @commit="commit"
  />
</template>
