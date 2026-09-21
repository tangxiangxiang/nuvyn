<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NFlex, NIcon, NList, NListItem, NNumberAnimation, NSelect, NSpin, NStatistic, type SelectOption } from 'naive-ui'
import { CreditCard, Scale, Wallet } from '@vicons/tabler'
import type {
  LedgerOverviewDto,
  LedgerOverviewScope,
  LedgerPeriodName,
  LedgerTransactionDto,
  LedgerTrendPoint,
} from '../../../shared/ledgerProtocol'
import { getLedgerOverview, getLedgerTrend } from '../../features/ledger/api'
import { currencyExponentFor, formatLedgerMoney, formatLedgerSignedMoney } from '../../features/ledger/money'
import { ledgerPresentationBalanceMinor, ledgerTransactionPresentationKind } from '../../features/ledger/presentation'
import { formatLedgerDate, formatLedgerDateTime, formatLedgerPeriodPickerLabel, ledgerDateFilterRangeFromPeriod } from '../../features/ledger/time'
import { ledgerSelectNodeProps } from '../../features/ledger/naiveControls'
import { calendarDateFromNaivePickerTimestamp } from '../../features/ledger/naiveTemporal'
import { useLedgerStore } from '../../features/ledger/ledgerStore'
import LedgerCashflowTrend from './LedgerCashflowTrend.vue'
import LedgerDatePicker from './LedgerDatePicker.vue'
import LedgerAnimatedMoney from './LedgerAnimatedMoney.vue'
import LedgerAccountIcon from './LedgerAccountIcon.vue'

type LedgerTransactionNavigationFilters = {
  readonly categoryId?: string
  readonly from?: string
  readonly to?: string
}

const emit = defineEmits<{
  record: []
  viewTransactions: [filters?: LedgerTransactionNavigationFilters]
  inspectTransaction: [transaction: LedgerTransactionDto]
}>()
const store = useLedgerStore()
const overview = computed(() => store.overview.value)
const selectedScope = ref<LedgerOverviewScope>('month')
const categoryScope = ref<LedgerOverviewScope>('month')
const categoryDateInput = ref('')
const periodNames: readonly LedgerPeriodName[] = ['today', 'week', 'month', 'year']
const periodDateInputs = ref<Record<LedgerPeriodName, string>>({ today: '', week: '', month: '', year: '' })

type LocalProjectionStatus = 'idle' | 'loading' | 'ready' | 'error'

type LocalProjectionState<T> = {
  requestedKey: string | null
  resolvedKey: string | null
  status: LocalProjectionStatus
  data: T | null
  error: unknown | null
}

function createProjectionState<T>(): LocalProjectionState<T> {
  return {
    requestedKey: null,
    resolvedKey: null,
    status: 'idle',
    data: null,
    error: null,
  }
}

function projectionKey(scope: LedgerOverviewScope, anchorDate: string | undefined): string {
  return `${scope}:${anchorDate ?? 'all'}`
}

function trendProjectionKey(anchorDate: string): string {
  return `trend:${anchorDate}`
}

function projectionIsReady<T>(projection: LocalProjectionState<T>): projection is LocalProjectionState<T> & {
  status: 'ready'
  data: T
  requestedKey: string
  resolvedKey: string
} {
  return projection.status === 'ready'
    && projection.data !== null
    && projection.requestedKey !== null
    && projection.resolvedKey === projection.requestedKey
}

function setProjectionReady<T>(projection: LocalProjectionState<T>, key: string, data: T): void {
  projection.requestedKey = key
  projection.resolvedKey = key
  projection.status = 'ready'
  projection.data = data
  projection.error = null
}

function startProjection<T>(projection: LocalProjectionState<T>, key: string): void {
  projection.requestedKey = key
  projection.resolvedKey = null
  projection.status = 'loading'
  projection.data = null
  projection.error = null
}

function setProjectionError<T>(projection: LocalProjectionState<T>, key: string, error: unknown): void {
  projection.requestedKey = key
  projection.resolvedKey = null
  projection.status = 'error'
  projection.data = null
  projection.error = error
}

const categoryProjection = reactive<LocalProjectionState<LedgerOverviewDto>>(createProjectionState())
const categoryRefreshing = computed(() => categoryProjection.status === 'loading')
const categoryDataReady = computed(() => projectionIsReady(categoryProjection))
const categoryOverview = computed(() => categoryDataReady.value ? categoryProjection.data : null)
let categoryRequestEpoch = 0

const trendDateInput = ref('')
const trendProjection = reactive<LocalProjectionState<readonly LedgerTrendPoint[]>>(createProjectionState())
const trendDataReady = computed(() => projectionIsReady(trendProjection))
const trendData = computed<readonly LedgerTrendPoint[]>(() => trendDataReady.value ? trendProjection.data ?? [] : [])
const trendRefreshing = computed(() => trendProjection.status === 'loading')
const trendError = computed(() => trendProjection.status === 'error' ? trendProjection.error : null)
let trendRequestEpoch = 0

const periodProjectionStates = reactive<Record<LedgerPeriodName, LocalProjectionState<LedgerOverviewDto>>>({
  today: createProjectionState<LedgerOverviewDto>(),
  week: createProjectionState<LedgerOverviewDto>(),
  month: createProjectionState<LedgerOverviewDto>(),
  year: createProjectionState<LedgerOverviewDto>(),
})
const periodRequestEpochs: Record<LedgerPeriodName, number> = { today: 0, week: 0, month: 0, year: 0 }
const historicalMode = computed(() => overview.value?.context.isToday === false
  || store.overviewRequestedAnchorDate.value !== undefined)
const scopeOptions = computed<SelectOption[]>(() => {
  const historical = historicalMode.value
  return [
    { value: 'today' as const, label: historical ? '当日' : '今天' },
    { value: 'week' as const, label: historical ? '所在周' : '本周' },
    { value: 'month' as const, label: historical ? '所在月' : '本月' },
    { value: 'year' as const, label: historical ? '所在年' : '今年' },
    { value: 'all', label: '全部' },
  ]
})

const refreshing = computed(() => store.overviewLoading.value)
const scopeError = computed(() => store.overviewError.value)
/**
 * The Current Snapshot stays on screen behind this error, so the copy must
 * stay inside the period boundary. The global Ledger formatter answers a
 * different question ("is Ledger usable at all?") and would tell the user the
 * whole workspace is unavailable while it is still showing current balances.
 */
const scopeErrorMessage = computed(() => (scopeError.value ? '这段期间的数据暂时无法加载。' : ''))
const periodDataReady = computed(() => overview.value !== null && store.overviewMatchesRequest.value)
const periodDataLoading = computed(() => refreshing.value && !periodDataReady.value && !scopeError.value)
const dateInputValue = computed(() => store.overviewRequestedAnchorDate.value
  ?? overview.value?.context.todayDate
  ?? '')
const dateMax = computed(() => overview.value?.context.todayDate ?? '')
const ledgerTimezone = computed(() => store.settings.value?.timezone ?? 'UTC')
const isDashboardDateDisabled = (timestamp: number, detail: { type: string }) => {
  if (!dateMax.value) return false
  const candidate = calendarDateFromNaivePickerTimestamp(timestamp)
  if (detail.type === 'year') return candidate.slice(0, 4) > dateMax.value.slice(0, 4)
  if (detail.type === 'month') return candidate.slice(0, 7) > dateMax.value.slice(0, 7)
  return candidate > dateMax.value
}

watch(() => store.overviewScope.value, (scope) => {
  selectedScope.value = scope
}, { immediate: true })

watch(selectedScope, (scope, previous) => {
  if (scope !== previous && scope !== store.overviewScope.value) {
    store.setOverviewRequestContext({
      scope,
      anchorDate: store.overviewRequestedAnchorDate.value,
    })
    void store.refreshOverview()
  }
})

const transactionAccountLabels = computed(() => new Map(
  store.accounts.value.map((account) => [
    account.id,
    account.archivedAt === null ? account.name : `${account.name}（已归档）`,
  ]),
))
const categoryNames = computed(() => new Map(
  store.categories.value.map((category) => [category.id, category.name]),
))
const selectedPeriodLabel = computed(() => scopeOptions.value.find((option) => option.value === selectedScope.value)?.label ?? '本月')
const categoryScopeOptions = computed<SelectOption[]>(() => [
  { value: 'today' as const, label: '天' },
  { value: 'week' as const, label: '周' },
  { value: 'month' as const, label: '月' },
  { value: 'year' as const, label: '年' },
  { value: 'all' as const, label: '全部' },
])
const categoryPickerType = computed(() => periodPickerTypes[categoryScope.value === 'all' ? 'today' : categoryScope.value])
const categoryPickerFormat = computed(() => periodPickerFormats[categoryScope.value === 'all' ? 'today' : categoryScope.value])
const selectedPeriods = computed(() => categoryOverview.value
  ? categoryOverview.value.categoryBreakdown
  : { income: [], expense: [] })
