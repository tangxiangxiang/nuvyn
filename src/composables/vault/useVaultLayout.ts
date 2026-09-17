// Shared vault layout state. TOC, links, and AI are views of one
// persistent right rail with one width and one collapsed state.
//
// The composable owns:
//   - module-level reactive refs so NavBar and VaultView share state
//   - the useStorage hydration + the load-bearing old-schema migration
//     (fileTreeOpen / fileTreeWidth -> activePanel / sidePanelWidth)
//   - the single watcher that bridges live refs -> persisted state
//   - one computed style (vaultStyle for the outer grid)
//
// Pointer-drag handling lives in `useSplitterDrag` (separate file) —
// it imports nothing here, the caller passes the width/ratio refs in.
//
// `pathToUrl` is NOT here: it is a pure string concatenation with no
// reactive dependency, so it stays as a one-liner in VaultView.vue (it's
// only used by the tabs composable's openPost/closeTab/selectTab, which
// all live in the same file).
//
// The persisted shape is unchanged; only the storage namespace migrates.
//
import { computed, ref, watch, type Ref } from 'vue'
import { useStorage } from '@vueuse/core'
import type { SidePanel } from '../../components/vault/ActivityBar.vue'
import { NUVYN_BROWSER_STORAGE_KEYS } from '../../technicalNamespace'

export type ActivePanel = SidePanel | null
export type RightRailTab = 'toc' | 'links' | 'ai' | 'properties' | 'history'

export interface VaultLayout {
  activePanel: ActivePanel
  /* Whether the left activity bar and its side panel are collapsed. */
  leftSidebarCollapsed: boolean
  sidePanelWidth: number
  rightRailTab: RightRailTab
  rightRailWidth: number
  /* Whether the unified right rail is collapsed by user choice. */
  rightRailCollapsed: boolean
}

export interface UseVaultLayoutOptions {
  /**
   * Whether the workspace chrome should reserve its left activity/sidebar
   * tracks. Calendar Home passes its presentation state here so the layout
   * can remove the tracks instead of hiding them with a page-level CSS hack.
   */
  sidebarVisible?: Readonly<Ref<boolean>>
  /**
   * Whether the document status bar occupies the final grid row. Empty
   * workspaces can omit that row so the editor surface uses the full height.
   */
  statusBarVisible?: Readonly<Ref<boolean>>
}

const STORAGE_KEY = NUVYN_BROWSER_STORAGE_KEYS.vaultLayout
const DEFAULTS: VaultLayout = {
  activePanel: 'files',
  leftSidebarCollapsed: false,
  sidePanelWidth: 260,
  rightRailTab: 'toc',
  rightRailWidth: 380,
  rightRailCollapsed: false,
}

/* Module-level shared refs.
   NavBar (in the navbar above the router view) and VaultView (the
   router view) both call useVaultLayout(). Each call would normally
   create its own layout refs, and the two would only stay
   in sync via the round-trip through localStorage. That round-trip is
   async (useStorage's writer is next-tick), which is fine for the
   first mount but breaks reactivity: when NavBar.toggleRightRail() mutates
   its local state, VaultView's watcher doesn't see
   the change — only the localStorage-sync watcher does, and only on
   the next tick. That was the original bug: closing the AI panel in
   NavBar did not re-open the TOC in VaultView.

   By making the per-field refs module-level (the same pattern as
   `tocHeadings` in useTocState), every consumer of useVaultLayout()
   reads and writes the same Ref instances. No localStorage round-trip
   needed for runtime mutation, and watchers fire synchronously across
   consumers. localStorage is still the persistence boundary; it's
   driven by a single watcher below. */
const _activePanel = ref<ActivePanel>(DEFAULTS.activePanel)
// Remember the last panel the user had selected so the dedicated collapse
// control can restore that panel instead of always forcing Files open.
const _lastActivePanel = ref<SidePanel>(DEFAULTS.activePanel as SidePanel)
const _leftSidebarCollapsed = ref(DEFAULTS.leftSidebarCollapsed)
const _sidePanelWidth = ref(DEFAULTS.sidePanelWidth)
const _rightRailTab = ref<RightRailTab>(DEFAULTS.rightRailTab)
const _rightRailWidth = ref(DEFAULTS.rightRailWidth)
const _rightRailCollapsed = ref(DEFAULTS.rightRailCollapsed)

/* Hydration guard. The first useVaultLayout() call (which is the
   VaultView's) is the one that owns the storage round-trip — it reads
   the persisted payload into the module-level refs and installs the
   writer. Subsequent callers (e.g. NavBar) just receive the same Ref
   instances. */
let _hydrated = false

/* Test-only reset. Restores the module-level refs to their defaults
   and clears the hydration guard so the next useVaultLayout() call
   re-runs the localStorage hydration step. The persistent writer is
   left in place; it's harmless in the next mount because it re-runs
   once and reattaches. */
