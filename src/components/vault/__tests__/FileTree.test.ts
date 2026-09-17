// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import FileTree from '../FileTree.vue'
import type { PostSummary, TreeNode } from '../../../lib/api'
import { installDialogMocks } from '../../../__test-helpers__/dialogs'
import { useI18n } from '../../../composables/useI18n'
import { useScopeFilter } from '../../../composables/vault/useScopeFilter'
import { VaultContextKey } from '../../../composables/vault/context/vaultContext'
import { getFallbackVaultFileChanges } from '../../../composables/vault/context/fileChanges'
import { metadataDrafts } from '../metadataDraftStore'

installDialogMocks()

beforeEach(() => {
  localStorage.clear()
  useScopeFilter().activeScope.value = 'note'
  metadataDrafts.clear()
  useI18n().setLocale('zh')
})

afterEach(() => {
  useI18n().setLocale('zh')
})

const TREE: TreeNode[] = [{
  kind: 'folder', name: 'content', path: '', children: [
    {
      kind: 'folder', name: 'inbox', path: 'inbox', children: [
        { kind: 'file', name: 'redis-note', path: 'inbox/backend/redis-note', title: 'Cache design', mtime: 0 },
        { kind: 'file', name: 'draft', path: 'inbox/draft', title: 'Release checklist', mtime: 0 },
      ],
    },
    {
      kind: 'folder', name: 'archive', path: 'archive', children: [
        { kind: 'file', name: 'history', path: 'archive/history', title: 'Old decisions', mtime: 0 },
      ],
    },
    {
      kind: 'folder', name: 'literature', path: 'literature', children: [
        { kind: 'file', name: 'cache-paper', path: 'literature/cache-paper', title: 'Redis internals', mtime: 0 },
      ],
    },
  ],
}]

const DIARY_TREE: TreeNode[] = [{
  kind: 'folder', name: 'content', path: '', children: [
    {
      kind: 'folder', name: 'diary', path: 'diary', children: [
        { kind: 'file', name: '2026-08-24', path: 'diary/2026-08-24', title: 'Diary', mtime: 0 },
        { kind: 'file', name: '2026-08-25', path: 'diary/2026-08-25', title: 'Diary', mtime: 0 },
        { kind: 'file', name: '2026-08-26', path: 'diary/2026-08-26', title: 'Diary', mtime: 0 },
        { kind: 'file', name: 'legacy', path: 'diary/legacy', title: 'Legacy external file', mtime: 0 },
      ],
    },
  ],
}]

const POSTS: PostSummary[] = [
  { path: 'inbox/draft', title: 'Release checklist', tags: ['redis'], summary: 'secret body phrase', created: '', updated: '', size: 0, mtime: 0 },
]

function rowByName(wrapper: any, name: string): any {
  return wrapper.findAll('.tree-row').find((row: any) =>
    row.find('.row-name-text')?.text() === name || row.find('.row-name')?.text() === name,
  )
}