const selectedPeriodSummary = computed(() => periodDataReady.value ? overview.value?.cashflow ?? null : null)
const accountsByBalance = (nature: 'asset' | 'liability') => (overview.value?.accounts ?? [])
  .filter((account) => account.nature === nature)
  .sort((left, right) => right.currentBalanceMinor - left.currentBalanceMinor)
const assetAccounts = computed(() => accountsByBalance('asset'))
const liabilityAccounts = computed(() => accountsByBalance('liability'))
const dashboardAccountIcon = (account: { readonly id: string; readonly icon?: import('../../../shared/ledgerProtocol').LedgerAccountIcon }) =>
  account.icon ?? store.accounts.value.find((candidate) => candidate.id === account.id)?.icon

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

const periodLabels = computed<Record<LedgerPeriodName, string>>(() => ({
  today: historicalMode.value ? '当日' : '今天',
  week: historicalMode.value ? '所在周' : '本周',
  month: historicalMode.value ? '所在月' : '本月',
  year: historicalMode.value ? '所在年' : '今年',
}))
const periodPickerTypes: Record<LedgerPeriodName, 'date' | 'week' | 'month' | 'year'> = {
  today: 'date',
  week: 'week',
  month: 'month',
  year: 'year',
}
const periodPickerFormats: Record<LedgerPeriodName, string> = {
  today: 'yyyy-MM-dd',
  week: 'YYYY-w周',
  month: 'yyyy-MM',
  year: 'yyyy',
}

function accountLabel(id: string): string { return transactionAccountLabels.value.get(id) ?? '未知账户' }
function categoryLabel(id: string): string { return categoryNames.value.get(id) ?? '未知分类' }
function periodPickerTestId(period: LedgerPeriodName): string {
  return period === 'today' ? 'ledger-period-date' : `ledger-period-picker-${period}`
}

/**
 * Presentation-only share of the period total. The bar next to each row reads
 * from the same number, so the width can never disagree with the label.
 */
function categorySharePercent(items: readonly { amountMinor: number }[], amountMinor: number): number {
  const total = items.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n)
  if (total === 0n) return 0
  const roundedPercent = (BigInt(amountMinor) * 100n + total / 2n) / total
  return Math.min(100, Math.max(0, Number(roundedPercent)))
}

function categoryShare(items: readonly { amountMinor: number }[], amountMinor: number): string {
  return `${categorySharePercent(items, amountMinor)}%`
}

function transactionTitle(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income' || transaction.type === 'expense') {
    return transaction.payee || categoryLabel(transaction.categoryId)
  }
  if (transaction.type === 'transfer') return `${accountLabel(transaction.fromAccountId)} → ${accountLabel(transaction.toAccountId)}`
  return '余额调整'
}

function transactionMeta(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income' || transaction.type === 'expense') {
    return `${categoryLabel(transaction.categoryId)} · ${accountLabel(transaction.accountId)}`
  }
  if (transaction.type === 'transfer') {
    return transaction.transferKind === 'repayment'
      ? '还款'
      : transaction.transferKind === 'withdrawal' ? '提现' : '账户之间转账'
  }
  return accountLabel(transaction.accountId)
}

function transactionAmount(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income') return formatLedgerSignedMoney(transaction.amountMinor, store.settings.value?.baseCurrency ?? 'CNY')
  if (transaction.type === 'expense') return formatLedgerSignedMoney(-transaction.amountMinor, store.settings.value?.baseCurrency ?? 'CNY')
  return formatLedgerMoney(transaction.amountMinor, store.settings.value?.baseCurrency ?? 'CNY')
}

function transactionMark(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income') return '↑'
  if (transaction.type === 'expense') return '↓'
  if (transaction.type === 'transfer' && transaction.transferKind === 'repayment') return '↘'
  if (transaction.type === 'transfer') return '→'
  return '='
}

function presentationKind(transaction: LedgerTransactionDto): string {
  return ledgerTransactionPresentationKind(transaction)
}

function inspectTransaction(transaction: LedgerTransactionDto): void {
  emit('inspectTransaction', transaction)
}

function categoryTransactionFilters(categoryId: string): LedgerTransactionNavigationFilters | null {
  const projection = categoryOverview.value
  if (!projection) return null
  if (projection.context.scope === 'all') return { categoryId }

  const period = projection.periods.find((item) => item.period === projection.context.scope)
  if (!period) {
    console.error('Ledger category drill-down is missing its authoritative period range')
    return null
  }

  return {
    categoryId,
    ...ledgerDateFilterRangeFromPeriod(period.startAt, period.endAt, ledgerTimezone.value),
  }
}

function openCategoryTransactions(categoryId: string): void {
  const filters = categoryTransactionFilters(categoryId)
  if (!filters) return
  emit('viewTransactions', filters)
}

function onCategoryRowKeydown(event: KeyboardEvent, categoryId: string): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  openCategoryTransactions(categoryId)
}

function recentTransactionRowProps(transaction: LedgerTransactionDto) {
  return {
    class: 'ledger-recent-row',
    'data-testid': `ledger-recent-transaction-row-${transaction.id}`,
    role: 'button',
    tabindex: 0,
    'aria-label': `查看${transactionTitle(transaction)}交易详情`,
    onClick: () => inspectTransaction(transaction),
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        inspectTransaction(transaction)
      }
    },
  }
}

function periodSummary(period: LedgerPeriodName) {
  if (!periodDataReady.value) return null
  const projection = periodProjectionStates[period]
  if (!projectionIsReady(projection)) return null
  return projection.data.periods.find((item) => item.period === period) ?? null
}

function periodProjectionLoading(period: LedgerPeriodName): boolean {
  return periodProjectionStates[period].status === 'loading'
}

function periodProjectionError(period: LedgerPeriodName): boolean {
  return periodProjectionStates[period].status === 'error'
}

function retryScope(): void {
  void store.refreshOverview()
}

async function refreshCategory(scope: LedgerOverviewScope, anchorDate: string): Promise<void> {
  const requestedAnchor = scope === 'all' ? undefined : anchorDate
  const requestKey = projectionKey(scope, requestedAnchor)
  const epoch = ++categoryRequestEpoch
  startProjection(categoryProjection, requestKey)
  try {
    const result = await getLedgerOverview({
      scope,
      anchorDate: requestedAnchor,
    })
    if (epoch !== categoryRequestEpoch || categoryProjection.requestedKey !== requestKey) return
    const resolvedKey = projectionKey(
      result.context.scope,
      scope === 'all' ? undefined : result.context.anchorDate,
    )
    if (resolvedKey === requestKey) setProjectionReady(categoryProjection, requestKey, result)
    else setProjectionError(categoryProjection, requestKey, new Error('Ledger category response did not match the requested period.'))
  } catch (error) {
    if (epoch === categoryRequestEpoch && categoryProjection.requestedKey === requestKey) {
      setProjectionError(categoryProjection, requestKey, error)
    }
  }
}

let lastMainProjectionKey: string | null = null
watch([dateInputValue, () => store.overviewScope.value, overview], ([value, scope, currentOverview]) => {
  if (!value || !currentOverview) return

  const requestedAnchor = store.overviewRequestedAnchorDate.value
    ?? (scope === 'all' ? undefined : value)
  const mainProjectionKey = projectionKey(scope, requestedAnchor)
  const mainContextChanged = mainProjectionKey !== lastMainProjectionKey

  for (const period of periodNames) {
    const projection = periodProjectionStates[period]
    if (mainContextChanged) {
      periodDateInputs.value[period] = value
      periodRequestEpochs[period] += 1
      setProjectionReady(projection, mainProjectionKey, currentOverview)
    } else if (periodDateInputs.value[period] === value && projection.requestedKey === mainProjectionKey) {
      // A mutation refresh replaces the main Overview object without changing
      // its request key. Rehydrate only cards still showing that main key; a
      // card with an independent local date remains untouched.
      periodRequestEpochs[period] += 1
      setProjectionReady(projection, mainProjectionKey, currentOverview)
    }
  }

  if (!categoryDateInput.value) {
    categoryDateInput.value = value
    if (categoryScope.value === scope) {
      categoryRequestEpoch += 1
      setProjectionReady(categoryProjection, projectionKey(scope, requestedAnchor), currentOverview)
    }
  } else if (categoryDateInput.value === value && categoryProjection.requestedKey === mainProjectionKey) {
    categoryRequestEpoch += 1
    setProjectionReady(categoryProjection, mainProjectionKey, currentOverview)
  }

  const mainTrendKey = trendProjectionKey(value)
  if (!trendDateInput.value) {
    trendDateInput.value = value
    trendRequestEpoch += 1
    setProjectionReady(trendProjection, mainTrendKey, currentOverview.trend)
  } else if (trendDateInput.value === value && trendProjection.requestedKey === mainTrendKey) {
    trendRequestEpoch += 1
    setProjectionReady(trendProjection, mainTrendKey, currentOverview.trend)
  }

  lastMainProjectionKey = mainProjectionKey
}, { immediate: true })

