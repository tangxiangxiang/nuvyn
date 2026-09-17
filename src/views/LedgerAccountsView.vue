<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NList, NListItem, NModal, NNumberAnimation, NResult, NSelect, NSpin } from 'naive-ui'
import LedgerFirstAccountForm from '../components/ledger/LedgerFirstAccountForm.vue'
import LedgerAnimatedMoney from '../components/ledger/LedgerAnimatedMoney.vue'
import LedgerPendingCreateGate from '../components/ledger/LedgerPendingCreateGate.vue'
import LedgerAccountIcon from '../components/ledger/LedgerAccountIcon.vue'
import { ledgerAccountTypeOptionsForNature } from '../features/ledger/accountPresentation'
import { ledgerErrorMessage, ledgerWorkspaceReadErrorMessage } from '../features/ledger/ledgerErrors'
import { useLedgerStore } from '../features/ledger/ledgerStore'

const store = useLedgerStore()
const createOpen = ref(false)
const restoreId = ref<string | null>(null)
const actionError = ref('')
const activeAccountTypeFilter = ref<'all' | 'asset' | 'liability'>('asset')
const archivedAccountTypeFilter = ref<'all' | 'asset' | 'liability'>('asset')
const accountTypeOptions = [
  { label: '全部', value: 'all' },
  { label: '资产', value: 'asset' },
  { label: '负债', value: 'liability' },
]

// Keep an open create form mounted while its successful mutation refreshes the
// shared read model. Otherwise refreshData's loading flag would unmount the
// form before it can emit `saved`, leaving the user on a stale draft.
const loading = computed(() => store.workspaceState.value === 'BOOTSTRAPPING' || (store.loading.value && !createOpen.value))
const typeLabels = new Map(
  ledgerAccountTypeOptionsForNature('asset').concat(ledgerAccountTypeOptionsForNature('liability'))
    .map((option) => [option.value, option.label]),
)
const visibleActiveAccounts = computed(() => {
  const accounts = activeAccountTypeFilter.value === 'all'
    ? store.activeAccounts.value
    : store.activeAccounts.value.filter((account) => account.nature === activeAccountTypeFilter.value)
  return [...accounts].sort((left, right) => right.currentBalanceMinor - left.currentBalanceMinor)
})
const sortedArchivedAccounts = computed(() => [...store.archivedAccounts.value]
  .filter((account) => archivedAccountTypeFilter.value === 'all' || account.nature === archivedAccountTypeFilter.value)
  .sort((left, right) => right.currentBalanceMinor - left.currentBalanceMinor))
const scrollbarHideTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

function showScrollbarWhileScrolling(event: Event): void {
  const viewport = event.currentTarget as HTMLElement
  viewport.classList.add('is-scrolling')
  const timer = scrollbarHideTimers.get(viewport)
  if (timer) clearTimeout(timer)
  scrollbarHideTimers.set(viewport, setTimeout(() => {
    viewport.classList.remove('is-scrolling')
    scrollbarHideTimers.delete(viewport)
  }, 700))
}

onMounted(() => {
  document.body.classList.add('ledger-accounts-mode')
  document.documentElement.classList.add('ledger-accounts-mode')
  void store.bootstrap()
})

onBeforeUnmount(() => {
  document.body.classList.remove('ledger-accounts-mode')
  document.documentElement.classList.remove('ledger-accounts-mode')
})

function typeLabel(type: string): string {
  return typeLabels.get(type as never) ?? type
}

async function restore(id: string, version: number): Promise<void> {
  if (restoreId.value) return
  restoreId.value = id
  actionError.value = ''
  try {
    await store.restoreAccount(id, version)
  } catch (cause) {
    actionError.value = ledgerErrorMessage(cause, '账户没有恢复，请刷新后重试。')
  } finally {
    restoreId.value = null
  }
}

function onAccountSaved(): void {
  createOpen.value = false
  actionError.value = ''
}
</script>

