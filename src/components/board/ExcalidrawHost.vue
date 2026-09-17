<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  ExcalidrawIslandHandle,
  ExcalidrawIslandLangCode,
  ExcalidrawIslandTheme,
  BoardEditorMenuOptions,
} from '../../features/board/engine/excalidraw/reactIsland'
import type { BoardRuntimeAsset, ExcalidrawRuntimeScene } from '../../features/board/engine/types'
import type { BoardMaterial } from '../../../shared/boardMaterialProtocol'

const props = withDefaults(defineProps<{
  initialScene: ExcalidrawRuntimeScene
  theme?: ExcalidrawIslandTheme
  langCode?: ExcalidrawIslandLangCode
  editorMenu?: BoardEditorMenuOptions
}>(), {
  theme: 'light',
  langCode: 'en',
})

const emit = defineEmits<{
  change: [scene: ExcalidrawRuntimeScene]
  assetsChanged: [assets: readonly BoardRuntimeAsset[]]
  assetError: [error: unknown]
  librarySaveError: [error: unknown]
  ready: []
  error: [error: unknown]
}>()

const host = ref<HTMLElement | null>(null)
let island: ExcalidrawIslandHandle | null = null
let mountGeneration = 0

onMounted(() => {
  const generation = ++mountGeneration

  void import('../../features/board/engine/excalidraw/reactIsland').then(async (module) => {
    if (generation !== mountGeneration || !host.value) return

    const nextIsland = await module.mountExcalidrawIsland({
      container: host.value,
      initialScene: props.initialScene,
      theme: props.theme,
      langCode: props.langCode,
      editorMenu: props.editorMenu,
      onChange: (scene) => emit('change', scene),
      onAssetsChanged: (assets) => emit('assetsChanged', assets),
      onAssetError: (error) => emit('assetError', error),
      onLibrarySaveError: (error) => emit('librarySaveError', error),
      onReady: () => emit('ready'),
      onError: (error) => emit('error', error),
    })

    if (generation !== mountGeneration) {
      nextIsland.unmount()
      return
    }

    island = nextIsland
  }).catch((error: unknown) => {
    if (generation === mountGeneration) emit('error', error)
  })
})

watch([() => props.theme, () => props.langCode, () => props.editorMenu], ([theme, langCode, editorMenu]) => {
  island?.update({ theme, langCode, editorMenu })
})

onBeforeUnmount(() => {
  mountGeneration += 1
  island?.unmount()
  island = null
})

async function insertMaterial(material: BoardMaterial): Promise<void> {
  if (!island) throw new Error('Excalidraw is not ready')
  await island.insertSvgMaterial(material)
}

defineExpose({ insertMaterial })
</script>

<template>
  <div
    ref="host"
    class="excalidraw-host"
    data-testid="excalidraw-host"
    data-board-excalidraw-root
  />
</template>

<style scoped>
.excalidraw-host {
  width: 100%;
  height: 100%;
  min-height: 32rem;
}

.excalidraw-host :deep(.excalidraw) {
  width: 100%;
  height: 100%;
}
</style>
