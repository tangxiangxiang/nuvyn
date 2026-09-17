<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { DraftRecoveryItem } from '../../composables/vault/draft-recovery/useUnsavedDraftRecovery'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  item: Readonly<DraftRecoveryItem> | null
  busy?: boolean
}>()
const emit = defineEmits<{
  restore: [recoveryId: string]
  diff: [recoveryId: string]
  content: [recoveryId: string]
  disk: [recoveryId: string]
  discard: [recoveryId: string]
  later: [recoveryId: string]
  retry: [recoveryId: string]
  manage: []
}>()
const { t } = useI18n()
const heading = ref<HTMLElement | null>(null)
const kind = computed(() => props.item?.decision?.kind ?? null)
const diskReady = computed(() => props.item?.decision?.disk.status === 'ready')
const diskUnreadable = computed(() => props.item?.decision?.disk.status === 'unreadable')
const isConflict = computed(() => props.item?.source === 'conflict')

watch(() => props.item?.recoveryId, async (id) => {
  if (!id) return
  await nextTick()
  heading.value?.focus()
}, { immediate: true })

function later(): void {
  if (props.item) emit('later', props.item.recoveryId)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.item) return
  event.preventDefault()
  later()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="item"
      class="draft-recovery-backdrop"
      @keydown="onKeydown"
    >
      <section
        class="draft-recovery-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="`draft-recovery-title-${item.recoveryId}`"
        :aria-busy="busy || item.status === 'loading' || undefined"
      >
        <h2
          :id="`draft-recovery-title-${item.recoveryId}`"
          ref="heading"
          tabindex="-1"
        >
          {{ t('draft_recovery.title') }}
        </h2>
        <p class="draft-recovery-path">{{ item.draft.documentPath }}</p>
        <p v-if="item.status === 'loading'">{{ t('draft_recovery.loading') }}</p>
        <p v-else-if="item.status === 'error'" role="alert">
          {{ t('draft_recovery.classify_failed') }}
        </p>
        <p v-else-if="kind === 'baseline-match'">
          {{ t('draft_recovery.baseline_match') }}
        </p>
        <p v-else-if="kind === 'missing-source'">
          {{ t('draft_recovery.missing_source') }}
        </p>
        <p v-else-if="kind === 'identity-mismatch'">
          {{ t('draft_recovery.identity_mismatch') }}
        </p>
        <p v-else>
          {{ t('draft_recovery.divergent') }}
        </p>

        <div class="draft-recovery-actions">
          <NButton
            v-if="item.status === 'error'"
            attr-type="button"
            :bordered="false"
            :disabled="busy"
            @click="emit('retry', item.recoveryId)"
          >
            {{ t('draft_recovery.retry') }}
          </NButton>
          <template v-else-if="item.status === 'ready'">
            <NButton
              v-if="kind === 'baseline-match' && !isConflict"
              attr-type="button"
              :bordered="false"
              :disabled="busy"
              @click="emit('restore', item.recoveryId)"
            >
              {{ t('draft_recovery.restore') }}
            </NButton>
            <NButton
              v-if="(kind === 'divergent' || kind === 'unknown') && diskReady"
              attr-type="button"
              :bordered="false"
              :disabled="busy"
              @click="emit('diff', item.recoveryId)"
            >
              {{ t('draft_recovery.view_diff') }}
            </NButton>
            <NButton
              v-if="kind === 'unknown' && diskUnreadable"
              attr-type="button"
              :bordered="false"
              :disabled="busy"
              @click="emit('retry', item.recoveryId)"
            >
              {{ t('draft_recovery.retry') }}
            </NButton>
            <NButton
              v-if="kind !== 'baseline-match' || isConflict"
              attr-type="button"
              :bordered="false"
              :disabled="busy"
              @click="emit('content', item.recoveryId)"
            >
              {{ t('draft_recovery.open_content') }}
            </NButton>
            <NButton
              v-if="!isConflict && (kind === 'baseline-match' || kind === 'divergent' || kind === 'unknown')"
              attr-type="button"
              :bordered="false"
              :disabled="busy"
              @click="emit('disk', item.recoveryId)"
            >
              {{ t('draft_recovery.use_disk') }}
            </NButton>
            <NButton
              v-else
              attr-type="button"
              :bordered="false"
              :disabled="busy"
              @click="emit('discard', item.recoveryId)"
            >
              {{ t('draft_recovery.discard') }}
            </NButton>
          </template>
          <NButton attr-type="button" :bordered="false" :disabled="busy" @click="later">
            {{ t('draft_recovery.later') }}
          </NButton>
          <NButton attr-type="button" :bordered="false" :disabled="busy" @click="emit('manage')">
            {{ t('draft_recovery.open_list') }}
          </NButton>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.draft-recovery-backdrop {
  position: fixed;
  inset: 0;
  z-index: 14000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 42%);
}

.draft-recovery-dialog {
  width: min(520px, 100%);
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-primary);
  color: var(--text-primary);
  box-shadow: 0 18px 60px rgb(0 0 0 / 30%);
}

.draft-recovery-dialog h2 { margin: 0 0 8px; }
.draft-recovery-path { color: var(--text-secondary); overflow-wrap: anywhere; }
.draft-recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.draft-recovery-actions button { min-height: 34px; }
</style>
