<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NModal, NRadio, NRadioGroup, NSpace, NText } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import type { DocumentExportFormat } from '../../lib/documentExport'

const props = defineProps<{ show: boolean; busy: boolean }>()
const emit = defineEmits<{ close: []; export: [format: DocumentExportFormat] }>()
const { t } = useI18n()
const format = ref<DocumentExportFormat>('markdown')
watch(() => props.show, (show) => { if (show) format.value = 'markdown' })
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="t('document_export.title')"
    class="document-export-dialog"
    :closable="!busy"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    @update:show="(value) => { if (!value && !busy) emit('close') }"
  >
    <NRadioGroup v-model:value="format" :disabled="busy" role="radiogroup" :aria-label="t('document_export.format')">
      <NSpace vertical :size="16">
        <div>
          <NRadio value="markdown">{{ t('document_export.markdown') }}</NRadio>
          <p class="document-export-description"><NText depth="3">{{ t('document_export.markdown_description') }}</NText></p>
          <p class="document-export-description"><NText depth="3">{{ t('document_export.no_attachments') }}</NText></p>
        </div>
        <div>
          <NRadio value="html">{{ t('document_export.html') }}</NRadio>
          <p class="document-export-description"><NText depth="3">{{ t('document_export.html_description') }}</NText></p>
        </div>
        <div>
          <NRadio value="pdf">{{ t('document_export.pdf') }}</NRadio>
          <p class="document-export-description"><NText depth="3">{{ t('document_export.pdf_description') }}</NText></p>
        </div>
      </NSpace>
    </NRadioGroup>
    <template #footer>
      <NSpace justify="end">
        <NButton :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="busy" :disabled="busy" @click="emit('export', format)">
          {{ t(busy ? 'document_export.exporting' : 'document_export.export') }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.document-export-dialog { width: min(440px, calc(100vw - 28px)); }
.document-export-description { margin: 6px 0 0 24px; font-size: 0.8rem; }
</style>