<template>
  <main class="ledger-page ledger-accounts-page" data-testid="ledger-accounts-page">
    <header class="ledger-page-header">
      <div>
        <p class="ledger-eyebrow">Ledger</p>
        <h1>账户</h1>
        <p>查看余额、维护账户，或恢复已归档账户。</p>
      </div>
      <div class="ledger-page-actions">
        <RouterLink class="ledger-secondary-button" :to="{ name: 'ledger' }">返回总览</RouterLink>
        <NButton class="ledger-primary-button" attr-type="button" type="primary" size="small" :bordered="false" :disabled="loading || store.hasUnresolvedCreate.value" @click="createOpen = true">新增账户</NButton>
      </div>
    </header>

    <LedgerPendingCreateGate v-if="store.recoveryGateVisible.value" @resolved="onAccountSaved" />
    <div v-else-if="loading" class="ledger-state-panel ledger-loading-state" data-testid="ledger-accounts-loading" role="status"><NSpin size="medium" description="正在加载账户…" /></div>
    <section v-else-if="store.workspaceState.value === 'RECOVERABLE_ERROR'" class="ledger-state-panel ledger-result-state" data-testid="ledger-accounts-error" role="alert">
      <NResult status="error" title="账户暂时无法加载" :description="ledgerWorkspaceReadErrorMessage(store.workspaceError.value)">
        <template #footer><NButton class="ledger-primary-button" attr-type="button" type="primary" size="small" :bordered="false" @click="store.bootstrap">重新加载</NButton></template>
      </NResult>
    </section>
    <NEmpty v-else-if="!store.settings.value" class="ledger-state-panel ledger-empty-state" data-testid="ledger-accounts-needs-settings" :show-icon="false" description="请先设置 Ledger">
      <template #extra>
        <div class="ledger-state-extra">
          <p>完成基础货币和时区设置后，才能管理账户。</p>
          <RouterLink class="ledger-primary-button" :to="{ name: 'ledger' }">去设置 Ledger</RouterLink>
        </div>
      </template>
    </NEmpty>
    <NModal
      v-else-if="createOpen"
      :show="createOpen"
      :mask-closable="false"
      :close-on-esc="false"
      :auto-focus="false"
      :trap-focus="true"
      :on-esc="() => { createOpen = false }"
      :on-update-show="(show) => { if (!show) createOpen = false }"
    >
      <NCard
        class="ledger-account-create-modal-card"
        :bordered="false"
        size="small"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ledger-create-account-title"
        @scroll="showScrollbarWhileScrolling"
      >
        <LedgerFirstAccountForm :first-account="false" cancelable @cancel="createOpen = false" @saved="onAccountSaved" />
      </NCard>
    </NModal>
    <template v-else>
      <NAlert v-if="actionError" class="ledger-form-error" type="error" :show-icon="false" role="alert">{{ actionError }}</NAlert>

      <div class="ledger-account-sections">
        <NCard class="ledger-account-section" :bordered="false" size="small" aria-labelledby="ledger-active-accounts-title">
          <div class="ledger-section-heading">
            <div>
              <h2 id="ledger-active-accounts-title">可用账户 <span class="ledger-count"><NNumberAnimation :from="0" :to="visibleActiveAccounts.length" :duration="2000" /></span></h2>
              <p>新增交易时只能选择这些账户。</p>
            </div>
            <NSelect v-model:value="activeAccountTypeFilter" class="ledger-account-type-filter" size="small" :options="accountTypeOptions" :consistent-menu-width="false" aria-label="可用账户类型" />
          </div>
          <NList v-if="visibleActiveAccounts.length" class="ledger-account-list" data-testid="ledger-active-account-list" :show-divider="false" hoverable @scroll="showScrollbarWhileScrolling">
            <NListItem v-for="account in visibleActiveAccounts" :key="account.id" class="ledger-account-list-item">
              <RouterLink
                class="ledger-account-row"
                :to="{ name: 'ledger-account', params: { id: account.id }, query: { from: 'list' } }"
                :data-testid="`ledger-account-row-${account.id}`"
              >
                <span class="ledger-account-name">
                  <span class="ledger-account-icon" :class="account.nature === 'asset' ? 'is-asset' : 'is-liability'" aria-hidden="true">
                    <LedgerAccountIcon :icon="account.icon" />
                  </span>
                  <span class="ledger-account-copy">
                    <strong>{{ account.name }}</strong>
                    <small>{{ account.nature === 'asset' ? '资产' : '负债' }} · {{ typeLabel(account.type) }}</small>
                  </span>
                </span>
                <strong class="ledger-account-balance"><LedgerAnimatedMoney :minor="account.currentBalanceMinor" :currency="account.currency" /></strong>
              </RouterLink>
            </NListItem>
          </NList>
          <NEmpty v-else class="ledger-inline-empty" data-testid="ledger-active-account-empty" :show-icon="false" :description="store.activeAccounts.value.length ? '没有符合条件的账户。' : '还没有可用账户。'">
            <template #extra><NButton class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" @click="createOpen = true">创建账户</NButton></template>
          </NEmpty>
        </NCard>

        <NCard class="ledger-account-section" :bordered="false" size="small" aria-labelledby="ledger-archived-accounts-title">
          <div class="ledger-section-heading">
            <div>
              <h2 id="ledger-archived-accounts-title">已归档账户 <span class="ledger-count"><NNumberAnimation :from="0" :to="sortedArchivedAccounts.length" :duration="2000" /></span></h2>
              <p>历史记录仍然保留；恢复后可以再次用于记账。</p>
            </div>
            <NSelect v-model:value="archivedAccountTypeFilter" class="ledger-account-type-filter" size="small" :options="accountTypeOptions" :consistent-menu-width="false" aria-label="已归档账户类型" />
          </div>
          <NList v-if="sortedArchivedAccounts.length" class="ledger-account-list" data-testid="ledger-archived-account-list" :show-divider="false" @scroll="showScrollbarWhileScrolling">
            <NListItem v-for="account in sortedArchivedAccounts" :key="account.id" class="ledger-account-list-item">
              <div class="ledger-account-row is-archived">
                <RouterLink class="ledger-account-name" :to="{ name: 'ledger-account', params: { id: account.id }, query: { from: 'list' } }">
                  <span class="ledger-account-icon" :class="account.nature === 'asset' ? 'is-asset' : 'is-liability'" aria-hidden="true">
                    <LedgerAccountIcon :icon="account.icon" />
                  </span>
                  <span class="ledger-account-copy">
                    <strong>{{ account.name }}</strong>
                    <small>已归档 · {{ account.nature === 'asset' ? '资产' : '负债' }} · {{ typeLabel(account.type) }}</small>
                  </span>
                </RouterLink>
                <div class="ledger-row-actions">
                  <strong class="ledger-account-balance"><LedgerAnimatedMoney :minor="account.currentBalanceMinor" :currency="account.currency" /></strong>
                  <NButton class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" :disabled="Boolean(restoreId)" @click="restore(account.id, account.version)">
                    {{ restoreId === account.id ? '正在恢复…' : '恢复' }}
                  </NButton>
                </div>
              </div>
            </NListItem>
          </NList>
          <NEmpty v-else class="ledger-archived-empty" data-testid="ledger-archived-account-empty" :show-icon="false" :description="store.archivedAccounts.value.length ? '没有符合条件的账户。' : '暂无归档账户。'" />
        </NCard>
      </div>
    </template>
  </main>
