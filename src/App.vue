<script setup lang="ts">
import { computed, provide, ref, watch, watchEffect } from 'vue'
import { NButton } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import NavBar from './components/NavBar.vue'
import GlobalSearchHost from './components/search/GlobalSearchHost.vue'
import ToastHost from './components/ToastHost.vue'
import ConfirmHost from './components/ConfirmHost.vue'
import PromptHost from './components/PromptHost.vue'
import SettingsModal from './components/vault/SettingsModal.vue'
import { VaultViewModeKey, type VaultViewMode } from './composables/vault/viewMode'
import { useAuth } from './composables/useAuth'
import { shouldShowNormalChrome } from './lib/auth-chrome'
import { useI18n } from './composables/useI18n'
import { ensureVaultIdentity, getVaultIdentityState } from './lib/vault-identity'
import { useToast } from './composables/useToast'
import { useScopeFilter } from './composables/vault/useScopeFilter'
import { useDiaryAccessSession } from './composables/diary/useDiaryAccessSession'
import { DiaryAccessContextKey } from './composables/diary/diaryAccessContext'
import { AppShellContextKey } from './composables/appShellContext'
import DiaryAccessDialog from './components/diary/DiaryAccessDialog.vue'
import type { ScopeKey } from '../shared/scopeProtocol'
import { boardMetadataSource } from './features/board/boardMetadataSource'
import { documentSearchSource } from './lib/documentSearchSource'
import { clearSearchReveal } from './composables/useSearchReveal'
import { workspaceKindForPath, type ChromeStyle, type WorkspaceKind } from './lib/workspace'
import { createIndexedDbBoardCheckpointStore } from './features/board/checkpointStore'
import { NUVYN_BROWSER_STORAGE_KEYS, readStorageKey, writeStorageKey } from './technicalNamespace'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const vaultIdentity = getVaultIdentityState()
const { t } = useI18n()
const toast = useToast()
const diaryAccess = useDiaryAccessSession()
const { activeScope, selectScope } = useScopeFilter()
const settingsRequestTick = ref(0)
const ledgerSettingsOpen = ref(false)
const diaryCalendarVisible = ref(false)
const globalSearchHost = ref<{ show: () => void } | null>(null)
const boardRecoveryStore = createIndexedDbBoardCheckpointStore()

function requestSettings(): void {
  settingsRequestTick.value += 1
  if (route.path === '/ledger' || route.path.startsWith('/ledger/')) ledgerSettingsOpen.value = true
}

function onOpenSearch(): void {
  globalSearchHost.value?.show()
}

provide(AppShellContextKey, {
  settingsRequestTick,
  diaryCalendarVisible,
  openGlobalSearch: onOpenSearch,
})

const workspaceKind = computed<WorkspaceKind>(() => (
  route.meta.workspaceKind !== undefined
    ? route.meta.workspaceKind
    : workspaceKindForPath(route.path)
))
const chromeStyle = computed<ChromeStyle>(() => route.meta.chromeStyle ?? 'workspace')
const requiresVaultIdentity = computed(() => (
  route.meta.workspace === true && route.meta.requiresVaultIdentity !== false
))
/* Vault and Ledger routes both use the compact workspace navbar. Board Home
   joins that chrome, while the Board editor placeholder is intentionally
   immersive and owns no global workspace bar. */
const isVaultRoute = computed(() => (
  workspaceKind.value === 'vault'
  && auth.state.value === 'authenticated'
  && vaultIdentity.state.value === 'ready'
))
const isLedgerRoute = computed(() => workspaceKind.value === 'ledger')
const isWorkspaceChrome = computed(() => (
  auth.state.value === 'authenticated'
  && workspaceKind.value !== null
  && chromeStyle.value === 'workspace'
))
const isImmersive = computed(() => chromeStyle.value === 'immersive')
const isPublicDevPreview = computed(() => route.meta.publicDevPreview === true)
const showNormalChrome = computed(() => shouldShowNormalChrome(
  auth.state.value,
  route.meta.authPage === true,
  isPublicDevPreview.value,
  !requiresVaultIdentity.value || vaultIdentity.state.value === 'ready',
) && !isImmersive.value)
const identityLoading = computed(() => auth.state.value === 'authenticated'
  && requiresVaultIdentity.value
  && (vaultIdentity.state.value === 'unknown' || vaultIdentity.state.value === 'loading'))
