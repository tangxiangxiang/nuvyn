<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NForm,
  NIcon,
  NInput,
  NNumberAnimation,
  NPagination,
  NSelect,
  NSpin,
  type DataTableColumns,
  type SelectGroupOption,
  type SelectOption,
} from 'naive-ui'
import { ArrowDown, ArrowRight, ArrowUp, ArrowsVertical, Calendar, Search, Tag, Wallet } from '@vicons/tabler'
import { Temporal } from '@js-temporal/polyfill'
import { useRoute } from 'vue-router'
import type {
  LedgerCategoryDto,
  LedgerTransactionDto,
  LedgerTransactionFilterType,
  LedgerTransactionQuery,
} from '../../shared/ledgerProtocol'
import LedgerTransactionDetailSheet from '../components/ledger/LedgerTransactionDetailSheet.vue'
import LedgerPendingCreateGate from '../components/ledger/LedgerPendingCreateGate.vue'
import LedgerTransactionSheet from '../components/ledger/LedgerTransactionSheet.vue'
import { ledgerErrorMessage } from '../features/ledger/ledgerErrors'
import { formatLedgerDateTime, formatLedgerTransactionDateTime, instantFromLedgerDate } from '../features/ledger/time'
import { useLedgerStore } from '../features/ledger/ledgerStore'
import { ledgerSelectNodeProps } from '../features/ledger/naiveControls'
import LedgerDatePicker from '../components/ledger/LedgerDatePicker.vue'
import LedgerAnimatedMoney from '../components/ledger/LedgerAnimatedMoney.vue'
import { ledgerAccountSelectOptions, renderLedgerAccountLabel, renderLedgerCategoryLabel } from '../components/ledger/ledgerSelectRenderers'

const store = useLedgerStore()
const route = useRoute()
const transactionSheetOpen = ref(false)
const detailOpen = ref(false)
const selectedTransaction = ref<LedgerTransactionDto | null>(null)
const filterType = ref<LedgerTransactionFilterType | 'all'>('all')
const filterAccountId = ref('')
const filterCategoryId = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const filterSearch = ref('')
type DatePreset = 'all' | 'today' | 'week' | 'month' | 'year' | 'custom'
const filterDatePreset = ref<DatePreset>('all')
const filtersLoading = ref(false)
const paginationLoading = ref(false)
const filterError = ref('')
const tablePage = ref(1)
const tablePageSize = ref(25)

const typeOptions: SelectOption[] = [
  { value: 'all', label: '全部类型' },
  { value: 'income', label: '收入' },
  { value: 'expense', label: '支出' },
  { value: 'transfer', label: '转账' },
]
const datePresetOptions: SelectOption[] = [
  { value: 'all', label: '全部日期' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '今年' },
  { value: 'custom', label: '自定义' },
]
const pageSizeOptions = [
  { value: 5, label: '5 / 页' },
  { value: 25, label: '25 / 页' },
  { value: 50, label: '50 / 页' },
  { value: 100, label: '100 / 页' },
]
const accountOptions = computed<Array<SelectOption | SelectGroupOption>>(() => [
  { value: '', label: '全部账户' },
  ...ledgerAccountSelectOptions(store.accounts.value),
])
const categoryOptions = computed<SelectOption[]>(() => [
  { value: '', label: '全部分类' },
  ...store.categories.value.map((category) => ({
    value: category.id,
    label: categoryLabel(category),
  })),
])

const loading = computed(() => store.workspaceState.value === 'BOOTSTRAPPING' || filtersLoading.value)
const page = computed(() => store.transactions.value)
const transactions = computed(() => page.value?.transactions ?? [])
const transactionTotal = computed(() => page.value?.page.total ?? transactions.value.length)
const tablePageCount = computed(() => Math.max(1, Math.ceil(transactionTotal.value / tablePageSize.value)))
const visibleTransactions = computed(() => [...transactions.value])
const hasFilters = computed(() => filterType.value !== 'all' || Boolean(filterAccountId.value || filterCategoryId.value || filterFrom.value || filterTo.value || filterSearch.value.trim()))
const resultSummary = computed(() => ({
  incomeMinor: page.value?.page.incomeMinor ?? transactions.value
    .filter((transaction) => transaction.type === 'income')
    .reduce((total, transaction) => total + transaction.amountMinor, 0),
  expenseMinor: page.value?.page.expenseMinor ?? transactions.value
    .filter((transaction) => transaction.type === 'expense')
    .reduce((total, transaction) => total + transaction.amountMinor, 0),
}))

function queryValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function initializeFiltersFromRoute(): void {
  filterAccountId.value = queryValue(route.query.accountId)
  filterCategoryId.value = queryValue(route.query.categoryId)
  const type = queryValue(route.query.type)
  if (type === 'income' || type === 'expense' || type === 'transfer' || type === 'all') {
    filterType.value = type
  }
  filterFrom.value = queryValue(route.query.from)
  filterTo.value = queryValue(route.query.to)
  filterSearch.value = queryValue(route.query.search)
  if (filterFrom.value || filterTo.value) filterDatePreset.value = 'custom'
}

onMounted(async () => {
  document.body.classList.add('ledger-transactions-mode')
  document.documentElement.classList.add('ledger-transactions-mode')
  initializeFiltersFromRoute()
  await store.bootstrap()
  if (store.settings.value) await loadTransactions()
})

function accountName(id: string): string {
  return store.accounts.value.find((account) => account.id === id)?.name ?? '未知账户'
}

function categoryName(id: string): string {
  return store.categories.value.find((category) => category.id === id)?.name ?? '未知分类'
}

function categoryLabel(category: LedgerCategoryDto): string {
  return `${category.name}${category.archivedAt !== null ? '（已归档）' : ''}`
}

function renderAccountLabel(option: SelectOption | SelectGroupOption) {
  return renderLedgerAccountLabel(option, store.accounts.value)
}

function renderCategoryLabel(option: SelectOption) {
  return renderLedgerCategoryLabel(option, store.categories.value)
}

function selectFilterType(type: LedgerTransactionFilterType | 'all'): void {
  filterType.value = type
  void applyFilters()
}

function refreshAfterFilterChange(): void {
  void applyFilters()
}

function ledgerTodayDate(): string {
  return store.overview.value?.context.todayDate
    ?? Temporal.Now.zonedDateTimeISO(store.settings.value?.timezone ?? 'UTC').toPlainDate().toString()
}

function selectDatePreset(value: string | number | null): void {
  if (typeof value !== 'string') return
  const preset = value as DatePreset
  filterDatePreset.value = preset
  if (preset === 'custom') {
    if (filterFrom.value || filterTo.value) void applyFilters()
    return
  }
  if (preset === 'all') {
    filterFrom.value = ''
    filterTo.value = ''
    void applyFilters()
    return
  }
  const today = Temporal.PlainDate.from(ledgerTodayDate())
  const from = preset === 'today'
    ? today
    : preset === 'week'
      ? today.subtract({ days: today.dayOfWeek - 1 })
      : preset === 'month'
        ? today.with({ day: 1 })
        : today.with({ month: 1, day: 1 })
  filterFrom.value = from.toString()
  filterTo.value = today.toString()
  void applyFilters()
}

