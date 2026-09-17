<script setup lang="ts">
/* The activity-bar buttons drive the side panels. Links used to be
   one of them (a 4-button row); it has been moved to live below the
   TOC in the read-mode right rail, so it's gone from here.

   The History button carries a small numeric badge when there are
   dirty files in the working tree. The count comes from the
   vault-scoped useHistory instance (which subscribes to the file-change bus)
   so the badge updates live as the user saves tabs. */
import { NButton, NIcon } from 'naive-ui'
import { Folder, GitBranch, Tag } from '@vicons/tabler'
import { useHistory } from '../../composables/vault/useHistory.js'
import { useI18n } from '../../composables/useI18n'
export type SidePanel = 'files' | 'tags' | 'history' | 'recovery'

defineProps<{ activePanel: SidePanel | null }>()
const emit = defineEmits<{
  'select-panel': [panel: SidePanel]
}>()

const h = useHistory()
const { t } = useI18n()
</script>

<template>
  <aside class="activity-bar" :aria-label="t('activity.label')">
    <NButton
      attr-type="button"
      text
      :bordered="false"
      class="ab-btn"
      :class="{ active: activePanel === 'files' }"
      :title="t('activity.explorer')"
      :aria-label="t('activity.explorer')"
      :aria-pressed="activePanel === 'files'"
      @click="emit('select-panel', 'files')"
    >
      <NIcon class="ab-btn-icon" aria-hidden="true"><Folder /></NIcon>
    </NButton>
    <NButton
      attr-type="button"
      text
      :bordered="false"
      class="ab-btn"
      :class="{ active: activePanel === 'tags' }"
      :title="t('activity.tags')"
      :aria-label="t('activity.tags')"
      :aria-pressed="activePanel === 'tags'"
      @click="emit('select-panel', 'tags')"
    >
      <NIcon class="ab-btn-icon" aria-hidden="true"><Tag /></NIcon>
    </NButton>
    <NButton
      attr-type="button"
      text
      :bordered="false"
      class="ab-btn ab-btn-history"
      :class="{ active: activePanel === 'history' }"
      :title="t('history.activity_label')"
      :aria-label="t('history.activity_label')"
      :aria-pressed="activePanel === 'history'"
      @click="emit('select-panel', 'history')"
    >
      <NIcon class="ab-btn-icon" aria-hidden="true"><GitBranch /></NIcon>
      <span
        v-if="h.dirtyCount.value > 0"
        class="ab-status-dot"
        role="img"
        :aria-label="t('history.changed_files', { count: h.dirtyCount.value })"
      />
    </NButton>
  </aside>
</template>