watch([categoryScope, categoryDateInput], ([scope, anchorDate]) => {
  const requestedAnchor = scope === 'all' ? undefined : anchorDate
  if (requestedAnchor || scope === 'all') {
    const requestKey = projectionKey(scope, requestedAnchor)
    if (categoryDataReady.value
      && categoryProjection.requestedKey === requestKey
      && categoryProjection.resolvedKey === requestKey) return
    void refreshCategory(scope, anchorDate)
  }
}, { immediate: true })

async function refreshTrend(anchorDate: string): Promise<void> {
  const requestKey = trendProjectionKey(anchorDate)
  const epoch = ++trendRequestEpoch
  startProjection(trendProjection, requestKey)
  try {
    const result = await getLedgerTrend(12, anchorDate)
    if (epoch === trendRequestEpoch && trendProjection.requestedKey === requestKey) {
      setProjectionReady(trendProjection, requestKey, result)
    }
  } catch (error) {
    if (epoch === trendRequestEpoch && trendProjection.requestedKey === requestKey) {
      setProjectionError(trendProjection, requestKey, error)
    }
  }
}

watch(trendDateInput, (value, previous) => {
  if (value && previous && value !== previous) void refreshTrend(value)
})

function updateScope(value: string | number | null): void {
  if (typeof value !== 'string' || !scopeOptions.value.some((option) => option.value === value)) return
  selectedScope.value = value as LedgerOverviewScope
}

function updateCategoryScope(value: string | number | null): void {
  if (typeof value !== 'string' || !categoryScopeOptions.value.some((option) => option.value === value)) return
  categoryScope.value = value as LedgerOverviewScope
}

function updateCategoryDate(value: string): void {
  if (value) categoryDateInput.value = value
}

function updateTrendDate(value: string): void {
  if (!value) return
  const year = value.slice(0, 4)
  trendDateInput.value = year === dateMax.value.slice(0, 4)
    ? dateMax.value
    : `${year}-12-31`
}

async function refreshPeriodSummary(period: LedgerPeriodName, anchorDate: string): Promise<void> {
  const scope = store.overviewScope.value
  const requestKey = projectionKey(scope, anchorDate)
  const epoch = ++periodRequestEpochs[period]
  startProjection(periodProjectionStates[period], requestKey)
  try {
    const result = await getLedgerOverview({ scope, anchorDate })
    if (epoch !== periodRequestEpochs[period]) return
    const projection = periodProjectionStates[period]
    if (projection.requestedKey !== requestKey) return
    const resolvedKey = projectionKey(result.context.scope, result.context.anchorDate)
    if (resolvedKey === requestKey) setProjectionReady(projection, requestKey, result)
    else setProjectionError(projection, requestKey, new Error('Ledger period response did not match the requested date.'))
  } catch (error) {
    const projection = periodProjectionStates[period]
    if (epoch === periodRequestEpochs[period] && projection.requestedKey === requestKey) {
      setProjectionError(projection, requestKey, error)
    }
  }
}

function onDateChange(period: LedgerPeriodName, value: string): void {
  if (value && value !== periodDateInputs.value[period]) {
    periodDateInputs.value[period] = value
    void refreshPeriodSummary(period, value)
  }
}

function retryPeriodSummary(period: LedgerPeriodName): void {
  const anchorDate = periodDateInputs.value[period]
  if (anchorDate) void refreshPeriodSummary(period, anchorDate)
}

function retryCategory(): void {
  void refreshCategory(categoryScope.value, categoryDateInput.value)
}

function retryTrend(): void {
  if (trendDateInput.value) void refreshTrend(trendDateInput.value)
}

type MetricKey = 'assets' | 'liabilities' | 'netWorth'
const metricAnimationFrom = reactive<Record<MetricKey, number | null>>({
  assets: 0,
  liabilities: 0,
  netWorth: 0,
})
let metricAnimationResetTimer: ReturnType<typeof setTimeout> | undefined

watch(overview, (next, previous) => {
  if (!next) return
  if (!previous) {
    return
  }
  if (next.currency !== previous.currency) {
    metricAnimationFrom.assets = next.assetTotalMinor
    metricAnimationFrom.liabilities = next.liabilityTotalMinor
    metricAnimationFrom.netWorth = next.netWorthMinor
    return
  }
  metricAnimationFrom.assets = previous.assetTotalMinor
  metricAnimationFrom.liabilities = previous.liabilityTotalMinor
  metricAnimationFrom.netWorth = previous.netWorthMinor
  if (metricAnimationResetTimer) clearTimeout(metricAnimationResetTimer)
  metricAnimationResetTimer = setTimeout(() => {
    metricAnimationFrom.assets = null
    metricAnimationFrom.liabilities = null
    metricAnimationFrom.netWorth = null
  }, 700)
})

onBeforeUnmount(() => {
  if (metricAnimationResetTimer) clearTimeout(metricAnimationResetTimer)
})

function animatedMoneyParts(minor: number, currency: string, key: MetricKey): { prefix: string; value: number; from: number; precision: number } {
  const precision = currencyExponentFor(currency)
  const currencyPart = new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    currencyDisplay: 'symbol',
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency
  return {
    prefix: minor < 0 ? `-${currencyPart}` : currencyPart,
    value: Math.abs(minor) / (10 ** precision),
    from: Math.abs(metricAnimationFrom[key] ?? minor) / (10 ** precision),
    precision,
  }
}
</script>

