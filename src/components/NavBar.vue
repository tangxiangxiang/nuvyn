<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import {
  Box,
  Calendar,
  Edit,
  Eye,
  LayoutSidebarLeftExpand,
  LayoutSidebarRightExpand,
  Lock,
  Moon,
  Notes,
  Search,
  Sun,
  Wallet,
} from '@vicons/tabler'
import { useRoute, useRouter } from 'vue-router'
import { useTheme } from '../composables/useTheme'
import { VaultViewModeKey } from '../composables/vault/viewMode'
import { useScopeFilter } from '../composables/vault/useScopeFilter'
import type { ScopeKey } from '../../shared/scopeProtocol'
import { useVaultLayout } from '../composables/vault/useVaultLayout'
import { useI18n } from '../composables/useI18n'
import { DiaryAccessContextKey } from '../composables/diary/diaryAccessContext'
import { AppShellContextKey } from '../composables/appShellContext'
import AccountMenu from './vault/AccountMenu.vue'
import { isNuvynShortcutBlocked } from '../lib/keyboard'
import { isDiaryShortcutBlocked, isDiaryTextEntryContext } from '../views/diaryShortcutChord'
import {
  isWorkspaceNavigationAvailable,
  workspaceMobileNavigationQuery,
  type ChromeStyle,
  type WorkspaceKind,
} from '../lib/workspace'

const props = withDefaults(defineProps<{
  workspaceKind?: WorkspaceKind
  chromeStyle?: ChromeStyle
  /** Compatibility alias for isolated Vault/NavBar callers. */
  isVault?: boolean
  username?: string | null
  logoutBusy?: boolean
  diaryUnlocked?: boolean
  diaryLockBusy?: boolean
}>(), {
  workspaceKind: null,
  chromeStyle: 'workspace',
  isVault: false,
  username: '',
  logoutBusy: false,
  diaryUnlocked: false,
  diaryLockBusy: false,
})
const emit = defineEmits<{
  'open-search': []
  'open-settings': []
  logout: []
  'lock-diary': []
}>()

const { theme, toggle } = useTheme()
const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()
const workspaceMobileMediaQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia(workspaceMobileNavigationQuery)
  : null
const isMobileWorkspaceViewport = ref(workspaceMobileMediaQuery?.matches ?? false)

function onWorkspaceViewportChange(event: MediaQueryListEvent): void {
  isMobileWorkspaceViewport.value = event.matches
}

const workspaceNavigationViewport = computed(() => isMobileWorkspaceViewport.value ? 'mobile' : 'desktop')
const showBoardNavigation = computed(() => (
  isWorkspaceNavigationAvailable('board', workspaceNavigationViewport.value)
))

const effectiveWorkspaceKind = computed<WorkspaceKind>(() => {
  if (props.workspaceKind !== null && props.workspaceKind !== undefined) return props.workspaceKind
  return props.isVault ? 'vault' : null
})
const isWorkspace = computed(() => effectiveWorkspaceKind.value !== null)
const isVault = computed(() => effectiveWorkspaceKind.value === 'vault')
/* Ledger shares this navbar with Vault, but its body does not own Vault's
   editor/read-mode or right-rail controls. Keep the route fallback for
   legacy isolated mounts that still pass only `isVault`. */
const isLedger = computed(() => (
  effectiveWorkspaceKind.value === 'ledger'
  || (props.workspaceKind === null && props.isVault && route?.path?.startsWith('/ledger') === true)
))
const isBoard = computed(() => effectiveWorkspaceKind.value === 'board')
const isImmersive = computed(() => props.chromeStyle === 'immersive')
const showScopeChips = computed(() => isWorkspace.value && !isImmersive.value)
const showSearchButton = computed(() => (
  isWorkspace.value
  && !isImmersive.value
  && !isLedger.value
))

/* Sun when current theme is dark (click to lighten),
   moon when current theme is light (click to darken). */
const themeIcon = computed<'sun' | 'moon'>(() => (theme.value === 'dark' ? 'sun' : 'moon'))

const themeTitle = computed<string>(() => {
  const next = t(theme.value === 'dark' ? 'nav.theme_light' : 'nav.theme_dark')
  const current = t(theme.value === 'dark' ? 'nav.theme_dark' : 'nav.theme_light')
  return t('nav.theme', { current, next })
})

const scopeChips = computed(() => {
  const chips = [
    { scope: 'note', label: 'note', icon: Notes },
    { scope: 'diary', label: 'diary', icon: props.diaryUnlocked ? Calendar : Lock },
    { scope: 'ledger', label: 'ledger', icon: Wallet },
  ] as const
  return chips.filter((chip) => (
    isWorkspaceNavigationAvailable(chip.scope, workspaceNavigationViewport.value)
  ))
})

function scopeLabel(scope: ScopeKey, label: string): string {
  return isScopeActive(scope)
    ? t('nav.scope_active', { scope: label })
    : t('nav.scope_only', { scope: label })
}

/* View-mode toggle. The button shows the icon of the *opposite*
   mode (i.e. "click to switch to that"), matching the convention
   used by theme/AI toggles in this bar. State is owned by App.vue
   (via VaultViewModeKey) so the keyboard shortcut Cmd/Ctrl+E and
   this button share one source of truth and stay in sync. */