export function __resetVaultLayoutState(): void {
  _hydrated = false
  _activePanel.value = DEFAULTS.activePanel
  _lastActivePanel.value = DEFAULTS.activePanel as SidePanel
  _leftSidebarCollapsed.value = DEFAULTS.leftSidebarCollapsed
  _sidePanelWidth.value = DEFAULTS.sidePanelWidth
  _rightRailTab.value = DEFAULTS.rightRailTab
  _rightRailWidth.value = DEFAULTS.rightRailWidth
  _rightRailCollapsed.value = DEFAULTS.rightRailCollapsed
}

export function useVaultLayout(options: UseVaultLayoutOptions = {}) {
  const sidebarVisible = options.sidebarVisible ?? ref(true)
  const statusBarVisible = options.statusBarVisible ?? ref(true)
  // useStorage handles the deep-compare-and-skip-noop write for us, so the
  // bidirectional watcher below doesn't ping-pong on rehydration. The
  // serializer.read keeps the old {fileTreeOpen, fileTreeWidth} shape
  // working — if a user upgrades from a build that used the old keys, the
  // next read translates them into the new shape and from then on writes
  // the new shape only.
  const layout = useStorage(STORAGE_KEY, DEFAULTS, undefined, {
    serializer: {
      read: (raw) => {
        try {
          const d = JSON.parse(raw) as Record<string, unknown>
          const ap = d.activePanel
          let active: ActivePanel = null
          if (ap === 'graph') active = 'files'
          // Recovery is no longer a persistent navigation destination.
          // Migrate the old preview's saved panel to a hidden state; the
          // temporary Unsaved Content surface is opened only from a prompt.
          else if (ap === 'recovery') active = null
          else if (ap === 'files' || ap === 'tags' || ap === 'history' || ap === null) active = ap as ActivePanel
          else if (typeof d.fileTreeOpen === 'boolean') active = d.fileTreeOpen ? 'files' : null
          const w = typeof d.sidePanelWidth === 'number'
            ? d.sidePanelWidth
            : typeof d.fileTreeWidth === 'number' ? d.fileTreeWidth : DEFAULTS.sidePanelWidth
          const legacyAiOpen = d.aiOpen === true
          const storedTab = d.rightRailTab
          const rightRailTab: RightRailTab = legacyAiOpen
            ? 'ai'
            : storedTab === 'links' || storedTab === 'ai' || storedTab === 'properties' || storedTab === 'history' ? storedTab : 'toc'
          const rightRailWidth = typeof d.rightRailWidth === 'number'
            ? d.rightRailWidth
            : typeof d.aiPanelWidth === 'number' ? d.aiPanelWidth
            : typeof d.tocPanelWidth === 'number' ? d.tocPanelWidth
            : DEFAULTS.rightRailWidth
          return {
            activePanel: active,
            leftSidebarCollapsed: d.leftSidebarCollapsed === true,
            sidePanelWidth: w,
            rightRailTab,
            rightRailWidth: Math.max(280, Math.min(560, rightRailWidth)),
            // Missing means expanded. The navbar right-rail toggle is the
            // control that collapses the unified rail.
            rightRailCollapsed: legacyAiOpen ? false : typeof d.rightRailCollapsed === 'boolean' ? d.rightRailCollapsed : DEFAULTS.rightRailCollapsed,
          } satisfies VaultLayout
        } catch {
          return { ...DEFAULTS }
        }
      },
      write: (v) => JSON.stringify(v),
    },
  })

  /* The live refs are MODULE-LEVEL (see comment block above the
     ref declarations). The very first call to useVaultLayout() (which
     is the VaultView's setup) hydrates the module-level refs from the
     persisted payload, and registers a writer that persists back. Later
     callers (e.g. NavBar) get the same Ref instances. */
  if (!_hydrated) {
    _hydrated = true
    _activePanel.value = layout.value.activePanel
    _lastActivePanel.value = layout.value.activePanel ?? DEFAULTS.activePanel as SidePanel
    _leftSidebarCollapsed.value = layout.value.leftSidebarCollapsed
    _sidePanelWidth.value = layout.value.sidePanelWidth
    _rightRailTab.value = layout.value.rightRailTab
    _rightRailWidth.value = layout.value.rightRailWidth
    _rightRailCollapsed.value = layout.value.rightRailCollapsed

    // Persist on any change. useStorage's deep-compare avoids noop writes
    // (e.g. when the storage value already matches), so the round-trip
    // doesn't cause re-render storms.
    watch(
      [_activePanel, _leftSidebarCollapsed, _sidePanelWidth, _rightRailTab, _rightRailWidth, _rightRailCollapsed],
      ([ap, lsc, w, tab, rw, rrc]) => {
        layout.value = { activePanel: ap, leftSidebarCollapsed: lsc, sidePanelWidth: w, rightRailTab: tab, rightRailWidth: rw, rightRailCollapsed: rrc }
      },
    )
  }

  /* Exposed as a top-level ref so the template can use it for the
     side-splitter's v-show. */
  const sidePanelOpen = computed(() =>
    !_leftSidebarCollapsed.value && (
      _activePanel.value === 'files' ||
      _activePanel.value === 'tags' ||
      _activePanel.value === 'history' ||
      _activePanel.value === 'recovery'
    ),
  )
  const leftSidebarCollapsed: Ref<boolean> = _leftSidebarCollapsed
  const leftSidebarVisible = computed(() => sidebarVisible.value && !leftSidebarCollapsed.value)
  const activePanel: Ref<ActivePanel> = _activePanel
  const sidePanelWidth: Ref<number> = _sidePanelWidth
  const rightRailTab: Ref<RightRailTab> = _rightRailTab
  const rightRailWidth: Ref<number> = _rightRailWidth
  const rightRailCollapsed: Ref<boolean> = _rightRailCollapsed

  const vaultStyle = computed(() => {
    // Rows: editor-area (fills), optionally followed by a 24px status-bar
    // that spans the full width. Empty workspaces omit that row so the
    // editor surface can use the recovered height. Columns vary depending
    // on whether the left side panel and/or unified right rail are open.
    // The splitter grid track is 1px (matches
    // .vault .splitter { width: 1px }); the actual grabbable area is
    // wider (7px) but that lives on a
    // transparent ::before that overflows the layout box.
    //
    // The left side panel is the file tree, tag panel, or history panel.
    //
    // The right-rail panel sits on the right of the editor when expanded —
    // VaultView keeps the rail available in edit, read, History, Diff,
    // and Recovery views. The TOC tab gates on headings itself; the
    // Links tab does not. Side panel and rail coexist — the user routinely
    // reads with the file tree open on the left, and the side+rail
    // combined width (~580px) leaves plenty of room for the editor
    // area.
    //
    // The right rail is one track regardless of which tab is active.
    // Trailing space on `left` and leading space on `right`/`toc`
    // are load-bearing — they separate the splitter tracks from
    // `1fr` in the template literal below. Don't normalize the
    // whitespace.
    const left = leftSidebarVisible.value && sidePanelOpen.value ? `${sidePanelWidth.value}px 1px ` : ''
    // Keep the stored width stable while allowing the rendered track to
    // yield space on compact Vault windows. The 38vw cap only becomes
    // meaningful below the normal desktop range; max(280px, ...) keeps
    // the rail usable on very narrow screens.
    const railTrack = `minmax(280px, max(280px, min(${rightRailWidth.value}px, 560px, 38vw)))`
    // Calendar Home is a canvas-first surface. Its right rail is not mounted
    // while the same presentation flag is false, so do not reserve a hidden
    // rail track here either.
    const right = sidebarVisible.value && !rightRailCollapsed.value ? ` 1px ${railTrack}` : ''
    const activity = leftSidebarVisible.value ? '40px ' : ''
    return {
      gridTemplateColumns: `${activity}${left}1fr${right}`,
      gridTemplateRows: sidebarVisible.value && statusBarVisible.value ? '1fr 24px' : '1fr',
    }
  })
  // Template ref to the outer .vault element lives in VaultView.vue (so
  // vue-tsc is happy with the `ref="..."` string template binding). We
  // accept it as a parameter to startDrag so this composable does not
  // have to assume a particular ref name or be the owner of the DOM node.

  function selectPanel(panel: SidePanel) {
    // Keyboard shortcuts and other programmatic panel selections should
    // restore the left workspace if it was collapsed from the NavBar.
    if (leftSidebarCollapsed.value) {
      leftSidebarCollapsed.value = false
      _lastActivePanel.value = panel
      activePanel.value = panel
      return
    }
    if (activePanel.value === panel) {
      _lastActivePanel.value = panel
      activePanel.value = null
      return
    }
    _lastActivePanel.value = panel
    activePanel.value = panel
  }

  function toggleSidePanel() {
    if (!leftSidebarCollapsed.value) {
      if (activePanel.value) _lastActivePanel.value = activePanel.value
      leftSidebarCollapsed.value = true
      return
    }
    leftSidebarCollapsed.value = false
    if (!activePanel.value) activePanel.value = _lastActivePanel.value
  }

  function toggleRightRail() {
    rightRailCollapsed.value = !rightRailCollapsed.value
  }

  return {
    activePanel,
    sidePanelOpen,
    leftSidebarCollapsed,
    leftSidebarVisible,
    sidePanelWidth,
    rightRailTab,
    rightRailWidth,
    rightRailCollapsed,
    vaultStyle,
    selectPanel,
    toggleSidePanel,
    toggleRightRail,
  }
}