<template>
  <section class="ledger-dashboard" data-testid="ledger-dashboard" :aria-busy="refreshing ? 'true' : undefined">
    <header class="ledger-dashboard-header">
      <div>
        <p class="ledger-eyebrow">Ledger</p>
        <h1>财务概览</h1>
        <p v-if="store.settings.value">{{ store.settings.value.baseCurrency }} · {{ store.settings.value.timezone }}</p>
      </div>
      <NFlex class="ledger-dashboard-actions" align="center" :wrap="true" :size="10">
        <RouterLink class="ledger-secondary-button" :to="{ name: 'ledger-accounts' }">管理账户</RouterLink>
        <NButton class="ledger-primary-button" attr-type="button" type="primary" size="small" :bordered="false" :disabled="!store.activeAccounts.value.length" data-testid="ledger-record-button" @click="emit('record')">＋ 记一笔</NButton>
      </NFlex>
    </header>

    <template v-if="overview">
      <section class="ledger-metric-grid" aria-label="资产概览">
        <NCard class="ledger-metric-card" data-testid="ledger-total-assets" size="small">
          <div class="ledger-metric-layout">
            <span class="ledger-metric-icon" aria-hidden="true">
              <NIcon aria-hidden="true" :size="22"><Wallet /></NIcon>
            </span>
            <span class="ledger-metric-copy">
              <NStatistic label="总资产" tabular-nums>
                <template #prefix>{{ animatedMoneyParts(overview.assetTotalMinor, overview.currency, 'assets').prefix }}</template>
                <NNumberAnimation :from="animatedMoneyParts(overview.assetTotalMinor, overview.currency, 'assets').from" :to="animatedMoneyParts(overview.assetTotalMinor, overview.currency, 'assets').value" :precision="animatedMoneyParts(overview.assetTotalMinor, overview.currency, 'assets').precision" show-separator :duration="2000" />
              </NStatistic>
            </span>
          </div>
        </NCard>
        <NCard class="ledger-metric-card" data-testid="ledger-total-liabilities" size="small">
          <div class="ledger-metric-layout">
            <span class="ledger-metric-icon" aria-hidden="true">
              <NIcon aria-hidden="true" :size="22"><CreditCard /></NIcon>
            </span>
            <span class="ledger-metric-copy">
              <NStatistic label="总负债" tabular-nums>
                <template #prefix>{{ animatedMoneyParts(overview.liabilityTotalMinor, overview.currency, 'liabilities').prefix }}</template>
                <NNumberAnimation :from="animatedMoneyParts(overview.liabilityTotalMinor, overview.currency, 'liabilities').from" :to="animatedMoneyParts(overview.liabilityTotalMinor, overview.currency, 'liabilities').value" :precision="animatedMoneyParts(overview.liabilityTotalMinor, overview.currency, 'liabilities').precision" show-separator :duration="2000" />
              </NStatistic>
            </span>
          </div>
        </NCard>
        <NCard class="ledger-metric-card is-primary" data-testid="ledger-net-worth" size="small">
          <div class="ledger-metric-layout">
            <span class="ledger-metric-icon" aria-hidden="true">
              <NIcon aria-hidden="true" :size="22"><Scale /></NIcon>
            </span>
            <span class="ledger-metric-copy">
              <NStatistic label="净资产" tabular-nums>
                <template #prefix>{{ animatedMoneyParts(overview.netWorthMinor, overview.currency, 'netWorth').prefix }}</template>
                <NNumberAnimation :from="animatedMoneyParts(overview.netWorthMinor, overview.currency, 'netWorth').from" :to="animatedMoneyParts(overview.netWorthMinor, overview.currency, 'netWorth').value" :precision="animatedMoneyParts(overview.netWorthMinor, overview.currency, 'netWorth').precision" show-separator :duration="2000" />
              </NStatistic>
            </span>
          </div>
        </NCard>
      </section>

      <NCard class="ledger-dashboard-section ledger-cashflow-section" :bordered="false" size="small" aria-labelledby="ledger-dashboard-cashflow-title">
        <NFlex class="ledger-section-heading ledger-period-heading" align="flex-start" justify="space-between" :size="18">
          <div class="ledger-period-heading-copy">
            <h2 id="ledger-dashboard-cashflow-title">{{ selectedPeriodLabel }}概览</h2>
            <p v-if="historicalMode" class="ledger-historical-hint" role="note">
              {{ formatLedgerDate(dateInputValue, ledgerTimezone) }} · 账户余额为当前值
            </p>
          </div>
          <NFlex class="ledger-period-toolbar" align="center" :size="10">
            <NSelect
              class="ledger-period-scope"
              size="small"
              :value="selectedScope"
              :options="scopeOptions"
              :node-props="ledgerSelectNodeProps"
              aria-label="选择收支期间"
              aria-haspopup="listbox"
              role="combobox"
              :input-props="{ name: 'scope' }"
              @update:value="updateScope"
            />
          </NFlex>
        </NFlex>
        <NAlert v-if="scopeError" class="ledger-inline-error" type="error" :show-icon="false" role="alert">
          <span>{{ scopeErrorMessage }}</span>
          <NButton class="ledger-link-button" attr-type="button" size="small" text :bordered="false" @click="retryScope">重试</NButton>
        </NAlert>
        <div v-if="periodDataLoading" class="ledger-period-analysis-loading" data-testid="ledger-period-analysis-loading" role="status" aria-live="polite">
          <NSpin size="medium" description="正在加载所选期间…" />
        </div>
        <div v-else-if="selectedPeriodSummary" class="ledger-cashflow-grid" data-testid="ledger-dashboard-cashflow">
          <div>
            <span class="ledger-cashflow-mark is-income" aria-hidden="true">↑</span>
            <span class="ledger-cashflow-copy"><span>收入</span><strong class="is-income"><LedgerAnimatedMoney :minor="selectedPeriodSummary.incomeMinor" :currency="overview.currency" animate-on-mount /></strong></span>
          </div>
          <div>
            <span class="ledger-cashflow-mark is-expense" aria-hidden="true">↓</span>
            <span class="ledger-cashflow-copy"><span>支出</span><strong class="is-expense"><LedgerAnimatedMoney :minor="selectedPeriodSummary.expenseMinor" :currency="overview.currency" animate-on-mount /></strong></span>
          </div>
          <div>
            <span class="ledger-cashflow-mark is-repayment" aria-hidden="true">↘</span>
            <span class="ledger-cashflow-copy"><span>还款</span><strong class="is-repayment"><LedgerAnimatedMoney :minor="selectedPeriodSummary.repaymentMinor" :currency="overview.currency" animate-on-mount /></strong></span>
          </div>
          <div>
            <span class="ledger-cashflow-mark is-balance" aria-hidden="true">=</span>
            <span class="ledger-cashflow-copy"><span>结余</span><strong class="is-balance"><LedgerAnimatedMoney :minor="ledgerPresentationBalanceMinor(selectedPeriodSummary)" :currency="overview.currency" animate-on-mount /></strong></span>
          </div>
        </div>
      </NCard>

      <NCard class="ledger-dashboard-section" data-testid="ledger-dashboard-accounts" :bordered="false" size="small" aria-labelledby="ledger-dashboard-accounts-title">
        <NFlex class="ledger-section-heading" align="flex-start" justify="space-between" :size="18">
          <div>
            <h2 id="ledger-dashboard-accounts-title">账户</h2>
          </div>
          <RouterLink :to="{ name: 'ledger-accounts' }">查看全部</RouterLink>
        </NFlex>
        <div class="ledger-dashboard-account-viewport" data-testid="ledger-dashboard-account-viewport">
          <div class="ledger-dashboard-account-groups">
            <section class="ledger-dashboard-account-group" data-testid="ledger-dashboard-assets" aria-labelledby="ledger-dashboard-assets-title">
              <h3 id="ledger-dashboard-assets-title">
                <span><i class="is-asset" aria-hidden="true" />资产账户 <small>(<NNumberAnimation :from="0" :to="assetAccounts.length" :duration="2000" />)</small></span>
                <strong><LedgerAnimatedMoney :minor="overview.assetTotalMinor" :currency="overview.currency" animate-on-mount /></strong>
              </h3>
              <div v-if="assetAccounts.length" class="ledger-dashboard-account-list-viewport" data-testid="ledger-dashboard-assets-viewport" @scroll="showScrollbarWhileScrolling">
                <NList class="ledger-dashboard-accounts" :show-divider="false" hoverable>
                  <NListItem v-for="account in assetAccounts" :key="account.id" class="ledger-dashboard-account-item">
                      <RouterLink class="ledger-dashboard-account" :to="{ name: 'ledger-account', params: { id: account.id }, query: { from: 'overview' } }">
                      <span class="ledger-account-identity">
                        <span class="ledger-account-icon is-asset" aria-hidden="true">
                          <LedgerAccountIcon :icon="dashboardAccountIcon(account)" :size="17" />
                        </span>
                        <span>
                          <strong>{{ account.name }}</strong>
                          <small>资产 · {{ account.currency }}</small>
                        </span>
                      </span>
                      <strong class="ledger-account-amount"><LedgerAnimatedMoney :minor="account.currentBalanceMinor" :currency="account.currency" /></strong>
                    </RouterLink>
                  </NListItem>
                </NList>
              </div>
              <NEmpty v-else class="ledger-inline-empty" size="small" :show-icon="false" description="还没有资产账户。" />
            </section>
            <section class="ledger-dashboard-account-group" data-testid="ledger-dashboard-liabilities" aria-labelledby="ledger-dashboard-liabilities-title">
              <h3 id="ledger-dashboard-liabilities-title">
                <span><i class="is-liability" aria-hidden="true" />负债账户 <small>(<NNumberAnimation :from="0" :to="liabilityAccounts.length" :duration="2000" />)</small></span>
                <strong><LedgerAnimatedMoney :minor="overview.liabilityTotalMinor" :currency="overview.currency" animate-on-mount /></strong>
              </h3>
              <div v-if="liabilityAccounts.length" class="ledger-dashboard-account-list-viewport" data-testid="ledger-dashboard-liabilities-viewport" @scroll="showScrollbarWhileScrolling">
                <NList class="ledger-dashboard-accounts" :show-divider="false" hoverable>
                  <NListItem v-for="account in liabilityAccounts" :key="account.id" class="ledger-dashboard-account-item">
                      <RouterLink class="ledger-dashboard-account" :to="{ name: 'ledger-account', params: { id: account.id }, query: { from: 'overview' } }">
                      <span class="ledger-account-identity">
                        <span class="ledger-account-icon is-liability" aria-hidden="true">
                          <LedgerAccountIcon :icon="dashboardAccountIcon(account)" :size="17" />
                        </span>
                        <span>
                          <strong>{{ account.name }}</strong>
                          <small>负债 · {{ account.currency }}</small>
                        </span>
                      </span>
                      <strong class="ledger-account-amount"><LedgerAnimatedMoney :minor="account.currentBalanceMinor" :currency="account.currency" /></strong>
                    </RouterLink>
                  </NListItem>
                </NList>
              </div>
              <NEmpty v-else class="ledger-inline-empty" size="small" :show-icon="false" description="还没有负债账户。" />
            </section>
          </div>
        </div>
      </NCard>

      <template v-if="periodDataReady">
      <div class="ledger-dashboard-two-column">
        <NCard class="ledger-dashboard-section" :bordered="false" size="small" aria-labelledby="ledger-category-breakdown-title">
          <NFlex class="ledger-section-heading" align="flex-start" justify="space-between" :size="18">
            <h2 id="ledger-category-breakdown-title">收支分类</h2>
            <NFlex class="ledger-category-toolbar" align="center" :wrap="true" :size="10">
              <NSelect
                class="ledger-category-scope"
                size="small"
                :value="categoryScope"
                :options="categoryScopeOptions"
                :node-props="ledgerSelectNodeProps"
                aria-label="选择统计期间"
                aria-haspopup="listbox"
                role="combobox"
                :input-props="{ name: 'categoryScope' }"
                :loading="categoryRefreshing"
                @update:value="updateCategoryScope"
              />
              <LedgerDatePicker
                :key="categoryPickerType"
                class="ledger-category-date"
                :model-value="categoryDateInput"
                label="选择统计时间"
                :type="categoryPickerType"
                :format="categoryPickerFormat"
                size="small"
                test-id="ledger-category-date"
                :disabled="categoryScope === 'all'"
                :is-date-disabled="isDashboardDateDisabled"
                @update:model-value="updateCategoryDate"
              />
            </NFlex>
          </NFlex>
          <div v-if="categoryRefreshing" class="ledger-period-analysis-loading" data-testid="ledger-category-analysis-loading" role="status" aria-live="polite">
            <NSpin size="medium" description="正在加载所选期间…" />
          </div>
          <NAlert v-else-if="categoryProjection.status === 'error'" class="ledger-inline-error" data-testid="ledger-category-error" type="error" :show-icon="false" role="alert">
            <span>这段期间的数据暂时无法加载。</span>
            <NButton class="ledger-link-button" attr-type="button" size="small" text :bordered="false" @click="retryCategory">重试</NButton>
          </NAlert>
          <div v-else-if="categoryDataReady" class="ledger-breakdown-columns" data-testid="ledger-category-breakdown">
            <div>
              <h3><i class="is-income" aria-hidden="true" />收入分类</h3>
              <div v-if="selectedPeriods.income.length" class="ledger-breakdown-list-viewport" data-testid="ledger-income-breakdown-viewport" @scroll="showScrollbarWhileScrolling">
                <NList class="ledger-breakdown-list" :show-divider="false">
                  <NListItem v-for="item in selectedPeriods.income" :key="item.categoryId" class="ledger-breakdown-list-item">
                    <div
                      class="ledger-breakdown-row"
                      role="button"
                      tabindex="0"
                      :data-testid="`ledger-category-row-${item.categoryId}`"
                      :aria-label="`查看${item.name}分类交易`"
                      @click="openCategoryTransactions(item.categoryId)"
                      @keydown="onCategoryRowKeydown($event, item.categoryId)"
                    >
                      <span class="ledger-breakdown-label">
                        <span class="ledger-breakdown-name">{{ item.name }}</span>
                        <span class="ledger-breakdown-share">{{ categoryShare(selectedPeriods.income, item.amountMinor) }}</span>
                      </span>
                      <strong class="ledger-breakdown-amount"><LedgerAnimatedMoney :minor="item.amountMinor" :currency="overview.currency" /></strong>
                      <span class="ledger-breakdown-bar" aria-hidden="true">
                        <span
                          class="ledger-breakdown-bar-fill is-income"
                          :style="{ width: `${categorySharePercent(selectedPeriods.income, item.amountMinor)}%` }"
                        />
                      </span>
                    </div>
                  </NListItem>
                </NList>
              </div>
              <NEmpty v-else class="ledger-inline-empty" size="small" :show-icon="false" description="这段期间还没有收入分类。" />
            </div>
            <div>
              <h3><i class="is-expense" aria-hidden="true" />支出分类</h3>
              <div v-if="selectedPeriods.expense.length" class="ledger-breakdown-list-viewport" data-testid="ledger-expense-breakdown-viewport" @scroll="showScrollbarWhileScrolling">
                <NList class="ledger-breakdown-list" :show-divider="false">
                  <NListItem v-for="item in selectedPeriods.expense" :key="item.categoryId" class="ledger-breakdown-list-item">
                    <div
                      class="ledger-breakdown-row"
                      role="button"
                      tabindex="0"
                      :data-testid="`ledger-category-row-${item.categoryId}`"
                      :aria-label="`查看${item.name}分类交易`"
                      @click="openCategoryTransactions(item.categoryId)"
                      @keydown="onCategoryRowKeydown($event, item.categoryId)"
                    >
                      <span class="ledger-breakdown-label">
                        <span class="ledger-breakdown-name">{{ item.name }}</span>
                        <span class="ledger-breakdown-share">{{ categoryShare(selectedPeriods.expense, item.amountMinor) }}</span>
                      </span>
                      <strong class="ledger-breakdown-amount"><LedgerAnimatedMoney :minor="item.amountMinor" :currency="overview.currency" /></strong>
                      <span class="ledger-breakdown-bar" aria-hidden="true">
                        <span
                          class="ledger-breakdown-bar-fill is-expense"
                          :style="{ width: `${categorySharePercent(selectedPeriods.expense, item.amountMinor)}%` }"
                        />
                      </span>
                    </div>
                  </NListItem>
                </NList>
              </div>
              <NEmpty v-else class="ledger-inline-empty" size="small" :show-icon="false" description="这段期间还没有支出分类。" />
            </div>
          </div>
        </NCard>

        <NCard class="ledger-dashboard-section" :bordered="false" size="small" aria-labelledby="ledger-recent-title">
          <NFlex class="ledger-section-heading" align="flex-start" justify="space-between" :size="18">
            <div>
              <h2 id="ledger-recent-title">最近交易</h2>
              <p v-if="historicalMode">截至 {{ formatLedgerDate(dateInputValue, ledgerTimezone) }}</p>
            </div>
            <NButton class="ledger-link-button" attr-type="button" size="small" text :bordered="false" @click="emit('viewTransactions')">查看全部</NButton>
          </NFlex>
          <NList v-if="overview.recentTransactions.length" class="ledger-recent-list" data-testid="ledger-recent-transactions" :show-divider="false" hoverable>
            <NListItem v-for="transaction in overview.recentTransactions" :key="transaction.id">
              <div v-bind="recentTransactionRowProps(transaction)">
                <span :class="['ledger-recent-icon', `is-${presentationKind(transaction)}`]" aria-hidden="true">{{ transactionMark(transaction) }}</span>
                <span class="ledger-recent-info"><strong>{{ transactionTitle(transaction) }}</strong><small>{{ transactionMeta(transaction) }} · {{ formatLedgerDateTime(transaction.occurredAt, store.settings.value?.timezone ?? 'UTC') }}</small></span>
                <strong :class="['ledger-recent-amount', `is-${presentationKind(transaction)}`]">{{ transactionAmount(transaction) }}</strong>
              </div>
            </NListItem>
          </NList>
          <NEmpty v-else class="ledger-inline-empty" data-testid="ledger-recent-empty" size="small" :show-icon="false" :description="historicalMode ? '截至该日期还没有交易记录。' : '还没有交易记录。'">
            <template v-if="!historicalMode" #extra>
              <NButton class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" @click="emit('record')">记下第一笔</NButton>
            </template>
          </NEmpty>
        </NCard>
      </div>
      </template>

      <NCard class="ledger-dashboard-section" :bordered="false" size="small" aria-labelledby="ledger-periods-title">
        <NFlex class="ledger-section-heading" align="flex-start" justify="space-between" :size="18">
          <h2 id="ledger-periods-title">期间摘要</h2>
        </NFlex>
        <div v-if="periodDataReady" class="ledger-period-grid" data-testid="ledger-period-summaries">
          <NCard v-for="period in (['today', 'week', 'month', 'year'] as const)" :key="period" class="ledger-period-card" :data-testid="`ledger-period-${period}`" :bordered="false" size="small">
            <div class="ledger-period-card-heading">
              <h3>{{ periodLabels[period] }}</h3>
              <div v-if="periodDateInputs[period]" class="ledger-period-date-control" :data-testid="`ledger-period-date-control-${period}`">
                <span class="ledger-period-date-label">{{ formatLedgerPeriodPickerLabel(period, periodDateInputs[period]) }}</span>
                <div class="ledger-period-date-editor">
                  <LedgerDatePicker
                    :model-value="periodDateInputs[period]"
                    :type="periodPickerTypes[period]"
                    :format="periodPickerFormats[period]"
                    :label="`${periodLabels[period]}日期`"
                    size="small"
                    :test-id="periodPickerTestId(period)"
                    :is-date-disabled="isDashboardDateDisabled"
                    @update:model-value="onDateChange(period, $event)"
                  />
                </div>
              </div>
            </div>
            <div v-if="periodSummary(period)" class="ledger-period-values">
              <span>收入 <strong class="is-income"><LedgerAnimatedMoney :minor="periodSummary(period)!.incomeMinor" :currency="overview.currency" /></strong></span>
              <span>支出 <strong class="is-expense"><LedgerAnimatedMoney :minor="periodSummary(period)!.expenseMinor" :currency="overview.currency" /></strong></span>
              <span>还款 <strong class="is-repayment"><LedgerAnimatedMoney :minor="periodSummary(period)!.repaymentMinor" :currency="overview.currency" /></strong></span>
              <span>结余 <strong class="is-balance"><LedgerAnimatedMoney :minor="ledgerPresentationBalanceMinor(periodSummary(period)!)" :currency="overview.currency" /></strong></span>
            </div>
            <div v-else-if="periodProjectionLoading(period)" class="ledger-period-local-state" :data-testid="`ledger-period-loading-${period}`" role="status" aria-live="polite">
              <NSpin size="small" />
              <span>正在加载…</span>
            </div>
            <div v-else-if="periodProjectionError(period)" class="ledger-period-local-state is-error" :data-testid="`ledger-period-error-${period}`" role="alert">
              <span>该期间数据暂时无法加载</span>
              <NButton class="ledger-link-button" attr-type="button" size="small" text :bordered="false" @click="retryPeriodSummary(period)">重试</NButton>
            </div>
          </NCard>
        </div>
        <div v-else class="ledger-period-summary-loading" data-testid="ledger-period-summary-loading" role="status" aria-live="polite">
          <NSpin size="small" description="正在加载期间摘要…" />
        </div>
      </NCard>

      <template v-if="periodDataReady">
      <NCard class="ledger-dashboard-section" :bordered="false" size="small" aria-labelledby="ledger-trend-title">
        <NFlex class="ledger-section-heading" align="flex-start" justify="space-between" :size="18">
          <div>
            <h2 id="ledger-trend-title">收支趋势</h2>
            <p v-if="trendDataReady && trendData.length">最近 {{ trendData.length }} 个月</p>
          </div>
          <LedgerDatePicker
            class="ledger-trend-date"
            :model-value="trendDateInput"
            label="选择趋势时间"
            type="year"
            format="yyyy"
            size="small"
            test-id="ledger-trend-date"
            :is-date-disabled="isDashboardDateDisabled"
            @update:model-value="updateTrendDate"
          />
        </NFlex>
        <div v-if="trendRefreshing" class="ledger-period-analysis-loading" data-testid="ledger-trend-loading" role="status" aria-live="polite">
          <NSpin size="medium" description="正在加载趋势数据…" />
        </div>
        <NAlert v-else-if="trendError" class="ledger-inline-error" data-testid="ledger-trend-error" type="error" :show-icon="false" role="alert">
          <span>趋势数据暂时无法加载。</span>
          <NButton class="ledger-link-button" attr-type="button" size="small" text :bordered="false" @click="retryTrend">重试</NButton>
        </NAlert>
        <LedgerCashflowTrend v-show="trendDataReady" :trend="trendData" :currency="overview.currency" />
      </NCard>
      </template>
    </template>
  </section>