const identityFailure = computed(() => auth.state.value === 'authenticated'
  && requiresVaultIdentity.value
  && vaultIdentity.state.value === 'error')
const showRoutedContent = computed(() => isPublicDevPreview.value
  || (auth.state.value !== 'unknown'
    && (!route.meta.workspace || !requiresVaultIdentity.value || vaultIdentity.state.value === 'ready')))
const authLoading = computed(() => auth.hydrating.value || (auth.state.value === 'unknown' && !auth.hydrationError.value))
const authFailureMessage = computed(() => {
  return auth.hydrationError.value ? t('auth.unavailable') : ''
})
const bootstrapBusy = computed(() => authLoading.value || identityLoading.value)
const bootstrapFailure = computed(() => Boolean(authFailureMessage.value || identityFailure.value))
async function retryAuth(): Promise<void> {
  const nextState = await auth.refreshStatus()
  if (nextState !== 'unknown') await router.replace(route.fullPath || '/vault')
}
async function retryVaultIdentity(): Promise<void> {
  try {
    await ensureVaultIdentity()
    await router.replace(route.fullPath || '/vault')
  } catch {
    // Keep the retry surface visible; the next click starts a new request.
  }
}

async function onLogout(): Promise<void> {
  if (auth.transitionKind.value) return
  try {
    const result = await auth.logout()
    if (result.status === 'logged-out') {
      if ('warning' in result) toast.info(t('auth.logout_revoke_unconfirmed'), 6000)
      await router.replace({ name: 'login' })
    }
  } catch {
    toast.error(t('auth.unavailable'))
  }
}

const diaryAccessOpen = ref(false)
const diaryAccessBusy = ref(false)
const diaryLockBusy = ref(false)
const diaryAccessError = ref('')
const diaryAccessMode = computed<'setup' | 'unlock'>(() => (
  diaryAccess.state.value === 'UNINITIALIZED' ? 'setup' : 'unlock'
))
let pendingAccess: Promise<boolean> | null = null
let resolveAccess: ((granted: boolean) => void) | null = null
let accessIntentGeneration = 0

async function requestDiaryAccess(): Promise<boolean> {
  if (diaryAccess.isUnlocked.value) return true
  if (pendingAccess) return pendingAccess
  const requestGeneration = accessIntentGeneration
  try {
    await diaryAccess.ensureStatus()
  } catch {
    toast.error(t('diary_access.unavailable'))
    return false
  }
  if (requestGeneration !== accessIntentGeneration || auth.state.value !== 'authenticated') return false
  if (diaryAccess.isUnlocked.value) return true
  diaryAccessError.value = ''
  diaryAccessOpen.value = true
  pendingAccess = new Promise<boolean>((resolve) => { resolveAccess = resolve })
  return pendingAccess
}

async function requestScopeChange(scope: ScopeKey): Promise<void> {
  if (scope === activeScope.value) return
  if (scope === 'diary') {
    if (await requestDiaryAccess()) selectScope('diary')
    return
  }
  selectScope(scope)
}

function finishAccess(granted: boolean): void {
  accessIntentGeneration += 1
  diaryAccessOpen.value = false
  diaryAccessBusy.value = false
  diaryAccessError.value = ''
  const resolve = resolveAccess
  resolveAccess = null
  pendingAccess = null
  resolve?.(granted)
}

