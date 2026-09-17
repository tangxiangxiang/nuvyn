<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NIcon, NInput } from 'naive-ui'
import { FileText, Search } from '@vicons/tabler'
import type { PostSummary } from '../../lib/api'
import {
  buildTagIndex,
  normalizeTag,
  sortTagsByCountDescThenName,
  type TagRecord,
} from '../../lib/tags'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{ posts: PostSummary[]; selectedTag: string | null; path: string | null }>()
const emit = defineEmits<{ select: [tag: string]; open: [path: string] }>()

/* The panel contains:
   1. A filterable single-select tag list.
   2. Notes belonging to the selected tag. */
const filter = defineModel<string>('filter', { default: '' })
const { t } = useI18n()

/* Phase 1 of the unified tag plan. The tag list and the
   single-tag post filter used to be hand-rolled in this component;
   both now go through the shared `lib/tags` module so the tag
   query semantics can never drift between TagPanel and FileTree.
   The user-visible behavior is identical:
   - The list is still sorted by count desc then name asc.
   - The filter is still a case-insensitive substring of the tag
     name (plain text only; `#`-prefixed tokens in the filter
     parse to `includeAll` but the list filter only consults the
     `text` channel — see `visibleTags` below).
   - Selecting a tag still shows posts whose `tags` array contains
     that exact tag (case-insensitive on the server side, but we
     also normalize here so a `Java` / `java` mismatch can't sneak
     through). */
const tagIndex = computed(() => buildTagIndex(props.posts))

const allTagsSorted = computed<TagRecord[]>(() =>
  sortTagsByCountDescThenName(Array.from(tagIndex.value.tags.values())),
)

// Phase 1.1 fix: the tag-list filter normalizes the input via
// `normalizeTag` (trim + strip leading `#` + lowercase), then
// substring-matches against the tag's normalized identity. This
// makes the input a true "tag name filter" rather than a free-text
// query — typing `#java` matches Java (the prefix is stripped),
// typing `java` matches Java, and a bare `#` (with nothing after)
// deliberately returns no tags so the user gets clear feedback
// that the input is incomplete. The previous shape (parsing
// through `parseTagQuery` and only reading `query.text`) silently
// swallowed `#java` and showed every tag, because the parser
// routes `#xxx` to `includeAll` not to `text`.
const visibleTags = computed<TagRecord[]>(() => {
  const trimmed = filter.value.trim()
  if (!trimmed) return allTagsSorted.value
  const needle = normalizeTag(trimmed)
  if (!needle) return []
  return allTagsSorted.value.filter((tag) =>
    tag.normalizedName.includes(needle),
  )
})

// Phase 1.1 fix: case-insensitive active-state comparison. The
// `filteredPosts` selector already resolves the selected tag via
// `normalizeTag`, so a user selecting `Math` and a post tagged
// `math` produce results — but the visual active state on the
// list row was comparing the raw `selectedTag` (caller-supplied
// casing) to the tag's `displayName` (first-seen casing). Two
// different casings would show results without any row lighting
// up. Normalize once into a key and compare keys.
const selectedTagKey = computed(() => normalizeTag(props.selectedTag))

const filteredPosts = computed(() => {
  if (!props.selectedTag) return []
  // Use the normalized form as the index key — this is what
  // TagIndex.tagDocuments was built on. A user-selected `#Java`
  // will resolve via the same lookup as the index's `java` entry,
  // so casing mismatches in the selected tag can't cause "no
  // notes" when notes clearly carry the tag.
  const target = normalizeTag(props.selectedTag)
  if (!target) return []
  const paths = tagIndex.value.tagDocuments.get(target)
  if (!paths || paths.size === 0) return []
  // Preserve the input order of `posts` so the result list order
  // is deterministic — building a Set first and then sorting would
  // either shuffle the order or require an extra sort.
  return props.posts.filter((post) => paths.has(post.path))
})

function onFilterKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && filter.value) {
    event.stopPropagation()
    filter.value = ''
  }
}
</script>

<template>
  <aside class="tag-panel" :class="{ 'has-results': selectedTag }" :aria-label="t('tags.panel_label')">
    <header>
      <div class="tag-filter">
        <NIcon class="tag-filter-icon" aria-hidden="true"><Search /></NIcon>
        <NInput
          v-model:value="filter"
          class="tag-filter-control"
          size="small"
          :bordered="false"
          :placeholder="t('tags.filter')"
          :input-props="{ class: 'tag-filter-input', type: 'search', 'aria-label': t('tags.filter') }"
          @keydown="onFilterKeydown"
        />
        <NButton v-if="filter" attr-type="button" text :bordered="false" class="tag-filter-clear-x" :title="t('tags.clear_filter')" :aria-label="t('tags.clear_filter')" @click="filter = ''">×</NButton>
      </div>
    </header>

    <div class="tag-list-region">
      <ul v-if="visibleTags.length" class="tag-list" role="listbox" :aria-label="t('tags.list_label')">
        <li v-for="tagRecord in visibleTags" :key="tagRecord.normalizedName" role="presentation">
          <NButton attr-type="button" text :bordered="false" class="tag-entry" role="option" :class="{ active: selectedTagKey === tagRecord.normalizedName }" :aria-selected="selectedTagKey === tagRecord.normalizedName" :title="selectedTagKey === tagRecord.normalizedName ? t('tags.deselect', { tag: tagRecord.displayName }) : t('tags.browse', { tag: tagRecord.displayName })" @click="emit('select', tagRecord.displayName)">
            <span class="tag-name"><span class="tag-hash" aria-hidden="true">#</span><span class="tag-label">{{ tagRecord.displayName }}</span></span>
            <span class="tag-count">{{ tagRecord.count }}</span>
          </NButton>
        </li>
      </ul>
      <p v-else-if="filter" class="empty">{{ t('tags.no_match') }}</p>
      <p v-else class="empty">{{ t('tags.empty') }}</p>
    </div>

    <div v-if="selectedTag" class="results" aria-live="polite">
      <header class="results-header">
        <span class="results-title"><span class="tag-hash" aria-hidden="true">#</span>{{ selectedTag }}</span>
        <span class="results-count">{{ t('tags.note_count', { count: filteredPosts.length }) }}</span>
      </header>
      <ul v-if="filteredPosts.length" class="results-list">
        <li v-for="post in filteredPosts" :key="post.path">
          <NButton attr-type="button" text :bordered="false" class="result-entry document-row" :class="{ active: post.path === path }" @click="emit('open', post.path)">
            <span class="result-chevron-spacer" aria-hidden="true" />
            <NIcon class="result-icon" aria-hidden="true"><FileText /></NIcon>
            <span class="result-label">
              <span class="result-title">{{ post.title }}</span>
            </span>
          </NButton>
        </li>
      </ul>
      <p v-else class="empty">{{ t('tags.no_notes') }}</p>
    </div>
  </aside>
</template>