function typeLabel(type: string, transferKind?: string): string {
  if (type === 'income') return '收入'
  if (type === 'expense') return '支出'
  if (type === 'transfer') return transferKind === 'repayment' ? '还款' : transferKind === 'withdrawal' ? '提现' : '转账'
  return '余额调整'
}

function transactionTitle(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income' || transaction.type === 'expense') return transaction.payee || categoryName(transaction.categoryId)
  if (transaction.type === 'transfer') return `${accountName(transaction.fromAccountId)} → ${accountName(transaction.toAccountId)}`
  return '余额调整'
}

function transactionCategory(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income' || transaction.type === 'expense') return categoryName(transaction.categoryId)
  if (transaction.type === 'transfer') return '转账'
  return '余额调整'
}

function transactionAccount(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income' || transaction.type === 'expense') return accountName(transaction.accountId)
  if (transaction.type === 'transfer') return '账户间转账'
  return accountName(transaction.accountId)
}

function transactionTypeIcon(type: string) {
  if (type === 'income') return ArrowUp
  if (type === 'expense') return ArrowDown
  return ArrowRight
}

function filterTypeLabel(value: string): string {
  return value === 'all' ? '全部' : typeLabel(value)
}

let searchTimer: ReturnType<typeof setTimeout> | undefined

function cancelSearch(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = undefined
}

function scheduleSearch(): void {
  cancelSearch()
  searchTimer = setTimeout(() => {
    searchTimer = undefined
    void applyFilters()
  }, 300)
}

function formatTransactionTableTime(instantMs: number): string {
  return formatLedgerTransactionDateTime(instantMs, store.settings.value?.timezone ?? 'UTC')
}

function buildQuery(pageNumber = tablePage.value): LedgerTransactionQuery {
  const timezone = store.settings.value?.timezone ?? 'UTC'
  const offset = (pageNumber - 1) * tablePageSize.value
  return {
    type: filterType.value,
    limit: tablePageSize.value,
    ...(offset > 0 ? { offset } : {}),
    ...(filterAccountId.value ? { accountId: filterAccountId.value } : {}),
    ...(filterCategoryId.value ? { categoryId: filterCategoryId.value } : {}),
    ...(filterFrom.value ? { from: instantFromLedgerDate(filterFrom.value, timezone, 'start') } : {}),
    ...(filterTo.value ? { to: instantFromLedgerDate(filterTo.value, timezone, 'end') } : {}),
    ...(filterSearch.value.trim() ? { search: filterSearch.value.trim() } : {}),
  }
}

async function loadTransactions(targetPage = 1): Promise<void> {
  if (!store.settings.value) return
  filtersLoading.value = true
  tablePage.value = targetPage
  filterError.value = ''
  try {
    await store.refreshTransactions(buildQuery(targetPage))
    if (store.transactionsError.value) filterError.value = ledgerErrorMessage(store.transactionsError.value, '交易列表暂时无法加载。')
  } catch (cause) {
    filterError.value = ledgerErrorMessage(cause, '交易列表暂时无法加载。')
  } finally {
    filtersLoading.value = false
  }
}

async function applyFilters(): Promise<void> {
  cancelSearch()
  try {
    buildQuery()
  } catch {
    filterError.value = '请选择有效的日期范围。'
    return
  }
  await loadTransactions()
}

async function clearFilters(): Promise<void> {
  filterType.value = 'all'
  filterAccountId.value = ''
  filterCategoryId.value = ''
  filterFrom.value = ''
  filterTo.value = ''
  filterSearch.value = ''
  filterDatePreset.value = 'all'
  cancelSearch()
  await loadTransactions()
}

async function changeTablePage(nextPage: number): Promise<void> {
  const targetPage = Math.max(1, Math.min(nextPage, tablePageCount.value))
  if (targetPage === tablePage.value || paginationLoading.value) return
  const previousPage = tablePage.value
  paginationLoading.value = true
  tablePage.value = targetPage
  filterError.value = ''
  try {
    await store.refreshTransactions(buildQuery(targetPage))
    if (store.transactionsError.value) {
      tablePage.value = previousPage
      filterError.value = ledgerErrorMessage(store.transactionsError.value, '这一页交易暂时无法加载。')
    }
  } catch (cause) {
    tablePage.value = previousPage
    filterError.value = ledgerErrorMessage(cause, '这一页交易暂时无法加载。')
  } finally {
    paginationLoading.value = false
  }
}

async function changePageSize(value: string | number | null): Promise<void> {
  if (typeof value !== 'number' || value === tablePageSize.value) return
  tablePageSize.value = value
  await loadTransactions()
}

onBeforeUnmount(() => {
  document.body.classList.remove('ledger-transactions-mode')
  document.documentElement.classList.remove('ledger-transactions-mode')
  cancelSearch()
})

function inspect(transaction: LedgerTransactionDto): void {
  selectedTransaction.value = transaction
  detailOpen.value = true
}

function onTransactionUpdated(transaction: LedgerTransactionDto): void {
  selectedTransaction.value = transaction
}

function onTransactionDeleted(): void {
  selectedTransaction.value = null
}

function onRecoveryResolved(): void {
  transactionSheetOpen.value = false
  detailOpen.value = false
}

function transactionRowProps(transaction: LedgerTransactionDto) {
  return {
    class: 'ledger-transaction-row',
    'data-testid': `ledger-transaction-row-${transaction.id}`,
    tabindex: 0,
    onClick: () => inspect(transaction),
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        inspect(transaction)
      }
    },
  }
}

const transactionColumns: DataTableColumns<LedgerTransactionDto> = [
  {
    key: 'transaction',
    title: '交易对象',
    width: 210,
    render: (transaction) => h('span', { class: 'ledger-table-primary' }, [
      h('strong', { title: transactionTitle(transaction) }, transactionTitle(transaction)),
    ]),
  },
  {
    key: 'type',
    title: '类型',
    width: 100,
    align: 'center',
    titleAlign: 'center',
    render: (transaction) => h('span', { class: ['ledger-transaction-type', `is-${transaction.type}`] }, [
      h(NIcon, { size: 14, 'aria-hidden': 'true' }, { default: () => h(transactionTypeIcon(transaction.type)) }),
      ` ${typeLabel(transaction.type, transaction.type === 'transfer' ? transaction.transferKind : undefined)}`,
    ]),
  },
  {
    key: 'category',
    title: '分类',
    width: 95,
    render: (transaction) => h('span', { class: 'ledger-transaction-category', title: transactionCategory(transaction) }, transactionCategory(transaction)),
  },
  {
    key: 'account',
    title: '账户',
    width: 165,
    render: (transaction) => h('span', { class: 'ledger-transaction-account', title: transactionAccount(transaction) }, transactionAccount(transaction)),
  },
  {
    key: 'note',
    title: '备注',
    width: 200,
    render: (transaction) => {
      const detail = [transaction.note, transaction.location].filter(Boolean).join(' · ')
      return h('span', { class: 'ledger-transaction-note', title: detail || undefined }, detail || '—')
    },
  },
  {
    key: 'time',
    title: '时间',
    width: 175,
    render: (transaction) => h('span', {
      class: 'ledger-transaction-date',
      title: formatLedgerDateTime(transaction.occurredAt, store.settings.value?.timezone ?? 'UTC'),
    }, formatTransactionTableTime(transaction.occurredAt)),
  },
  {
    key: 'amount',
    title: '金额',
    width: 145,
    align: 'right',
    render: (transaction) => {
      const amountMinor = transaction.type === 'expense' ? -transaction.amountMinor : transaction.amountMinor
      return h('strong', { class: ['ledger-transaction-amount', `is-${transaction.type}`] }, [
        h(LedgerAnimatedMoney, {
          minor: amountMinor,
          currency: store.settings.value?.baseCurrency ?? 'CNY',
          signed: transaction.type !== 'transfer',
          animateOnMount: false,
          animateOnChange: false,
        }),
      ])
    },
  },
]
</script>