const viewModeApi = inject(VaultViewModeKey, null)
const isReadMode = computed(() => viewModeApi?.mode.value === 'read')

/* Scope filter (vault root chips). Owned by the composable so
   FileTree can read the active scope and the chips here can write it.
   Counts are pushed in by VaultView whenever the tree changes. */
const { activeScope, selectScope } = useScopeFilter()
const navigationSelectedScope = ref<ScopeKey | null>(null)
watch(activeScope, () => {
  navigationSelectedScope.value = null
}, { flush: 'sync' })
const diaryAccess = inject(DiaryAccessContextKey, null)
const appShell = inject(AppShellContextKey, null)

let analysisExportHoveredScope: 'diary' | 'ledger' | null = null
let analysisExportRunning = false
let analysisExportDisposed = false

function supportsAnalysisHover(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

function leaveAnalysisScopeChip(): void {
  analysisExportHoveredScope = null
  window.removeEventListener('keydown', onAnalysisExportKeydown)
}

function enterScopeChip(scope: ScopeKey): void {
  if ((scope !== 'diary' && scope !== 'ledger') || analysisExportDisposed || !supportsAnalysisHover()) return
  if (analysisExportHoveredScope === scope) return
  leaveAnalysisScopeChip()
  analysisExportHoveredScope = scope
  window.addEventListener('keydown', onAnalysisExportKeydown)
}

async function runAnalysisExport(scope: 'diary' | 'ledger', command: () => Promise<void>): Promise<void> {
  analysisExportRunning = true
  try {
    await command()
  } catch {
    // Never log an exception which might carry decrypted document context.
    console.error(`${scope === 'diary' ? 'Diary' : 'Ledger'} analysis export failed`)
  } finally {
    analysisExportRunning = false
  }
}

function onAnalysisExportKeydown(event: KeyboardEvent): void {
  const scope = analysisExportHoveredScope
  if (!scope || analysisExportDisposed || analysisExportRunning
    || !isScopeActive(scope) || props.logoutBusy || !supportsAnalysisHover()
    || event.key.toLowerCase() !== 'e' || event.repeat || event.isComposing || event.defaultPrevented
    || event.ctrlKey || event.metaKey || event.altKey || isNuvynShortcutBlocked(event)
    || isDiaryTextEntryContext(event) || isDiaryShortcutBlocked(event)
    || event.composedPath().some((target) => target instanceof HTMLElement && target.isContentEditable)) return
  if (scope === 'diary' && (!isVault.value || isLedger.value || !props.diaryUnlocked)) return
  if (scope === 'ledger' && !isLedger.value) return
  const command = scope === 'diary'
    ? appShell?.diaryAnalysisExportCommand?.value
    : appShell?.ledgerAnalysisExportCommand?.value
  if (command) void runAnalysisExport(scope, command)
}

watch(showScopeChips, (visible) => {
  if (!visible) leaveAnalysisScopeChip()
}, { flush: 'sync' })

function requestGlobalSearch(): void {
  if (appShell?.openGlobalSearch) appShell.openGlobalSearch()
  else emit('open-search')
}

function isVaultLedgerDocument(): boolean {
  return isVault.value
    && !isLedger.value
    && route?.name === 'vault-doc'
    && route.path.startsWith('/vault/ledger/')
}

function activeVaultDocumentScope(): ScopeKey | null {
  if (!isVault.value || route?.name !== 'vault-doc') return null
  const pathMatch = route.params.pathMatch as string[] | string | undefined
  const path = Array.isArray(pathMatch) ? pathMatch.join('/') : pathMatch ?? ''
  if (!path) return null
  // A Diary URL does not prove an unlocked Diary scope. During lock recovery
  // the same document route remains while App normalizes the scope to Note.
  if (path === 'diary' || path.startsWith('diary/')) return null
  if (path === 'ledger' || path.startsWith('ledger/')) return 'ledger'
  return 'note'
}

function isScopeActive(scope: ScopeKey): boolean {
  if (isBoard.value) return false
  if (isLedger.value) return scope === 'ledger'
  if (scope === 'ledger' && isVaultLedgerDocument()) return true
  // When Calendar Home is the visible surface, the selected Vault scope owns
  // navigation state. A retained document URL must not mask a scope change.
  if (appShell?.diaryCalendarVisible.value === true) return activeScope.value === scope
  if (navigationSelectedScope.value) return navigationSelectedScope.value === scope
  const documentScope = activeVaultDocumentScope()
  if (documentScope) return scope === documentScope
  return activeScope.value === scope
}

/* Calendar Home is the Diary scope at the Vault root. A Diary document has a
   nested /vault/<path> route and keeps the normal reading/editing controls.
   VaultView publishes the resolved visibility so a retained document URL
   cannot make Calendar Home controls appear; the route fallback keeps this
   component correct in isolated mounts without the App shell. */
const isDiaryCalendarVisible = computed(() => (
  isVault.value
  && (
    appShell?.diaryCalendarVisible.value === true
    || (activeScope.value === 'diary' && route?.name === 'vault')
  )
))

/* The Vault home can have a highlighted file-tree row without an active
   document. Reading/editing is meaningful only after a document route has
   been opened. Keep the isolated NavBar mount fallback visible for callers
   that do not install a router; the real app always has a named route. */
const isVaultDocumentVisible = computed(() => (
  !route?.name || route.name === 'vault-doc'
))

function onScopeClick(scope: ScopeKey): void {
  if (scope === 'ledger') {
    // Keep direct legacy Ledger documents usable in the Vault while the
    // top-level Ledger chip opens the canonical Ledger workspace elsewhere.
    if (isVaultLedgerDocument()) {
      selectScope('ledger')
      navigationSelectedScope.value = 'ledger'
      return
    }
    if (!isLedger.value) {
      navigationSelectedScope.value = 'ledger'
      void router.push({ name: 'ledger' })
    }
    return
  }
  if (isLedger.value) {
    if (scope === 'diary' && diaryAccess) {
      void diaryAccess.requestScopeChange(scope).then(() => {
        if (activeScope.value === scope) {
          navigationSelectedScope.value = scope
          void router.push({ name: 'vault' })
        }
      })
      return
    }
    selectScope(scope)
    navigationSelectedScope.value = scope
    void router.push({ name: 'vault' })
    return
  }
  if (
    scope === 'diary'
    && isVault.value
    && props.diaryUnlocked
    && activeScope.value === 'diary'
  ) {
    // The Vault owns whether this is an ordinary Diary document eligible for
    // Back. Calendar Home and special surfaces intentionally turn this into
    // a no-op; the navbar never duplicates document-close policy.
    navigationSelectedScope.value = scope
    appShell?.diaryBackCommand?.value?.()
    return
  }
  if (scope === 'note' && isVault.value && activeScope.value === 'diary') {
    const changeScope = appShell?.vaultScopeChangeCommand?.value
    if (!changeScope) return
    void changeScope('note').then((completed) => {
      if (completed && activeScope.value === 'note') {
        navigationSelectedScope.value = 'note'
      }
    }).catch(() => {})
    return
  }
  if (scope === 'diary' && diaryAccess) {
    void diaryAccess.requestScopeChange(scope).then(() => {
      if (activeScope.value === scope) navigationSelectedScope.value = scope
      if (isBoard.value && activeScope.value === scope) void router.push({ name: 'vault' })
    })
    return
  }
  selectScope(scope)
  navigationSelectedScope.value = scope
  if (isBoard.value) void router.push({ name: 'vault' })
}

/* Right-rail toggle. This button owns only the rail's expanded/collapsed
   state; the three tabs inside the rail own tab selection. Keeping those
   responsibilities separate means collapsing the rail never changes the
   user's selected tab. */
const { leftSidebarCollapsed, leftSidebarVisible, rightRailCollapsed, workspaceRightPanelAvailable, toggleSidePanel, toggleRightRail } = useVaultLayout()

const showBrandConstellation = ref(false)
const brandVirtueModeActive = ref(false)
const reducedMotionActive = ref(false)
const activeBrandVirtueIndex = ref<number | null>(null)
const launchedBrandVirtueIndices = ref<Set<number>>(new Set())
const arrivedBrandVirtueIndices = ref<Set<number>>(new Set())
let brandHoverTimer: ReturnType<typeof setTimeout> | undefined
let brandClickSuppressTimer: ReturnType<typeof setTimeout> | undefined
let brandVirtueLaunchTimer: ReturnType<typeof setTimeout> | undefined
let brandVirtueFinalHoldTimer: ReturnType<typeof setTimeout> | undefined
const brandVirtueParticleWatchdogs = new Map<number, ReturnType<typeof setTimeout>>()
let reducedMotionMediaQuery: MediaQueryList | null = null
let brandConstellationCycle = 0
let brandVirtueRun = 0
let brandAnimationFinished = false
let brandVirtueFinalizing = false
let touchPointerId: number | null = null
let touchPointerOrigin: { x: number; y: number } | null = null
let touchLongPressTriggered = false
let brandConstellationTrigger: 'hover' | 'touch' | null = null
let suppressBrandClick = false
let pendingBrandZenEntry: (() => boolean) | null = null

const BRAND_NODES = [
  { x: 500, y: 145 },
  { x: 728, y: 228 },
  { x: 849, y: 438 },
  { x: 808, y: 678 },
  { x: 621, y: 834 },
  { x: 379, y: 834 },
  { x: 192, y: 678 },
  { x: 151, y: 438 },
  { x: 272, y: 228 },
]

const BRAND_VIRTUES = [
  { key: 'courage', color: '#6270AC' },
  { key: 'honesty', color: '#6977B7' },
  { key: 'reflection', color: '#7280C2' },
  { key: 'humility', color: '#7D89CD' },
  { key: 'kindness', color: '#8992D6' },
  { key: 'patience', color: '#969CE0' },
  { key: 'restraint', color: '#A5A8E9' },
  { key: 'focus', color: '#B3B3F1' },
  { key: 'clarity', color: '#C4C1FA' },
] as const

const BRAND_VIRTUE_PARTICLE_INTERVAL_MS = 600
const BRAND_VIRTUE_PARTICLE_DURATION_MS = 540
const BRAND_VIRTUE_PARTICLE_END_EVENT_GRACE_MS = 180
const BRAND_VIRTUE_FINAL_HOLD_MS = 800
const BRAND_VIRTUE_WORD_TRANSITION_MS = 160
const BRAND_PARTICLE_TARGET_RADIUS = 189

type BrandParticleMotion = Element & {
  beginElement?: () => void
  endElement?: () => void
}

const brandParticleMotionRefs = new Map<number, {
  element: BrandParticleMotion
  listener: EventListener
}>()
const brandParticleMotionRefCallbacks = BRAND_NODES.map((_, index) => (
  (element: Element | ComponentPublicInstance | null) => {
    setBrandParticleMotionRef(index, element instanceof Element ? element : null)
  }
))

const activeBrandVirtueLabel = computed(() => {
  if (activeBrandVirtueIndex.value === null) return ''
  const virtue = BRAND_VIRTUES[activeBrandVirtueIndex.value]
  return virtue ? t(`brand.virtue.${virtue.key}`) : ''
})

function brandParticleMotionPath(node: typeof BRAND_NODES[number]) {
  const dx = 500 - node.x
  const dy = 500 - node.y
  const distance = Math.hypot(dx, dy)
  const travelRatio = 1 - BRAND_PARTICLE_TARGET_RADIUS / distance
  return `M 0 0 L ${dx * travelRatio} ${dy * travelRatio}`
}

const brandZenEligibility = computed(() => (
  appShell?.zenModeBrandEntry?.value?.canEnter() ?? false
))

function clearBrandHoverTimer() {
  if (brandHoverTimer) {
    clearTimeout(brandHoverTimer)
    brandHoverTimer = undefined
  }
}

function clearBrandVirtueTimers() {
  if (brandVirtueLaunchTimer) clearTimeout(brandVirtueLaunchTimer)
  if (brandVirtueFinalHoldTimer) clearTimeout(brandVirtueFinalHoldTimer)
  for (const timer of brandVirtueParticleWatchdogs.values()) clearTimeout(timer)
  brandVirtueParticleWatchdogs.clear()
  brandVirtueLaunchTimer = undefined
  brandVirtueFinalHoldTimer = undefined
}

function clearBrandParticleWatchdog(index: number) {
  const timer = brandVirtueParticleWatchdogs.get(index)
  if (timer === undefined) return
  clearTimeout(timer)
  brandVirtueParticleWatchdogs.delete(index)
}

function resetBrandVirtueAnimation() {
  clearBrandVirtueTimers()
  brandVirtueRun += 1
  for (const { element } of brandParticleMotionRefs.values()) {
    try { element.endElement?.() } catch { /* animation can already be inactive */ }
  }
  activeBrandVirtueIndex.value = null
  launchedBrandVirtueIndices.value = new Set()
  arrivedBrandVirtueIndices.value = new Set()
  brandVirtueFinalizing = false
}

function setBrandParticleMotionRef(index: number, element: Element | null) {
  const previous = brandParticleMotionRefs.get(index)
  if (previous) {
    previous.element.removeEventListener('endEvent', previous.listener)
    brandParticleMotionRefs.delete(index)
  }
  if (!element) return

  const motion = element as BrandParticleMotion
  const run = brandVirtueRun
  const listener: EventListener = () => onBrandParticleArrival(index, run)
  motion.addEventListener('endEvent', listener)
  brandParticleMotionRefs.set(index, { element: motion, listener })
}

function setBrandCursorHidden(hidden: boolean) {
  document.body.classList.toggle('brand-constellation-active', hidden)
}

function suppressNextBrandClick() {
  suppressBrandClick = true
  if (brandClickSuppressTimer) clearTimeout(brandClickSuppressTimer)
  brandClickSuppressTimer = undefined
}

function clearSuppressedBrandClick() {
  suppressBrandClick = false
  if (brandClickSuppressTimer) clearTimeout(brandClickSuppressTimer)
  brandClickSuppressTimer = undefined
}

function showFinalBrandVirtue(run: number) {
  if (
    run !== brandVirtueRun
    || !showBrandConstellation.value
    || !brandVirtueModeActive.value
    || brandVirtueFinalizing
  ) return
  clearBrandVirtueTimers()
  brandVirtueRun += 1
  const finalRun = brandVirtueRun
  brandVirtueFinalizing = true
  for (const { element } of brandParticleMotionRefs.values()) {
    try { element.endElement?.() } catch { /* animation can already be inactive */ }
  }
  activeBrandVirtueIndex.value = BRAND_VIRTUES.length - 1
  arrivedBrandVirtueIndices.value = new Set([BRAND_VIRTUES.length - 1])
  brandVirtueFinalHoldTimer = setTimeout(() => {
    brandVirtueFinalHoldTimer = undefined
    if (finalRun === brandVirtueRun) completeBrandConstellation()
  }, BRAND_VIRTUE_FINAL_HOLD_MS + (reducedMotionActive.value ? 0 : BRAND_VIRTUE_WORD_TRANSITION_MS))
}

function onBrandParticleArrival(index: number, run: number) {
  if (
    run !== brandVirtueRun
    || !showBrandConstellation.value
    || !brandVirtueModeActive.value
    || brandVirtueFinalizing
    || !launchedBrandVirtueIndices.value.has(index)
    || arrivedBrandVirtueIndices.value.has(index)
  ) return

  arrivedBrandVirtueIndices.value = new Set([...arrivedBrandVirtueIndices.value, index])
  clearBrandParticleWatchdog(index)
  if (index !== BRAND_VIRTUES.length - 1) return

  brandVirtueFinalizing = true
  clearBrandVirtueTimers()
  brandVirtueFinalHoldTimer = setTimeout(() => {
    brandVirtueFinalHoldTimer = undefined
    if (run === brandVirtueRun) completeBrandConstellation()
  }, BRAND_VIRTUE_FINAL_HOLD_MS)
}

function launchBrandParticle(index: number, run: number) {
  if (
    run !== brandVirtueRun
    || !showBrandConstellation.value
    || !brandVirtueModeActive.value
    || brandVirtueFinalizing
  ) return
  if (!brandZenEligibility.value) {
    stopBrandConstellation()
    return
  }

  const motion = brandParticleMotionRefs.get(index)?.element
  if (!motion || typeof motion.beginElement !== 'function') {
    showFinalBrandVirtue(run)
    return
  }

  launchedBrandVirtueIndices.value = new Set([...launchedBrandVirtueIndices.value, index])
  // The particle and its virtue share one sequence beat. Arrival is kept
  // separate below so only the final particle's completion starts the hold.
  activeBrandVirtueIndex.value = index
  // SMIL's endEvent is the normal source of truth. Keep an event-derived,
  // duration-bounded fallback for browsers that expose beginElement() but
  // fail to deliver the finite motion's endEvent.
  brandVirtueParticleWatchdogs.set(index, setTimeout(() => {
    brandVirtueParticleWatchdogs.delete(index)
    onBrandParticleArrival(index, run)
  }, BRAND_VIRTUE_PARTICLE_DURATION_MS + BRAND_VIRTUE_PARTICLE_END_EVENT_GRACE_MS))
  try {
    motion.beginElement()
  } catch {
    showFinalBrandVirtue(run)
    return
  }

  if (index < BRAND_VIRTUES.length - 1) {
    brandVirtueLaunchTimer = setTimeout(() => {
      brandVirtueLaunchTimer = undefined
      launchBrandParticle(index + 1, run)
    }, BRAND_VIRTUE_PARTICLE_INTERVAL_MS)
  }
}

function startBrandVirtueAnimation(run: number) {
  if (run !== brandVirtueRun || !showBrandConstellation.value || !brandVirtueModeActive.value) return
  if (!brandZenEligibility.value) {
    stopBrandConstellation()
    return
  }

  if (reducedMotionMediaQuery?.matches) {
    showFinalBrandVirtue(run)
    return
  }
  launchBrandParticle(0, run)
}

function expireSuppressedBrandClickAfterPointerUp() {
  if (!suppressBrandClick) return
  brandClickSuppressTimer = setTimeout(() => {
    suppressBrandClick = false
    brandClickSuppressTimer = undefined
  }, 1000)
}

function startBrandConstellation(trigger: 'hover' | 'touch' = 'hover') {
  if (showBrandConstellation.value || brandHoverTimer) return
  clearBrandHoverTimer()
  const cycle = ++brandConstellationCycle
  brandHoverTimer = setTimeout(() => {
    brandHoverTimer = undefined
    if (cycle !== brandConstellationCycle || showBrandConstellation.value) return
    resetBrandVirtueAnimation()
    brandConstellationTrigger = trigger
    brandVirtueModeActive.value = brandZenEligibility.value
    showBrandConstellation.value = true
    setBrandCursorHidden(true)
    if (trigger === 'touch') {
      touchLongPressTriggered = true
      suppressNextBrandClick()
    }
    const run = brandVirtueRun
    if (brandVirtueModeActive.value) {
      void nextTick(() => startBrandVirtueAnimation(run))
    } else if (reducedMotionActive.value && trigger === 'touch') {
      void nextTick(completeBrandConstellation)
    }
  }, 3000)
}

function stopBrandConstellation() {
  const recognizedTouch = touchLongPressTriggered
  clearBrandHoverTimer()
  brandConstellationCycle += 1
  resetBrandVirtueAnimation()
  brandVirtueModeActive.value = false
  brandAnimationFinished = false
  brandConstellationTrigger = null
  touchPointerId = null
  touchPointerOrigin = null
  touchLongPressTriggered = false
  if (recognizedTouch) {
    suppressNextBrandClick()
    expireSuppressedBrandClickAfterPointerUp()
  }
  pendingBrandZenEntry = null
  showBrandConstellation.value = false
  setBrandCursorHidden(false)
}

function closeBrandConstellationForZenEntry() {
  showBrandConstellation.value = false
  setBrandCursorHidden(false)
}

function completeBrandConstellation() {
  if (!showBrandConstellation.value || brandAnimationFinished) return
  brandAnimationFinished = true
  clearBrandVirtueTimers()

  const entry = appShell?.zenModeBrandEntry?.value
  if (entry?.canEnter()) {
    pendingBrandZenEntry = entry.enter
    closeBrandConstellationForZenEntry()
  } else if (brandConstellationTrigger === 'touch') {
    // Touch has no hover-leave signal. On unsupported surfaces, let users
    // see the complete mark once and then restore the unobstructed page.
    closeBrandConstellationForZenEntry()
  }
}

function onBrandNodeAnimationEnd(event: AnimationEvent, index: number) {
  if (
    index === BRAND_NODES.length - 1
    && event.animationName === 'brand-network-node-in'
  ) {
    if (brandVirtueModeActive.value) return
    completeBrandConstellation()
  }
}

function onBrandNodeAnimationCancel(event: AnimationEvent) {
  if (event.animationName !== 'brand-network-node-in' || !showBrandConstellation.value) return
  if (reducedMotionMediaQuery?.matches) {
    void nextTick(() => {
      if (brandVirtueModeActive.value) showFinalBrandVirtue(brandVirtueRun)
      else completeBrandConstellation()
    })
  } else {
    stopBrandConstellation()
  }
}

function onBrandConstellationAfterLeave() {
  const enter = pendingBrandZenEntry
  pendingBrandZenEntry = null
  if (touchPointerId === null) touchLongPressTriggered = false
  brandConstellationTrigger = null
  brandAnimationFinished = false
  brandVirtueModeActive.value = false
  resetBrandVirtueAnimation()
  enter?.()
}

function onBrandPointerEnter(event: PointerEvent) {
  // Touch browsers may synthesize compatibility hover events after a tap.
  // Only a real hover-capable pointer can start the desktop gesture.
  if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
    startBrandConstellation('hover')
  }
}