async function submitDiaryAccess(payload: { password: string; confirmPassword: string }): Promise<void> {
  if (diaryAccessBusy.value) return
  if (diaryAccessMode.value === 'setup' && payload.password !== payload.confirmPassword) {
    diaryAccessError.value = t('auth.password_mismatch')
    return
  }
  diaryAccessBusy.value = true
  diaryAccessError.value = ''
  const requestGeneration = accessIntentGeneration
  try {
    if (diaryAccessMode.value === 'setup') await diaryAccess.setup(payload.password)
    else await diaryAccess.unlock(payload.password)
    if (requestGeneration !== accessIntentGeneration
      || auth.state.value !== 'authenticated'
      || !diaryAccess.isUnlocked.value) return
    finishAccess(true)
  } catch (error) {
    if (requestGeneration !== accessIntentGeneration || auth.state.value !== 'authenticated') return
    const code = (error as { code?: unknown } | null)?.code
    diaryAccessError.value = code === 'diary-access-invalid-password'
      ? t('diary_access.invalid_password')
      : t('diary_access.unavailable')
    diaryAccessBusy.value = false
  }
}

function cancelDiaryAccess(): void {
  if (diaryAccessBusy.value) return
  finishAccess(false)
}

async function lockDiary(): Promise<void> {
  if (diaryLockBusy.value || !diaryAccess.isUnlocked.value) return
  diaryLockBusy.value = true
  try {
    await diaryAccess.lock()
  } catch {
    toast.error(t('diary_access.unavailable'))
  } finally {
    diaryLockBusy.value = false
  }
}

provide(DiaryAccessContextKey, {
  session: diaryAccess,
  requestAccess: requestDiaryAccess,
  requestScopeChange,
  lock: lockDiary,
})

watch(() => diaryAccess.state.value, (next) => {
  if (next !== 'UNLOCKED' && activeScope.value === 'diary') selectScope('note')
})

watch(() => auth.state.value, (next) => {
  if (next === 'authenticated') return
  // Recovery records are local, but Board ownership is authenticated. Clear
  // them at the session boundary so a later account cannot see another
  // account's checkpoint if a board identifier is ever reused.
  void boardRecoveryStore.clearAllRecovery().catch(() => {})
  boardMetadataSource.invalidate()
  documentSearchSource.invalidate()
  clearSearchReveal()
  if (pendingAccess) finishAccess(false)
  else accessIntentGeneration += 1
})

// A persisted Diary scope is only a user preference, never permission to
// restore a Diary body. On a fresh browser process the capability is absent,
// so resolve the access status first and normalize the scope to note before
// VaultView can treat the persisted selection as an active Diary context.
let scopeBootstrapRequest = 0
watch(
  [() => auth.state.value, () => activeScope.value],
  ([authState, scope]) => {
    if (authState !== 'authenticated' || scope !== 'diary') return
    const request = ++scopeBootstrapRequest
    void diaryAccess.ensureStatus().then((next) => {
      if (request !== scopeBootstrapRequest || activeScope.value !== 'diary') return
      if (next !== 'UNLOCKED') selectScope('note')
    }).catch(() => {
      if (request === scopeBootstrapRequest && activeScope.value === 'diary') selectScope('note')
    })
  },
  { immediate: true },
)

/* The vault uses an internal scrollable surface (FileTree, Editor,
   Preview). It must NOT let the outer document scroll, otherwise
   two scrollbars fight and the page wobbles. Route-scoped classes keep
   the Vault body lock and the Ledger scrollbar treatment isolated. */
watchEffect(() => {
  document.body.classList.toggle('vault-mode', isVaultRoute.value)
  document.body.classList.toggle('ledger-mode', isLedgerRoute.value)
  document.documentElement.classList.toggle('ledger-mode', isLedgerRoute.value)
})

/* View mode for the vault (edit vs read). Persisted to localStorage so
   the user's preference survives reloads. Defaults to 'edit' — the
   current split-pane authoring experience. Provided globally so the
   NavBar (in the chrome) can toggle it and VaultView (in the router
   view) can react to it. */
