import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type WatchStopHandle } from 'vue'
import {
  clearSearchReveal,
  consumeSearchReveal,
  requestSearchReveal,
  searchRevealIntent,
} from '../../useSearchReveal'
import {
  watchSearchRevealHandoff,
  type SearchRevealEditor,
  type SearchRevealTab,
} from '../useSearchRevealHandoff'

async function flushRevealWatch(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
}

describe('search reveal intent', () => {
  beforeEach(clearSearchReveal)
  afterEach(clearSearchReveal)

  it('creates a fresh id for each request and consumes only the current id', () => {
    const first = requestSearchReveal({ path: 'inbox/a', text: 'redis' })
    const second = requestSearchReveal({ path: 'inbox/a', text: 'redis' })

    expect(first.id).not.toBe(second.id)
    expect(searchRevealIntent.value).toEqual(second)
    consumeSearchReveal(first.id)
    expect(searchRevealIntent.value).toEqual(second)
    consumeSearchReveal(second.id)
    expect(searchRevealIntent.value).toBeNull()
  })

  it('clears the pending intent explicitly', () => {
    requestSearchReveal({ path: 'inbox/a', text: 'redis' })
    clearSearchReveal()
    expect(searchRevealIntent.value).toBeNull()
  })
})

describe('VaultView search reveal handoff', () => {
  let stop: WatchStopHandle | undefined

  beforeEach(clearSearchReveal)
  afterEach(() => {
    stop?.()
    stop = undefined
    clearSearchReveal()
  })

  function setup(initial: {
    path?: string | null
    tab?: SearchRevealTab | null
    editor?: SearchRevealEditor | null
    readMode?: boolean
    ordinary?: boolean
  } = {}) {
    const activePath = ref<string | null>(initial.path ?? null)
    const activeTab = ref<SearchRevealTab | null>(initial.tab ?? null)
    const editorPane = ref<SearchRevealEditor | null>(initial.editor ?? null)
    const isReadMode = ref(initial.readMode ?? false)
    const isOrdinaryPresentation = ref(initial.ordinary ?? true)
    stop = watchSearchRevealHandoff({ activePath, activeTab, editorPane, isReadMode, isOrdinaryPresentation })
    return { activePath, activeTab, editorPane, isReadMode, isOrdinaryPresentation }
  }

  it('waits for an unopened target Note to load and for EditorPane to mount', async () => {
    const { activePath, activeTab, editorPane } = setup()
    const revealText = vi.fn(() => true)
    const intent = requestSearchReveal({ path: 'inbox/target', text: 'transaction isolation' })
    await flushRevealWatch()
    expect(searchRevealIntent.value).toEqual(intent)
    expect(revealText).not.toHaveBeenCalled()

    activePath.value = 'inbox/target'
    activeTab.value = { path: 'inbox/target', loading: true, loadError: null }
    await flushRevealWatch()
    expect(revealText).not.toHaveBeenCalled()

    activeTab.value.loading = false
    await flushRevealWatch()
    expect(searchRevealIntent.value).toEqual(intent)
    expect(revealText).not.toHaveBeenCalled()

    editorPane.value = { revealText }
    await flushRevealWatch()
    expect(revealText).toHaveBeenCalledOnce()
    expect(revealText).toHaveBeenCalledWith('transaction isolation')
    expect(searchRevealIntent.value).toBeNull()
  })

  it('keeps a not-yet-entered target pending across route ticks', async () => {
    const state = setup({
      path: 'inbox/a',
      tab: { path: 'inbox/a', loading: false, loadError: null },
    })
    const intent = requestSearchReveal({ path: 'inbox/b', text: 'target body' })

    await flushRevealWatch()
    await flushRevealWatch()
    await flushRevealWatch()

    expect(state.activePath.value).toBe('inbox/a')
    expect(searchRevealIntent.value).toEqual(intent)
  })

  it('consumes an entered target when the user leaves before reveal, preventing a later stale reveal', async () => {
    const tabA = { path: 'inbox/a', loading: false, loadError: null }
    const tabBLoading = { path: 'inbox/b', loading: true, loadError: null }
    const state = setup({ path: tabA.path, tab: tabA })
    const revealText = vi.fn(() => true)
    const intent = requestSearchReveal({ path: 'inbox/b', text: 'target body' })

    await flushRevealWatch()
    expect(searchRevealIntent.value).toEqual(intent)

    state.activePath.value = tabBLoading.path
    state.activeTab.value = tabBLoading
    await flushRevealWatch()
    expect(searchRevealIntent.value).toEqual(intent)

    state.activePath.value = tabA.path
    state.activeTab.value = tabA
    await flushRevealWatch()
    expect(searchRevealIntent.value).toBeNull()

    state.activePath.value = 'inbox/b'
    state.activeTab.value = { path: 'inbox/b', loading: false, loadError: null }
    state.editorPane.value = { revealText }
    await flushRevealWatch()
    expect(revealText).not.toHaveBeenCalled()
  })

  it('resets entered-target tracking when a newer intent replaces the old one', async () => {
    const state = setup({ path: 'inbox/a', tab: { path: 'inbox/a', loading: false, loadError: null } })
    requestSearchReveal({ path: 'inbox/b', text: 'first target' })
    state.activePath.value = 'inbox/b'
    state.activeTab.value = { path: 'inbox/b', loading: true, loadError: null }
    await flushRevealWatch()

    const latest = requestSearchReveal({ path: 'inbox/c', text: 'second target' })
    await flushRevealWatch()
    expect(searchRevealIntent.value).toEqual(latest)

    state.activePath.value = 'inbox/c'
    state.activeTab.value = { path: 'inbox/c', loading: true, loadError: null }
    await flushRevealWatch()
    expect(searchRevealIntent.value).toEqual(latest)
  })

  it('reveals on the current same-route Note and handles repeated identical requests', async () => {
    const revealText = vi.fn(() => true)
    setup({
      path: 'inbox/current',
      tab: { path: 'inbox/current', loading: false, loadError: null },
      editor: { revealText },
    })

    const first = requestSearchReveal({ path: 'inbox/current', text: 'redis' })
    await flushRevealWatch()
    expect(revealText).toHaveBeenNthCalledWith(1, 'redis')
    expect(searchRevealIntent.value).toBeNull()

    const second = requestSearchReveal({ path: 'inbox/current', text: 'redis' })
    expect(second.id).not.toBe(first.id)
    await flushRevealWatch()
    expect(revealText).toHaveBeenCalledTimes(2)
    expect(searchRevealIntent.value).toBeNull()
  })

  it('reveals after an already-open inactive tab becomes active', async () => {
    const tabA = { path: 'inbox/a', loading: false, loadError: null }
    const existingTabB = { path: 'inbox/b', loading: false, loadError: null }
    const revealText = vi.fn(() => true)
    const state = setup({ path: tabA.path, tab: tabA })

    requestSearchReveal({ path: existingTabB.path, text: 'existing target' })
    await flushRevealWatch()
    expect(revealText).not.toHaveBeenCalled()

    state.activePath.value = existingTabB.path
    state.activeTab.value = existingTabB
    state.editorPane.value = { revealText }
    await flushRevealWatch()

    expect(state.activeTab.value).toMatchObject({ path: existingTabB.path })
    expect(revealText).toHaveBeenCalledOnce()
    expect(revealText).toHaveBeenCalledWith('existing target')
    expect(searchRevealIntent.value).toBeNull()
  })

  it('consumes stale text after the editor declines to reveal it', async () => {
    const revealText = vi.fn(() => false)
    setup({
      path: 'inbox/stale',
      tab: { path: 'inbox/stale', loading: false, loadError: null },
      editor: { revealText },
    })

    requestSearchReveal({ path: 'inbox/stale', text: 'no longer present' })
    await flushRevealWatch()

    expect(revealText).toHaveBeenCalledOnce()
    expect(searchRevealIntent.value).toBeNull()
  })

  it('clears a failed target load without calling EditorPane', async () => {
    const revealText = vi.fn(() => true)
    setup({
      path: 'inbox/missing',
      tab: { path: 'inbox/missing', loading: false, loadError: 'not found' },
      editor: { revealText },
    })

    requestSearchReveal({ path: 'inbox/missing', text: 'anything' })
    await flushRevealWatch()

    expect(revealText).not.toHaveBeenCalled()
    expect(searchRevealIntent.value).toBeNull()
  })

  it('opens successfully in Read Mode but consumes without revealing or changing mode', async () => {
    const revealText = vi.fn(() => true)
    const state = setup({
      path: 'inbox/read-mode',
      tab: { path: 'inbox/read-mode', loading: false, loadError: null },
      editor: { revealText },
      readMode: true,
    })

    requestSearchReveal({ path: 'inbox/read-mode', text: 'source query' })
    await flushRevealWatch()

    expect(revealText).not.toHaveBeenCalled()
    expect(state.isReadMode.value).toBe(true)
    expect(searchRevealIntent.value).toBeNull()
  })
})
