<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from 'vue'
import { createDiaryEntryId } from '../../lib/diary-life-api'
import DiaryActionMenu from './DiaryActionMenu.vue'

const props = defineProps<{
  entries: string[]
  entryIds?: string[]
  actionsDisabled?: boolean
}>()
const emit = defineEmits<{
  'update:entries': [entries: string[]]
  'update:content': [content: { entries: string[]; entryIds: string[] }]
  'add-image': [entryId: string]
}>()
let composingTextarea: HTMLTextAreaElement | null = null
let emptyEntryId = createDiaryEntryId()
let focusRequest = 0
const textareas = new Map<string | number, HTMLTextAreaElement>()
const rows = computed(() => props.entries.length
  ? props.entries.map((entry, index) => {
      const id = props.entryIds?.[index]
      return { entry, id, key: id ?? index }
    })
  : [{ entry: '', id: undefined, key: emptyEntryId }])

function currentEntryIds() {
  return props.entries.map((_, index) => props.entryIds?.[index] ?? createDiaryEntryId())
}

function updateContent(entries: string[], entryIds: string[]) {
  emit('update:entries', entries)
  emit('update:content', { entries, entryIds })
}

function setTextareaRef(element: unknown, key: string | number) {
  const textarea = element as HTMLTextAreaElement | null
  if (textarea) textareas.set(key, textarea)
  else textareas.delete(key)
}