</template>

<style scoped>
.ledger-dashboard {
  --ledger-border: color-mix(in srgb, var(--border) 76%, transparent);
  --ledger-divider: color-mix(in srgb, var(--border) 58%, transparent);
  --ledger-glass-surface: color-mix(in srgb, var(--bg-soft) 74%, transparent);
  --ledger-glass-tint: color-mix(in srgb, var(--accent) 3%, transparent);
  --ledger-glass-highlight: color-mix(in srgb, var(--text-h) 9%, transparent);
  --ledger-glass-shadow: color-mix(in srgb, var(--text-h) 8%, transparent);
  --ledger-row-hover: color-mix(in srgb, var(--accent) 5%, transparent);
  --ledger-income: color-mix(in srgb, #15945f 82%, var(--text-h));
  --ledger-expense: color-mix(in srgb, #dc3f4d 82%, var(--text-h));
  --ledger-transfer: var(--nuvyn-info, #005fb8);
  --ledger-balance: var(--nuvyn-info);
  width: min(100%, 1240px);
  margin: 0 auto;
  padding: 42px 28px 24px;
  box-sizing: border-box;
}

.ledger-dashboard-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 28px;
  margin-bottom: 28px;
}

.ledger-eyebrow {
  margin: 0 0 7px;
  color: var(--accent);
  font-size: .7rem;
  font-weight: 750;
  letter-spacing: .1em;
  text-transform: uppercase;
}

.ledger-dashboard-header h1 {
  margin: 0;
  color: var(--text-h);
  font-size: clamp(1.85rem, 3vw, 2.35rem);
  font-weight: 720;
  letter-spacing: -.035em;
  line-height: 1.16;
}

.ledger-dashboard-header p:not(.ledger-eyebrow) {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: .78rem;
}

.ledger-dashboard-actions {
  display: flex;
  align-items: center;
  justify-self: end;
  flex-wrap: wrap;
  gap: 10px;
}

.ledger-primary-button,
.ledger-secondary-button {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 6px 12px;
  border-radius: 8px;
  font: inherit;
  font-size: .78rem;
  font-weight: 650;
  text-decoration: none;
  cursor: pointer;
  transition: border-color .16s ease, background-color .16s ease, color .16s ease;
}

.ledger-primary-button {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
}

.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }

.ledger-secondary-button {
  border: 1px solid var(--ledger-border);
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  color: var(--text-h);
}

.ledger-secondary-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 58%, var(--border));
  color: var(--accent);
}