<template>
  <main class="ledger-page ledger-transactions-page" data-testid="ledger-transactions-page">
    <header class="ledger-transactions-header">
      <div>
        <p class="ledger-eyebrow">Ledger</p>
        <h1>交易记录</h1>
        <p>查看所有收入、支出和账户间转账。</p>
      </div>
      <div class="ledger-transactions-header-actions">
        <div
          class="ledger-header-date-range"
          :class="{ 'is-visible': filterDatePreset === 'custom' }"
          :aria-hidden="filterDatePreset === 'custom' ? 'false' : 'true'"
        >
          <LedgerDatePicker v-model="filterFrom" label="从日期" test-id="ledger-filter-from" size="small" clearable placeholder="开始日期" @update:model-value="refreshAfterFilterChange" />
          <span aria-hidden="true">至</span>
          <LedgerDatePicker v-model="filterTo" label="到日期" test-id="ledger-filter-to" size="small" clearable placeholder="结束日期" @update:model-value="refreshAfterFilterChange" />
        </div>
        <RouterLink class="ledger-secondary-button" :to="{ name: 'ledger' }" data-testid="ledger-transactions-overview-button">返回总览</RouterLink>
        <NButton class="ledger-primary-button" attr-type="button" type="primary" size="small" :bordered="false" :disabled="loading || store.hasUnresolvedCreate.value || !store.activeAccounts.value.length" data-testid="ledger-transactions-record-button" @click="transactionSheetOpen = true">＋ 记一笔</NButton>
      </div>
    </header>

    <LedgerPendingCreateGate v-if="store.recoveryGateVisible.value" @resolved="onRecoveryResolved" />

    <NCard v-else-if="store.settings.value" class="ledger-filters" :bordered="false" size="small" aria-label="交易筛选">
      <NForm class="ledger-filters-form" size="small" data-testid="ledger-filters-form" @submit.prevent="applyFilters">
        <div class="ledger-filter-bar">
          <div class="ledger-filter-select-grid">
            <div class="ledger-filter-select-card">
              <span class="ledger-filter-icon" aria-hidden="true"><NIcon :size="18"><Wallet /></NIcon></span>
              <div class="ledger-filter-select-copy">
                <span class="ledger-filter-label">账户</span>
                <NSelect v-model:value="filterAccountId" class="ledger-filter-control" size="small" :options="accountOptions" :render-label="renderAccountLabel" :node-props="ledgerSelectNodeProps" :input-props="{ id: 'ledger-filter-account', name: 'accountId' }" role="combobox" aria-haspopup="listbox" aria-label="账户" @update:value="refreshAfterFilterChange" />
              </div>
            </div>
            <div class="ledger-filter-select-card">
              <span class="ledger-filter-icon" aria-hidden="true"><NIcon :size="18"><Tag /></NIcon></span>
              <div class="ledger-filter-select-copy">
                <span class="ledger-filter-label">分类</span>
                <NSelect v-model:value="filterCategoryId" class="ledger-filter-control ledger-filter-category-select" size="small" :options="categoryOptions" :render-label="renderCategoryLabel" :node-props="ledgerSelectNodeProps" :input-props="{ id: 'ledger-filter-category', name: 'categoryId' }" role="combobox" aria-haspopup="listbox" aria-label="分类" @update:value="refreshAfterFilterChange" />
              </div>
            </div>
            <div class="ledger-filter-select-card ledger-filter-date-card">
              <span class="ledger-filter-icon" aria-hidden="true"><NIcon :size="18"><Calendar /></NIcon></span>
              <div class="ledger-filter-select-copy">
                <span class="ledger-filter-label">日期</span>
                <NSelect
                  v-model:value="filterDatePreset"
                  class="ledger-filter-control"
                  size="small"
                  :options="datePresetOptions"
                  :node-props="ledgerSelectNodeProps"
                  :input-props="{ id: 'ledger-filter-date-preset', name: 'datePreset' }"
                  role="combobox"
                  aria-haspopup="listbox"
                  aria-label="日期"
                  @update:value="selectDatePreset"
                />
              </div>
            </div>
          </div>
        </div>
      </NForm>
    </NCard>

    <div v-if="!store.hasUnresolvedCreate.value && loading && !page && !store.settings.value" class="ledger-transactions-state ledger-loading-state" data-testid="ledger-transactions-loading" role="status"><NSpin size="medium" description="正在加载交易…" /></div>
    <NEmpty v-else-if="!store.hasUnresolvedCreate.value && !store.settings.value" class="ledger-transactions-state ledger-empty-state" data-testid="ledger-transactions-needs-settings" :show-icon="false" description="请先完成 Ledger 初始化">
      <template #extra><div class="ledger-state-extra">设置基础货币、时区并创建账户后，交易记录才会出现在这里。</div></template>
    </NEmpty>
    <NCard v-else-if="!store.hasUnresolvedCreate.value && store.settings.value" class="ledger-transaction-history" :bordered="false" size="small" aria-label="交易记录列表">
      <div v-if="!store.activeAccounts.value.length" class="ledger-no-active-account-notice" data-testid="ledger-transactions-no-account" role="status">
        <div>
          <strong>当前没有可用于新增交易的账户。</strong>
          <p>历史记录仍然可以查看；恢复账户或创建新账户后即可继续记账。</p>
        </div>
        <div class="ledger-notice-actions">
          <RouterLink class="ledger-secondary-button" :to="{ name: 'ledger-accounts' }">恢复账户</RouterLink>
          <RouterLink class="ledger-secondary-button" :to="{ name: 'ledger-accounts' }">创建新账户</RouterLink>
        </div>
      </div>
      <div class="ledger-history-tools">
        <div class="ledger-type-switch" role="tablist" aria-label="类型" data-testid="ledger-filter-type-switch">
          <button
            v-for="option in typeOptions"
            :key="String(option.value)"
            type="button"
            :class="['ledger-type-option', { 'is-active': filterType === option.value }]"
            role="tab"
            :aria-selected="filterType === option.value ? 'true' : 'false'"
            :aria-pressed="filterType === option.value ? 'true' : 'false'"
            :data-ledger-filter-type="option.value"
            @click="selectFilterType(option.value as LedgerTransactionFilterType | 'all')"
          >
            <NIcon v-if="option.value !== 'all'" :size="15" aria-hidden="true"><component :is="transactionTypeIcon(String(option.value))" /></NIcon>
            <NIcon v-else :size="15" aria-hidden="true"><ArrowsVertical /></NIcon>
            {{ filterTypeLabel(String(option.value)) }}
          </button>
        </div>
        <div class="ledger-search-row">
          <NInput
            v-model:value="filterSearch"
            class="ledger-search-input"
            size="small"
            clearable
            placeholder="搜索交易对象、地点或备注"
            aria-label="搜索交易"
            :input-props="{ id: 'ledger-filter-search', name: 'search', autocomplete: 'off' }"
            @update:value="scheduleSearch"
            @keyup.enter="applyFilters"
          >
            <template #prefix><NIcon :size="18" aria-hidden="true"><Search /></NIcon></template>
          </NInput>
        </div>
        <div class="ledger-history-summary" aria-label="交易汇总">
          <span>收入 <strong class="is-income"><LedgerAnimatedMoney :minor="resultSummary.incomeMinor" :currency="store.settings.value?.baseCurrency ?? 'CNY'" animate-on-mount /></strong></span>
          <i aria-hidden="true" />
          <span>支出 <strong class="is-expense"><LedgerAnimatedMoney :minor="resultSummary.expenseMinor" :currency="store.settings.value?.baseCurrency ?? 'CNY'" animate-on-mount /></strong></span>
        </div>
      </div>

      <NAlert v-if="filterError" class="ledger-inline-error" type="error" :show-icon="false" role="alert"><span>{{ filterError }}</span><NButton class="ledger-link-button" attr-type="button" size="small" text :bordered="false" @click="loadTransactions(tablePage)">重试</NButton></NAlert>
      <div v-if="loading && !page" class="ledger-table-skeleton" data-testid="ledger-transactions-inline-loading" role="status" aria-label="正在加载交易">
        <span v-for="row in 5" :key="row" class="ledger-skeleton-row" aria-hidden="true">
          <i /><i /><i /><i /><i /><i /><i />
        </span>
      </div>
      <NDataTable
        v-else-if="transactions.length"
        class="ledger-transaction-table"
        data-testid="ledger-transaction-list"
        aria-label="交易记录表格"
        :data="visibleTransactions"
        :columns="transactionColumns"
        :row-key="(transaction) => transaction.id"
        :row-props="transactionRowProps"
        :loading="loading || paginationLoading"
        :max-height="268"
        size="small"
        :bordered="false"
        :bottom-bordered="false"
        :single-line="false"
      />
      <NEmpty v-else class="ledger-transactions-empty" data-testid="ledger-transactions-empty" size="medium" :description="hasFilters ? '没有符合当前筛选条件的交易' : '暂无交易记录'">
        <template #icon>
          <span class="ledger-empty-icon" aria-hidden="true">
            <NIcon :size="24"><component :is="hasFilters ? Search : Wallet" /></NIcon>
          </span>
        </template>
        <template #extra>
          <div class="ledger-empty-extra">
            <p>{{ hasFilters ? '可以清除筛选，或尝试其他日期、账户和分类。' : '保存第一笔收入、支出或转账后，它会显示在这里。' }}</p>
            <NButton v-if="hasFilters" class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" @click="clearFilters">清除筛选</NButton>
            <NButton v-else class="ledger-primary-button" attr-type="button" type="primary" size="small" :bordered="false" :disabled="!store.activeAccounts.value.length" @click="transactionSheetOpen = true">记下第一笔</NButton>
          </div>
        </template>
      </NEmpty>
      <div v-if="transactions.length" class="ledger-transaction-pagination">
        <div class="ledger-pagination-meta">共 <span class="ledger-animated-count"><NNumberAnimation :key="transactionTotal" :from="transactionTotal" :to="transactionTotal" :duration="0" /></span> 条</div>
        <div class="ledger-pagination-controls">
          <NPagination
            :page="tablePage"
            :page-size="tablePageSize"
            :item-count="transactionTotal"
            :page-sizes="pageSizeOptions"
            :disabled="paginationLoading"
            :page-slot="7"
            show-size-picker
            size="medium"
            @update:page="changeTablePage"
            @update:page-size="changePageSize"
          />
          <span v-if="paginationLoading" class="ledger-pagination-loading">正在加载…</span>
        </div>
      </div>
    </NCard>

    <LedgerTransactionSheet v-if="!store.recoveryGateVisible.value" :open="transactionSheetOpen" @close="transactionSheetOpen = false" />
    <LedgerTransactionDetailSheet :open="detailOpen" :transaction="selectedTransaction" @close="detailOpen = false" @updated="onTransactionUpdated" @deleted="onTransactionDeleted" />
  </main>
