<script setup lang="ts">
import { nextTick, onMounted, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { Trash } from '@vicons/tabler'
import { createDiaryEntryId } from '../../lib/diary-life-api'

const props = defineProps<{ entries: string[]; entryIds?: string[] }>()
const emit = defineEmits<{
  'update:entries': [entries: string[]]
  'update:content': [content: { entries: string[]; entryIds: string[] }]
}>()
let composingTextarea: HTMLTextAreaElement | null = null
const textareas: Array<HTMLTextAreaElement | null> = []
const visibleEntries = () => props.entries.length ? props.entries : ['']
const visibleEntryId = (index: number) => props.entryIds?.[index]

function currentEntryIds() {
  return props.entries.map((_, index) => props.entryIds?.[index] ?? createDiaryEntryId())
}

function updateContent(entries: string[], entryIds: string[]) {
  emit('update:entries', entries)
  emit('update:content', { entries, entryIds })
}

function setTextareaRef(element: unknown, index: number) {
  const textarea = element as HTMLTextAreaElement | null
  textareas[index] = textarea && textarea.tagName === 'TEXTAREA' ? textarea : null
}

function resize(textarea: HTMLTextAreaElement | null | undefined) {
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

function update(index: number, value: string) {
  const next = props.entries.length ? [...props.entries] : ['']
  next[index] = value
  const ids = props.entries.length ? currentEntryIds() : [createDiaryEntryId()]
  updateContent(next, ids)
}

function focus(index: number, caret?: number) {
  void nextTick(() => {
    const textarea = textareas[index]
    textarea?.focus()
    if (textarea && caret !== undefined) textarea.setSelectionRange(caret, caret)
    resize(textarea)
  })
}

function addEntry() {
  const next = props.entries.length ? [...props.entries, ''] : ['']
  const ids = [...currentEntryIds(), createDiaryEntryId()]
  updateContent(next, ids)
  focus(next.length - 1, 0)
}

function removeEntry(index: number) {
  if (!props.entries.length) return
  const next = props.entries.filter((_, entryIndex) => entryIndex !== index)
  const ids = currentEntryIds().filter((_, entryIndex) => entryIndex !== index)
  updateContent(next, ids)
  if (next.length) focus(Math.max(0, index - 1))
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
    const ids = props.entries.length ? currentEntryIds() : [createDiaryEntryId()]
    const firstId = ids[index] ?? createDiaryEntryId()
    next.splice(index, 1, before, after)
    ids.splice(index, 1, firstId, createDiaryEntryId())
    updateContent(next, ids)
    focus(index + 1, 0)
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
    <ul>
      <li v-for="(entry, index) in visibleEntries()" :key="visibleEntryId(index) ?? index" :data-entry-id="visibleEntryId(index)">
        <div class="diary-bullet-row">
          <textarea
            :ref="element => setTextareaRef(element, index)"
            :value="entry"
            rows="1"
            :aria-label="`第 ${index + 1} 条日记`"
            @input="onInput(index, $event)"
            @keydown="onKeydown(index, $event)"
            @focus="onFocus"
            @blur="onBlur"
            @compositionstart="onCompositionStart"
            @compositionend="onCompositionEnd"
          />
          <NButton
            attr-type="button"
            quaternary
            size="small"
            class="diary-bullet-remove"
            :disabled="!props.entries.length"
            :aria-label="`删除第 ${index + 1} 条日记`"
            @click="removeEntry(index)"
          ><NIcon aria-hidden="true" :size="16"><Trash /></NIcon></NButton>
        </div>
        <slot name="after-entry" :entry-id="visibleEntryId(index) ?? null" :entry="entry" :index="index" />
      </li>
    </ul>
    <NButton attr-type="button" quaternary class="diary-bullet-add" data-testid="diary-add-entry" @click="addEntry">+ 添加一条</NButton>
  </div>
</template>

<style scoped>
.diary-bullet-editor ul { margin: 0; padding-inline-start: 1.4em; }
.diary-bullet-editor li { min-width: 0; }
.diary-bullet-editor li + li { margin-block-start: 8px; }
.diary-bullet-editor li::marker { color: var(--text-muted); }
.diary-bullet-row { display: grid; grid-template-columns: minmax(0, 1fr) 40px; align-items: start; column-gap: 4px; min-width: 0; }
.diary-bullet-editor textarea { display: block; width: 100%; min-width: 0; min-height: 1.7em; box-sizing: border-box; overflow: hidden; resize: none; padding: 3px 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; line-height: 1.7; overflow-wrap: anywhere; }
.diary-bullet-editor textarea:focus-visible { box-shadow: 0 1px 0 color-mix(in srgb, var(--accent) 55%, transparent); }
.diary-bullet-remove { width: 40px; min-width: 40px; height: 40px; padding: 0; opacity: .7; }
.diary-bullet-remove:hover { opacity: 1; }
.diary-bullet-add { min-height: 40px; margin: 10px 0 0 1.4em; padding-inline: 0; }
</style>