.ledger-primary-button:focus-visible,
.ledger-secondary-button:focus-visible,
.ledger-link-button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 70%, transparent);
  outline-offset: 2px;
}

.ledger-primary-button:disabled,
.ledger-secondary-button:disabled {
  cursor: wait;
  opacity: .62;
}

.ledger-link-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: .77rem;
  cursor: pointer;
}

.ledger-link-button:hover { text-decoration: underline; }

.ledger-inline-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 18px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--ledger-expense) 30%, var(--ledger-border));
  border-radius: 8px;
  color: var(--ledger-expense);
  font-size: .8rem;
}

.ledger-metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.ledger-metric-card {
  min-height: 84px;
  box-sizing: border-box;
  border: 1px solid var(--ledger-border);
  border-radius: 12px;
  background:
    linear-gradient(135deg, var(--ledger-glass-tint), transparent 58%),
    var(--ledger-glass-surface);
  box-shadow:
    inset 0 1px 0 var(--ledger-glass-highlight),
    0 8px 24px var(--ledger-glass-shadow);
  -webkit-backdrop-filter: saturate(145%) blur(18px);
  backdrop-filter: saturate(145%) blur(18px);
}

.ledger-metric-card :deep(.n-card__content) { padding: 0; }

.ledger-metric-layout {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 84px;
  padding: 10px 16px;
  box-sizing: border-box;
}

.ledger-metric-icon {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 13px;
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-soft));
  color: color-mix(in srgb, var(--accent) 76%, var(--text-h));
}

.ledger-metric-card.is-primary .ledger-metric-icon {
  background: color-mix(in srgb, var(--accent) 20%, var(--bg));
}

.ledger-metric-copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.ledger-metric-copy > span {
  color: var(--text-muted);
  font-size: .76rem;
}