describe('FileTree', () => {
  it('moves a legacy metadata draft when a file is dropped at the vault root', async () => {
    metadataDrafts.set('path:inbox/draft', {
      documentId: null,
      path: 'inbox/draft',
      title: 'Draft title',
      summary: '',
      tagsText: '',
      base: { title: 'Draft title', summary: '', tags: [], updatedAt: 1 },
      dirty: true,
      revision: 1,
    })
    const renameFile = vi.fn().mockResolvedValue({ path: 'draft' })
    const wrapper = mount(FileTree, {
      props: { tree: TREE, currentPath: null },
      global: {
        provide: {
          [VaultContextKey as symbol]: {
            fileChanges: getFallbackVaultFileChanges(),
            lifecycle: { renameFile },
          },
        },
      },
    })

    await wrapper.find('.file-tree').trigger('drop', {
      dataTransfer: {
        getData: (key: string) => {
          if (key === 'text/x-nuvyn-path') return 'inbox/draft'
          if (key === 'text/x-nuvyn-kind') return 'file'
          return ''
        },
      },
    })

    expect(renameFile).toHaveBeenCalledWith('inbox/draft', { targetPath: 'draft' })
    expect(metadataDrafts.has('path:inbox/draft')).toBe(false)
    expect(metadataDrafts.get('path:draft')?.path).toBe('draft')
    wrapper.unmount()
  })

  it('reveals a path by expanding ancestors and focusing without selecting', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const wrapper = mount(FileTree, {
      props: { tree: TREE, currentPath: null },
      attachTo: document.body,
    })
    expect(await wrapper.vm.revealPath('inbox/backend/redis-note')).toBe(true)
    expect(JSON.parse(localStorage.getItem('nuvyn.vault.expandedPaths') ?? '[]'))
      .toEqual(expect.arrayContaining(['inbox', 'inbox/backend']))
    expect(document.activeElement?.getAttribute('data-tree-key')).toBe('file:inbox/backend/redis-note')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(await wrapper.vm.revealPath('missing')).toBe(false)
    wrapper.unmount()
  })

  it('renders top-level folders and expands a folder from its row', async () => {
    const wrapper = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    expect(wrapper.text()).toContain('inbox')
    expect(wrapper.text()).toContain('archive')
    expect(wrapper.text()).not.toContain('redis-note')
    await rowByName(wrapper, 'inbox').find('.row-line').trigger('click')
    expect(wrapper.text()).toContain('redis-note')
  })

  it('does not render a document hover card for file rows', async () => {
    const wrapper = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    await rowByName(wrapper, 'inbox').find('.row-line').trigger('click')
    await rowByName(wrapper, 'draft').trigger('mouseenter')

    expect(document.body.querySelector('.document-hover-card')).toBeNull()
    wrapper.unmount()
  })

  it('focuses the filter with Ctrl/Cmd+F while the tree is focused', async () => {
    const wrapper = mount(FileTree, { props: { tree: TREE, currentPath: null }, attachTo: document.body })
    await rowByName(wrapper, 'inbox').trigger('keydown', { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(wrapper.find('.search-input').element)
    wrapper.unmount()
  })

  it('persists deliberate expansion separately from filter expansion', async () => {
    const wrapper = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    await rowByName(wrapper, 'inbox').find('.chevron').trigger('click')
    expect(JSON.parse(localStorage.getItem('nuvyn.vault.expandedPaths') ?? '[]')).toContain('inbox')
  })
})

describe('Files filter', () => {
  function mountTree() {
    return mount(FileTree, { props: { tree: TREE, posts: POSTS, currentPath: null } })
  }

  it('groups inbox, literature, and archive under the note scope', () => {
    useScopeFilter().activeScope.value = 'note'
    const wrapper = mountTree()

    expect(wrapper.text()).toContain('inbox')
    expect(wrapper.text()).toContain('literature')
    expect(wrapper.text()).toContain('archive')

    wrapper.unmount()
  })

  it('matches title, filename, and directory path without case sensitivity', async () => {
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('CHECKLIST')
    expect(wrapper.text()).toContain('draft')

    await wrapper.find('.search-input').setValue('redis-note')
    expect(wrapper.text()).toContain('redis-note')

    await wrapper.find('.search-input').setValue('backend')
    expect(wrapper.text()).toContain('redis-note')
  })

  it('AND-composes multiple tokens across fields', async () => {
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('redis cache')
    expect(wrapper.text()).toContain('redis-note')
    expect(wrapper.text()).toContain('cache-paper')

    await wrapper.find('.search-input').setValue('redis checklist')
    expect(wrapper.text()).not.toContain('draft')
    expect(wrapper.text()).not.toContain('redis-note')
    expect(wrapper.text()).not.toContain('cache-paper')
  })

  it('does not match summary or tags', async () => {
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('secret body phrase')
    expect(wrapper.text()).not.toContain('draft')
    await wrapper.find('.search-input').setValue('redis')
    expect(wrapper.text()).not.toContain('draft')
  })

  it('keeps the complete subtree when a folder matches', async () => {
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('archive')
    expect(wrapper.text()).toContain('history')
  })

  it('keeps matching ancestors visible and auto-expands them without persisting', async () => {
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('redis-note')
    expect(wrapper.text()).toContain('inbox')
    expect(wrapper.text()).toContain('redis-note')
    expect(JSON.parse(localStorage.getItem('nuvyn.vault.expandedPaths') ?? '[]')).not.toContain('inbox')
  })

  it('clears with Escape and the clear button', async () => {
    const wrapper = mountTree()
    const input = wrapper.find('.search-input')
    await input.setValue('redis')
    await input.trigger('keydown', { key: 'Escape' })
    expect((input.element as HTMLInputElement).value).toBe('')

    await input.setValue('redis')
    await wrapper.find('.search-clear-x').trigger('click')
    expect((input.element as HTMLInputElement).value).toBe('')
  })

  it('preserves the filter when FileTree is unmounted during a view switch', async () => {
    const Harness = defineComponent({
      components: { FileTree },
      setup() {
        return { activePanel: ref<'files' | 'tags'>('files'), filesFilter: ref(''), tree: TREE }
      },
      template: `
        <button class="show-files" @click="activePanel = 'files'">Files</button>
        <button class="show-tags" @click="activePanel = 'tags'">Tags</button>
        <FileTree
          v-if="activePanel === 'files'"
          v-model:filter="filesFilter"
          :tree="tree"
          :current-path="null"
        />
        <div v-else class="tags-panel">Tags</div>
      `,
    })
    const wrapper = mount(Harness)
    await wrapper.find('.search-input').setValue('redis')
    await wrapper.find('.show-tags').trigger('click')
    expect(wrapper.find('.search-input').exists()).toBe(false)
    await wrapper.find('.show-files').trigger('click')
    expect((wrapper.find('.search-input').element as HTMLInputElement).value).toBe('redis')
  })

  it('reports one prioritized match field per token', async () => {
    const wrapper = mountTree()

    await wrapper.find('.search-input').setValue('cache')
    expect(rowByName(wrapper, 'redis-note').find('.row-name').attributes('title')).toContain('标题')
    expect(rowByName(wrapper, 'redis-note').find('.row-name').attributes('title')).not.toContain('文件名')

    await wrapper.find('.search-input').setValue('redis-note')
    expect(rowByName(wrapper, 'redis-note').find('.row-name').attributes('title')).toContain('文件名')
    expect(rowByName(wrapper, 'redis-note').find('.row-name').attributes('title')).not.toContain('路径')

    await wrapper.find('.search-input').setValue('backend')
    expect(rowByName(wrapper, 'redis-note').find('.row-name').attributes('title')).toContain('路径')
  })

  // Phase 1 of the unified tag plan: tag-shaped tokens (`#xxx`,
  // `-#xxx`) are routed through the shared `lib/tags` parser /
  // matcher so FileTree and TagPanel can never drift apart on tag
  // semantics again. Pure text queries continue to use the legacy
  // substring branch.
  it('matches `#tag` tokens against post.tags (shared with TagPanel)', async () => {
    // `POSTS` carries `inbox/draft` with tag `redis`. Neither the
    // file's path (`inbox/draft`) nor its title (`Release checklist`)
    // contains the literal `redis`, so a legacy substring search
    // would not find it. The shared tag matcher must.
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('#redis')
    expect(rowByName(wrapper, 'draft')).toBeDefined()
    // Files without that tag must NOT appear.
    expect(rowByName(wrapper, 'redis-note')).toBeUndefined()
    expect(rowByName(wrapper, 'history')).toBeUndefined()
    expect(rowByName(wrapper, 'cache-paper')).toBeUndefined()
  })

  it('excludes files with `-#tag` tokens', async () => {
    // Same data; -#redis must drop the only redis-tagged file.
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('-#redis')
    expect(rowByName(wrapper, 'draft')).toBeUndefined()
    // Other files don't carry the tag either, but they also don't
    // carry it, so they should still appear (exclude only filters
    // out matches, doesn't require inclusion).
    expect(rowByName(wrapper, 'redis-note')).toBeDefined()
  })

  it('combines `#tag` and plain text with AND', async () => {
    const wrapper = mountTree()
    // `#redis` alone matches the `draft` file via its tag. Adding
    // `release` (which is in the title) keeps the match. Adding
    // `nonexistent-needle` should drop it.
    await wrapper.find('.search-input').setValue('#redis release')
    expect(rowByName(wrapper, 'draft')).toBeDefined()

    await wrapper.find('.search-input').setValue('#redis nonexistent-needle')
    expect(rowByName(wrapper, 'draft')).toBeUndefined()
  })

  it('preserves the legacy substring branch for queries without `#` tokens', async () => {
    // Pure-text queries must continue to match by path / title
    // substring (case-insensitive), exactly as before Phase 1.
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('checklist')
    expect(rowByName(wrapper, 'draft')).toBeDefined()
    // `redis-note` is matched by its path segment in the legacy
    // branch — confirms the branch wasn't accidentally bypassed.
    await wrapper.find('.search-input').setValue('redis-note')
    expect(rowByName(wrapper, 'redis-note')).toBeDefined()
  })

  // Phase 1.1 fix: the AND-tokenized text semantic must survive a
  // `#tag` prefix. `#java redis cache` is interpreted as
  // "tagged #java AND (path/title contains 'redis') AND (path/
  // title contains 'cache')" — same AND semantic the legacy
  // `"redis cache"` query had. The shared-model branch must NOT
  // collapse the text tokens into one continuous string.
  it('keeps multi-text-token AND semantics under a `#tag` prefix (P1.3)', async () => {
    // POSTS only has `inbox/draft` tagged `redis`. There's no
    // file whose path or title contains BOTH `redis` and `cache`,
    // so the strict AND across text tokens must drop every file.
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('#redis cache')
    expect(rowByName(wrapper, 'draft')).toBeUndefined()
    // Plain text query without the tag, but with the same AND,
    // behaves identically — locks the rule across both branches.
    await wrapper.find('.search-input').setValue('redis cache')
    expect(rowByName(wrapper, 'draft')).toBeUndefined()
    // Single-token text AND a single-tag query matches.
    await wrapper.find('.search-input').setValue('#redis checklist')
    expect(rowByName(wrapper, 'draft')).toBeDefined()
  })

  // Phase 1.1 fix: text tokens MUST NOT search the body summary.
  // POSTS[0].summary is `'secret body phrase'`; without the fix
  // `#redis secret` would match via the summary.
  it('does NOT search the body summary (P1.3)', async () => {
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('#redis secret')
    expect(rowByName(wrapper, 'draft')).toBeUndefined()
  })

  // Phase 1.1 fix: a bare `#` is no tag name, no text token, no
  // exclude. `parseTagQuery('#')` produces an empty query and
  // `matchesTagQuery` short-circuits to true — the tree stays
  // intact, the user sees that their input is incomplete rather
  // than watching every file disappear.
  it('a bare `#` shows the full tree (no silent literal-`#` filter) (P1.3)', async () => {
    const wrapper = mountTree()
    await wrapper.find('.search-input').setValue('#')
    expect(rowByName(wrapper, 'redis-note')).toBeDefined()
    expect(rowByName(wrapper, 'draft')).toBeDefined()
    expect(rowByName(wrapper, 'cache-paper')).toBeDefined()
    expect(rowByName(wrapper, 'history')).toBeDefined()
  })
})

describe('Diary FileTree presentation boundary', () => {
  it('keeps managed and invalid Diary files visible in the FileTree', async () => {
    useScopeFilter().activeScope.value = 'diary'
    const wrapper = mount(FileTree, { props: { tree: DIARY_TREE, currentPath: null } })

    expect(wrapper.text()).toContain('diary')
    await rowByName(wrapper, 'diary').find('.chevron').trigger('click')
    expect(wrapper.text()).toContain('2026-08-24')
    expect(wrapper.text()).toContain('legacy')
  })

  it('applies a generic exact-path filter and keeps only required ancestors', () => {
    useScopeFilter().activeScope.value = 'diary'
    const wrapper = mount(FileTree, {
      props: {
        tree: DIARY_TREE,
        currentPath: 'diary/2026-08-25',
        exactPathFilter: 'diary/2026-08-25',
        exactPathFilterLabel: '2026-08-25',
      },
    })

    expect(wrapper.text()).toContain('diary')
    expect(wrapper.text()).toContain('2026-08-25')
    expect(wrapper.text()).not.toContain('2026-08-24')
    expect(wrapper.text()).not.toContain('2026-08-26')
    expect(wrapper.text()).not.toContain('legacy')
    expect(wrapper.find('[data-testid="file-tree-exact-context"]').exists()).toBe(false)
    expect(wrapper.find('.search-input').exists()).toBe(true)
  })

  it('does not fall back to the full tree when the exact path is missing', () => {
    useScopeFilter().activeScope.value = 'diary'
    const wrapper = mount(FileTree, {
      props: {
        tree: DIARY_TREE,
        currentPath: null,
        exactPathFilter: 'diary/2099-01-01',
      },
    })

    expect(wrapper.findAll('.tree-row')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('2026-08-24')
    expect(wrapper.text()).not.toContain('legacy')
  })

  it('keeps the user filter editable while exact path remains constrained', async () => {
    useScopeFilter().activeScope.value = 'diary'
    const Harness = defineComponent({
      components: { FileTree },
      setup() {
        return {
          tree: DIARY_TREE,
          filesFilter: ref('redis'),
          exactPath: ref<string | null>('diary/2026-08-25'),
        }
      },
      template: `
        <FileTree
          v-model:filter="filesFilter"
          :tree="tree"
          :current-path="exactPath"
          :exact-path-filter="exactPath"
        />
        <span data-testid="stored-filter">{{ filesFilter }}</span>
      `,
    })
    const wrapper = mount(Harness)

    expect(wrapper.find('.search-input').exists()).toBe(true)
    expect((wrapper.get('.search-input').element as HTMLInputElement).value).toBe('redis')
    expect(wrapper.text()).not.toContain('2026-08-25')
    expect(wrapper.get('[data-testid="stored-filter"]').text()).toBe('redis')

    await wrapper.get('.search-input').setValue('2026-08-25')
    expect(wrapper.text()).toContain('2026-08-25')
  })

  it('uses the normal searchable FileTree input in exact-path context', () => {
    useScopeFilter().activeScope.value = 'diary'
    const wrapper = mount(FileTree, {
      props: {
        tree: DIARY_TREE,
        currentPath: 'diary/2026-08-25',
        exactPathFilter: 'diary/2026-08-25',
      },
      attachTo: document.body,
    })

    expect(wrapper.get('.search-input').element).toBeInstanceOf(HTMLInputElement)
    wrapper.unmount()
  })
})