const VIEW_MODE_KEY = NUVYN_BROWSER_STORAGE_KEYS.vaultViewMode

function readViewMode(): VaultViewMode {
  try {
    const raw = readStorageKey(VIEW_MODE_KEY)
    if (raw === 'read' || raw === 'edit') return raw
  } catch { /* private mode / storage blocked — fall through */ }
  return 'edit'
}

const viewMode = ref<VaultViewMode>(readViewMode())
function setViewMode(m: VaultViewMode) {
  viewMode.value = m
  writeStorageKey(VIEW_MODE_KEY, m)
}
function toggleViewMode() {
  setViewMode(viewMode.value === 'edit' ? 'read' : 'edit')
}
provide(VaultViewModeKey, { mode: viewMode, set: setViewMode, toggle: toggleViewMode })
</script>

<template>
  <NavBar
    v-if="showNormalChrome"
    :workspace-kind="workspaceKind"
    :chrome-style="chromeStyle"
    :username="auth.user.value?.username"
    :logout-busy="auth.transitionKind.value === 'logout'"
    :diary-unlocked="diaryAccess.isUnlocked.value"
    :diary-lock-busy="diaryLockBusy"
    @open-search="onOpenSearch"
    @open-settings="requestSettings"
    @logout="onLogout"
    @lock-diary="lockDiary"
  />
  <SettingsModal
    v-if="isLedgerRoute"
    :open="ledgerSettingsOpen"
    @close="ledgerSettingsOpen = false"
  />
  <section
    v-if="!showRoutedContent"
    :class="['auth-bootstrap-surface', { 'is-error': bootstrapFailure }]"
    :aria-busy="bootstrapBusy"
    aria-live="polite"
  >
    <div class="auth-bootstrap-card">
      <p v-if="authLoading" role="status">{{ t('auth.loading') }}</p>
      <template v-else-if="identityLoading">
        <p role="status">{{ t('auth.vault_identity_loading') }}</p>
      </template>
      <template v-else-if="identityFailure">
        <p role="alert">{{ t('auth.vault_identity_unavailable') }}</p>
        <NButton attr-type="button" @click="retryVaultIdentity">{{ t('auth.retry') }}</NButton>
      </template>
      <template v-else>
        <p role="alert">{{ authFailureMessage }}</p>
        <NButton attr-type="button" @click="retryAuth">{{ t('auth.retry') }}</NButton>
      </template>
    </div>
  </section>
  <RouterView v-else v-slot="{ Component, route: r }">
    <!-- Do not key the wrapper on r.fullPath. The key on <main> caused
         VaultView to re-mount on every route change (e.g. /vault ->
         /vault/inbox/markdown-syntax), which reset the tabs ref to []
         and made multi-tab state impossible to keep. The component
         itself is keyed by the router, and re-mounting on every
         navigation is what we explicitly want to avoid. -->
    <main
      :class="['container', {
        'full-width': r.meta.fullWidth,
        'auth-page-shell': r.meta.authPage === true,
      }]"
      :style="{ '--navbar-h': showNormalChrome ? (isWorkspaceChrome ? '36px' : '56px') : '0px' }"
      :inert="auth.transitionKind.value !== null || undefined"
      :aria-busy="auth.transitionKind.value !== null || undefined"
    >
      <component :is="Component" @logout="onLogout" />
    </main>
  </RouterView>
  <GlobalSearchHost ref="globalSearchHost" />
  <ToastHost />
  <ConfirmHost />
  <PromptHost />
  <DiaryAccessDialog
    :open="diaryAccessOpen"
    :mode="diaryAccessMode"
    :busy="diaryAccessBusy"
    :error="diaryAccessError"
    @submit="submitDiaryAccess"
    @cancel="cancelDiaryAccess"
  />
</template>
