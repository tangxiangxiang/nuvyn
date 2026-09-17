<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NResult, NSpin } from 'naive-ui'
import { useRoute, useRouter, type RouteLocationNormalizedLoaded } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import LedgerDashboard from '../components/ledger/LedgerDashboard.vue'
import LedgerFirstAccountForm from '../components/ledger/LedgerFirstAccountForm.vue'
import LedgerNoActiveAccountState from '../components/ledger/LedgerNoActiveAccountState.vue'
import LedgerOnboarding from '../components/ledger/LedgerOnboarding.vue'
import LedgerPendingCreateGate from '../components/ledger/LedgerPendingCreateGate.vue'
import LedgerTransactionSheet from '../components/ledger/LedgerTransactionSheet.vue'
import { ledgerWorkspaceReadErrorMessage } from '../features/ledger/ledgerErrors'
import { useLedgerStore, type LedgerOverviewRefreshResult } from '../features/ledger/ledgerStore'
import { parseLedgerRouteDate } from '../features/ledger/periodNavigation'

const auth = useAuth()
// The view is also mounted without a Router in focused component tests. The
// production route always provides both injections; the guards keep those
// tests on the existing bootstrap path without adding a second navigation
// implementation.
const router = useRouter() as ReturnType<typeof useRouter> | undefined
const route = useRoute() as RouteLocationNormalizedLoaded | undefined
const store = useLedgerStore()
const newAccountOpen = ref(false)
const transactionSheetOpen = ref(false)

// The Workspace lifecycle now completes independently of the Overview
// request, so a period navigation can no longer strand it in BOOTSTRAPPING.
// A READY workspace still has nothing to render until an Overview exists: the
// Current Snapshot itself comes from that projection, so it keeps the loading
// state instead of an empty Dashboard frame. States that do not read the
// projection at all (onboarding, no active account) are not gated on it.
const bootstrapping = computed(() => store.workspaceState.value === 'BOOTSTRAPPING'
  || (store.workspaceState.value === 'READY' && store.overview.value === null && store.overviewLoading.value))
const showOnboarding = computed(() => store.workspaceState.value === 'UNINITIALIZED' || store.workspaceState.value === 'FIRST_ACCOUNT_REQUIRED')

type RouteDateSnapshot = {
  readonly token: string
  readonly date: string | undefined
  readonly invalid: boolean
}

let hasBootstrapped = false

function routeDateSnapshot(): RouteDateSnapshot {
  const raw = route?.query.date
  if (raw === undefined) return { token: '', date: undefined, invalid: false }
  if (typeof raw !== 'string') return { token: JSON.stringify(raw), date: undefined, invalid: true }
  const date = parseLedgerRouteDate(raw)
  return { token: raw, date: date ?? undefined, invalid: date === null }
}

function routeStillMatches(snapshot: RouteDateSnapshot): boolean {
  return routeDateSnapshot().token === snapshot.token
}

function overviewRequestStillMatches(snapshot: RouteDateSnapshot, result: LedgerOverviewRefreshResult | undefined): boolean {
  if (result === undefined || !routeStillMatches(snapshot)) return false
  const current = store.overviewRequestContext.value
  return result.request.scope === current.scope
    && result.request.anchorDate === current.anchorDate
}

function isFutureAnchorResult(result: LedgerOverviewRefreshResult | undefined): boolean {
  return result?.status === 'error'
    && result.error.code === 'ledger-validation-failed'
    && result.error.details?.field === 'anchorDate'
}

async function syncRouteDate(snapshot: RouteDateSnapshot): Promise<void> {
  if (!route || !router) {
    if (!hasBootstrapped) {
      hasBootstrapped = true
      await store.bootstrap()
    }
    return
  }

  if (snapshot.invalid) {
    store.setOverviewRequestContext({ scope: store.overviewScope.value, anchorDate: undefined })
    if (routeStillMatches(snapshot)) await router.replace({ name: 'ledger', hash: route.hash })
    return
  }

  store.setOverviewRequestContext({ scope: store.overviewScope.value, anchorDate: snapshot.date })
  let result: LedgerOverviewRefreshResult | undefined
  if (!hasBootstrapped) {
    hasBootstrapped = true
    result = await store.bootstrap()
  } else {
    result = await store.refreshOverview()
  }

  // A newer browser navigation owns the route. An older request may finish,
  // but it must not canonicalize or otherwise interpret the newer route.
  if (!routeStillMatches(snapshot)) return

  if (isFutureAnchorResult(result)) {
    // The canonical follow-up must start a fresh Overview request even when the
    // original request still belongs to an in-flight bootstrap. Mark the
    // bootstrap path as already entered so the route watcher uses
    // refreshOverview instead of reusing that stale bootstrap promise.
    if (!overviewRequestStillMatches(snapshot, result)) return
    hasBootstrapped = true
    await router.replace({ name: 'ledger', hash: route.hash })
    return
  }

  if (snapshot.date !== undefined
    && result?.status === 'success'
    && overviewRequestStillMatches(snapshot, result)
    && result.overview.context.isToday
    && result.overview.context.anchorDate === snapshot.date) {
    await router.replace({ name: 'ledger', hash: route.hash })
  }
}