</template>

<style scoped>
.ledger-page { min-height: calc(100vh - var(--navbar-h, 52px)); box-sizing: border-box; background: var(--bg); }
.ledger-transactions-page { width: min(100%, 1120px); margin: 0 auto; padding: 34px 28px 64px; box-sizing: border-box; }
.ledger-transactions-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 22px; margin-bottom: 22px; }
.ledger-transactions-header-actions { display: flex; align-items: center; gap: 10px; }
.ledger-eyebrow { margin: 0 0 5px; color: var(--accent); font-size: .75rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.ledger-transactions-header h1 { margin: 0; color: var(--text-h); font-size: 2rem; line-height: 1.2; }
.ledger-transactions-header p:not(.ledger-eyebrow) { margin: 8px 0 0; color: var(--text-muted); font-size: .84rem; }
.ledger-primary-button,
.ledger-secondary-button { display: inline-flex; min-height: 32px; align-items: center; justify-content: center; box-sizing: border-box; padding: 6px 12px; border-radius: 7px; font: inherit; font-size: .78rem; font-weight: 650; text-decoration: none; cursor: pointer; }
.ledger-primary-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.ledger-secondary-button { border: 1px solid var(--border); background: var(--bg); color: var(--text-h); }
.ledger-secondary-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-primary-button:disabled,
.ledger-secondary-button:disabled { cursor: wait; opacity: .65; }
.ledger-link-button { padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; font-size: .78rem; cursor: pointer; }
.ledger-link-button:hover { text-decoration: underline; }
.ledger-filters { margin-bottom: 21px; padding: 17px 18px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-soft); }
.ledger-filters :deep(.n-card__content),
.ledger-transaction-history :deep(.n-card__content) { padding: 0; }
.ledger-filters :deep(.n-card-content),
.ledger-transaction-history :deep(.n-card-content) { padding: 0; }
.ledger-filters :deep(.n-card-content) { width: 100%; box-sizing: border-box; }
.ledger-filters-form { display: grid; gap: 12px; }
.ledger-filters-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.ledger-filters-heading h2 { margin: 0; color: var(--text-h); font-size: .92rem; }
.ledger-filters-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)) auto; gap: 10px; align-items: end; }
.ledger-filter-item { min-width: 0; }
.ledger-filter-item :deep(.n-form-item-label) { color: var(--text-muted); font-size: .72rem; }
.ledger-filter-control { width: 100%; }
.ledger-filters-grid :deep(.ledger-filter-control .n-base-selection),
.ledger-filters-grid :deep(.ledger-date-picker),
.ledger-filters-grid :deep(.ledger-date-picker .n-date-picker) { width: 100%; }
.ledger-filters-grid :deep(.ledger-date-picker .n-input) { width: 100%; }
.ledger-filter-submit { white-space: nowrap; }
.ledger-transactions-state { display: grid; min-height: 340px; align-content: center; gap: 9px; padding: 30px 18px; color: var(--text-muted); }
.ledger-loading-state { place-items: center; text-align: center; }
.ledger-empty-state { place-items: center start; text-align: left; }
.ledger-loading-state :deep(.n-spin-container) { display: grid; place-items: center; }
.ledger-empty-state :deep(.n-empty__extra) { text-align: left; }
.ledger-transactions-state :deep(.n-empty__description) { color: var(--text-h); font-size: 1.1rem; }
.ledger-transactions-state :deep(.n-empty__extra) { max-width: 34rem; color: var(--text-muted); font-size: .82rem; line-height: 1.5; }
.ledger-transactions-state h2,
.ledger-transactions-state p { margin: 0; }
.ledger-transactions-state h2 { color: var(--text-h); font-size: 1.2rem; }
.ledger-transaction-history { padding: 20px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg); }
.ledger-history-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 13px; }
.ledger-history-heading h2 { margin: 0; color: var(--text-h); font-size: 1rem; }
.ledger-history-heading p { margin: 4px 0 0; color: var(--text-muted); font-size: .75rem; }
.ledger-timezone-note { color: var(--text-muted); font-size: .73rem; }
.ledger-inline-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; color: #b42318; font-size: .78rem; }
.ledger-inline-error :deep(.n-alert-body) { width: 100%; }
.ledger-inline-error :deep(.n-alert__content) { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
.ledger-transactions-inline-loading { display: grid; min-height: 220px; place-items: center; color: var(--text-muted); }
.ledger-transaction-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.ledger-transaction-table th { padding: 0 8px 9px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: .73rem; font-weight: 650; text-align: left; }
.ledger-transaction-table td { padding: 13px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); vertical-align: middle; }
.ledger-transaction-table th:first-child,
.ledger-transaction-table td:first-child { width: 34%; }
.ledger-transaction-table th:nth-child(2),
.ledger-transaction-table td:nth-child(2) { width: 13%; }
.ledger-transaction-table th:nth-child(3),
.ledger-transaction-table td:nth-child(3) { width: 20%; }
.ledger-transaction-table th:nth-child(4),
.ledger-transaction-table td:nth-child(4) { width: 20%; }
.ledger-transaction-table th:nth-child(5),
.ledger-transaction-table td:nth-child(5) { width: 13%; }
.ledger-transaction-row { cursor: pointer; }
.ledger-transaction-row:hover td { background: var(--bg-soft); }
.ledger-table-primary { display: grid; gap: 3px; min-width: 0; }
.ledger-table-primary strong { overflow: hidden; color: var(--text-h); font-size: .84rem; text-overflow: ellipsis; white-space: nowrap; }
.ledger-table-primary small,
.ledger-transaction-date { overflow: hidden; color: var(--text-muted); font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
.ledger-transaction-date { display: block; text-align: right; }
.ledger-transaction-type { color: var(--text-muted); font-size: .78rem; }
.ledger-transaction-type.is-income { color: #18794e; }
.ledger-transaction-type.is-expense { color: #b42318; }
.ledger-transaction-note { display: block; overflow: hidden; color: var(--text-muted); font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.ledger-transaction-amount { text-align: right; color: var(--text-h); font-size: .83rem; }
.ledger-transaction-amount.is-income { color: #18794e; }
.ledger-transaction-amount.is-expense { color: #b42318; }
.ledger-transactions-empty {
  display: grid;
  min-height: 240px;
  place-items: center;
  align-content: center;
  gap: 12px;
  padding: 42px 24px;
  box-sizing: border-box;
  color: var(--text-muted);
  text-align: center;
}
.ledger-empty-icon {
  display: grid;
  width: 56px;
  height: 56px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--ledger-border));
  border-radius: 18px;
  background: color-mix(in srgb, var(--accent) 8%, var(--ledger-surface-strong));
  box-shadow: inset 0 1px 0 var(--ledger-highlight);
  color: var(--accent);
}
.ledger-transactions-empty :deep(.n-empty__description) { color: var(--text-h); font-size: 1rem; font-weight: 650; }
.ledger-transactions-empty :deep(.n-empty__extra) { display: grid; gap: 14px; max-width: 360px; color: var(--text-muted); font-size: .8rem; line-height: 1.6; text-align: center; }
.ledger-empty-extra { display: grid; justify-items: center; gap: 14px; text-align: center; }
.ledger-transactions-empty p { margin: 0; }
.ledger-no-active-account-notice { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 18px; padding: 12px 13px; border: 1px solid color-mix(in srgb, #b7791f 30%, var(--border)); border-radius: 8px; background: color-mix(in srgb, #f6ad55 7%, var(--bg-soft)); }
.ledger-no-active-account-notice strong { color: var(--text-h); font-size: .8rem; }
.ledger-no-active-account-notice p { margin: 4px 0 0; color: var(--text-muted); font-size: .75rem; }
.ledger-notice-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ledger-transaction-pagination { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 18px; }
.ledger-pagination-loading { color: var(--text-muted); font-size: .75rem; }
@media (max-width: 850px) {
  .ledger-filters-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .ledger-filter-submit { grid-column: span 3; }
}
@media (max-width: 620px) {
  .ledger-transactions-page { padding: 28px 16px 48px; }
  .ledger-transactions-header { align-items: stretch; flex-direction: column; }
  .ledger-transactions-header-actions { width: 100%; }
  .ledger-transactions-header-actions > * { flex: 1; }
  .ledger-no-active-account-notice { align-items: stretch; flex-direction: column; }
  .ledger-notice-actions > * { flex: 1 1 140px; }
  .ledger-filters-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ledger-filter-submit { grid-column: span 2; }
  .ledger-transaction-history { padding: 16px 13px; }
  .ledger-transaction-table th,
  .ledger-transaction-table td { padding-right: 6px; padding-left: 6px; }
  .ledger-transaction-table th:nth-child(4),
  .ledger-transaction-table td:nth-child(4) { display: none; }
  .ledger-transaction-table th:first-child,
  .ledger-transaction-table td:first-child { width: 42%; }
  .ledger-transaction-table th:nth-child(2),
  .ledger-transaction-table td:nth-child(2) { width: 18%; }
  .ledger-transaction-table th:nth-child(3),
  .ledger-transaction-table td:nth-child(3) { width: 18%; }
  .ledger-transaction-table th:nth-child(5),
  .ledger-transaction-table td:nth-child(5) { width: 22%; }
}

/* Transaction history workspace — the page uses one calm glass surface for
   filters and another for the result table, matching the Ledger dashboard. */
.ledger-transactions-page {
  --ledger-border: color-mix(in srgb, var(--border) 72%, transparent);
  --ledger-divider: color-mix(in srgb, var(--border) 58%, transparent);
  --ledger-surface: color-mix(in srgb, var(--bg-soft) 72%, transparent);
  --ledger-surface-strong: color-mix(in srgb, var(--bg-soft) 82%, transparent);
  --ledger-tint: color-mix(in srgb, var(--accent) 4%, transparent);
  --ledger-highlight: color-mix(in srgb, #fff 38%, transparent);
  --ledger-income: var(--nuvyn-positive, var(--accent));
  --ledger-expense: var(--nuvyn-negative, var(--text-h));
  --ledger-transfer: var(--nuvyn-info, #005fb8);
  width: min(100%, 1240px);
  margin: 0 auto;
  padding: 42px 28px 20px;
  box-sizing: border-box;
}

.ledger-transactions-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 28px;
  margin-bottom: 28px;
}

.ledger-transactions-header h1 {
  margin: 0;
  color: var(--text-h);
  font-size: clamp(1.85rem, 3vw, 2.35rem);
  font-weight: 720;
  letter-spacing: -.035em;
  line-height: 1.16;
}

.ledger-transactions-header p:not(.ledger-eyebrow) {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: .78rem;
}

.ledger-transactions-header-actions {
  display: flex;
  align-items: center;
  justify-self: end;
  flex-wrap: nowrap;
  gap: 10px;
}

.ledger-header-date-range {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  width: 320px;
  align-items: center;
  gap: 8px;
  visibility: hidden;
  opacity: 0;
  transform: translateY(2px);
  pointer-events: none;
  transition: opacity .18s ease, transform .18s ease, visibility .18s ease;
}
.ledger-header-date-range.is-visible {
  visibility: visible;
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.ledger-header-date-range > span { color: var(--text-muted); font-size: .76rem; }
.ledger-header-date-range :deep(.ledger-date-picker),
.ledger-header-date-range :deep(.ledger-date-picker .n-date-picker),
.ledger-header-date-range :deep(.n-input) { width: 100%; min-width: 0; }
.ledger-header-date-range :deep(.n-input) { height: 32px; border-radius: 8px; }

.ledger-transactions-header-actions .ledger-primary-button,
.ledger-transactions-header-actions .ledger-secondary-button {
  height: 32px;
  min-height: 32px;
  box-sizing: border-box;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: .78rem;
}

.ledger-filters,
.ledger-transaction-history {
  border: 1px solid var(--ledger-border);
  background:
    linear-gradient(135deg, var(--ledger-tint), transparent 48%),
    var(--ledger-surface);
  box-shadow:
    inset 0 1px 0 var(--ledger-highlight),
    0 8px 24px color-mix(in srgb, var(--text-h) 6%, transparent);
  -webkit-backdrop-filter: saturate(145%) blur(18px);
  backdrop-filter: saturate(145%) blur(18px);
}

.ledger-filters {
  margin-bottom: 14px;
  padding: 6px 24px;
  border-radius: 11px;
}

.ledger-filters-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
}
.ledger-search-row { display: flex; align-items: center; gap: 12px; width: 390px; min-width: 0; }
.ledger-search-input { flex: 1 1 auto; min-width: 0; }
.ledger-search-input :deep(.n-input) {
  border: 1px solid var(--ledger-border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--bg) 34%, transparent);
  box-shadow: none;
}
.ledger-search-input :deep(.n-input--focus) {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
}
.ledger-search-input :deep(.n-input__input-el) { font-size: .82rem; }
.ledger-search-input :deep(.n-input__prefix) { color: var(--text-muted); }

.ledger-filter-bar { display: contents; }
.ledger-type-switch {
  display: grid;
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  min-height: 28px;
  padding: 2px;
  border: 1px solid var(--ledger-border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--bg) 35%, transparent);
}
.ledger-type-option {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: .74rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color .18s ease, color .18s ease, box-shadow .18s ease;
}
.ledger-type-option:hover { color: var(--text-h); }
.ledger-type-option.is-active {
  background: var(--accent);
  color: #fff;
  box-shadow: none;
}
.ledger-filter-divider { display: none; }
.ledger-filter-select-grid {
  display: grid;
  grid-column: 1;
  grid-row: 1;
  width: 100%;
  margin-left: 0;
  box-sizing: border-box;
  min-width: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.ledger-filter-select-card {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 42px;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  box-sizing: border-box;
  border: 0;
  border-radius: 9px;
  background: color-mix(in srgb, var(--bg) 18%, transparent);
}
.ledger-filter-icon {
  display: grid;
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-soft));
  color: var(--accent);
}
.ledger-filter-select-copy { display: grid; min-width: 0; flex: 1; gap: 1px; }
.ledger-filter-label { display: none; }
.ledger-filter-control { width: 100%; min-width: 0; }
.ledger-filter-select-card :deep(.n-base-selection) {
  min-height: 25px;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}
.ledger-filter-select-card :deep(.n-base-selection-label) { padding: 0; }
.ledger-filter-select-card :deep(.n-base-selection-input__content .ledger-account-select-icon),
.ledger-filter-select-card :deep(.n-base-selection-input__content .ledger-category-select-icon) { display: none; }
.ledger-filter-select-card :deep(.n-base-selection-input__content) {
  color: var(--text-h);
  font-size: .8rem;
  font-weight: 650;
}
.ledger-filter-select-card :deep(.n-base-selection__arrow) { color: var(--text-muted); }
.ledger-filter-category-select :deep(.n-base-selection) { min-height: 25px; }
.ledger-filter-category-select :deep(.n-base-selection-input__content) { font-size: .8rem; }
.ledger-transaction-history {
  overflow: hidden;
  padding: 0;
  border-radius: 11px;
}
.ledger-history-heading {
  margin: 0;
  padding: 21px 24px 17px;
  border-bottom: 1px solid var(--ledger-divider);
}
.ledger-history-tools {
  display: grid;
  grid-template-columns: minmax(280px, 390px) 390px 320px;
  align-items: center;
  gap: 18px;
  justify-content: space-between;
  margin: 0 24px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ledger-divider);
}
.ledger-history-tools .ledger-history-summary { grid-column: 3; grid-row: 1; }
.ledger-history-tools .ledger-type-switch { grid-column: 1; grid-row: 1; }
.ledger-history-tools .ledger-type-switch {
  box-sizing: border-box;
  height: 28px;
  min-height: 0;
}
.ledger-history-tools .ledger-search-row { grid-column: 2; grid-row: 1; }
.ledger-history-heading h2 { font-size: 1.08rem; font-weight: 720; }
.ledger-history-heading p { margin-top: 5px; font-size: .73rem; }
.ledger-history-summary { display: flex; align-items: baseline; justify-content: flex-end; gap: 9px; width: 320px; color: var(--text-muted); font-size: .76rem; white-space: nowrap; }
.ledger-history-summary strong { color: var(--text-h); font-size: .84rem; font-variant-numeric: tabular-nums; }
.ledger-history-summary strong.is-income { color: var(--ledger-income); }
.ledger-history-summary strong.is-expense { color: var(--ledger-expense); }
.ledger-history-summary i { width: 1px; height: 13px; background: var(--ledger-divider); }
.ledger-animated-count { display: inline-block; animation: ledger-number-pop .42s ease-out both; }
@keyframes ledger-number-pop {
  from { opacity: .45; transform: translateY(2px) scale(.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.ledger-transaction-history :deep(.n-card__content) { overflow-x: auto; }
.ledger-transaction-table {
  width: 100%;
  min-width: 1000px;
}
.ledger-transaction-table :deep(.n-data-table) { width: 100%; }
.ledger-transaction-table :deep(.n-data-table-wrapper) { min-width: 1000px; }
.ledger-transaction-table :deep(.n-data-table-table) {
  display: table;
  width: 100%;
  margin: 0;
  table-layout: fixed;
}
.ledger-transaction-table :deep(.n-data-table-th),
.ledger-transaction-table :deep(.n-data-table-td) {
  border-right: 0;
  text-align: left;
}
.ledger-transaction-table :deep(.n-data-table-th) {
  padding: 10px 22px;
  border: 0 !important;
  box-shadow: none;
  background: color-mix(in srgb, var(--accent) 3%, var(--ledger-surface-strong)) !important;
  color: var(--text-muted);
  font-size: .7rem;
  font-weight: 650;
}
.ledger-transaction-table :deep(.n-data-table-td) {
  padding: 9px 22px;
  border-bottom: 1px solid var(--ledger-divider);
  background: transparent;
}
.ledger-transaction-table :deep(.n-data-table-th:last-child),
.ledger-transaction-table :deep(.n-data-table-td:last-child) { text-align: right; }
.ledger-transaction-table :deep(.n-data-table-tr:last-child .n-data-table-td) { border-bottom: 0; }
.ledger-transaction-table :deep(.n-data-table-tr:hover .n-data-table-td) { background: color-mix(in srgb, var(--accent) 4%, transparent); }
.ledger-transaction-table :deep(.ledger-transaction-row:focus-visible .n-data-table-td) {
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--accent) 20%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--accent) 20%, transparent);
}
.ledger-transaction-table :deep(.ledger-transaction-row:focus-visible) { outline: 1px solid color-mix(in srgb, var(--accent) 28%, transparent); outline-offset: -1px; }
.ledger-transaction-table :deep(.ledger-table-primary) { display: grid; gap: 3px; min-width: 0; }
.ledger-transaction-table :deep(.ledger-table-primary strong) { overflow: hidden; color: var(--text-h); font-size: .82rem; text-overflow: ellipsis; white-space: nowrap; }
.ledger-transaction-table :deep(.ledger-transaction-type) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ledger-transfer) 11%, transparent);
  color: var(--ledger-transfer);
  font-size: .72rem;
  font-weight: 650;
  white-space: nowrap;
}
.ledger-transaction-table :deep(.ledger-transaction-type.is-income) { background: color-mix(in srgb, var(--ledger-income) 12%, transparent); color: var(--ledger-income); }
.ledger-transaction-table :deep(.ledger-transaction-type.is-expense) { background: color-mix(in srgb, var(--ledger-expense) 12%, transparent); color: var(--ledger-expense); }
.ledger-transaction-table :deep(.ledger-transaction-category),
.ledger-transaction-table :deep(.ledger-transaction-account),
.ledger-transaction-table :deep(.ledger-transaction-note),
.ledger-transaction-table :deep(.ledger-transaction-date) {
  display: block;
  overflow: hidden;
  color: var(--text-muted);
  font-size: .75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ledger-transaction-table :deep(.ledger-transaction-date) { text-align: left; font-variant-numeric: tabular-nums; }
.ledger-transaction-table :deep(.ledger-transaction-amount) { color: var(--text-h); font-size: .82rem; font-variant-numeric: tabular-nums; }
.ledger-transaction-table :deep(.ledger-transaction-amount.is-income) { color: var(--ledger-income); }
.ledger-transaction-table :deep(.ledger-transaction-amount.is-expense) { color: var(--ledger-expense); }
.ledger-transaction-table th {
  padding: 13px 22px 11px;
  border-bottom: 1px solid var(--ledger-divider);
  color: var(--text-muted);
  font-size: .7rem;
  font-weight: 650;
}
.ledger-transaction-table th,
.ledger-transaction-table td { text-align: left; }
.ledger-transaction-table th:last-child,
.ledger-transaction-table td:last-child { text-align: right; }
.ledger-transaction-table td { padding: 12px 22px; border-bottom: 1px solid var(--ledger-divider); }
.ledger-transaction-table th:first-child,
.ledger-transaction-table td:first-child { width: 22%; }
.ledger-transaction-table th:nth-child(2),
.ledger-transaction-table td:nth-child(2) { width: 9%; }
.ledger-transaction-table th:nth-child(3),
.ledger-transaction-table td:nth-child(3) { width: 10%; }
.ledger-transaction-table th:nth-child(4),
.ledger-transaction-table td:nth-child(4) { width: 15%; }
.ledger-transaction-table th:nth-child(5),
.ledger-transaction-table td:nth-child(5) { width: 22%; }
.ledger-transaction-table th:nth-child(6),
.ledger-transaction-table td:nth-child(6) { width: 11%; }
.ledger-transaction-table th:nth-child(7),
.ledger-transaction-table td:nth-child(7) { width: 12%; }
.ledger-transaction-row:last-child td { border-bottom: 0; }
.ledger-transaction-row:hover td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
.ledger-table-primary { gap: 3px; }
.ledger-table-primary strong { font-size: .82rem; }
.ledger-table-primary small,
.ledger-transaction-category,
.ledger-transaction-account,
.ledger-transaction-note,
.ledger-transaction-location { font-size: .75rem; }
.ledger-transaction-category,
.ledger-transaction-account { display: block; overflow: hidden; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; }
.ledger-transaction-type {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ledger-transfer) 11%, transparent);
  color: var(--ledger-transfer);
  font-size: .72rem;
  font-weight: 650;
  white-space: nowrap;
}
.ledger-transaction-type.is-income { background: color-mix(in srgb, var(--ledger-income) 12%, transparent); color: var(--ledger-income); }
.ledger-transaction-type.is-expense { background: color-mix(in srgb, var(--ledger-expense) 12%, transparent); color: var(--ledger-expense); }
.ledger-transaction-note { display: block; overflow: hidden; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; }
.ledger-transaction-location { display: block; overflow: hidden; margin-top: 2px; color: var(--text-muted); opacity: .75; text-overflow: ellipsis; white-space: nowrap; }
.ledger-transaction-date { text-align: left; font-size: .73rem; }
.ledger-transaction-amount { font-size: .82rem; font-variant-numeric: tabular-nums; }
.ledger-transaction-amount.is-income { color: var(--ledger-income); }
.ledger-transaction-amount.is-expense { color: var(--ledger-expense); }
.ledger-transaction-pagination {
  justify-content: space-between;
  margin-top: auto;
  padding: 12px 22px;
  border-top: 1px solid var(--ledger-divider);
  background: color-mix(in srgb, var(--bg) 14%, transparent);
}
.ledger-pagination-meta { color: var(--text-muted); font-size: .74rem; }
.ledger-pagination-controls { display: flex; align-items: center; gap: 12px; }
.ledger-pagination-controls :deep(.n-pagination) { align-items: center; }
.ledger-pagination-controls :deep(.n-pagination .n-select) { width: 82px; }
.ledger-table-skeleton { display: grid; min-width: 1000px; padding: 0 22px; }
.ledger-skeleton-row { display: grid; grid-template-columns: 21% 9% 9% 15% 20% 13% 13%; gap: 0; min-height: 46px; align-items: center; border-bottom: 1px solid var(--ledger-divider); }
.ledger-skeleton-row:last-child { border-bottom: 0; }
.ledger-skeleton-row i { display: block; width: calc(100% - 22px); height: 10px; border-radius: 999px; background: color-mix(in srgb, var(--border) 62%, transparent); animation: ledger-skeleton-pulse 1.4s ease-in-out infinite; }
.ledger-skeleton-row i:nth-child(2) { width: 52px; }
.ledger-skeleton-row i:nth-child(3) { width: 44px; }
.ledger-skeleton-row i:nth-child(6) { width: 66px; }
.ledger-skeleton-row i:nth-child(7) { justify-self: end; width: 76px; }
@keyframes ledger-skeleton-pulse { 0%, 100% { opacity: .45; } 50% { opacity: .9; } }

