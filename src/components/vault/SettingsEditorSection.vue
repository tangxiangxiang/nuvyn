<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { NButton, NCheckbox, NInput, NInputNumber, NSelect, type SelectOption } from 'naive-ui'
import { useEditorPreferences } from '../../composables/vault/useEditorPreferences'
import { useFileTreePreferences } from '../../composables/vault/useFileTreePreferences'

/* Editor preferences live in module-level useStorage() refs and
   auto-persist on change, so this section is fully self-contained —
   no props, no emits. The parent just renders it. */

const { t } = useI18n()
const editorPreferences = useEditorPreferences()
const fileTreePreferences = useFileTreePreferences()
const tabSizeOptions = computed<SelectOption[]>(() => [2, 4].map((count) => ({
  value: count,
  label: t('settings.spaces', { count }),
})))
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-editor-title">
    <header class="settings-section-header">
      <div>
        <h3 id="settings-editor-title">{{ t('settings.editor') }}</h3>
        <p>{{ t('settings.editor_subtitle') }}</p>
      </div>
      <div class="settings-section-actions">
        <NButton attr-type="button" size="medium" class="btn" :bordered="false" @click="editorPreferences.reset">{{ t('settings.reset_editor') }}</NButton>
      </div>
    </header>
    <div class="settings-section-body">
      <div class="settings-card" aria-labelledby="settings-editor-configuration-title">
        <h4 id="settings-editor-configuration-title" class="settings-card-title">
          {{ t('settings.editor_configuration') }}
        </h4>
        <div class="settings-field-grid">
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.font_size') }}</span>
            <NInputNumber
              v-model:value="editorPreferences.fontSize.value"
              size="medium"
              :min="11"
              :max="24"
              :aria-label="t('settings.font_size')"
            />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.line_height') }}</span>
            <NInputNumber
              v-model:value="editorPreferences.lineHeight.value"
              size="medium"
              :min="16"
              :max="40"
              :aria-label="t('settings.line_height')"
            />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.tab_width') }}</span>
            <NSelect v-model:value="editorPreferences.tabSize.value" size="medium" :options="tabSizeOptions" :aria-label="t('settings.tab_width')" />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.wrap_column') }}</span>
            <NInputNumber
              v-model:value="editorPreferences.wrapColumn.value"
              size="medium"
              :min="60"
              :max="160"
              :aria-label="t('settings.wrap_column')"
            />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">{{ t('settings.font_family') }}</span>
            <NInput v-model:value="editorPreferences.fontFamily.value" type="text" size="medium" :placeholder="t('settings.system_monospace')" :maxlength="120" />
          </label>
          <label class="settings-field settings-field-checkbox">
            <NCheckbox v-model:checked="editorPreferences.typography.value" :aria-label="t('settings.writing_diagnostics')" />
            <span class="settings-field-label">{{ t('settings.writing_diagnostics') }}</span>
          </label>
          <label class="settings-field settings-field-checkbox">
            <NCheckbox v-model:checked="fileTreePreferences.compactFileTree.value" :aria-label="t('settings.compact_tree')" />
            <span class="settings-field-label">{{ t('settings.compact_tree') }}</span>
          </label>
        </div>
      </div>
    </div>
  </section>
</template>
