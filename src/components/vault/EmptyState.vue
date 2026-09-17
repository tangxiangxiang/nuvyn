<script setup lang="ts">
// Shared "the main surface is empty" affordance.
//
// Used wherever a panel would otherwise render a blank area:
//   - VaultView (edit / read mode when no tabs are open)
//   - HistoryPanel (git missing / repo not initialized)
//
// All visual rules live in src/style.css (`.empty-state*` block) so
// the component stays portable and the `--vs-*` token usage stays
// scoped to the `.vault` consumer. The component deliberately has no
// `<style>` block — see the css comment near the matching rules.
//
// Inline list-level empties (FileTree `.empty`, TagPanel `.empty`,
// AiSessionPicker
// `.ai-sp-empty`, ReadingPane `.reading-empty`) are intentionally NOT
// migrated — they're 1-line italic stubs inside an already-mounted
// list, semantically different from "the whole surface is empty".

defineProps<{
  /** Bold headline. Single line. */
  title: string
  /** `'normal'` for the centered hero card (VaultView main pane),
   *  `'compact'` for narrow side-pane wrappers such as HistoryPanel. */
  size?: 'normal' | 'compact'
}>()
</script>

<template>
  <div class="empty-state" :class="size === 'compact' && 'empty-state--compact'">
    <div class="empty-state-title">{{ title }}</div>
    <div v-if="$slots.default" class="empty-state-hint">
      <slot />
    </div>
  </div>
</template>
