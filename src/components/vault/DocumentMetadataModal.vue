<script setup lang="ts">
import { NButton } from 'naive-ui'
import { onBeforeUnmount, ref, watch } from 'vue'
import type { DocumentMetadata } from '../../lib/api'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { useI18n } from '../../composables/useI18n'
import DocumentMetadataForm from './DocumentMetadataForm.vue'

const props = defineProps<{ open: boolean; path: string | null }>()
const emit = defineEmits<{ close: []; saved: [metadata: DocumentMetadata] }>()

const trap = useFocusTrap()
const { t } = useI18n()
const modalRef = ref<HTMLElement | null>(null)

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  } else if (event.key === 'Tab') {
    trap.onTab(() => modalRef.value, event)
  }
}

watch(() => [props.open, props.path] as const, ([open]) => {
  if (open) {
    trap.activate()
  } else {
    void trap.deactivate()
  }
}, { immediate: true })

onBeforeUnmount(() => { void trap.deactivate() })
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="document-metadata-backdrop"
      role="presentation"
      tabindex="-1"
      @click.self="emit('close')"
      @keydown="onKeydown"
    >
      <div
        ref="modalRef"
        class="document-metadata-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="t('metadata.title')"
      >
        <header class="document-metadata-header">
          <div>
            <h2>{{ t('metadata.title') }}</h2>
            <span>{{ path }}</span>
          </div>
          <NButton attr-type="button" text :bordered="false" class="document-metadata-close" :aria-label="t('metadata.close')" :title="t('metadata.close')" @click="emit('close')">×</NButton>
        </header>

        <DocumentMetadataForm
          :path="path"
          :enabled="open"
          autofocus
          @cancel="emit('close')"
          @saved="emit('saved', $event)"
        />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.document-metadata-backdrop { position: fixed; inset: 0; z-index: 9200; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 0.42); }
.document-metadata-modal { width: min(560px, 100%); max-height: min(720px, calc(100vh - 40px)); overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); box-shadow: 0 16px 48px rgb(0 0 0 / 0.28); }
.document-metadata-header { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 18px; border-bottom: 1px solid var(--border); }
.document-metadata-header h2 { margin: 0; font-size: 0.98rem; letter-spacing: 0; }
.document-metadata-header span { display: block; max-width: 440px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font: 0.72rem var(--mono); }
.document-metadata-close { width: 28px; height: 28px; border: 0; border-radius: 4px; background: transparent; color: var(--text-muted); font-size: 1.25rem; cursor: pointer; }
.document-metadata-close:hover { background: var(--bg-soft); color: var(--text); }
@media (max-width: 600px) { .document-metadata-backdrop { align-items: end; padding: 0; } .document-metadata-modal { width: 100%; max-height: 88vh; border-radius: 6px 6px 0 0; } }
</style>