.ledger-metric-copy strong {
  overflow: hidden;
  color: var(--text-h);
  font-size: clamp(1.25rem, 2vw, 1.55rem);
  font-variant-numeric: tabular-nums;
  letter-spacing: -.02em;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ledger-dashboard-section {
  margin-top: 22px;
  border: 1px solid var(--ledger-border);
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

.ledger-dashboard-section :deep(.n-card__content) { padding: 20px; }

.ledger-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 15px;
}

.ledger-section-heading h2 {
  margin: 0;
  color: var(--text-h);
  font-size: 1rem;
  font-weight: 680;
  letter-spacing: -.01em;
}

.ledger-section-heading p {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: .73rem;
  line-height: 1.45;
}

.ledger-section-heading > a {
  flex: 0 0 auto;
  color: var(--accent);
  font-size: .77rem;
  text-decoration: none;
}

.ledger-period-heading { align-items: flex-start; }
.ledger-period-heading-copy { min-width: 0; }

.ledger-period-toolbar {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.ledger-period-scope {
  width: 96px;
  opacity: 0;
  pointer-events: auto;
  transition: opacity .14s ease;
}
.ledger-period-scope:hover,
.ledger-period-scope:focus-within {
  opacity: 1;
}
.ledger-category-scope {
  width: 72px;
  opacity: 0;
  pointer-events: auto;
  transition: opacity .14s ease;
}
.ledger-category-toolbar {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 6px;
}
.ledger-category-scope:hover,
.ledger-category-scope:focus-within {
  opacity: 1;
}
.ledger-category-date {
  width: 148px;
  opacity: 0;
  pointer-events: auto;
  transition: opacity .14s ease;
}
.ledger-category-date:hover,
.ledger-category-date:focus-within {
  opacity: 1;
}
.ledger-category-date :deep(.n-input) { width: 148px; }
.ledger-trend-date {
  width: 96px;
  opacity: 0;
  pointer-events: auto;
  transition: opacity .14s ease;
}
.ledger-trend-date:hover,
.ledger-trend-date:focus-within {
  opacity: 1;
}
.ledger-trend-date :deep(.n-input) { width: 96px; }
.ledger-period-toolbar :deep(.ledger-period-scope .n-base-selection) { width: 96px; }

.ledger-historical-hint {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: .73rem;
  line-height: 1.45;
}

.ledger-period-analysis-loading {
  display: grid;
  min-height: 150px;
  margin-top: 20px;
  place-items: center;
  border: 1px dashed var(--ledger-border);
  border-radius: 10px;
  color: var(--text-muted);
  font-size: .8rem;
}

.ledger-cashflow-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-inline: -20px;
}

.ledger-cashflow-grid > div {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 4px 36px;
  border-left: 1px solid var(--ledger-divider);
}

.ledger-cashflow-grid > div:first-child {
  padding-left: 36px;
  border-left: 0;
}

.ledger-cashflow-grid > div:last-child { padding-right: 36px; }

.ledger-cashflow-mark {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 13px;
  background: color-mix(in srgb, var(--accent) 11%, var(--bg));
  color: var(--accent);
  font-size: 1.15rem;
  font-weight: 700;
}

.ledger-cashflow-mark.is-income {
  background: color-mix(in srgb, var(--ledger-income) 13%, var(--bg));
  color: var(--ledger-income);
}

.ledger-cashflow-mark.is-expense {
  background: color-mix(in srgb, var(--ledger-expense) 13%, var(--bg));
  color: var(--ledger-expense);
}

.ledger-cashflow-mark.is-repayment {
  background: color-mix(in srgb, var(--ledger-repayment) 13%, var(--bg));
  color: var(--ledger-repayment);
}

.ledger-cashflow-mark.is-balance {
  background: color-mix(in srgb, var(--ledger-balance) 11%, var(--bg));
  color: var(--ledger-balance);
}

.ledger-cashflow-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.ledger-cashflow-copy > span {
  color: var(--text-muted);
  font-size: .73rem;
}

.ledger-cashflow-copy strong {
  overflow: hidden;
  color: var(--text-h);
  font-size: 1.12rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ledger-cashflow-grid .is-income { color: var(--ledger-income); }
.ledger-cashflow-grid .is-expense { color: var(--ledger-expense); }
.ledger-cashflow-grid .is-repayment { color: var(--ledger-repayment); }
.ledger-cashflow-grid .is-balance { color: var(--ledger-balance); }

.ledger-dashboard-account-viewport {
  min-width: 0;
}

.ledger-dashboard-account-list-viewport {
  max-height: 280px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: transparent transparent;
  scrollbar-width: thin;
}

.ledger-dashboard-account-list-viewport.is-scrolling {
  scrollbar-color: color-mix(in srgb, var(--text-muted) 34%, transparent) transparent;
}

.ledger-dashboard-account-list-viewport::-webkit-scrollbar,
.ledger-breakdown-list-viewport::-webkit-scrollbar {
  width: 6px;
}

.ledger-dashboard-account-list-viewport::-webkit-scrollbar-thumb,
.ledger-breakdown-list-viewport::-webkit-scrollbar-thumb {
  background: transparent;
  transition: background .18s ease;
}

.ledger-dashboard-account-list-viewport.is-scrolling::-webkit-scrollbar-thumb,
.ledger-breakdown-list-viewport.is-scrolling::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--text-muted) 34%, transparent);
}

.ledger-breakdown-list-viewport {
  max-height: 280px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: transparent transparent;
  scrollbar-width: thin;
}

.ledger-breakdown-list-viewport.is-scrolling {
  scrollbar-color: color-mix(in srgb, var(--text-muted) 34%, transparent) transparent;
}

.ledger-dashboard-account-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
}

.ledger-dashboard-account-group {
  min-width: 0;
  padding-right: 26px;
}

.ledger-dashboard-account-group + .ledger-dashboard-account-group {
  padding-left: 26px;
  padding-right: 0;
  border-left: 1px solid var(--ledger-divider);
}

.ledger-dashboard-account-group h3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin: 0 0 5px;
  padding: 0 4px 8px 10px;
  color: var(--text-muted);
  font-size: .75rem;
  font-weight: 550;
}

.ledger-dashboard-account-group h3 > span {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.ledger-dashboard-account-group h3 i,
.ledger-breakdown-columns h3 i {
  display: inline-block;
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.ledger-dashboard-account-group h3 i.is-asset,
.ledger-breakdown-columns h3 i.is-income { background: var(--ledger-income); }

.ledger-dashboard-account-group h3 i.is-liability,
.ledger-breakdown-columns h3 i.is-expense { background: var(--ledger-expense); }

.ledger-dashboard-account-group h3 small {
  color: var(--text-muted);
  font: inherit;
}

.ledger-dashboard-account-group h3 > strong {
  overflow: hidden;
  color: var(--text-h);
  font-size: .76rem;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ledger-dashboard-accounts { display: grid; }

.ledger-dashboard-accounts :deep(.n-list-item) { padding: 0; }
.ledger-dashboard-accounts :deep(.n-list-item__main) { width: 100%; }

.ledger-dashboard-account {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 54px;
  padding: 7px 4px 7px 10px;
  border-bottom: 1px solid var(--ledger-divider);
  color: inherit;
  text-decoration: none;
  transition: background-color .14s ease;
}

.ledger-dashboard-account-item { padding: 0; }

.ledger-dashboard-account:last-child { border-bottom: 0; }
.ledger-dashboard-account:hover { background: var(--ledger-row-hover); }

.ledger-dashboard-account:focus-visible {
  position: relative;
  z-index: 1;
  border-radius: 7px;
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.ledger-account-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.ledger-account-identity > span:last-child {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ledger-account-icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 11%, var(--bg));
  color: var(--accent);
}

.ledger-account-icon.is-asset {
  background: color-mix(in srgb, var(--ledger-income) 10%, var(--bg));
  color: var(--ledger-income);
}

.ledger-account-icon.is-liability {
  background: color-mix(in srgb, var(--ledger-expense) 10%, var(--bg));
  color: var(--ledger-expense);
}

.ledger-account-identity strong,
.ledger-account-amount {
  overflow: hidden;
  color: var(--text-h);
  font-size: .81rem;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ledger-account-identity small {
  color: var(--text-muted);
  font-size: .69rem;
}

.ledger-account-amount {
  flex: 0 0 auto;
  font-weight: 650;
  text-align: right;
}

.ledger-dashboard-two-column {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 22px;
}

.ledger-dashboard-two-column .ledger-dashboard-section {
  min-width: 0;
  margin-top: 0;
}

.ledger-breakdown-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
}

.ledger-breakdown-columns > div:first-child { padding-right: 20px; }
.ledger-breakdown-columns > div + div {
  padding-left: 20px;
  border-left: 1px solid var(--ledger-divider);
}

.ledger-breakdown-columns h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 12px;
  color: var(--text-muted);
  font-size: .75rem;
  font-weight: 600;
}

.ledger-breakdown-list { display: grid; }
.ledger-breakdown-list :deep(.n-list-item) { padding: 0; }
.ledger-breakdown-list :deep(.n-list-item__main) { width: 100%; }

.ledger-breakdown-list-item + .ledger-breakdown-list-item { border-top: 1px solid var(--ledger-divider); }

.ledger-breakdown-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-width: 0;
  align-items: center;
  gap: 7px 12px;
  font-size: .77rem;
  cursor: pointer;
}

.ledger-breakdown-label {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
  overflow: hidden;
}

.ledger-breakdown-name {
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ledger-breakdown-share {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: .69rem;
  font-weight: 400;
  white-space: nowrap;
}

.ledger-breakdown-amount {
  flex: 0 0 auto;
  color: var(--text-h);
  font-size: .76rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.ledger-breakdown-bar {
  grid-column: 1 / -1;
  overflow: hidden;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 13%, transparent);
}

.ledger-breakdown-bar-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
}

.ledger-breakdown-bar-fill.is-income { background: var(--ledger-income); }
.ledger-breakdown-bar-fill.is-expense { background: var(--ledger-expense); }

.ledger-inline-empty {
  margin: 0;
  color: var(--text-muted);
  font-size: .77rem;
  line-height: 1.45;
}

.ledger-inline-empty:has(button) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ledger-recent-list { display: grid; }
.ledger-recent-list :deep(.n-list-item) { padding: 0; }
.ledger-recent-list :deep(.n-list-item__main) { width: 100%; min-width: 0; }

.ledger-recent-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  border-bottom: 1px solid var(--ledger-divider);
  border-radius: 7px;
  cursor: pointer;
  outline-offset: -1px;
}

.ledger-recent-row:last-child { border-bottom: 0; }
.ledger-recent-row:hover { background: var(--ledger-row-hover); }
.ledger-recent-row:focus-visible { outline: 1px solid color-mix(in srgb, var(--accent) 34%, transparent); }

