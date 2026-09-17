<script setup lang="ts">
import type { DiaryPresentationMode } from '../../composables/diary/useDiaryWorkspacePresentation'

const props = defineProps<{
  eligible: boolean
  mode: DiaryPresentationMode
  visible: boolean
}>()
</script>

<template>
  <section
    v-show="props.visible"
    class="diary-workspace-shell"
    data-testid="diary-workspace-shell"
    :data-presentation-mode="props.mode"
    :data-presentation-eligible="props.eligible ? 'true' : 'false'"
    :aria-hidden="props.visible ? undefined : 'true'"
  >
    <!-- Calendar Home is the only Diary-owned surface. The scope-only parent
         v-if keeps this subtree mounted while native Vault documents show. -->
    <div
      v-show="props.visible && props.eligible && props.mode === 'home'"
      class="diary-workspace-home"
      data-testid="diary-workspace-home"
    >
      <slot name="home" />
    </div>
  </section>
</template>

<style scoped>
.diary-workspace-shell,
.diary-workspace-home {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}
</style>
