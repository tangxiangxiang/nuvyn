<script setup lang="ts">
import { useI18n } from '../../composables/useI18n'
import { NButton } from 'naive-ui'
import type { FrontmatterCleanupPreview, MetadataMigrationSummary } from '../../lib/api'

/* The metadata section is presentational — async side effects
   (confirm dialogs, toasts, change publishing) live in the parent so
   this component stays unaware of the toast / confirm / vault-context
   machinery. The parent hands down the callbacks and the section
   only decides when to fire them. */

defineProps<{
  migrationSummary: MetadataMigrationSummary | null
  cleanupPreview: FrontmatterCleanupPreview | null
  cleanedPaths: string[]
  previewing: boolean
  mutatingMetadata: boolean
}>()

const emit = defineEmits<{
  preview: []
  restore: []
  remove: []
}>()

const { t } = useI18n()
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-metadata-title">
    <header class="settings-section-header">
      <div>
        <h3 id="settings-metadata-title">{{ t('settings.metadata') }}</h3>
        <p>{{ t('settings.metadata_subtitle') }}</p>
      </div>
      <div class="settings-section-actions">
        <NButton attr-type="button" size="medium" class="btn" :bordered="false" :disabled="previewing" @click="emit('preview')">
          {{ t(previewing ? 'settings.checking' : 'settings.check_cleanup') }}
        </NButton>
      </div>
    </header>
    <div class="settings-section-body">
      <div v-if="migrationSummary" class="settings-card" aria-labelledby="settings-migration-status-title">
        <h4 id="settings-migration-status-title" class="settings-card-title">
          {{ t('settings.migration_status') }}
        </h4>
        <div class="settings-metadata-stats">
          <span><strong>{{ migrationSummary.verified }}</strong> {{ t('settings.verified') }}</span>
          <span><strong>{{ migrationSummary.cleaned }}</strong> {{ t('settings.cleaned') }}</span>
          <span :class="{ danger: migrationSummary.failed > 0 }">
            <strong>{{ migrationSummary.failed }}</strong> {{ t('settings.failed') }}
          </span>
        </div>
      </div>
      <div v-if="cleanupPreview" class="settings-card" aria-labelledby="settings-cleanup-preview-title">
        <h4 id="settings-cleanup-preview-title" class="settings-card-title">
          {{ t('settings.cleanup_preview') }}
        </h4>
        <div class="settings-cleanup-result" aria-live="polite">
          <span><strong>{{ cleanupPreview.candidates.length }}</strong> {{ t('settings.ready') }}</span>
          <span><strong>{{ cleanupPreview.blocked.length }}</strong> {{ t('settings.blocked') }}</span>
          <span>
            <strong>{{ cleanupPreview.candidates.filter((item) => item.customFields.length).length }}</strong>
            {{ t('settings.custom_fields') }}
          </span>
        </div>
        <div class="settings-metadata-actions">
          <NButton
            v-if="cleanedPaths.length"
            attr-type="button"
            size="medium"
            :bordered="false"
            class="btn"
            :disabled="mutatingMetadata"
            @click="emit('restore')"
          >{{ t('settings.restore_original', { count: cleanedPaths.length }) }}</NButton>
          <NButton
            v-if="cleanupPreview.candidates.length"
            attr-type="button"
            size="medium"
            type="error"
            :bordered="false"
            class="btn btn-danger"
            :disabled="mutatingMetadata || cleanupPreview.blocked.length > 0"
            @click="emit('remove')"
          >{{ t('settings.remove_frontmatter', { count: cleanupPreview.candidates.length }) }}</NButton>
        </div>
      </div>
    </div>
  </section>
</template>
