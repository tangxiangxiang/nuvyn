<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import {
  CircleCheck,
  CircleX,
  FileDiff,
  FilePlus,
  FileText,
  List,
  Loader,
  Pencil,
  Trash,
} from '@vicons/tabler'
import type { ToolCallRecord } from '../../lib/ai-api'

const props = defineProps<{ call: ToolCallRecord }>()

const expanded = ref(false)
const collapsible = computed(() => ['read_file', 'list_files'].includes(props.call.name))

const TOOL_ICONS: Record<string, Component> = {
  read_file: FileText,
  list_files: List,
  create_file: FilePlus,
  write_file: FileText,
  patch_file: FileDiff,
  delete_file: Trash,
  rename_file: Pencil,
}

const icon = computed(() => TOOL_ICONS[props.call.name] ?? FileText)

// Status pill glyph. The pill is icon-only on the screen; the
// aria-label carries the text meaning for screen readers.
const statusPill = computed<{ icon: Component; label: string; className: string }>(() => {
  if (props.call.result.is_error) return { icon: CircleX, label: 'error', className: 'ai-tool-pill-error' }
  if (props.call.result.content) return { icon: CircleCheck, label: 'ok', className: 'ai-tool-pill-ok' }
  return { icon: Loader, label: 'pending', className: 'ai-tool-pill-pending' }
})

function stringInput(key: string): string {
  const value = props.call.input[key]
  return typeof value === 'string' ? value : ''
}

function countResultItems(content: string): number | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  const lines = trimmed.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length > 1) return lines.length
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) return parsed.length
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length
  } catch {
    // Plain text results use the character-count summary.
  }
  return null
}

function formatChars(content: string): string {
  const n = content.length
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k chars`
  return `${n} chars`
}

const summary = computed(() => {
  const path = stringInput('path')
  const newPath = stringInput('new_path')
  const scope = stringInput('scope')
  const target = props.call.name === 'rename_file' && newPath
    ? `${path || 'file'} -> ${newPath}`
    : path || scope || ''
  const content = props.call.result.content
  const result = props.call.result.is_error
    ? 'error'
    : !content
      ? 'pending'
      : props.call.name === 'list_files'
        ? `${countResultItems(content) ?? 0} items`
        : formatChars(content)
  return [target, result].filter(Boolean).join(' · ')
})

const visibleContent = computed(() => {
  return props.call.result.content
})
</script>

<template>
  <div class="ai-tool-card" :class="{ 'ai-tool-error': call.result.is_error, 'ai-tool-expanded': expanded }">
    <div class="ai-tool-header">
      <NIcon class="ai-tool-icon" aria-hidden="true">
        <component :is="icon" />
      </NIcon>
      <span class="ai-tool-name">{{ call.name }}</span>
      <span class="ai-tool-summary">{{ summary }}</span>
      <NButton
        v-if="call.result.content && collapsible"
        attr-type="button"
        text
        :bordered="false"
        class="ai-tool-toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >{{ expanded ? '收起' : '展开' }}</NButton>
      <span
        class="ai-tool-pill"
        :class="statusPill.className"
        :aria-label="statusPill.label"
      >
        <NIcon aria-hidden="true">
          <component :is="statusPill.icon" />
        </NIcon>
      </span>
    </div>
    <pre
      v-if="call.result.content && (expanded || !collapsible)"
      class="ai-tool-result"
    ><code>{{ visibleContent }}</code></pre>
  </div>
</template>

<style scoped>
.ai-tool-card { margin-top: 7px; padding: 5px 7px; border: 1px solid color-mix(in srgb, var(--vs-border, #3a3f4b) 72%, transparent); border-radius: 5px; background: color-mix(in srgb, var(--vs-bg-2, #252526) 78%, transparent); font-size: 0.82em; }
.ai-tool-card.ai-tool-error { border-color: color-mix(in srgb, #c14545 72%, var(--vs-border, #3a3f4b)); background: color-mix(in srgb, #c14545 10%, var(--vs-bg-2, #252526)); }
.ai-tool-header { display: flex; align-items: center; gap: 5px; min-height: 18px; }
.ai-tool-card.ai-tool-expanded .ai-tool-header { margin-bottom: 5px; }
.ai-tool-icon { display: inline-flex; align-items: center; color: var(--vs-text-3, #8a93a6); }
.ai-tool-name { font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-weight: 500; color: var(--vs-text-2, #858585); }
.ai-tool-summary { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vs-text-3, #6a6a6a); font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.92em; }
.ai-tool-pill { margin-left: auto; flex: 0 0 auto; padding: 2px; border-radius: 4px; line-height: 0; display: inline-flex; align-items: center; justify-content: center; }
.ai-tool-pill :deep(svg) { display: block; }
.ai-tool-pill-ok { background: color-mix(in srgb, #50aa6e 16%, transparent); color: #6ec486; }
.ai-tool-pill-error { background: color-mix(in srgb, #c14545 18%, transparent); color: #e06c75; }
.ai-tool-pill-pending { background: color-mix(in srgb, var(--vs-text-3, #8a93a6) 16%, transparent); color: var(--vs-text-3, #8a93a6); }
.ai-tool-result { margin: 0; padding: 6px 7px; max-height: 220px; overflow: auto; border: 1px solid color-mix(in srgb, var(--vs-border, #3a3f4b) 45%, transparent); border-radius: 4px; background: color-mix(in srgb, var(--vs-bg-1, #1e1e1e) 86%, black); font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.82em; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.ai-tool-result.ai-tool-collapsed { max-height: 64px; overflow: hidden; text-overflow: ellipsis; }
.ai-tool-result code { font-family: inherit; }
.ai-tool-toggle { flex: 0 0 auto; padding: 1px 5px; border: none; border-radius: 4px; background: transparent; color: var(--vs-accent, #7aa2f7); cursor: pointer; font-size: 0.82em; }
.ai-tool-toggle:hover { background: color-mix(in srgb, var(--vs-accent, #7aa2f7) 10%, transparent); }
</style>
