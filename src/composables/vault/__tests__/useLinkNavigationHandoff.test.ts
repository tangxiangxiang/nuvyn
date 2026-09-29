import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLinkNavigation,
  linkNavigationIntent,
  requestLinkNavigation,
} from '../../useLinkNavigation'
import {
  watchLinkNavigationHandoff,
  type LinkNavigationPane,
  type LinkNavigationTab,
} from '../useLinkNavigationHandoff'

const scopes: EffectScope[] = []

afterEach(() => {
  for (const scope of scopes) scope.stop()
  scopes.length = 0
  clearLinkNavigation()
})

async function flushHandoff(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function createHandoff(initial: {
  activePath?: string | null
  activeTab?: LinkNavigationTab | null
  isReadMode?: boolean
  readingPaneReady?: boolean
} = {}) {
  const activePath = ref<string | null>(initial.activePath ?? null)
  const activeTab = ref<LinkNavigationTab | null>(initial.activeTab ?? null)
  const editorPane = ref<LinkNavigationPane | null>(null)
  const readingPane = ref<LinkNavigationPane | null>(null)
  const readingPaneReady = ref(initial.readingPaneReady ?? false)
  const isReadMode = ref(initial.isReadMode ?? false)
  const isOrdinaryPresentation = ref(true)
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => watchLinkNavigationHandoff({
    activePath: activePath as Readonly<Ref<string | null>>,
    activeTab: activeTab as Readonly<Ref<LinkNavigationTab | null>>,
    editorPane,
    readingPane,
    readingPaneReady,
    isReadMode,
    isOrdinaryPresentation,
  }))
  return { activePath, activeTab, editorPane, readingPane, readingPaneReady, isReadMode, isOrdinaryPresentation, scope }
}

describe('link navigation handoff', () => {
  it('waits for the target tab and editor before revealing an Edit Mode anchor', async () => {
    const state = createHandoff({ activePath: 'notes/source', activeTab: { path: 'notes/source', loading: false, loadError: null } })
    const revealAnchor = vi.fn(() => true)
    requestLinkNavigation({ path: 'notes/target', anchor: 'section-2' })

    state.activePath.value = 'notes/target'
    state.activeTab.value = { path: 'notes/target', loading: true, loadError: null }
    await flushHandoff()
    expect(revealAnchor).not.toHaveBeenCalled()
    expect(linkNavigationIntent.value?.path).toBe('notes/target')

    state.activeTab.value = { path: 'notes/target', loading: false, loadError: null }
    state.editorPane.value = { revealAnchor }
    await flushHandoff()

    expect(revealAnchor).toHaveBeenCalledWith('section-2', expect.any(Function))
    expect(linkNavigationIntent.value).toBeNull()
    state.scope.stop()
  })

  it('waits for Reader rendering and reveals through the pane DOM authority', async () => {
    const state = createHandoff({
      activePath: 'notes/target',
      activeTab: { path: 'notes/target', loading: false, loadError: null },
      isReadMode: true,
    })
    const revealAnchor = vi.fn(() => true)
    state.readingPane.value = { revealAnchor }
    requestLinkNavigation({ path: 'notes/target', anchor: 'stable-id-2' })
    await flushHandoff()
    expect(revealAnchor).not.toHaveBeenCalled()

    state.readingPaneReady.value = true
    await flushHandoff()
    expect(revealAnchor).toHaveBeenCalledWith('stable-id-2', expect.any(Function))
    expect(linkNavigationIntent.value).toBeNull()
    state.scope.stop()
  })

  it('consumes an intent after entering then leaving its target while render is pending', async () => {
    const state = createHandoff({
      activePath: 'notes/source',
      activeTab: { path: 'notes/source', loading: false, loadError: null },
      isReadMode: true,
    })
    const revealAnchor = vi.fn(() => true)
    state.readingPane.value = { revealAnchor }
    requestLinkNavigation({ path: 'notes/target', anchor: 'section' })

    state.activePath.value = 'notes/target'
    state.activeTab.value = { path: 'notes/target', loading: false, loadError: null }
    await flushHandoff()
    state.activePath.value = 'notes/source'
    state.activeTab.value = { path: 'notes/source', loading: false, loadError: null }
    await flushHandoff()

    state.activePath.value = 'notes/target'
    state.activeTab.value = { path: 'notes/target', loading: false, loadError: null }
    state.readingPaneReady.value = true
    await flushHandoff()

    expect(revealAnchor).not.toHaveBeenCalled()
    expect(linkNavigationIntent.value).toBeNull()
    state.scope.stop()
  })

  it('consumes a missing anchor and a target load error', async () => {
    const missing = createHandoff({
      activePath: 'notes/target',
      activeTab: { path: 'notes/target', loading: false, loadError: null },
    })
    const revealAnchor = vi.fn(() => false)
    missing.editorPane.value = { revealAnchor }
    requestLinkNavigation({ path: 'notes/target', anchor: 'does-not-exist' })
    await flushHandoff()
    expect(revealAnchor).toHaveBeenCalledWith('does-not-exist', expect.any(Function))
    expect(linkNavigationIntent.value).toBeNull()
    missing.scope.stop()

    const failed = createHandoff({
      activePath: 'notes/missing',
      activeTab: { path: 'notes/missing', loading: false, loadError: 'not found' },
    })
    requestLinkNavigation({ path: 'notes/missing', anchor: 'section' })
    await flushHandoff()
    expect(linkNavigationIntent.value).toBeNull()
    failed.scope.stop()
  })

  it('guards a slow editor reveal when a newer same-path link intent replaces it', async () => {
    const state = createHandoff({
      activePath: 'notes/target',
      activeTab: { path: 'notes/target', loading: false, loadError: null },
    })
    const gates = [deferred(), deferred()]
    const revealed: string[] = []
    let call = 0
    const revealAnchor = vi.fn(async (anchor: string, isCurrent?: () => boolean) => {
      const gate = gates[call++]
      await gate.promise
      if (isCurrent?.()) revealed.push(anchor)
      return Boolean(isCurrent?.())
    })
    state.editorPane.value = { revealAnchor }
    requestLinkNavigation({ path: 'notes/target', anchor: 'old-anchor' })
    await flushHandoff()
    requestLinkNavigation({ path: 'notes/target', anchor: 'new-anchor' })
    await flushHandoff()

    gates[0].resolve()
    await flushHandoff()
    expect(revealed).toEqual([])
    gates[1].resolve()
    await flushHandoff()

    expect(revealed).toEqual(['new-anchor'])
    expect(linkNavigationIntent.value).toBeNull()
    state.scope.stop()
  })
})
