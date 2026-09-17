// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { useI18n } from '../../../composables/useI18n'
import type { PostSummary } from '../../../lib/api'
import TagPanel from '../TagPanel.vue'

const POSTS: PostSummary[] = [
  { path: 'inbox/markdown-syntax', title: 'Markdown syntax', summary: 'Redis appears only in this summary', created: '', updated: '', tags: ['markdown', 'reference'], size: 100, mtime: Date.UTC(2026, 6, 15, 12, 10) },
  { path: 'inbox/redis-path-only', title: 'Redis title only', created: '', updated: '', tags: ['typescript', 'reference'], size: 100, mtime: 0 },
  { path: 'archive/derivation', title: 'Derivation', created: '', updated: '', tags: ['Math'], size: 100, mtime: 0 },
  { path: 'inbox/notes/draft', title: 'Draft', created: '', updated: '', tags: ['reference', 'draft'], size: 100, mtime: 0 },
]

function mountPanel(props: { selectedTag?: string | null; path?: string | null; posts?: PostSummary[] } = {}) {
  return mount(TagPanel, {
    props: {
      posts: props.posts ?? POSTS,
      selectedTag: props.selectedTag ?? null,
      path: props.path ?? null,
    },
  })
}

function tagOrder(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAll('.tag-name').map((item) => item.text())
}

