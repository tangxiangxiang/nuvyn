<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NInput, type InputInst } from 'naive-ui'
import type { PostSummary } from '../../lib/api'
import { createDocumentSearchProvider, createLatestSearchRunner, type DocumentSearchPayload, type SearchProvider, type SearchResult, type SearchResultSection } from '../../lib/searchResults'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { useI18n } from '../../composables/useI18n'
import { isNuvynShortcutBlocked } from '../../lib/keyboard'
import type { DiarySearchPayload } from '../../features/diary/diarySearchProvider'
import type { BoardSearchPayload } from '../../features/board/searchProvider'

const props = withDefaults(defineProps<{
  posts?: PostSummary[]
  activePath?: string | null
  providers?: SearchProvider[]
  keyboardShortcut?: boolean
  allowCreate?: boolean
}>(), {
  keyboardShortcut: true,
  allowCreate: true,
})
const emit = defineEmits<{
  select: [path: string]
  new: [title: string]
  commit: [hit: SearchResult]
}>()
const open = ref(false)
const query = ref('')
const sections = ref<SearchResultSection[]>([])
const hits = computed(() => sections.value.flatMap((section) => section.results))
const activeIdx = ref(0)
const keyboardNavigated = ref(false)
const searching = ref(false)
const loadingMore = ref(false)
const searchFailed = computed(() => sections.value.some(section => section.error))
const inputRef = ref<InputInst | null>(null)
const trap = useFocusTrap()
const { t } = useI18n()
const placeholder = computed(() => props.providers
  ? t('search.placeholder.global')
  : t('search.placeholder', { count: props.posts?.length ?? 0 }))
function matchLabel(match: DocumentSearchPayload['match']): string {
  return t(`search.match.${match}`)
}
const documentProvider = createDocumentSearchProvider(() => props.posts ?? [])
const runLatestSearch = createLatestSearchRunner(
  () => props.providers ?? [documentProvider],
  (next) => { sections.value = next; activeIdx.value = 0; keyboardNavigated.value = false },
)

let debounceTimer: ReturnType<typeof setTimeout> | undefined
let refreshVersion = 0
function cancelScheduledSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = undefined
}
async function refresh() {
  cancelScheduledSearch()
  const version = ++refreshVersion
  if (!open.value) return
  if (!query.value.trim()) {
    runLatestSearch.cancel()
    sections.value = []
    activeIdx.value = 0
    searching.value = false
    loadingMore.value = false
    return
  }
  searching.value = true
  await runLatestSearch(query.value)
  if (version === refreshVersion) searching.value = false
}
let providerUnsubscribers: Array<() => void> = []
function subscribeToProviderUpdates() {
  providerUnsubscribers.forEach((unsubscribe) => unsubscribe())
  providerUnsubscribers = []
  const activeProviders = props.providers ?? [documentProvider]
  for (const provider of activeProviders) {
    const unsubscribe = provider.subscribe?.(() => {
      if (open.value && query.value.trim()) void refresh()
    })
    if (unsubscribe) providerUnsubscribers.push(unsubscribe)
  }
}
watch(() => props.providers, (providers, previous) => {
  subscribeToProviderUpdates()
  if (!previous || providers === previous) return
  for (const provider of previous) provider.clear?.()
  cancelScheduledSearch()
  refreshVersion += 1
  runLatestSearch.cancel()
  sections.value = []
  if (open.value) void refresh()
}, { immediate: true })
function show() { trap.activate(); open.value = true; sections.value = []; query.value = ''; activeIdx.value = 0; keyboardNavigated.value = false; void refresh(); void nextTick(() => inputRef.value?.focus()) }
function hide() {
  open.value = false
  cancelScheduledSearch()
  refreshVersion += 1
  runLatestSearch.cancel()
  searching.value = false
  loadingMore.value = false
  query.value = ''
  sections.value = []
  activeIdx.value = 0
  keyboardNavigated.value = false
  for (const provider of props.providers ?? []) provider.clear?.()
  void trap.deactivate()
}
function commit(hit: SearchResult) {
  emit('commit', hit)
  if (hit.type === 'file') emit('select', (hit.payload as { path: string }).path)
  else if (hit.type !== 'board' && hit.type !== 'diary-day') return
  hide()
}
function commitNew() {
  if (props.allowCreate === false) return
  emit('new', query.value.trim())
  hide()
}
function onKey(e: KeyboardEvent) {
  const meta = e.metaKey || e.ctrlKey
  if (props.keyboardShortcut !== false && !isNuvynShortcutBlocked(e) && meta && e.key.toLowerCase() === 'p') { e.preventDefault(); show() }
  else if (e.key === 'Escape' && open.value) { e.preventDefault(); hide() }
}
function onInputKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!hits.value.length) return
    activeIdx.value = Math.min(activeIdx.value + 1, hits.value.length - 1)
    keyboardNavigated.value = true
  }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (!hits.value.length) return
    activeIdx.value = Math.max(activeIdx.value - 1, 0)
    keyboardNavigated.value = true
  }
  else if (e.key === 'Enter' && hits.value[activeIdx.value]) { e.preventDefault(); commit(hits.value[activeIdx.value]) }
}
function onGlobalKey(e: KeyboardEvent) { if (open.value) trap.onTab(() => document.querySelector<HTMLElement>('.palette'), e) }
watch(query, () => {
  if (!open.value) return
  cancelScheduledSearch()
  refreshVersion += 1
  runLatestSearch.cancel()
  for (const provider of props.providers ?? []) provider.clear?.()
  activeIdx.value = 0
  keyboardNavigated.value = false
  sections.value = []
  if (!query.value.trim()) {
    searching.value = false
    loadingMore.value = false
    return
  }
  searching.value = true
  debounceTimer = setTimeout(() => { void refresh() }, 250)
})
watch(() => props.posts, () => { if (open.value) void refresh() }, { deep: false })