@media (max-width: 1050px) {
  .ledger-history-tools { grid-template-columns: minmax(280px, 1fr) auto; }
  .ledger-history-tools .ledger-type-switch { grid-column: 1; grid-row: 1; }
  .ledger-history-tools .ledger-history-summary { grid-column: 2; grid-row: 1; }
  .ledger-history-tools .ledger-search-row { grid-column: 1 / -1; grid-row: 2; }
  .ledger-history-tools .ledger-search-row { width: 100%; }
  .ledger-history-summary { width: auto; }
}

@media (min-width: 651px) {
  .ledger-transactions-page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - var(--navbar-h, 52px));
    min-height: 0;
    overflow: hidden;
  }
  .ledger-transactions-page > * { flex-shrink: 0; }
  .ledger-transaction-history {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    height: 0;
    min-height: 0;
    box-sizing: border-box;
  }
  .ledger-transaction-history :deep(.n-card__content),
  .ledger-transaction-history :deep(.n-card-content) {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    height: 0;
    min-height: 0;
    overflow: hidden;
    overscroll-behavior: contain;
  }
  .ledger-transaction-history .ledger-history-heading,
  .ledger-transaction-history .ledger-history-tools,
  .ledger-transaction-history .ledger-inline-error,
  .ledger-transaction-history .ledger-transaction-pagination {
    flex: 0 0 auto;
  }
  .ledger-transaction-history .ledger-transaction-table,
  .ledger-transaction-history .ledger-table-skeleton,
  .ledger-transaction-history .ledger-transactions-empty,
  .ledger-transaction-history .ledger-transactions-inline-loading {
    min-height: 0;
    flex: 1 1 auto;
  }
  .ledger-transaction-history .ledger-transaction-table {
    flex: 0 0 306px;
    height: 306px;
    overflow: visible;
  }
  .ledger-transaction-history .ledger-transaction-table :deep(.n-data-table),
  .ledger-transaction-history .ledger-transaction-table :deep(.n-data-table-wrapper) {
    min-height: 0;
  }
  .ledger-transaction-pagination {
    box-sizing: border-box;
    flex-basis: 53px;
    height: 53px;
    position: relative;
    z-index: 1;
  }
}