function onBrandPointerLeave(event: PointerEvent) {
  if (event.pointerType !== 'touch' && brandConstellationTrigger !== 'touch') {
    stopBrandConstellation()
  }
}

function onBrandPointerDown(event: PointerEvent) {
  // A fresh pointer sequence proves any still-pending compatibility-click
  // suppression belonged to the previous gesture, not this one.
  clearSuppressedBrandClick()
  if (event.pointerType !== 'touch' || showBrandConstellation.value) return
  clearBrandHoverTimer()
  touchPointerId = event.pointerId
  touchPointerOrigin = { x: event.clientX, y: event.clientY }
  touchLongPressTriggered = false
  const target = event.currentTarget
  if (target instanceof HTMLElement && target.setPointerCapture) {
    try { target.setPointerCapture(event.pointerId) } catch { /* pointer may already be inactive */ }
  }
  startBrandConstellation('touch')
}

function onBrandPointerMove(event: PointerEvent) {
  if (
    event.pointerType !== 'touch'
    || event.pointerId !== touchPointerId
    || !touchPointerOrigin
    || !brandHoverTimer
  ) return
  if (Math.hypot(event.clientX - touchPointerOrigin.x, event.clientY - touchPointerOrigin.y) > 12) {
    clearBrandHoverTimer()
    touchPointerId = null
    touchPointerOrigin = null
    touchLongPressTriggered = false
  }
}