async function loadMore() {
  if (!open.value || searching.value || loadingMore.value) return
  const providers = (props.providers ?? []).filter(provider => provider.loadMore)
  if (!providers.length) return
  const version = refreshVersion
  const activeQuery = query.value.trim()
  loadingMore.value = true
  try {
    const pages = await Promise.all(providers.map(provider => provider.loadMore!(activeQuery)))
    if (!open.value || version !== refreshVersion || activeQuery !== query.value.trim()) return
    for (const page of pages) {
      if (!page) continue
      const index = sections.value.findIndex(section => section.id === page.id)
      if (index < 0) {
        if (page.results.length || page.error) sections.value = [...sections.value, page]
      } else {
        const next = [...sections.value]
        const prior = next[index]!
        next[index] = { ...prior, results: [...prior.results, ...page.results], error: page.error }
        sections.value = next
      }
    }
  } finally {
    if (open.value && version === refreshVersion) loadingMore.value = false
  }
}

function onListScroll(event: Event) {
  const element = event.currentTarget as HTMLElement
  if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) void loadMore()
}

function retrySearch() {
  if (hits.value.length && (props.providers ?? []).some(provider => provider.loadMore)) void loadMore()
  else void refresh()
}

function diarySnippet(hit: SearchResult): { before: string; match: string; after: string } | null {
  if (hit.type !== 'diary-day') return null
  const payload = hit.payload as DiarySearchPayload
  if (!payload.snippet) return null
  const text = payload.snippet
  const normalized = text.toLocaleLowerCase()
  const needle = payload.query.toLocaleLowerCase()
  const start = normalized.indexOf(needle)
  if (start < 0) return { before: text, match: '', after: '' }
  return { before: text.slice(0, start), match: text.slice(start, start + payload.query.length), after: text.slice(start + payload.query.length) }
}
function exactMatchParts(text: string, value: string): { before: string; match: string; after: string } | null {
  const needle = value.trim()
  if (!needle) return null
  const start = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (start < 0) return null
  return { before: text.slice(0, start), match: text.slice(start, start + needle.length), after: text.slice(start + needle.length) }
}
function noteTitleMatch(hit: SearchResult) {
  return hit.type === 'file' ? exactMatchParts(hit.title, query.value) : null
}
function noteSnippetMatch(hit: SearchResult) {
  if (hit.type !== 'file') return null
  const payload = hit.payload as DocumentSearchPayload
  if (!payload.snippet) return null
  const needle = payload.match === 'body' ? payload.bodyQuery ?? query.value : query.value
  return exactMatchParts(payload.snippet, needle)
}
function boardBodySnippetMatch(hit: SearchResult) {
  if (hit.type !== 'board') return null
  const payload = hit.payload as Partial<BoardSearchPayload>
  if (payload.match !== 'body' || typeof payload.snippet !== 'string') return null
  return exactMatchParts(payload.snippet, query.value)
}
function boardBodyMatch(hit: SearchResult): boolean {
  return hit.type === 'board' && (hit.payload as Partial<BoardSearchPayload>).match === 'body'
}
function optionDomId(hit: SearchResult): string {
  return `palette-option-${encodeURIComponent(hit.id)}`
}
onMounted(() => {
  document.addEventListener('keydown', onKey)
  document.addEventListener('keydown', onGlobalKey)
})
onBeforeUnmount(() => {
  cancelScheduledSearch()
  runLatestSearch.cancel()
  for (const provider of props.providers ?? []) provider.clear?.()
  providerUnsubscribers.forEach((unsubscribe) => unsubscribe())
  providerUnsubscribers = []
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('keydown', onGlobalKey)
})
defineExpose({ show, hide, refresh })
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="palette-backdrop" @click.self="hide">
      <div class="palette" role="dialog" aria-modal="true" :aria-label="t('search.dialog_label')">
        <NInput
          ref="inputRef"
          v-model:value="query"
          class="palette-input"
          type="text"
          size="medium"
          :bordered="false"
          :placeholder="placeholder"
          :input-props="{
            'aria-label': t('search.input_label'),
            'aria-activedescendant': keyboardNavigated && hits[activeIdx] ? optionDomId(hits[activeIdx]!) : undefined,
            autocomplete: 'off',
            spellcheck: false,
          }"
          :theme-overrides="{ heightMedium: '53px', borderRadius: '0px' }"
          @keydown="onInputKey"
        />
        <div v-if="hits.length" class="palette-list" role="listbox" @scroll.passive="onListScroll">
          <section v-for="section in sections" :key="section.id" class="palette-section">
            <div v-for="hit in section.results" :id="optionDomId(hit)" :key="hit.id" :class="['palette-item', { active: hits.indexOf(hit) === activeIdx, 'keyboard-focus': keyboardNavigated && hits.indexOf(hit) === activeIdx }]" role="option" :aria-selected="hits.indexOf(hit) === activeIdx" @mouseenter="activeIdx = hits.indexOf(hit); keyboardNavigated = false" @click="commit(hit)">
              <div :class="['palette-row', { 'palette-note-row': hit.type === 'file' }]">
                <span :class="['palette-title', { 'palette-note-title': hit.type === 'file' }]">
                  <template v-if="noteTitleMatch(hit)"><span>{{ noteTitleMatch(hit)?.before }}</span><mark class="palette-note-highlight">{{ noteTitleMatch(hit)?.match }}</mark><span>{{ noteTitleMatch(hit)?.after }}</span></template>
                  <template v-else>{{ hit.title }}</template>
                </span>
                <span v-if="hit.type === 'file'" class="palette-badge">{{ matchLabel((hit.payload as DocumentSearchPayload).match) }}</span>
                <span v-else-if="boardBodyMatch(hit)" class="palette-badge">{{ matchLabel('body') }}</span>
              </div>
              <div v-if="hit.type === 'file' && (hit.payload as DocumentSearchPayload).snippet" class="palette-snippet palette-note-snippet">
                <template v-if="noteSnippetMatch(hit)"><span>{{ noteSnippetMatch(hit)?.before }}</span><mark class="palette-note-highlight">{{ noteSnippetMatch(hit)?.match }}</mark><span>{{ noteSnippetMatch(hit)?.after }}</span></template>
                <template v-else>{{ (hit.payload as DocumentSearchPayload).snippet }}</template>
              </div>
              <div v-if="boardBodySnippetMatch(hit)" class="palette-snippet palette-note-snippet">
                <span>{{ boardBodySnippetMatch(hit)?.before }}</span><mark class="palette-note-highlight">{{ boardBodySnippetMatch(hit)?.match }}</mark><span>{{ boardBodySnippetMatch(hit)?.after }}</span>
              </div>
              <div v-if="diarySnippet(hit)" class="palette-snippet"><span>{{ diarySnippet(hit)?.before }}</span><mark>{{ diarySnippet(hit)?.match }}</mark><span>{{ diarySnippet(hit)?.after }}</span></div>
              <div v-if="hit.subtitle && hit.type !== 'file'" class="palette-path">{{ hit.subtitle }}</div>
            </div>
            <div v-if="section.error" class="palette-search-error" role="alert">{{ t('search.failed') }} <button type="button" @click="retrySearch">{{ t('search.retry') }}</button></div>
          </section>
          <div v-if="loadingMore" class="palette-search-status" role="status">{{ t('search.loading') }}</div>
        </div>
        <div v-else class="palette-empty"><div role="status">{{ searching ? t('search.loading') : searchFailed ? t('search.failed') : query.trim() ? t('search.no_results') : t('search.start_prompt') }}</div><NButton v-if="searchFailed" attr-type="button" class="palette-new" @click="retrySearch">{{ t('search.retry') }}</NButton><NButton v-if="query.trim() && props.allowCreate !== false" attr-type="button" type="primary" class="palette-new" @click="commitNew">{{ t('search.create', { query: query.trim() }) }}</NButton></div>
        <div class="palette-foot"><span>{{ t('search.navigate') }}</span><span>{{ t('search.open') }}</span><span>{{ t('search.close') }}</span></div>
      </div>
    </div>
  </Teleport>
</template>