@media (max-width: 720px) {
  .ledger-transactions-page { padding: 24px 16px 48px; }
  .ledger-transactions-header { grid-template-columns: 1fr; align-items: start; }
  .ledger-transactions-header-actions { display: grid; width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); justify-self: stretch; }
  .ledger-transactions-header-actions > * { flex: none; }
  .ledger-header-date-range { display: none; width: 100%; grid-column: 1 / -1; }
  .ledger-header-date-range.is-visible { display: grid; }
  .ledger-transactions-header-actions .ledger-primary-button,
  .ledger-transactions-header-actions .ledger-secondary-button { width: 100%; }
  .ledger-filters { padding: 8px 16px; }
  .ledger-filter-select-grid { width: 100%; margin-left: 0; grid-template-columns: 1fr; }
  .ledger-filter-select-card { min-height: 42px; }
  .ledger-history-heading { align-items: flex-start; flex-direction: column; gap: 12px; padding: 18px 16px 15px; }
  .ledger-history-tools { grid-template-columns: 1fr; gap: 10px; margin: 0 16px; padding: 12px 0; }
  .ledger-history-tools .ledger-type-switch,
  .ledger-history-tools .ledger-search-row,
  .ledger-history-tools .ledger-history-summary { grid-column: 1; }
  .ledger-history-tools .ledger-type-switch { grid-row: 1; }
  .ledger-history-tools .ledger-search-row { grid-row: 2; }
  .ledger-history-tools .ledger-history-summary { grid-row: 3; }
  .ledger-history-summary { flex-wrap: wrap; white-space: normal; }
  .ledger-transaction-table th,
  .ledger-transaction-table td { padding-right: 14px; padding-left: 14px; }
  .ledger-transaction-table { min-width: 760px; }
  .ledger-transaction-table th:nth-child(3),
  .ledger-transaction-table td:nth-child(3),
  .ledger-transaction-table th:nth-child(5),
  .ledger-transaction-table td:nth-child(5) { display: none; }
  .ledger-transaction-table th:nth-child(4),
  .ledger-transaction-table td:nth-child(4) { display: table-cell; }
  .ledger-transaction-table th:first-child,
  .ledger-transaction-table td:first-child { width: 30%; }
  .ledger-transaction-table th:nth-child(2),
  .ledger-transaction-table td:nth-child(2) { width: 15%; }
  .ledger-transaction-table th:nth-child(4),
  .ledger-transaction-table td:nth-child(4) { width: 25%; }
  .ledger-transaction-table th:nth-child(6),
  .ledger-transaction-table td:nth-child(6) { width: 16%; }
  .ledger-transaction-table th:nth-child(7),
  .ledger-transaction-table td:nth-child(7) { width: 14%; }
  .ledger-transaction-pagination { align-items: stretch; flex-direction: column; padding: 14px 16px; }
  .ledger-pagination-controls { justify-content: space-between; }
}
</style>