</template>

<style scoped>
.ledger-page { min-height: calc(100vh - 52px); background: var(--bg); }
.ledger-accounts-page {
  --ledger-glass-surface: color-mix(in srgb, var(--bg-soft) 74%, transparent);
  --ledger-glass-tint: color-mix(in srgb, var(--accent) 3%, transparent);
  --ledger-glass-highlight: color-mix(in srgb, var(--text-h) 9%, transparent);
  --ledger-glass-shadow: color-mix(in srgb, var(--text-h) 8%, transparent);
  width: min(100%, 1240px);
  margin: 0 auto;
  padding: 42px 28px 72px;
  box-sizing: border-box;
}
.ledger-page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
.ledger-eyebrow { margin: 0 0 7px; color: var(--accent); font-size: .7rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
.ledger-page-header h1 { margin: 0; color: var(--text-h); font-size: clamp(1.85rem, 3vw, 2.35rem); font-weight: 720; letter-spacing: -.035em; line-height: 1.16; }
.ledger-page-header p:not(.ledger-eyebrow) { margin: 8px 0 0; color: var(--text-muted); font-size: .78rem; }
.ledger-page-actions,
.ledger-row-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.ledger-primary-button,
.ledger-secondary-button { display: inline-flex; min-height: 32px; align-items: center; justify-content: center; box-sizing: border-box; padding: 6px 12px; border-radius: 7px; font: inherit; font-size: .78rem; font-weight: 650; text-decoration: none; cursor: pointer; }
.ledger-primary-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.ledger-secondary-button { border: 1px solid var(--border); background: var(--bg); color: var(--text-h); }
.ledger-secondary-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-primary-button:disabled,
.ledger-secondary-button:disabled { cursor: wait; opacity: .65; }
.ledger-state-panel { display: grid; min-height: 260px; align-content: center; gap: 9px; color: var(--text-muted); }
.ledger-loading-state { place-items: center; text-align: center; }
.ledger-result-state,
.ledger-empty-state { place-items: center start; text-align: left; }
.ledger-loading-state :deep(.n-spin-container) { display: grid; place-items: center; }
.ledger-result-state :deep(.n-result) { display: grid; place-items: center start; width: min(100%, 620px); padding: 0; text-align: left; }
.ledger-result-state :deep(.n-result-header__title),
.ledger-result-state :deep(.n-result-header__description),
.ledger-result-state :deep(.n-result-footer) { text-align: left; }
.ledger-state-extra { display: grid; gap: 10px; text-align: left; }
.ledger-state-panel h2,
.ledger-state-panel p { margin: 0; }
.ledger-state-panel h2 { color: var(--text-h); }
.ledger-state-panel :deep(.n-empty__description) { color: var(--text-h); font-size: 1.15rem; }
.ledger-state-panel :deep(.n-empty__extra) { display: grid; gap: 10px; color: var(--text-muted); font-size: .82rem; line-height: 1.5; }
.ledger-account-section {
  height: 500px;
  margin-top: 22px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  border-radius: 12px;
  background:
    linear-gradient(135deg, var(--ledger-glass-tint), transparent 52%),
    var(--ledger-glass-surface);
  box-shadow:
    inset 0 1px 0 var(--ledger-glass-highlight),
    0 10px 30px var(--ledger-glass-shadow);
  -webkit-backdrop-filter: saturate(145%) blur(18px);
  backdrop-filter: saturate(145%) blur(18px);
}
.ledger-account-section :deep(.n-card__content) { display: flex; height: 100%; min-height: 0; flex-direction: column; overflow: hidden; padding: 20px; box-sizing: border-box; }
.ledger-account-create-modal-card {
  width: min(620px, calc(100vw - 32px));
  max-height: min(90vh, 820px);
  overflow: auto;
  scrollbar-width: none;
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  border-radius: 16px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 3%, transparent), transparent 52%),
    color-mix(in srgb, var(--bg-soft) 82%, transparent);
  box-shadow:
    0 18px 55px color-mix(in srgb, var(--text-h) 20%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--text-h) 9%, transparent);
  -webkit-backdrop-filter: saturate(145%) blur(18px);
  backdrop-filter: saturate(145%) blur(18px);
}
.ledger-account-create-modal-card::-webkit-scrollbar { display: none; }
.ledger-account-create-modal-card :deep(.n-card__content) { padding: 28px; }
.ledger-account-create-modal-card :deep(.ledger-onboarding-card) { width: 100%; padding: 0; border: 0; background: transparent; box-shadow: none; }
.ledger-account-sections { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.ledger-account-sections .ledger-account-section { min-width: 0; margin-top: 0; }
.ledger-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.ledger-section-heading h2 { margin: 0; color: var(--text-h); font-size: 1.08rem; }
.ledger-section-heading h2 .ledger-count { margin-left: 5px; vertical-align: middle; }
.ledger-section-heading p { margin: 4px 0 0; color: var(--text-muted); font-size: .78rem; }
.ledger-count { display: inline-grid; min-width: 25px; height: 25px; place-items: center; border-radius: 999px; background: var(--bg-soft); color: var(--text-muted); font-size: .76rem; }
.ledger-account-type-filter {
  width: 86px;
  flex: 0 0 auto;
  opacity: 0;
  pointer-events: auto;
  transition: opacity .14s ease;
}
.ledger-account-type-filter:hover,
.ledger-account-type-filter:focus-within {
  opacity: 1;
}
.ledger-account-list { display: grid; grid-auto-rows: max-content; align-content: start; height: 395px; min-height: 0; flex: 0 0 395px; overflow-y: auto; overscroll-behavior: contain; scrollbar-color: transparent transparent; scrollbar-width: thin; }
.ledger-account-list.is-scrolling { scrollbar-color: color-mix(in srgb, var(--text-muted) 34%, transparent) transparent; }
.ledger-account-list::-webkit-scrollbar { width: 6px; }
.ledger-account-list::-webkit-scrollbar-thumb { background: transparent; transition: background .18s ease; }
.ledger-account-list.is-scrolling::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--text-muted) 34%, transparent); }
.ledger-account-list :deep(.n-list-item) { padding: 0; }
.ledger-account-list :deep(.n-list-item__main) { width: 100%; }
.ledger-account-list-item { padding: 0; }
.ledger-account-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 64px; padding: 9px 10px; box-sizing: border-box; border-bottom: 1px solid var(--ledger-divider, var(--border)); color: inherit; text-decoration: none; transition: background-color .14s ease; }
.ledger-account-row:hover { background: var(--ledger-row-hover, var(--bg)); }
.ledger-account-row.is-archived { background: transparent; }
.ledger-account-row:last-child { border-bottom: 0; }
.ledger-archived-empty { flex: 1; min-height: 0; align-content: start; padding: 18px 10px; box-sizing: border-box; }
.ledger-archived-empty :deep(.n-empty__description) { color: var(--text-muted); font-size: .82rem; }
.ledger-account-name { display: flex; min-width: 0; align-items: center; gap: 10px; color: inherit; text-decoration: none; }
.ledger-account-copy { display: grid; min-width: 0; gap: 3px; }
.ledger-account-icon { display: grid; width: 32px; height: 32px; flex: 0 0 auto; place-items: center; border-radius: 9px; background: color-mix(in srgb, var(--accent) 11%, var(--bg)); color: var(--accent); }
.ledger-account-icon.is-asset { background: color-mix(in srgb, var(--ledger-income) 10%, var(--bg)); color: var(--ledger-income); }
.ledger-account-icon.is-liability { background: color-mix(in srgb, var(--ledger-expense) 10%, var(--bg)); color: var(--ledger-expense); }
.ledger-account-name strong { overflow: hidden; color: var(--text-h); font-size: .9rem; text-overflow: ellipsis; white-space: nowrap; }
.ledger-account-name small { color: var(--text-muted); font-size: .76rem; }
.ledger-account-balance { flex: 0 0 auto; color: var(--text-h); font-size: .9rem; }
.ledger-inline-empty { display: flex; flex: 1; min-height: 0; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 18px; border: 1px dashed var(--border); border-radius: 10px; color: var(--text-muted); }
.ledger-inline-empty :deep(.n-empty__description) { color: var(--text-muted); font-size: .82rem; }
.ledger-inline-empty :deep(.n-empty__extra) { margin: 0; }
.ledger-form-error { margin: 0 0 12px; color: #b42318; font-size: .82rem; }
.ledger-form-error :deep(.n-alert-body) { color: #b42318; }
@media (min-width: 651px) {
  .ledger-accounts-page { height: calc(100vh - var(--navbar-h, 52px)); min-height: 0; overflow: hidden; }
}
@media (max-width: 650px) {
  .ledger-accounts-page { padding: 28px 16px 48px; }
  .ledger-page-header { align-items: stretch; flex-direction: column; }
  .ledger-page-actions > * { flex: 1 1 150px; }
  .ledger-account-row { align-items: flex-start; flex-direction: column; }
  .ledger-row-actions { width: 100%; justify-content: space-between; }
  .ledger-account-section :deep(.n-card__content) { padding: 16px 13px; }
  .ledger-account-sections { grid-template-columns: 1fr; }
  .ledger-account-create-modal-card { width: calc(100vw - 24px); max-height: 92vh; }
  .ledger-account-create-modal-card :deep(.n-card__content) { padding: 21px 17px; }
}
</style>