.ledger-recent-icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 11%, var(--bg));
  color: var(--accent);
  font-size: .94rem;
  font-weight: 700;
}

.ledger-recent-icon.is-income {
  background: color-mix(in srgb, var(--ledger-income) 11%, var(--bg));
  color: var(--ledger-income);
}

.ledger-recent-icon.is-expense {
  background: color-mix(in srgb, var(--ledger-expense) 11%, var(--bg));
  color: var(--ledger-expense);
}

.ledger-recent-icon.is-transfer {
  background: color-mix(in srgb, var(--ledger-transfer) 11%, var(--bg));
  color: var(--ledger-transfer);
}

.ledger-recent-icon.is-repayment {
  background: color-mix(in srgb, var(--ledger-repayment) 11%, var(--bg));
  color: var(--ledger-repayment);
}

.ledger-recent-info {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.ledger-recent-info strong {
  overflow: hidden;
  color: var(--text-h);
  font-size: .8rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ledger-recent-info small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: .67rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ledger-recent-amount {
  flex: 0 0 auto;
  color: var(--text-h);
  font-size: .8rem;
  font-variant-numeric: tabular-nums;
}

.ledger-recent-amount.is-income { color: var(--ledger-income); }
.ledger-recent-amount.is-expense { color: var(--ledger-expense); }
.ledger-recent-amount.is-repayment { color: var(--ledger-repayment); }

.ledger-period-grid {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.ledger-period-summary-loading {
  display: grid;
  min-height: 100px;
  place-items: center;
  color: var(--text-muted);
  font-size: .75rem;
}

.ledger-period-card {
  min-height: 100px;
  border-left: 1px solid var(--ledger-divider);
}

.ledger-period-card :deep(.n-card__content) {
  display: grid;
  min-width: 0;
  gap: 6px;
  min-height: 100px;
  padding: 2px 22px;
  box-sizing: border-box;
}

.ledger-period-card:first-child {
  border-left: 0;
}

.ledger-period-card:first-child :deep(.n-card__content) { padding-left: 0; }
.ledger-period-card:last-child :deep(.n-card__content) { padding-right: 0; }

.ledger-period-card-heading {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ledger-divider);
  justify-content: space-between;
}

.ledger-period-card h3 {
  flex: 0 0 auto;
  margin: 0;
  color: var(--text-h);
  font-size: .8rem;
  font-weight: 650;
}

.ledger-period-date-control {
  flex: 0 1 auto;
  position: relative;
  min-width: 0;
  min-height: 1rem;
  text-align: right;
}

.ledger-period-date-label {
  display: block;
  overflow: hidden;
  color: var(--text-muted);
  font-size: .65rem;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity .14s ease;
}

.ledger-period-date-editor {
  position: absolute;
  top: 50%;
  right: 0;
  z-index: 2;
  width: 148px;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  text-align: left;
  transition: opacity .14s ease;
}

.ledger-period-date-editor :deep(.ledger-date-picker),
.ledger-period-date-editor :deep(.ledger-date-picker .n-input) { width: 100%; }
.ledger-period-date-editor :deep(.n-input__input-el) { text-align: left; }

.ledger-period-date-control:hover .ledger-period-date-label,
.ledger-period-date-control:focus-within .ledger-period-date-label { opacity: 0; }

.ledger-period-date-control:hover .ledger-period-date-editor,
.ledger-period-date-control:focus-within .ledger-period-date-editor {
  opacity: 1;
  pointer-events: auto;
}

.ledger-period-values {
  display: grid;
  gap: 4px;
  margin-top: auto;
  color: var(--text-muted);
  font-size: .68rem;
}

.ledger-period-local-state {
  display: flex;
  min-width: 0;
  min-height: 2.6rem;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  color: var(--text-muted);
  font-size: .68rem;
}

.ledger-period-local-state.is-error { color: var(--ledger-expense); }

.ledger-period-values span {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.ledger-period-values strong {
  color: var(--text-h);
  font-size: .71rem;
  font-variant-numeric: tabular-nums;
}

.ledger-period-values strong.is-income { color: var(--ledger-income); }
.ledger-period-values strong.is-expense { color: var(--ledger-expense); }
.ledger-period-values strong.is-repayment { color: var(--ledger-repayment); }
.ledger-period-values strong.is-balance { color: var(--ledger-balance); }

@media (max-width: 960px) {
  .ledger-metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ledger-metric-card.is-primary { grid-column: 1 / -1; }
  .ledger-dashboard-two-column { grid-template-columns: 1fr; row-gap: 14px; }
  .ledger-cashflow-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ledger-cashflow-grid > div:nth-child(odd) {
    padding-left: 36px;
    border-left: 0;
  }
  .ledger-cashflow-grid > div:nth-child(n + 3) {
    border-top: 1px solid var(--ledger-divider);
    padding-top: 14px;
  }
  .ledger-period-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ledger-period-card:nth-child(odd) {
    border-left: 0;
  }
  .ledger-period-card:nth-child(odd) :deep(.n-card__content) { padding-left: 0; }
  .ledger-period-card:nth-child(even) :deep(.n-card__content) { padding-right: 0; }
  .ledger-period-card:nth-child(n + 3) {
    border-top: 1px solid var(--ledger-divider);
  }
  .ledger-period-card:nth-child(n + 3) :deep(.n-card__content) { padding-top: 18px; }
}

@media (max-width: 760px) {
  .ledger-dashboard { padding: 30px 16px 24px; }
  .ledger-dashboard-header {
    grid-template-columns: 1fr;
    align-items: stretch;
    gap: 20px;
  }
  .ledger-dashboard-actions {
    justify-self: stretch;
    margin-left: 0;
  }
  .ledger-dashboard-actions > * { flex: 1 1 140px; }
  .ledger-dashboard-account-groups { grid-template-columns: 1fr; gap: 18px; }
  .ledger-dashboard-account-group { padding-right: 2px; }
  .ledger-dashboard-account-group + .ledger-dashboard-account-group {
    padding: 18px 2px 0 0;
    border-top: 1px solid var(--ledger-divider);
    border-left: 0;
  }
  .ledger-dashboard-account-list-viewport { max-height: 360px; }
  .ledger-period-heading { flex-direction: column; }
  .ledger-period-toolbar {
    width: 100%;
    justify-content: flex-start;
  }
}

@media (max-width: 620px) {
  .ledger-metric-grid { grid-template-columns: 1fr; }
  .ledger-metric-card.is-primary { grid-column: auto; }
  .ledger-dashboard-section :deep(.n-card__content) { padding: 17px 15px; }
  .ledger-cashflow-grid { grid-template-columns: 1fr; margin-inline: 0; }
  .ledger-cashflow-grid > div {
    min-height: 60px;
    padding: 12px 2px;
    border-top: 1px solid var(--ledger-divider);
    border-left: 0;
  }
  .ledger-cashflow-grid > div:nth-child(odd) { padding-left: 2px; }
  .ledger-cashflow-grid > div:first-child {
    padding-top: 4px;
    border-top: 0;
  }
  .ledger-cashflow-grid > div:last-child { padding-bottom: 4px; }
  .ledger-breakdown-columns { grid-template-columns: 1fr; gap: 20px; }
  .ledger-breakdown-columns > div:first-child { padding-right: 0; }
  .ledger-breakdown-columns > div + div {
    padding: 20px 0 0;
    border-top: 1px solid var(--ledger-divider);
    border-left: 0;
  }
}

@media (max-width: 440px) {
  .ledger-dashboard-header h1 { font-size: 1.75rem; }
  .ledger-metric-card {
    grid-template-columns: 42px minmax(0, 1fr);
    padding: 16px;
  }
  .ledger-metric-icon {
    width: 42px;
    height: 42px;
  }
  .ledger-period-grid { grid-template-columns: 1fr; }
  .ledger-period-card,
  .ledger-period-card:nth-child(odd),
  .ledger-period-card:nth-child(even) {
    border-top: 1px solid var(--ledger-divider);
    border-left: 0;
  }
  .ledger-period-card :deep(.n-card__content),
  .ledger-period-card:nth-child(odd) :deep(.n-card__content),
  .ledger-period-card:nth-child(even) :deep(.n-card__content) { padding: 14px 0; }
  .ledger-period-card:first-child {
    border-top: 0;
  }
  .ledger-period-card:first-child :deep(.n-card__content) { padding-top: 0; }
  .ledger-period-card:last-child :deep(.n-card__content) { padding-bottom: 0; }
  .ledger-period-toolbar :deep(.ledger-period-scope) {
    flex: 1 1 96px;
    min-width: 0;
    width: auto;
  }
  .ledger-recent-row {
    grid-template-columns: 30px minmax(0, 1fr) auto;
    gap: 8px;
  }
  .ledger-recent-icon {
    width: 29px;
    height: 29px;
  }
  .ledger-recent-amount { font-size: .74rem; }
}
</style>