function onBrandPointerUp(event: PointerEvent) {
  if (event.pointerId !== touchPointerId) return
  const wasLongPress = touchLongPressTriggered
  clearBrandHoverTimer()
  touchPointerId = null
  touchPointerOrigin = null
  touchLongPressTriggered = false
  if (wasLongPress) expireSuppressedBrandClickAfterPointerUp()
}

function onBrandPointerCancel(event: PointerEvent) {
  if (event.pointerId !== touchPointerId) return
  const wasLongPress = touchLongPressTriggered
  clearBrandHoverTimer()
  touchPointerId = null
  touchPointerOrigin = null
  touchLongPressTriggered = false
  if (wasLongPress) expireSuppressedBrandClickAfterPointerUp()
  else clearSuppressedBrandClick()
}

function onBrandContextMenu(event: MouseEvent) {
  if (
    touchPointerId !== null
    || touchLongPressTriggered
    || (showBrandConstellation.value && brandConstellationTrigger === 'touch')
  ) event.preventDefault()
}

function onBrandClick(event: MouseEvent) {
  if (suppressBrandClick) {
    event.preventDefault()
    event.stopPropagation()
    clearSuppressedBrandClick()
    return
  }
  void router.push('/')
}

function onReducedMotionChange(event: MediaQueryListEvent) {
  reducedMotionActive.value = event.matches
  if (event.matches && showBrandConstellation.value && !brandAnimationFinished) {
    void nextTick(() => {
      if (brandVirtueModeActive.value) showFinalBrandVirtue(brandVirtueRun)
      else completeBrandConstellation()
    })
  }
}