function resize(textarea: HTMLTextAreaElement | null | undefined) {
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

function update(index: number, value: string) {
  const next = props.entries.length ? [...props.entries] : ['']
  next[index] = value
  const ids = props.entries.length ? currentEntryIds() : [emptyEntryId]
  updateContent(next, ids)
}

function focusEntry(entryId: string, caret?: number) {
  const request = ++focusRequest
  const previousFocus = document.activeElement
  void nextTick(() => {
    const textarea = textareas.get(entryId)
    const active = document.activeElement
    if (request !== focusRequest || !textarea?.isConnected || (active !== previousFocus && active !== document.body)) return
    textarea.focus()
    if (caret !== undefined) textarea.setSelectionRange(caret, caret)
    resize(textarea)
  })
}

function addEntry() {
  const next = props.entries.length ? [...props.entries, ''] : ['']
  const entryId = props.entries.length ? createDiaryEntryId() : emptyEntryId
  updateContent(next, [...currentEntryIds(), entryId])
  focusEntry(entryId, 0)
}

defineExpose({ addEntry })

function selectEntryAction(action: string, index: number, entryId?: string) {
  if (props.actionsDisabled) return
  if (action === 'add-image' && entryId) emit('add-image', entryId)
  if (action === 'remove') removeEntry(index)
}

function removeEntry(index: number) {
  if (!props.entries.length) return
  const next = props.entries.filter((_, entryIndex) => entryIndex !== index)
  const ids = currentEntryIds().filter((_, entryIndex) => entryIndex !== index)
  if (!next.length) emptyEntryId = createDiaryEntryId()
  updateContent(next, ids)
  focusEntry(ids[Math.max(0, index - 1)] ?? emptyEntryId)
}

function onInput(index: number, event: Event) {
  const textarea = event.currentTarget as HTMLTextAreaElement
  update(index, textarea.value)
  resize(textarea)
}

function onCompositionStart(event: CompositionEvent) {
  composingTextarea = event.currentTarget as HTMLTextAreaElement
}

function onCompositionEnd(event: CompositionEvent) {
  const textarea = event.currentTarget as HTMLTextAreaElement
  if (composingTextarea === textarea) composingTextarea = null
}

function onFocus(event: FocusEvent) {
  const textarea = event.currentTarget as HTMLTextAreaElement
  if (composingTextarea && composingTextarea !== textarea) composingTextarea = null
}

function onBlur(event: FocusEvent) {
  const textarea = event.currentTarget as HTMLTextAreaElement
  if (composingTextarea === textarea) composingTextarea = null
}

function onKeydown(index: number, event: KeyboardEvent) {
  const textarea = event.currentTarget as HTMLTextAreaElement
  if (composingTextarea === textarea || event.isComposing || event.keyCode === 229) return

  if (
    event.key === 'Enter'
    && !event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
  ) {
    event.preventDefault()
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const before = textarea.value.slice(0, start)
    const after = textarea.value.slice(end)
    const next = props.entries.length ? [...props.entries] : ['']
    const ids = props.entries.length ? currentEntryIds() : [emptyEntryId]
    const entryId = createDiaryEntryId()
    next.splice(index, 1, before, after)
    ids.splice(index + 1, 0, entryId)
    updateContent(next, ids)
    focusEntry(entryId, 0)
    return
  }

  if (event.key === 'Backspace' && textarea.value === '' && textarea.selectionStart === 0
    && textarea.selectionEnd === 0 && props.entries.length > 1) {
    event.preventDefault()
    removeEntry(index)
  }
}

watch(() => props.entries, () => {
  void nextTick(() => textareas.forEach(resize))
}, { deep: true })

onMounted(() => { void nextTick(() => textareas.forEach(resize)) })
</script>

<template>
  <div class="diary-bullet-editor" data-testid="diary-bullet-editor">
    <ul role="list">
      <li v-for="(row, index) in rows" :key="row.key" class="diary-bullet-entry" :data-entry-id="row.id">
        <span class="diary-bullet-number" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
        <div class="diary-bullet-content">
          <div class="diary-bullet-row">
            <textarea
              :ref="element => setTextareaRef(element, row.key)"
              :value="row.entry"
              :placeholder="!props.entries.length ? '写下今天的事…' : undefined"
              rows="1"
              :aria-label="`第 ${index + 1} 条日记`"
              @input="onInput(index, $event)"
              @keydown="onKeydown(index, $event)"
              @focus="onFocus"
              @blur="onBlur"
              @compositionstart="onCompositionStart"
              @compositionend="onCompositionEnd"
            />
            <DiaryActionMenu
              contextual
              class="diary-bullet-actions"
              :label="`第 ${index + 1} 条日记的操作`"
              :disabled="props.actionsDisabled || !props.entries.length"
              :options="[
                { key: 'add-image', label: '添加图片', disabled: !row.id },
                { key: 'remove', label: '删除此条' },
              ]"
              @select="selectEntryAction($event, index, row.id)"
            />
          </div>
          <slot name="after-entry" :entry-id="row.id ?? null" :entry="row.entry" :index="index" />
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.diary-bullet-editor ul { margin: 0; padding: 0; list-style: none; }
.diary-bullet-editor li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 6px; min-width: 0; font-size: 1rem; }
.diary-bullet-number { color: var(--text-muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; line-height: 1.7rem; user-select: none; text-align: end; }
.diary-bullet-content { min-width: 0; }
.diary-bullet-editor li + li { margin-block-start: 10px; }
.diary-bullet-editor li :deep(.diary-attachment-section) { margin-top: 8px; }
.diary-bullet-row { position: relative; min-width: 0; padding-inline-end: 44px; }
.diary-bullet-editor textarea { display: block; width: 100%; min-width: 0; min-height: 1.7em; box-sizing: border-box; overflow: hidden; resize: none; padding: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; line-height: 1.7; overflow-wrap: anywhere; }
.diary-bullet-editor textarea::placeholder { color: var(--text-muted); }
.diary-bullet-editor textarea:focus-visible { box-shadow: 0 1px 0 color-mix(in srgb, var(--accent) 55%, transparent); }
.diary-bullet-actions { position: absolute; inset-block-start: -4px; inset-inline-end: 0; color: var(--text-muted); }
.diary-bullet-actions :deep(.diary-action-trigger) { height: 36px; }
</style>