describe('Tags filter', () => {
  beforeEach(() => {
    localStorage.clear()
    useI18n().setLocale('zh')
  })

  afterEach(() => {
    useI18n().setLocale('zh')
  })

  it('filters only tag names with case-insensitive substring matching', async () => {
    const wrapper = mountPanel()
    await wrapper.get('.tag-filter-input').setValue('mAt')
    expect(tagOrder(wrapper)).toEqual(['#Math'])
  })

  it('does not match document titles, paths, summaries, or body-like metadata', async () => {
    const wrapper = mountPanel()
    await wrapper.get('.tag-filter-input').setValue('redis')
    expect(wrapper.find('.tag-entry').exists()).toBe(false)
    expect(wrapper.text()).toContain('没有匹配的标签。')
  })

  it('clears with Escape and the clear button', async () => {
    const wrapper = mountPanel()
    const input = wrapper.get('.tag-filter-input')
    await input.setValue('ref')
    await input.trigger('keydown', { key: 'Escape' })
    expect((input.element as HTMLInputElement).value).toBe('')
    await input.setValue('ref')
    await wrapper.get('.tag-filter-clear-x').trigger('click')
    expect((input.element as HTMLInputElement).value).toBe('')
  })

  it('shows notes for the selected tag and emits the selected note path', async () => {
    const wrapper = mountPanel({ selectedTag: 'reference' })
    expect(wrapper.findAll('.result-entry')).toHaveLength(3)
    expect(wrapper.text()).toContain('3 篇笔记')
    await wrapper.get('.result-entry').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual([POSTS[0].path])
  })

  it('keeps management navigation out of the tag browsing panel', async () => {
    const wrapper = mountPanel({ selectedTag: 'reference' })
    await wrapper.get('.tag-filter-input').setValue('ref')
    const before = wrapper.findAll('.tag-entry').map((entry) => entry.text())
    expect(wrapper.find('[data-action="manage-tags"]').exists()).toBe(false)
    expect(wrapper.emitted('manage')).toBeUndefined()
    expect((wrapper.get('.tag-filter-input').element as HTMLInputElement).value).toBe('ref')
    expect(wrapper.findAll('.tag-entry').map((entry) => entry.text())).toEqual(before)
    expect(wrapper.find('.results').exists()).toBe(true)
  })

  it('does not render a document hover card for tag results', async () => {
    const wrapper = mountPanel({ selectedTag: 'reference' })
    await wrapper.get('.result-entry').trigger('mouseenter')

    expect(document.body.querySelector('.document-hover-card')).toBeNull()

    wrapper.unmount()
  })

  it('keeps count/name ordering stable when a tag is selected', () => {
    const unselected = mountPanel()
    const selected = mountPanel({ selectedTag: 'Math' })
    expect(tagOrder(selected)).toEqual(tagOrder(unselected))
    expect(tagOrder(selected)[0]).toBe('#reference')
  })

  it('separates tag navigation from the selected-tag detail region', () => {
    const wrapper = mountPanel({ selectedTag: 'reference' })
    expect(wrapper.get('.tag-panel').classes()).toContain('has-results')
    expect(wrapper.get('.tag-list-region').find('.tag-list').exists()).toBe(true)
    expect(wrapper.get('.results').find('.results-header').exists()).toBe(true)
    expect(wrapper.get('.results').find('.results-list').exists()).toBe(true)
    expect(wrapper.get('.result-entry').classes()).toContain('document-row')
    expect(wrapper.get('.result-entry').find('.result-chevron-spacer').exists()).toBe(true)
    expect(wrapper.get('.result-entry').find('.result-icon svg').exists()).toBe(true)
    expect(wrapper.get('.result-entry').find('.result-path').exists()).toBe(false)
    expect(wrapper.get('.tag-name').find('.tag-hash').text()).toBe('#')
    expect(wrapper.get('.tag-name').find('.tag-label').exists()).toBe(true)
  })

  it('uses single-select ARIA and does not declare a multiselect list', () => {
    const wrapper = mountPanel({ selectedTag: 'reference' })
    expect(wrapper.get('.tag-list').attributes('aria-multiselectable')).toBeUndefined()
    expect(wrapper.get('.tag-entry').attributes('role')).toBe('option')
    expect(wrapper.findAll('.tag-entry').find((item) => item.text().includes('reference'))?.attributes('aria-selected')).toBe('true')
  })

  it('supports selecting and deselecting the same tag through its single-select parent', async () => {
    const Harness = defineComponent({
      components: { TagPanel },
      setup: () => ({ posts: POSTS, selectedTag: ref<string | null>(null) }),
      template: `<TagPanel :posts="posts" :selected-tag="selectedTag" :path="null" @select="selectedTag = selectedTag === $event ? null : $event" />`,
    })
    const wrapper = mount(Harness)
    const reference = () => wrapper.findAll('.tag-entry').find((item) => item.text().includes('reference'))!
    await reference().trigger('click')
    expect(reference().attributes('aria-selected')).toBe('true')
    await reference().trigger('click')
    expect(reference().attributes('aria-selected')).toBe('false')
    expect(wrapper.find('.results').exists()).toBe(false)
  })

  it('preserves its filter across Files → Tags → Files → Tags view switches', async () => {
    const Harness = defineComponent({
      components: { TagPanel },
      setup: () => ({ activePanel: ref<'files' | 'tags'>('files'), tagsFilter: ref(''), posts: POSTS }),
      template: `
        <button class="show-files" @click="activePanel = 'files'">Files</button>
        <button class="show-tags" @click="activePanel = 'tags'">Tags</button>
        <div v-if="activePanel === 'files'" class="files-panel">Files</div>
        <TagPanel v-else v-model:filter="tagsFilter" :posts="posts" :selected-tag="null" :path="null" />
      `,
    })
    const wrapper = mount(Harness)
    await wrapper.get('.show-tags').trigger('click')
    await wrapper.get('.tag-filter-input').setValue('ref')
    await wrapper.get('.show-files').trigger('click')
    await wrapper.get('.show-tags').trigger('click')
    expect((wrapper.get('.tag-filter-input').element as HTMLInputElement).value).toBe('ref')
  })

  it('renders Chinese and English copy from the shared locale', async () => {
    const wrapper = mountPanel({ selectedTag: 'reference' })
    expect(wrapper.get('.tag-filter-input').attributes('placeholder')).toBe('筛选标签…')
    expect(wrapper.text()).toContain('3 篇笔记')
    useI18n().setLocale('en')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.tag-filter-input').attributes('placeholder')).toBe('Filter tags...')
    expect(wrapper.text()).toContain('3 notes')
  })

  // Phase 1 of the unified tag plan. Tag identity is now driven by
  // `normalizeTag` (trim + lowercase + strip leading `#`), so the
  // panel must collapse `Java` / `JAVA` / `java ` from three
  // separate posts into a single entry whose display name preserves
  // the first-seen casing and whose count sums the three posts.
  it('normalizes case-and-whitespace variants into a single tag entry', () => {
    const posts: PostSummary[] = [
      { path: 'a', title: 'A', tags: ['Java'], summary: '', created: '', updated: '', size: 0, mtime: 0 },
      { path: 'b', title: 'B', tags: ['JAVA'], summary: '', created: '', updated: '', size: 0, mtime: 0 },
      { path: 'c', title: 'C', tags: [' java '], summary: '', created: '', updated: '', size: 0, mtime: 0 },
    ]
    const wrapper = mountPanel({ posts })
    const names = wrapper.findAll('.tag-label').map((n) => n.text())
    expect(names).toEqual(['Java'])
    expect(wrapper.findAll('.tag-count').map((n) => n.text())).toEqual(['3'])
  })

  // Phase 1.1 fix: typing `#java` in the tag-list filter must
  // collapse to a real tag-name filter (the leading `#` is
  // stripped). The pre-fix behavior parsed the input through
  // `parseTagQuery` and only consulted `query.text`, which routed
  // `#java` into `includeAll` and never matched any tag name.
  it('treats `#tag` in the filter input as a tag-name prefix (P1.2)', async () => {
    const wrapper = mountPanel()
    await wrapper.get('.tag-filter-input').setValue('#mat')
    // `Math` is the only tag whose normalized identity contains `mat`.
    expect(tagOrder(wrapper)).toEqual(['#Math'])
    // Sanity check the unprefixed form still works.
    await wrapper.get('.tag-filter-input').setValue('mat')
    expect(tagOrder(wrapper)).toEqual(['#Math'])
  })

  // Phase 1.1 fix: a bare `#` is an incomplete tag-name filter —
  // no tag can match the empty needle after normalizeTag strips
  // it, so the panel must show zero entries (and the count badge
  // must reflect that). Pre-fix the bare `#` silently fell
  // through to the legacy `parseTagQuery` path with `text: ''`
  // and showed every tag, which read as "your filter is doing
  // nothing."
  it('a bare `#` shows no tags (P1.2)', async () => {
    const wrapper = mountPanel()
    await wrapper.get('.tag-filter-input').setValue('#')
    expect(tagOrder(wrapper)).toEqual([])
    expect(wrapper.text()).toContain('没有匹配的标签')
  })

  // Phase 1.1 fix: a selectedTag whose casing differs from the
  // tag's stored display name still lights up the matching row.
  // Pre-fix the visual active state compared raw strings, so
  // selecting `Math` against a tag stored as `math` rendered
  // results without any row showing the active state.
  it('selectedTagKey is case-insensitive against displayName (P1.2)', () => {
    // POSTS carries `Math` (capital M) on `archive/derivation`.
    // Selecting with the lowercase form must still light up the
    // row + render the right count.
    const wrapper = mountPanel({ selectedTag: 'math' })
    const activeRow = wrapper.findAll('.tag-entry').find((row) =>
      row.classes().includes('active'),
    )
    expect(activeRow).toBeDefined()
    expect(activeRow!.text()).toContain('#Math')
    // The normalized-key comparison must also drive aria-selected.
    expect(activeRow!.attributes('aria-selected')).toBe('true')
    expect(wrapper.text()).toContain('1 篇笔记')
  })
})