watch(brandZenEligibility, (canEnter) => {
  if (showBrandConstellation.value && brandVirtueModeActive.value && !canEnter) {
    stopBrandConstellation()
  }
})

function onWindowBlur() {
  stopBrandConstellation()
  leaveAnalysisScopeChip()
}
function onVisibilityChange() {
  if (document.hidden) {
    stopBrandConstellation()
    leaveAnalysisScopeChip()
  }
}
function onEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') stopBrandConstellation()
}

watch(() => route?.fullPath, () => {
  navigationSelectedScope.value = null
  stopBrandConstellation()
})

onMounted(() => {
  workspaceMobileMediaQuery?.addEventListener('change', onWorkspaceViewportChange)
  reducedMotionMediaQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
  reducedMotionActive.value = reducedMotionMediaQuery?.matches ?? false
  reducedMotionMediaQuery?.addEventListener('change', onReducedMotionChange)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('keydown', onEscape)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  analysisExportDisposed = true
  leaveAnalysisScopeChip()
  workspaceMobileMediaQuery?.removeEventListener('change', onWorkspaceViewportChange)
  reducedMotionMediaQuery?.removeEventListener('change', onReducedMotionChange)
  stopBrandConstellation()
  if (brandClickSuppressTimer) clearTimeout(brandClickSuppressTimer)
  suppressBrandClick = false
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('keydown', onEscape)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

</script>

<template>
  <header
    :class="['navbar', { 'is-vault': isVault, 'is-workspace': isWorkspace, 'ledger-nav-mode': isLedger, 'board-nav-mode': isBoard, 'diary-calendar-mode': isVault && activeScope === 'diary' }]"
    :inert="props.logoutBusy || undefined"
    :aria-busy="props.logoutBusy || undefined"
  >
    <div :class="['navbar-inner', { container: !isWorkspace, 'full-width': isWorkspace }]">
      <NButton
        attr-type="button"
        text
        :bordered="false"
        class="brand"
        :aria-label="t('nav.home')"
        @pointerenter="onBrandPointerEnter"
        @pointerleave="onBrandPointerLeave"
        @pointerdown="onBrandPointerDown"
        @pointermove="onBrandPointerMove"
        @pointerup="onBrandPointerUp"
        @pointercancel="onBrandPointerCancel"
        @contextmenu="onBrandContextMenu"
        @click="onBrandClick"
      >
        <img class="brand-logo" :src="'/logo-48.png'" :alt="t('nav.logo_alt')" width="24" height="24" />
        <span class="brand-wordmark">Nuvyn</span>
      </NButton>
      <!-- Scope filter: lives in the navbar (the file tree header is too
           narrow on 150px sidebars). The Ledger chip opens the Ledger workspace. -->
      <div v-if="isWorkspace" class="workspace-navigation">
        <div v-if="showScopeChips" class="scope-chips" role="tablist" :aria-label="t('nav.scope_label')">
          <NButton
            v-for="chip in scopeChips"
            :key="chip.scope"
            class="nav-workspace-link scope-chip"
            :class="{ active: isScopeActive(chip.scope) }"
            attr-type="button"
            size="small"
            quaternary
            :bordered="false"
            :aria-pressed="isScopeActive(chip.scope)"
            :aria-label="scopeLabel(chip.scope, chip.label)"
            :title="scopeLabel(chip.scope, chip.label)"
            @click="onScopeClick(chip.scope)"
            @mouseenter="enterScopeChip(chip.scope)"
            @mouseleave="leaveAnalysisScopeChip"
          >
            <NIcon class="scope-chip-icon" aria-hidden="true"><component :is="chip.icon" /></NIcon>
            <span class="scope-chip-label">{{ chip.label }}</span>
          </NButton>
        </div>
        <NButton
          v-if="showBoardNavigation"
          class="nav-workspace-link workspace-board-link"
          :class="{ active: isBoard }"
          attr-type="button"
          size="small"
          quaternary
          :bordered="false"
          :aria-current="isBoard ? 'page' : undefined"
          :aria-label="t('nav.board')"
          @click="router.push({ name: 'board' })"
        >
          <NIcon class="workspace-board-link-icon" aria-hidden="true"><Box /></NIcon>
          <span class="workspace-board-link-label">{{ t('nav.board') }}</span>
        </NButton>
      </div>
      <div class="nav-spacer" />
      <div class="nav-actions">
        <NButton
          v-if="showSearchButton"
          class="nav-search"
          attr-type="button"
          size="small"
          quaternary
          :bordered="false"
          :title="t('nav.search_hint')"
          :aria-label="t('nav.search')"
          @click="requestGlobalSearch"
        >
          <NIcon class="nav-search-icon" aria-hidden="true"><Search /></NIcon>
        </NButton>
        <NButton
          class="theme-toggle"
          attr-type="button"
          size="small"
          quaternary
          :bordered="false"
          :title="themeTitle"
          :aria-label="themeTitle"
          @click="toggle"
        >
          <NIcon class="theme-toggle-icon" aria-hidden="true">
            <Sun v-if="themeIcon === 'sun'" />
            <Moon v-else />
          </NIcon>
        </NButton>
        <NButton
          v-if="isVault && !isLedger && viewModeApi && isVaultDocumentVisible && !isDiaryCalendarVisible"
          class="view-toggle"
          :class="{ 'is-read': isReadMode }"
          attr-type="button"
          size="small"
          quaternary
          :bordered="false"
          :aria-label="t(isReadMode ? 'nav.switch_edit' : 'nav.switch_read')"
          :title="t(isReadMode ? 'nav.switch_edit_hint' : 'nav.switch_read_hint')"
          data-testid="view-toggle"
          @click="viewModeApi.toggle()"
        >
          <NIcon class="view-toggle-icon" aria-hidden="true">
            <Edit v-if="isReadMode" />
            <Eye v-else />
          </NIcon>
        </NButton>
        <NButton
          v-if="isVault && !isLedger && !isDiaryCalendarVisible"
          class="left-panel-toggle"
          attr-type="button"
          size="small"
          quaternary
          :bordered="false"
          :title="t(leftSidebarVisible ? 'nav.left_panel_close' : 'nav.left_panel_open')"
          :aria-label="t(leftSidebarVisible ? 'nav.left_panel_close' : 'nav.left_panel_open')"
          :aria-pressed="!leftSidebarCollapsed"
          data-testid="left-panel-toggle"
          @click="toggleSidePanel"
        >
          <NIcon class="left-panel-toggle-icon" aria-hidden="true"><LayoutSidebarLeftExpand /></NIcon>
        </NButton>
        <NButton
          v-if="isVault && !isLedger && !isDiaryCalendarVisible && workspaceRightPanelAvailable"
          class="right-rail-toggle"
          attr-type="button"
          size="small"
          quaternary
          :bordered="false"
          :title="t(rightRailCollapsed ? 'nav.right_rail_open' : 'nav.right_rail_close')"
          :aria-label="t(rightRailCollapsed ? 'nav.right_rail_open' : 'nav.right_rail_close')"
          :aria-pressed="!rightRailCollapsed"
          @click="toggleRightRail"
        >
          <NIcon class="right-rail-toggle-icon" aria-hidden="true"><LayoutSidebarRightExpand /></NIcon>
        </NButton>
        <AccountMenu
          v-if="isWorkspace"
          :username="props.username"
          :logout-busy="props.logoutBusy"
          :diary-unlocked="props.diaryUnlocked"
          :diary-lock-busy="props.diaryLockBusy"
          @open-settings="emit('open-settings')"
          @logout="emit('logout')"
          @lock-diary="emit('lock-diary')"
        />
      </div>
    </div>
  </header>

  <Transition name="brand-constellation" @after-leave="onBrandConstellationAfterLeave">
    <div v-if="showBrandConstellation" class="brand-constellation" aria-hidden="true">
      <div class="brand-constellation-backdrop" />
      <div class="brand-constellation-stage">
        <svg class="brand-network" viewBox="0 0 1000 1000" focusable="false">
          <circle class="brand-network-halo" cx="500" cy="500" r="205" />

          <g
            v-for="(node, index) in BRAND_NODES"
            :key="`${node.x}-${node.y}`"
            :class="[
              'brand-network-node',
              {
                'is-virtue-mode': brandVirtueModeActive,
                'is-current': activeBrandVirtueIndex === index,
              },
            ]"
            :data-virtue="BRAND_VIRTUES[index].key"
            :data-virtue-color="BRAND_VIRTUES[index].color"
            :style="{
              '--node-delay': `${index * 140}ms`,
              '--brand-virtue-color': BRAND_VIRTUES[index].color,
            }"
            @animationend="onBrandNodeAnimationEnd($event, index)"
            @animationcancel="onBrandNodeAnimationCancel"
          >
            <line class="brand-network-link" :x1="node.x" :y1="node.y" x2="500" y2="500" />
            <circle class="brand-network-dot" :cx="node.x" :cy="node.y" r="34" />
            <circle class="brand-network-dot-core" :cx="node.x" :cy="node.y" r="8" />
            <circle
              class="brand-network-particle"
              :class="{
                'is-decorative': !brandVirtueModeActive && !reducedMotionActive,
                'is-launched': brandVirtueModeActive && launchedBrandVirtueIndices.has(index),
                'is-arrived': arrivedBrandVirtueIndices.has(index),
              }"
              :cx="brandVirtueModeActive ? node.x : 0"
              :cy="brandVirtueModeActive ? node.y : 0"
              r="8"
            >
              <animateMotion
                v-if="brandVirtueModeActive && !reducedMotionActive"
                :ref="brandParticleMotionRefCallbacks[index]"
                :dur="`${BRAND_VIRTUE_PARTICLE_DURATION_MS}ms`"
                calcMode="spline"
                keyTimes="0;1"
                keySplines="0.2 0.8 0.2 1"
                begin="indefinite"
                fill="freeze"
                repeatCount="1"
                :path="brandParticleMotionPath(node)"
              />
              <animateMotion
                v-else-if="!brandVirtueModeActive && !reducedMotionActive"
                :begin="`${index * 140}ms`"
                dur="1.8s"
                repeatCount="indefinite"
                :path="`M ${node.x} ${node.y} L 500 500`"
              />
            </circle>
          </g>

          <circle
            :class="['brand-network-core', { 'is-virtue-mode': brandVirtueModeActive }]"
            cx="500"
            cy="500"
            r="178"
          />
          <Transition name="brand-network-virtue" :duration="BRAND_VIRTUE_WORD_TRANSITION_MS">
            <text
              v-if="brandVirtueModeActive && activeBrandVirtueIndex !== null"
              :key="activeBrandVirtueIndex"
              class="brand-network-virtue"
              :class="{ 'is-final': activeBrandVirtueIndex === BRAND_VIRTUES.length - 1 }"
              x="500"
              y="500"
              text-anchor="middle"
              dominant-baseline="central"
              :style="{ fontSize: locale === 'zh' ? '108px' : '62px' }"
            >{{ activeBrandVirtueLabel }}</text>
          </Transition>
          <image
            v-if="!brandVirtueModeActive"
            class="brand-network-logo"
            :href="'/brain.svg'"
            x="375"
            y="375"
            width="250"
            height="250"
            preserveAspectRatio="xMidYMid meet"
          />
        </svg>
      </div>
    </div>
  </Transition>
</template>