function requestRouteSync(): void {
  void syncRouteDate(routeDateSnapshot())
}

watch(() => auth.user.value?.username ?? null, (identity) => store.setOwnerIdentity(identity), { immediate: true })

if (route && router) watch(() => route.query.date, requestRouteSync, { immediate: true })
else onMounted(requestRouteSync)

function openNewAccount(): void {
  newAccountOpen.value = true
}

function closeNewAccount(): void {
  newAccountOpen.value = false
}

function retry(): void {
  void store.bootstrap()
}

function openTransactions(): void {
  if (router) void router.push({ name: 'ledger-transactions' })
}

function onRecoveryResolved(): void {
  transactionSheetOpen.value = false
  newAccountOpen.value = false
}

function closeTransactionSheet(): void {
  transactionSheetOpen.value = false
}
</script>

<template>
  <main class="ledger-page" data-testid="ledger-page">
    <div v-if="bootstrapping" class="ledger-loading-state" data-testid="ledger-loading" role="status" aria-live="polite">
      <NSpin size="medium" description="正在加载 Ledger…" />
    </div>

    <LedgerPendingCreateGate v-else-if="store.recoveryGateVisible.value" @resolved="onRecoveryResolved" />

    <section v-else-if="store.workspaceState.value === 'RECOVERABLE_ERROR'" class="ledger-error-state" data-testid="ledger-bootstrap-error" role="alert" aria-label="Ledger 暂时无法打开">
      <NResult status="error" title="Ledger 暂时无法打开" :description="ledgerWorkspaceReadErrorMessage(store.workspaceError.value)">
        <template #footer><NButton class="ledger-primary-button" attr-type="button" type="primary" size="small" :bordered="false" @click="retry">重新加载</NButton></template>
      </NResult>
    </section>

    <LedgerOnboarding
      v-else-if="showOnboarding"
      :initial-step="store.workspaceState.value === 'UNINITIALIZED' ? 'settings' : 'account'"
    />

    <template v-else-if="store.workspaceState.value === 'NO_ACTIVE_ACCOUNT'">
      <LedgerFirstAccountForm
        v-if="newAccountOpen"
        :first-account="false"
        cancelable
        @cancel="closeNewAccount"
        @edit-settings="closeNewAccount"
      />
      <LedgerNoActiveAccountState v-else @create="openNewAccount" />
    </template>

    <LedgerDashboard
      v-else
      @record="transactionSheetOpen = true"
      @view-transactions="openTransactions"
    />

    <LedgerTransactionSheet v-if="!store.recoveryGateVisible.value" :open="transactionSheetOpen" @close="closeTransactionSheet" />
  </main>
</template>

<style scoped>
.ledger-page { min-height: calc(100vh - 52px); background: var(--bg); }
.ledger-loading-state,
.ledger-error-state,
.ledger-ready-placeholder { display: grid; min-height: 420px; align-content: center; gap: 12px; padding: 32px 18px; box-sizing: border-box; color: var(--text-muted); }
.ledger-loading-state { place-items: center; text-align: center; }
.ledger-error-state { place-items: center start; text-align: left; }
.ledger-ready-placeholder { place-items: center; text-align: center; }
.ledger-loading-state :deep(.n-spin-container) { display: grid; place-items: center; }
.ledger-error-state :deep(.n-result) { display: grid; place-items: center start; width: min(100%, 620px); padding: 0; text-align: left; }
.ledger-error-state :deep(.n-result-header__title),
.ledger-error-state :deep(.n-result-header__description),
.ledger-error-state :deep(.n-result-footer) { text-align: left; }
.ledger-error-state h1,
.ledger-ready-placeholder h1 { margin: 0; color: var(--text-h); font-size: 1.5rem; }
.ledger-error-state p,
.ledger-ready-placeholder p { margin: 0; }
.ledger-eyebrow { margin: 0; color: var(--accent); font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ledger-primary-button { min-height: 32px; padding: 6px 12px; border: 1px solid var(--accent); border-radius: 7px; background: var(--accent); color: #fff; font: inherit; font-size: .78rem; font-weight: 650; cursor: pointer; }
.ledger-primary-button:hover { background: var(--accent-hover); }
</style>
