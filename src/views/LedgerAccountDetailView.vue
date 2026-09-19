<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { NAlert, NButton, NCard, NIcon, NModal, NResult, NSelect, NSpin, NTooltip } from 'naive-ui'
import { ArrowDown, ArrowUp, ChartBar, Wallet } from '@vicons/tabler'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { init, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import type { LineSeriesOption } from 'echarts/charts'
import type { GridComponentOption, TooltipComponentOption } from 'echarts/components'
import type { ComposeOption, ECharts } from 'echarts/core'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from '../composables/useConfirm'
import { useTheme } from '../composables/useTheme'
import LedgerAnimatedMoney from '../components/ledger/LedgerAnimatedMoney.vue'
import LedgerAccountIcon from '../components/ledger/LedgerAccountIcon.vue'
import LedgerAccountEditForm from '../components/ledger/LedgerAccountEditForm.vue'
import LedgerPendingCreateGate from '../components/ledger/LedgerPendingCreateGate.vue'
import { ledgerAccountTypeOptionsForNature } from '../features/ledger/accountPresentation'
import { isLedgerApiError, ledgerErrorMessage } from '../features/ledger/ledgerErrors'
import { formatLedgerMoney } from '../features/ledger/money'
import { formatLedgerDateTime, formatLedgerTransactionDateTime } from '../features/ledger/time'
import { useLedgerStore } from '../features/ledger/ledgerStore'
import type {
  LedgerAccountBalanceTrendPoint,
  LedgerAccountDto,
  LedgerAccountTransactionBalance,
  LedgerMovementSummary,
  LedgerTransactionDto,
} from '../../shared/ledgerProtocol'

use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

type LedgerBalanceChartOption = ComposeOption<
  | LineSeriesOption
  | GridComponentOption
  | TooltipComponentOption
>

const route = useRoute()
const router = useRouter()
const store = useLedgerStore()
const { theme } = useTheme()
const { confirm } = useConfirm()

const account = ref<LedgerAccountDto | null>(null)
const hasHistory = ref(false)
const recentTransactions = ref<readonly LedgerTransactionDto[]>([])
const recentTransactionBalances = ref<readonly LedgerAccountTransactionBalance[]>([])
const balanceTrendPoints = ref<readonly LedgerAccountBalanceTrendPoint[]>([])
const movement = ref<LedgerMovementSummary | null>(null)
const loading = ref(false)
const editing = ref(false)
const deleting = ref(false)
const actionError = ref('')
const trendRange = ref<7 | 30 | 90 | 365>(30)
const trendOptions: Array<{ value: 7 | 30 | 90 | 365; label: string }> = [
  { value: 7, label: '近7天' },
  { value: 30, label: '近30天' },
  { value: 90, label: '近3个月' },
  { value: 365, label: '近1年' },
]
const balanceTrendPlot = ref<HTMLElement | null>(null)
const balanceTrendReveal = ref<HTMLElement | null>(null)
const balanceTrendChart = shallowRef<ECharts | null>(null)
let balanceTrendResizeObserver: ResizeObserver | null = null
let loadSequence = 0
let balanceTrendSequence = 0
let balanceChartRenderSequence = 0
let balanceChartRevealAnimation: Animation | null = null

const accountId = computed(() => String(route.params.id ?? ''))
const returnFromOverview = computed(() => route.query.from === 'overview')
const breadcrumbRootRoute = computed(() => ({ name: returnFromOverview.value ? 'ledger' : 'ledger-accounts' }))
const typeLabels = new Map(
  ledgerAccountTypeOptionsForNature('asset').concat(ledgerAccountTypeOptionsForNature('liability'))
    .map((option) => [option.value, option.label]),
)

function typeLabel(type: string): string { return typeLabels.get(type as never) ?? type }

async function load(): Promise<void> {
  const id = accountId.value
  const sequence = ++loadSequence
  loading.value = true
  actionError.value = ''
  editing.value = false
  try {
    const history = await loadAccountHistory(id)
    if (sequence !== loadSequence) return
    account.value = history.account
    hasHistory.value = history.hasHistory
    recentTransactions.value = history.transactions
    recentTransactionBalances.value = history.transactionBalances
    balanceTrendPoints.value = history.balanceTrend
    movement.value = history.movement
  } catch (cause) {
    if (sequence !== loadSequence) return
    account.value = null
    actionError.value = ledgerErrorMessage(cause, '账户详情暂时无法加载。')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function loadAccountHistory(id: string): Promise<{
  readonly account: LedgerAccountDto
  readonly hasHistory: boolean
  readonly transactions: readonly LedgerTransactionDto[]
  readonly transactionBalances: readonly LedgerAccountTransactionBalance[]
  readonly balanceTrend: readonly LedgerAccountBalanceTrendPoint[]
  readonly movement: LedgerMovementSummary
}> {
  const [page, trend] = await Promise.all([
    store.getAccountTransactions(id, { limit: 5 }),
    store.getAccountBalanceTrend(id, trendRange.value),
  ])
  return {
    account: page.account,
    hasHistory: page.hasHistory,
    transactions: page.transactions,
    transactionBalances: page.transactionBalances ?? [],
    balanceTrend: trend.points,
    movement: page.movement,
  }
}

watch(accountId, () => { void load() }, { immediate: true })
onMounted(() => { void store.bootstrap() })

async function archive(): Promise<void> {
  const current = account.value
  if (!current || current.archivedAt !== null || current.currentBalanceMinor !== 0) return
  const confirmed = await confirm(
    `归档账户“${current.name}”？`,
    '归档后不会删除历史记录；如需继续记账，可以随时恢复。',
  )
  if (!confirmed) return
  actionError.value = ''
  try {
    account.value = await store.archiveAccount(current.id, current.version)
  } catch (cause) {
    actionError.value = ledgerErrorMessage(cause, '账户没有归档，请刷新后重试。')
  }
}

async function restore(): Promise<void> {
  const current = account.value
  if (!current || current.archivedAt === null) return
  actionError.value = ''
  try {
    account.value = await store.restoreAccount(current.id, current.version)
  } catch (cause) {
    actionError.value = ledgerErrorMessage(cause, '账户没有恢复，请刷新后重试。')
  }
}

async function permanentlyDelete(): Promise<void> {
  const current = account.value
  if (!current || hasHistory.value || deleting.value) return
  const confirmed = await confirm(
    `永久删除“${current.name}”？`,
    '此操作无法撤销。该账户没有历史交易，删除后将从 Ledger 中永久移除。',
    { confirmLabel: '永久删除', cancelLabel: '取消', destructive: true },
  )
  if (!confirmed) return
  deleting.value = true
  actionError.value = ''
  try {
    await store.deleteAccount(current.id, current.version)
    await router.push({ name: 'ledger-accounts' })
  } catch (cause) {
    const deleteErrorMessage = ledgerErrorMessage(cause, '账户没有删除，请刷新后重试。')
    if (isLedgerApiError(cause) && cause.code === 'ledger-account-has-history') {
      await load()
      if (account.value === null) {
        const reloadErrorMessage = actionError.value || '账户详情暂时无法加载。'
        actionError.value = `${deleteErrorMessage} ${reloadErrorMessage} 请点击“重新加载”后重试。`
        return
      }
    }
    actionError.value = deleteErrorMessage
  } finally {
    deleting.value = false
  }
}

function onSaved(next: LedgerAccountDto): void {
  account.value = next
  editing.value = false
}

function transactionTitle(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income' || transaction.type === 'expense') return transaction.payee || store.categories.value.find((item) => item.id === transaction.categoryId)?.name || '未分类'
  if (transaction.type === 'transfer') {
    const from = store.accounts.value.find((item) => item.id === transaction.fromAccountId)?.name ?? '未知账户'
    const to = store.accounts.value.find((item) => item.id === transaction.toAccountId)?.name ?? '未知账户'
    return `${from} → ${to}`
  }
  return '余额调整'
}

function transactionTypeLabel(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income') return '收入'
  if (transaction.type === 'expense') return '支出'
  if (transaction.type === 'transfer') return transaction.transferKind === 'repayment' ? '还款' : transaction.transferKind === 'withdrawal' ? '提现' : '转账'
  return '调整'
}

function transactionAmountMinor(transaction: LedgerTransactionDto): number | null {
  const amount = transaction.amountMinor
  if (!Number.isSafeInteger(amount)) return null
  if (transaction.type === 'income') return amount
  if (transaction.type === 'expense') return -amount
  if (transaction.type === 'transfer' && transaction.fromAccountId === accountId.value) {
    return -amount
  }
  return amount
}

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  return formatLedgerDateTime(timestamp, store.settings.value?.timezone ?? 'UTC')
}

function formatTransactionTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  return formatLedgerTransactionDateTime(timestamp, store.settings.value?.timezone ?? 'UTC')
}

function maskCardNumber(cardNumber: string | undefined): string {
  const value = cardNumber?.trim() ?? ''
  if (value.length <= 8) return value
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`
}

function transactionCategory(transaction: LedgerTransactionDto): string {
  if (transaction.type === 'income' || transaction.type === 'expense') {
    return store.categories.value.find((category) => category.id === transaction.categoryId)?.name ?? '未分类'
  }
  if (transaction.type === 'transfer') return transaction.transferKind === 'repayment' ? '还款' : transaction.transferKind === 'withdrawal' ? '提现' : '账户转账'
  return '余额调整'
}

const transactionBalanceMap = computed(() => new Map(
  recentTransactionBalances.value.map((entry) => [entry.transactionId, entry.balanceMinor]),
))

const balanceTrend = computed(() => balanceTrendPoints.value.map((point) => ({
  ...point,
  label: point.date,
})))

async function reloadBalanceTrend(range: 7 | 30 | 90 | 365): Promise<void> {
  const id = accountId.value
  if (!id || !account.value) return
  const sequence = ++balanceTrendSequence
  try {
    const trend = await store.getAccountBalanceTrend(id, range)
    if (sequence !== balanceTrendSequence || id !== accountId.value || range !== trendRange.value) return
    balanceTrendPoints.value = trend.points
  } catch (cause) {
    if (sequence !== balanceTrendSequence || id !== accountId.value || range !== trendRange.value) return
    balanceTrendPoints.value = []
    actionError.value = ledgerErrorMessage(cause, '余额趋势暂时无法加载。')
  }
}

watch(trendRange, (range) => { void reloadBalanceTrend(range) })

function balanceChartToken(name: string, fallback: string): string {
  const element = balanceTrendPlot.value
  if (element === null || typeof getComputedStyle !== 'function') return fallback
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

function balanceTooltip(params: unknown): string {
  const entry = Array.isArray(params) ? params[0] : params
  const dataIndex = (entry as { dataIndex?: unknown } | null | undefined)?.dataIndex
  if (typeof dataIndex !== 'number') return ''
  const point = balanceTrend.value[dataIndex]
  if (point === undefined) return ''
  return `<strong>${point.label}</strong><br/>余额：${formatLedgerMoney(point.balanceMinor, account.value?.currency ?? 'CNY')}`
}

function buildBalanceChartOption(): LedgerBalanceChartOption {
  const points = balanceTrend.value
  const accent = balanceChartToken('--accent', '#635bff')
  const text = balanceChartToken('--text-muted', '#6b7280')
  const textHeading = balanceChartToken('--text-h', '#111827')
  const border = balanceChartToken('--border', '#e5e7eb')
  const grid = balanceChartToken('--border', '#edf0f4')
  const surface = balanceChartToken('--bg-soft', '#ffffff')
  const lastPointIndex = Math.max(points.length - 1, 0)
  const labelCount = points.length <= 7 ? points.length : 7
  const labelStep = labelCount > 1 ? lastPointIndex / (labelCount - 1) : 1
  return {
    animation: false,
    grid: { top: 14, left: 0, right: 0, bottom: 28, containLabel: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: border, type: 'dashed' } },
      backgroundColor: surface,
      borderColor: border,
      extraCssText: 'box-shadow:0 8px 24px rgba(0,0,0,.08);border-radius:8px',
      textStyle: { color: textHeading, fontSize: 12 },
      formatter: balanceTooltip,
    },
    xAxis: {
      type: 'category',
      data: points.map((point) => point.label),
      boundaryGap: false,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: border } },
      axisLabel: {
        color: text,
        fontSize: 11,
        interval: 0,
        hideOverlap: true,
        margin: 10,
        formatter: (value: string, index: number) => {
          if (points.length <= 7) return value
          const nearestLabelIndex = Math.round(index / labelStep) * labelStep
          return index === 0 || index === lastPointIndex || Math.abs(index - nearestLabelIndex) < 0.01 ? value : ''
        },
      },
    },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { lineStyle: { color: grid, type: 'dashed' } },
    },
    series: [
      {
        name: '账户余额',
        type: 'line',
        data: points.map((point) => point.balanceMinor),
        smooth: 0.5,
        symbol: 'circle',
        symbolSize: 7,
        showSymbol: false,
        lineStyle: { color: accent, width: 2.5 },
        itemStyle: { color: surface, borderColor: accent, borderWidth: 2 },
        areaStyle: { color: accent, opacity: .12 },
      },
    ],
  }
}

function applyBalanceChartOption(): void {
  balanceTrendChart.value?.setOption(buildBalanceChartOption(), { notMerge: true })
}

function playBalanceChartAnimation(): void {
  const chart = balanceTrendChart.value
  const reveal = balanceTrendReveal.value
  const pointCount = balanceTrend.value.length
  if (chart === null || reveal === null || pointCount === 0) return
  chart.setOption(buildBalanceChartOption(), { notMerge: true })
  balanceChartRevealAnimation?.cancel()
  balanceChartRevealAnimation = reveal.animate(
    [
      { width: '0%' },
      { width: '100%' },
    ],
    { duration: 1400, easing: 'linear' },
  )
  balanceChartRevealAnimation.addEventListener('finish', () => {
    balanceChartRevealAnimation = null
  }, { once: true })
}

function createBalanceChart(): void {
  const element = balanceTrendPlot.value
  const reveal = balanceTrendReveal.value
  const chartWidth = reveal?.parentElement?.clientWidth ?? 0
  if (element === null || reveal === null || chartWidth === 0) return
  element.style.width = `${chartWidth}px`
  if (balanceTrendChart.value?.getDom() === element) return
  if (balanceTrendChart.value !== null) destroyBalanceChart()
  balanceTrendChart.value = init(element)
  if (typeof ResizeObserver === 'function') {
    balanceTrendResizeObserver = new ResizeObserver(handleBalanceChartResize)
    balanceTrendResizeObserver.observe(reveal.parentElement ?? reveal)
  } else {
    window.addEventListener('resize', handleBalanceChartResize)
  }
}

function handleBalanceChartResize(): void {
  const element = balanceTrendPlot.value
  const chartWidth = balanceTrendReveal.value?.parentElement?.clientWidth ?? 0
  if (element !== null && chartWidth > 0) element.style.width = `${chartWidth}px`
  balanceTrendChart.value?.resize()
}

function destroyBalanceChart(): void {
  balanceChartRevealAnimation?.cancel()
  balanceChartRevealAnimation = null
  balanceTrendResizeObserver?.disconnect()
  balanceTrendResizeObserver = null
  window.removeEventListener('resize', handleBalanceChartResize)
  balanceTrendChart.value?.dispose()
  balanceTrendChart.value = null
}

async function replayBalanceChart(): Promise<void> {
  const sequence = ++balanceChartRenderSequence
  destroyBalanceChart()
  await nextTick()
  if (sequence !== balanceChartRenderSequence) return
  if (balanceTrend.value.length === 0) {
    destroyBalanceChart()
    return
  }
  createBalanceChart()
  playBalanceChartAnimation()
}

watch(balanceTrend, () => { void replayBalanceChart() }, { flush: 'post' })
watch(() => theme.value, applyBalanceChartOption, { flush: 'post' })
onBeforeUnmount(() => {
  balanceChartRenderSequence += 1
  destroyBalanceChart()
})

const netMovement = computed(() => {
  if (!movement.value) return 0
  return movement.value.balanceIncreaseMinor - movement.value.balanceDecreaseMinor
})
</script>

<template>
  <main class="ledger-page ledger-account-page" data-testid="ledger-account-page">
    <LedgerPendingCreateGate v-if="store.recoveryGateVisible.value" />

    <div v-else-if="loading" class="ledger-state-panel ledger-loading-state" data-testid="ledger-account-loading" role="status"><NSpin size="medium" description="正在加载账户…" /></div>
    <section v-else-if="!account" class="ledger-state-panel ledger-result-state" data-testid="ledger-account-error" role="alert">
      <NResult status="error" title="账户详情无法加载" :description="actionError">
        <template #footer>
          <div class="ledger-page-actions">
            <NButton class="ledger-primary-button" attr-type="button" type="primary" size="small" :bordered="false" @click="load">重新加载</NButton>
            <RouterLink class="ledger-secondary-button" :to="{ name: 'ledger-accounts' }">返回账户</RouterLink>
          </div>
        </template>
      </NResult>
    </section>

    <section v-else-if="account" class="ledger-account-detail" aria-labelledby="ledger-account-detail-title">
      <header class="ledger-detail-header">
        <div class="ledger-account-identity">
          <span class="ledger-detail-account-icon" :class="account.nature === 'asset' ? 'is-asset' : 'is-liability'" aria-hidden="true"><LedgerAccountIcon :icon="account.icon" :size="42" /></span>
          <div class="ledger-account-identity-copy">
            <h1 id="ledger-account-detail-title">{{ account.name }}</h1>
            <p>{{ account.nature === 'asset' ? '资产' : '负债' }} · {{ typeLabel(account.type) }} · {{ account.currency }}</p>
          </div>
        </div>

        <div class="ledger-page-actions ledger-detail-header-actions">
          <RouterLink class="ledger-secondary-button" :to="breadcrumbRootRoute">返回总览</RouterLink>
          <NButton v-if="account.archivedAt === null" class="ledger-primary-button" attr-type="button" type="primary" size="small" :bordered="false" @click="editing = true">编辑账户</NButton>
          <NTooltip v-if="account.archivedAt === null && account.currentBalanceMinor !== 0" placement="bottom">
            <template #trigger><span class="ledger-action-trigger"><NButton class="ledger-secondary-button ledger-danger-button" attr-type="button" size="small" :bordered="false" disabled>归档账户</NButton></span></template>
            当前余额需调整为 0 后才能归档账户。
          </NTooltip>
          <NButton v-else-if="account.archivedAt === null" class="ledger-secondary-button ledger-danger-button" attr-type="button" size="small" :bordered="false" @click="archive">归档账户</NButton>
          <NButton v-else class="ledger-secondary-button" attr-type="button" size="small" :bordered="false" @click="restore">恢复账户</NButton>
          <NButton
            v-if="account.archivedAt !== null && !hasHistory"
            class="ledger-secondary-button ledger-danger-button"
            attr-type="button"
            type="error"
            size="small"
            :bordered="false"
            :disabled="deleting"
            data-testid="ledger-account-permanent-delete"
            @click="permanentlyDelete"
          >{{ deleting ? '正在删除…' : '删除账户' }}</NButton>
        </div>
      </header>

      <NAlert v-if="actionError" class="ledger-form-error" type="error" :show-icon="false" role="alert">{{ actionError }}</NAlert>

      <section class="ledger-metric-grid" data-testid="ledger-account-movement" aria-label="账户本月概览">
        <div class="ledger-detail-card ledger-metric-item">
          <span class="ledger-metric-icon" aria-hidden="true"><NIcon><Wallet /></NIcon></span>
          <div><span>当前余额</span><strong><LedgerAnimatedMoney :minor="account.currentBalanceMinor" :currency="account.currency" animate-on-mount /></strong></div>
        </div>
        <div class="ledger-detail-card ledger-metric-item">
          <span class="ledger-metric-icon" :class="account.nature === 'asset' ? 'is-income' : 'is-expense'" aria-hidden="true"><NIcon><ArrowUp /></NIcon></span>
          <div><span>{{ account.nature === 'asset' ? '本月流入' : '新增负债' }}</span><strong :class="account.nature === 'asset' ? 'is-income' : 'is-expense'"><LedgerAnimatedMoney :minor="movement?.balanceIncreaseMinor ?? 0" :currency="account.currency" animate-on-mount /></strong></div>
        </div>
        <div class="ledger-detail-card ledger-metric-item">
          <span class="ledger-metric-icon" :class="account.nature === 'asset' ? 'is-expense' : 'is-income'" aria-hidden="true"><NIcon><ArrowDown /></NIcon></span>
          <div><span>{{ account.nature === 'asset' ? '本月流出' : '减少负债' }}</span><strong :class="account.nature === 'asset' ? 'is-expense' : 'is-income'"><LedgerAnimatedMoney :minor="movement?.balanceDecreaseMinor ?? 0" :currency="account.currency" animate-on-mount /></strong></div>
        </div>
        <div class="ledger-detail-card ledger-metric-item">
          <span class="ledger-metric-icon is-net" aria-hidden="true"><NIcon><ChartBar /></NIcon></span>
          <div><span>本月净变动</span><strong :class="account.nature === 'liability' ? (netMovement > 0 ? 'is-expense' : 'is-income') : (netMovement < 0 ? 'is-expense' : 'is-income')"><LedgerAnimatedMoney :minor="netMovement" :currency="account.currency" signed animate-on-mount /></strong></div>
        </div>
      </section>

      <div class="ledger-detail-grid">
        <div class="ledger-detail-main-column">
          <section class="ledger-detail-card ledger-balance-trend" aria-labelledby="ledger-balance-trend-title">
            <div class="ledger-section-heading">
              <h2 id="ledger-balance-trend-title">余额趋势</h2>
              <NSelect
                v-model:value="trendRange"
                class="ledger-trend-range"
                size="small"
                :options="trendOptions"
                aria-label="趋势时间范围"
              />
            </div>
            <div class="ledger-trend-chart" role="img" aria-label="账户余额变化趋势图">
              <div ref="balanceTrendReveal" class="ledger-balance-trend-reveal">
                <div ref="balanceTrendPlot" class="ledger-balance-trend-plot" data-testid="ledger-balance-trend-chart" aria-hidden="true" />
              </div>
            </div>
          </section>

          <section class="ledger-detail-card ledger-recent-transactions" aria-labelledby="ledger-recent-title">
            <div class="ledger-section-heading"><h2 id="ledger-recent-title">最近交易</h2><RouterLink :to="{ name: 'ledger-transactions', query: { accountId: account.id } }">查看更多</RouterLink></div>
            <div v-if="recentTransactions.length" class="ledger-recent-table">
              <div class="ledger-recent-table-head"><span>日期</span><span>类型</span><span>分类</span><span>摘要</span><span>金额</span><span>余额</span></div>
              <div v-for="transaction in recentTransactions" :key="transaction.id" class="ledger-recent-row">
                <time>{{ formatTransactionTimestamp(transaction.occurredAt) }}</time>
                <span class="ledger-transaction-badge" :class="`is-${transaction.type}`">{{ transactionTypeLabel(transaction) }}</span>
                <span class="ledger-transaction-category">{{ transactionCategory(transaction) }}</span>
                <span class="ledger-transaction-summary">{{ transactionTitle(transaction) }}</span>
                <strong :class="`is-${transaction.type}`">
                  <LedgerAnimatedMoney v-if="transactionAmountMinor(transaction) !== null" :minor="transactionAmountMinor(transaction)!" :currency="account.currency" signed :animate-on-mount="false" :animate-on-change="false" />
                  <span v-else>—</span>
                </strong>
                <span class="ledger-transaction-balance"><LedgerAnimatedMoney :minor="transactionBalanceMap.get(transaction.id) ?? account.currentBalanceMinor" :currency="account.currency" :animate-on-mount="false" :animate-on-change="false" /></span>
              </div>
            </div>
            <p v-else class="ledger-empty-copy">暂无交易记录</p>
          </section>
        </div>

        <aside class="ledger-detail-side-column">
          <section class="ledger-detail-card ledger-account-info" aria-labelledby="ledger-account-info-title">
            <div class="ledger-side-heading"><h2 id="ledger-account-info-title">账户信息</h2></div>
            <dl>
              <div><dt>账户名称</dt><dd>{{ account.name }}</dd></div>
              <div><dt>账户类型</dt><dd>{{ typeLabel(account.type) }}</dd></div>
              <div><dt>资产类别</dt><dd>{{ account.nature === 'asset' ? '资产' : '负债' }}</dd></div>
              <div><dt>币种</dt><dd>{{ account.currency }}</dd></div>
              <div v-if="account.cardNumber"><dt>卡号</dt><dd>{{ maskCardNumber(account.cardNumber) }}</dd></div>
              <div><dt>期初余额</dt><dd><LedgerAnimatedMoney :minor="account.openingBalanceMinor" :currency="account.currency" :animate-on-mount="false" :animate-on-change="false" /></dd></div>
              <div><dt>开户日期</dt><dd>{{ account.openingDate }}</dd></div>
              <div><dt>创建时间</dt><dd>{{ formatTimestamp(account.createdAt) }}</dd></div>
              <div><dt>最后更新</dt><dd>{{ formatTimestamp(account.updatedAt) }}</dd></div>
            </dl>
          </section>

          <section class="ledger-detail-card ledger-detail-note" aria-labelledby="ledger-account-note-title">
            <div class="ledger-side-heading"><h2 id="ledger-account-note-title">备注</h2></div>
            <p>{{ account.note || '暂无备注' }}</p>
          </section>

        </aside>
      </div>
    </section>

    <NModal
      v-if="editing && account"
      :show="editing"
      :mask-closable="true"
      :close-on-esc="false"
      :auto-focus="false"
      :trap-focus="true"
      :on-esc="() => { editing = false }"
      :on-update-show="(show) => { if (!show) editing = false }"
    >
      <NCard
        class="ledger-account-edit-modal-card"
        :bordered="false"
        size="small"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ledger-account-edit-title"
      >
        <LedgerAccountEditForm :account="account" :has-history="hasHistory" @saved="onSaved" @cancel="editing = false" />
      </NCard>
    </NModal>
  </main>
</template>

<style scoped>
.ledger-page { min-height: calc(100vh - 52px); background: var(--bg); }
.ledger-account-page { width: min(100%, 1240px); margin: 0 auto; padding: 30px 28px 64px; box-sizing: border-box; }
.ledger-detail-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 26px; margin-bottom: 24px; }
.ledger-account-identity { display: flex; align-items: center; gap: 15px; min-width: 0; }
.ledger-eyebrow { margin: 0 0 6px; color: var(--accent); font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ledger-detail-header h1 { margin: 0; color: var(--text-h); font-size: 2rem; line-height: 1.2; }
.ledger-detail-header p:not(.ledger-eyebrow) { margin: 8px 0 0; color: var(--text-muted); font-size: .84rem; }
.ledger-account-identity .ledger-account-status { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; color: var(--text-muted); font-size: .76rem; }
.ledger-account-status i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.ledger-page-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.ledger-detail-header .ledger-page-actions { gap: 9px; }
.ledger-account-edit-modal-card {
  width: min(620px, calc(100vw - 32px));
  max-height: min(90vh, 760px);
  overflow: auto;
  scrollbar-width: none;
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  border-radius: 16px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 3%, transparent), transparent 52%),
    color-mix(in srgb, var(--bg-soft) 82%, transparent);
  box-shadow: 0 18px 55px color-mix(in srgb, var(--text-h) 20%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text-h) 9%, transparent);
  -webkit-backdrop-filter: saturate(145%) blur(18px);
  backdrop-filter: saturate(145%) blur(18px);
}
.ledger-account-edit-modal-card::-webkit-scrollbar { display: none; }
.ledger-account-edit-modal-card :deep(.n-card__content) { padding: 28px; }
.ledger-account-edit-modal-card :deep(.ledger-account-edit-form) { width: 100%; padding: 0; border: 0; background: transparent; }
.ledger-primary-button,
.ledger-secondary-button { display: inline-flex; min-height: 32px; align-items: center; justify-content: center; box-sizing: border-box; padding: 6px 12px; border-radius: 7px; font: inherit; font-size: .78rem; font-weight: 650; text-decoration: none; cursor: pointer; }
.ledger-primary-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.ledger-secondary-button { border: 1px solid var(--border); background: var(--bg); color: var(--text-h); }
.ledger-secondary-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-primary-button:disabled,
.ledger-secondary-button:disabled { cursor: wait; opacity: .65; }
.ledger-form-error { margin: 0 0 14px; color: #b42318; font-size: .82rem; }
.ledger-form-error :deep(.n-alert-body) { color: #b42318; }
.ledger-action-trigger { display: inline-flex; margin: 0; padding: 0; }
.ledger-detail-account-icon { display: grid; flex: 0 0 auto; width: 58px; height: 58px; place-items: center; border-radius: 15px; background: color-mix(in srgb, var(--accent) 11%, var(--bg)); color: var(--accent); }
.ledger-detail-account-icon.is-liability { background: color-mix(in srgb, var(--ledger-expense, #dc3f4d) 11%, var(--bg)); color: var(--ledger-expense, #dc3f4d); }
.ledger-account-hero-balance { min-width: 190px; text-align: right; }
.ledger-account-hero-balance :deep(.n-statistic-label) { color: var(--text-muted); font-size: .78rem; }
.ledger-account-hero-balance :deep(.n-statistic-value) { color: var(--text-h); font-size: 2.15rem; font-weight: 700; }
.ledger-detail-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(280px, 1fr); gap: 16px; align-items: stretch; }
.ledger-detail-main-column, .ledger-detail-side-column { display: grid; gap: 16px; min-width: 0; align-content: start; }
.ledger-detail-side-column { grid-template-rows: auto minmax(0, 1fr); }
.ledger-detail-card, .ledger-detail-movement { box-sizing: border-box; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--bg-soft) 86%, transparent); }
.ledger-detail-card :deep(.n-card__content), .ledger-detail-movement :deep(.n-card__content) { padding: 20px; box-sizing: border-box; }
.ledger-detail-movement { margin: 0 0 16px; }
.ledger-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.ledger-section-heading h2 { margin: 0; color: var(--text-h); font-size: .98rem; }
.ledger-section-heading a { color: var(--accent); font-size: .78rem; text-decoration: none; }
.ledger-movement-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.ledger-movement-grid > div { display: grid; gap: 7px; }
.ledger-movement-grid span { color: var(--text-muted); font-size: .76rem; }
.ledger-movement-grid strong { color: var(--text-h); font-size: 1rem; }
.ledger-movement-grid strong.is-negative, .ledger-recent-row strong.is-expense { color: var(--ledger-expense, #dc3f4d); }
.ledger-recent-transactions { min-height: 250px; }
.ledger-recent-list { display: grid; }
.ledger-recent-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.ledger-recent-row > span { display: grid; gap: 4px; min-width: 0; }
.ledger-recent-row strong { color: var(--text-h); font-size: .86rem; }
.ledger-recent-row small { overflow: hidden; color: var(--text-muted); font-size: .74rem; text-overflow: ellipsis; white-space: nowrap; }
.ledger-recent-row > strong { flex: 0 0 auto; }
.ledger-recent-row strong.is-income { color: var(--nuvyn-positive, #15803d); }
.ledger-empty-copy { margin: 34px 0; color: var(--text-muted); font-size: .82rem; text-align: center; }
.ledger-account-info h2 { margin: 0 0 17px; color: var(--text-h); font-size: .98rem; }
.ledger-account-info dl { display: grid; gap: 12px; margin: 0; }
.ledger-account-info dl div { display: flex; justify-content: space-between; gap: 12px; font-size: .78rem; }
.ledger-account-info dt { color: var(--text-muted); }
.ledger-account-info dd { margin: 0; color: var(--text-h); text-align: right; }
.ledger-detail-note { margin: 0; }
.ledger-detail-note :deep(.n-card__content) { padding: 20px; }
.ledger-detail-note h2 { margin: 0 0 7px; color: var(--text-h); font-size: .95rem; }
.ledger-detail-note p { margin: 0; color: var(--text-muted); font-size: .84rem; white-space: pre-wrap; }
.ledger-state-panel { display: grid; min-height: 300px; align-content: center; gap: 10px; color: var(--text-muted); }
.ledger-loading-state { place-items: center; text-align: center; }
.ledger-result-state {
  min-height: calc(100vh - var(--navbar-h, 52px) - 88px);
  place-items: center;
  text-align: center;
}
.ledger-loading-state :deep(.n-spin-container) { display: grid; place-items: center; }
.ledger-result-state :deep(.n-result) { display: grid; place-items: center; width: min(100%, 620px); padding: 0; text-align: center; }
.ledger-result-state :deep(.n-result-header__title),
.ledger-result-state :deep(.n-result-header__description),
.ledger-result-state :deep(.n-result-footer) { text-align: center; }
.ledger-result-state :deep(.n-result-footer .ledger-page-actions) { justify-content: center; }
.ledger-state-panel h1,
.ledger-state-panel p { margin: 0; }
.ledger-state-panel h1 { color: var(--text-h); font-size: 1.35rem; }
.ledger-state-panel :deep(.n-result-header__title) { color: var(--text-h); }
.ledger-state-panel :deep(.n-result-footer) { margin-top: 18px; }
.ledger-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.ledger-summary-grid :deep(.n-statistic-value), .ledger-summary-value { display: block; margin-top: 8px; font-size: 1.55rem; line-height: 1.4; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.ledger-summary-label { color: var(--text-muted); font-size: .88rem; }
.ledger-section-description { margin: 6px 0 12px; color: var(--text-muted); font-size: .78rem; }
.ledger-summary-grid .ledger-section-description { margin: 8px 0 0; }
.ledger-section-heading { margin-bottom: 4px; }
.ledger-detail-card :deep(.n-card__content), .ledger-detail-movement :deep(.n-card__content), .ledger-detail-note :deep(.n-card__content) { padding: 16px; }
.ledger-movement-grid { padding: 14px; border-radius: 8px; background: var(--bg); }
.ledger-movement-grid > div + div { padding-left: 18px; border-left: 1px solid var(--border); }
.ledger-movement-grid > div:last-child strong, .is-positive { color: var(--nuvyn-positive, #15803d); }
.ledger-movement-grid > div:last-child strong.is-negative, .is-negative { color: var(--ledger-expense, #dc3f4d); }
.ledger-recent-list { padding: 0 12px; border-radius: 8px; background: var(--bg); }
.ledger-recent-row { gap: 12px; padding: 10px 0; }
.ledger-recent-row:first-child { border-top: 0; }
.ledger-recent-row > span { flex: 1; overflow-wrap: anywhere; }
.ledger-transaction-symbol { flex: 0 0 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; font-size: 1.2rem; font-style: normal; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.ledger-transaction-symbol.is-income { color: var(--nuvyn-positive, #15803d); background: color-mix(in srgb, var(--nuvyn-positive, #15803d) 10%, transparent); }
.ledger-transaction-symbol.is-expense { color: var(--ledger-expense, #dc3f4d); background: color-mix(in srgb, var(--ledger-expense, #dc3f4d) 10%, transparent); }
.ledger-account-info dl { gap: 0; }
.ledger-account-info dl div { padding: 11px 0; border-bottom: 1px solid var(--border); }
.ledger-account-info dl div:last-child { border-bottom: 0; }
.ledger-detail-note { min-height: 0; box-sizing: border-box; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-soft); }
.ledger-detail-header h1, .ledger-account-info dd, .ledger-detail-note p { overflow-wrap: anywhere; }
.ledger-detail-note p { text-align: left; }
@media (max-width: 900px) {
  .ledger-detail-grid { grid-template-columns: 1fr; }
  .ledger-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 650px) {
  .ledger-summary-grid { grid-template-columns: 1fr; }
  .ledger-movement-grid > div + div { padding: 12px 0 0; border-left: 0; border-top: 1px solid var(--border); }
  .ledger-account-page { padding: 24px 16px 48px; }
  .ledger-detail-header { grid-template-columns: 1fr; align-items: stretch; gap: 16px; }
  .ledger-account-hero-balance { text-align: left; }
  .ledger-account-hero-balance :deep(.n-statistic-value) { font-size: 1.85rem; }
  .ledger-page-actions > * { flex: 1 1 150px; }
  .ledger-detail-grid, .ledger-movement-grid { grid-template-columns: 1fr; }
  .ledger-detail-movement :deep(.n-card__content) { padding: 16px 13px; }
  .ledger-account-edit-modal-card { width: calc(100vw - 24px); max-height: 92vh; }
  .ledger-account-edit-modal-card :deep(.n-card__content) { padding: 21px 17px; }
}

/* Account detail visual system: a compact hero followed by a dashboard-like
   overview. The older detail rules above remain as shared fallbacks for the
   loading and error states; these selectors intentionally come last so the
   account view can evolve without changing those states. */
.ledger-account-page {
  --ledger-glass-surface: color-mix(in srgb, var(--bg-soft) 74%, transparent);
  --ledger-glass-tint: color-mix(in srgb, var(--accent) 3%, transparent);
  --ledger-glass-highlight: color-mix(in srgb, var(--text-h) 9%, transparent);
  --ledger-glass-shadow: color-mix(in srgb, var(--text-h) 8%, transparent);
  width: min(100%, 1240px);
  padding: 24px 28px 64px;
}
.ledger-account-detail { min-width: 0; }
.ledger-detail-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 28px;
  margin-bottom: 16px;
  padding: 8px 0 10px;
}
.ledger-detail-header .ledger-account-identity { display: flex; min-width: 0; align-items: center; gap: 20px; }
.ledger-detail-header .ledger-detail-account-icon { width: 76px; height: 76px; border-radius: 18px; }
.ledger-detail-header .ledger-account-identity-copy { min-width: 0; }
.ledger-detail-header .ledger-account-identity-copy h1 { overflow: hidden; margin: 0; color: var(--text-h); font-size: clamp(1.55rem, 2.4vw, 2rem); line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.ledger-detail-header .ledger-account-identity-copy p { margin: 8px 0 0; color: var(--text-muted); font-size: .82rem; }
.ledger-detail-header-actions { justify-content: flex-end; }
.ledger-action-trigger { display: inline-flex; }
.ledger-detail-hero {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(300px, .8fr);
  align-items: stretch;
  gap: 0;
  min-height: 138px;
  padding: 22px;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  border-radius: 12px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 4%, transparent), transparent 48%),
    color-mix(in srgb, var(--bg-soft) 82%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-h) 7%, transparent), 0 10px 30px color-mix(in srgb, var(--text-h) 7%, transparent);
  -webkit-backdrop-filter: saturate(145%) blur(18px);
  backdrop-filter: saturate(145%) blur(18px);
}
.ledger-account-identity { display: grid; min-width: 0; grid-template-columns: auto minmax(160px, 1fr) minmax(220px, .9fr); align-items: center; gap: 22px; }
.ledger-detail-account-icon { width: 88px; height: 88px; border-radius: 18px; }
.ledger-account-identity-copy { min-width: 0; }
.ledger-detail-title-row { display: grid; min-width: 0; gap: 8px; }
.ledger-account-name-label { color: var(--text-muted); font-size: .78rem; font-weight: 650; }
.ledger-detail-title-row h1 { overflow: hidden; margin: 0; color: var(--text-h); font-size: clamp(1.35rem, 2vw, 1.72rem); line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.ledger-account-identity-copy > p { margin: 8px 0 0; color: var(--text-muted); font-size: .82rem; }
.ledger-account-identity > .ledger-card-number { display: grid; min-height: 88px; align-content: center; gap: 8px; margin: 0; padding-left: 22px; border-left: 1px solid var(--border); }
.ledger-card-number span { color: var(--text-muted); font-size: .78rem; font-weight: 650; }
.ledger-card-number strong { overflow: hidden; color: var(--text-h); font: inherit; font-size: clamp(1.35rem, 2vw, 1.72rem); font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.ledger-card-number small { color: var(--text-muted); font-size: .7rem; line-height: 1.35; }
.ledger-account-hero-balance { display: grid; min-width: 0; min-height: 88px; align-content: center; padding: 0 28px; border-left: 1px solid var(--border); text-align: left; }
.ledger-account-hero-balance > span { color: var(--text-muted); font-size: .78rem; }
.ledger-account-hero-balance > span i { margin-left: 4px; color: var(--text-muted); font-size: .67rem; font-style: normal; }
.ledger-account-hero-balance > strong { display: block; margin-top: 6px; color: var(--text-h); font-size: clamp(1.65rem, 3vw, 2.1rem); line-height: 1.15; font-variant-numeric: tabular-nums; }
.ledger-account-hero-balance > p { margin: 8px 0 0; color: var(--text-muted); font-size: .76rem; }
.ledger-account-hero-balance > p em { margin-left: 4px; font-style: normal; font-weight: 650; }
.ledger-page-actions { display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: 9px; }
.ledger-primary-button,
.ledger-secondary-button { display: inline-flex; min-height: 32px; align-items: center; justify-content: center; box-sizing: border-box; padding: 6px 12px; border-radius: 8px; font: inherit; font-size: .78rem; font-weight: 650; line-height: 1; text-decoration: none; cursor: pointer; }
.ledger-primary-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.ledger-secondary-button { border: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 76%, transparent); color: var(--text-h); }
.ledger-secondary-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ledger-danger-button { border-color: color-mix(in srgb, var(--ledger-expense, #dc3f4d) 45%, var(--border)); color: var(--ledger-expense, #dc3f4d); }
.ledger-danger-button:hover:not(:disabled) { border-color: var(--ledger-expense, #dc3f4d); background: color-mix(in srgb, var(--ledger-expense, #dc3f4d) 7%, transparent); color: var(--ledger-expense, #dc3f4d); }
.ledger-primary-button:disabled,
.ledger-secondary-button:disabled { cursor: wait; opacity: .65; }
.ledger-form-error { margin: 0 0 14px; }
.ledger-metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.ledger-detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 334px); gap: 16px; align-items: stretch; margin-top: 16px; }
.ledger-detail-main-column,
.ledger-detail-side-column { display: grid; gap: 16px; min-width: 0; align-content: start; }
.ledger-detail-card { min-width: 0; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--border) 76%, transparent); border-radius: 12px; background: linear-gradient(135deg, var(--ledger-glass-tint), transparent 52%), var(--ledger-glass-surface); box-shadow: inset 0 1px 0 var(--ledger-glass-highlight), 0 10px 30px var(--ledger-glass-shadow); -webkit-backdrop-filter: saturate(145%) blur(18px); backdrop-filter: saturate(145%) blur(18px); }
.ledger-metric-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; }
.ledger-metric-item { display: flex; min-width: 0; min-height: 96px; align-items: center; gap: 15px; padding: 18px 20px; }
.ledger-metric-grid .ledger-metric-item + .ledger-metric-item { border-left: 1px solid var(--border); }
.ledger-metric-item + .ledger-metric-item { border-left: 1px solid var(--border); }
.ledger-metric-item > div { display: grid; min-width: 0; gap: 8px; }
.ledger-metric-item > div > span { overflow: hidden; color: var(--text-muted); font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.ledger-metric-item strong { color: var(--text-h); font-size: 1.12rem; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ledger-metric-item strong.is-income { color: var(--nuvyn-positive, #15803d); }
.ledger-metric-item strong.is-expense { color: var(--ledger-expense, #dc3f4d); }
.ledger-metric-item strong small { color: var(--text-muted); font-size: .68rem; font-weight: 500; }
.ledger-metric-icon { display: grid; width: 44px; height: 44px; flex: 0 0 auto; place-items: center; border-radius: 13px; background: color-mix(in srgb, var(--accent) 9%, transparent); color: var(--accent); font-size: 1.42rem; font-weight: 500; }
.ledger-metric-icon.is-income { background: color-mix(in srgb, #2da76e 9%, transparent); color: #2da76e; }
.ledger-metric-icon.is-expense { background: color-mix(in srgb, #d94a58 9%, transparent); color: #d94a58; }
.ledger-metric-icon.is-net { background: color-mix(in srgb, var(--accent) 9%, transparent); color: var(--accent); }
.ledger-metric-icon.is-count { background: color-mix(in srgb, #7f75ee 9%, transparent); color: #7f75ee; }
.ledger-balance-trend { padding: 18px 20px 14px; }
.ledger-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.ledger-section-heading h2,
.ledger-side-heading h2 { margin: 0; color: var(--text-h); font-size: .98rem; }
.ledger-section-heading a,
.ledger-side-heading button { color: var(--accent); font: inherit; font-size: .78rem; text-decoration: none; }
.ledger-side-heading button { padding: 0; border: 0; background: transparent; cursor: pointer; }
.ledger-side-heading button:hover { color: var(--accent-hover); }
.ledger-trend-range { width: 120px; visibility: hidden; opacity: 0; transition: opacity .18s ease, visibility .18s ease; }
.ledger-balance-trend:hover .ledger-trend-range,
.ledger-balance-trend:focus-within .ledger-trend-range { visibility: visible; opacity: 1; }
.ledger-trend-chart { min-height: 205px; padding-left: 0; }
.ledger-balance-trend-reveal { width: 100%; height: 205px; overflow: hidden; }
.ledger-balance-trend-plot { width: 100%; height: 205px; }
.ledger-recent-transactions { overflow: hidden; padding: 18px 20px 14px; }
.ledger-recent-table { overflow-x: auto; }
.ledger-recent-table-head,
.ledger-recent-row { display: grid; grid-template-columns: minmax(108px, .9fr) 58px minmax(60px, .7fr) minmax(120px, 1.25fr) minmax(96px, .85fr) minmax(96px, .85fr); align-items: center; gap: 12px; min-width: 680px; }
.ledger-recent-table-head { padding: 0 10px 9px; color: var(--text-muted); font-size: .7rem; }
.ledger-recent-row { min-height: 48px; padding: 8px 10px; border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent); color: var(--text); font-size: .76rem; }
.ledger-recent-row time { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.ledger-recent-row strong { color: var(--text-h); font-size: .8rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ledger-recent-row strong.is-income { color: var(--nuvyn-positive, #15803d); }
.ledger-recent-row strong.is-expense { color: var(--ledger-expense, #dc3f4d); }
.ledger-recent-table-head > :nth-child(5),
.ledger-recent-table-head > :nth-child(6),
.ledger-recent-row > :nth-child(5),
.ledger-recent-row > :nth-child(6) { justify-self: end; text-align: right; }
.ledger-recent-table-head > :nth-child(2),
.ledger-recent-row > :nth-child(2) { justify-self: center; text-align: center; }
.ledger-transaction-badge { justify-self: start; padding: 3px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); font-size: .68rem; white-space: nowrap; }
.ledger-transaction-badge.is-income { background: color-mix(in srgb, #2da76e 13%, transparent); color: #168451; }
.ledger-transaction-badge.is-expense { background: color-mix(in srgb, #d94a58 13%, transparent); color: #c43443; }
.ledger-transaction-badge.is-transfer { background: color-mix(in srgb, var(--nuvyn-info, #005fb8) 11%, transparent); color: var(--nuvyn-info, #005fb8); }
.ledger-transaction-category,
.ledger-transaction-summary,
.ledger-transaction-balance { overflow: hidden; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; }
.ledger-transaction-summary { color: var(--text-h); }
.ledger-empty-copy { margin: 34px 0; color: var(--text-muted); font-size: .82rem; text-align: center; }
.ledger-detail-side-column { height: 100%; grid-template-rows: auto minmax(0, 1fr); }
.ledger-account-info,
.ledger-detail-note { padding: 18px 20px; }
.ledger-side-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.ledger-account-info dl { display: grid; gap: 0; margin: 0; }
.ledger-account-info dl div { display: flex; justify-content: space-between; gap: 18px; min-width: 0; padding: 8px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 78%, transparent); font-size: .78rem; }
.ledger-account-info dl div:last-child { border-bottom: 0; }
.ledger-account-info dt { color: var(--text-muted); }
.ledger-account-info dd { overflow: hidden; margin: 0; color: var(--text-h); text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.ledger-detail-note { min-height: 0; }
.ledger-detail-note p { margin: 0; color: var(--text-muted); font-size: .82rem; line-height: 1.6; white-space: pre-wrap; }
.is-positive { color: var(--nuvyn-positive, #15803d) !important; }
.is-negative { color: var(--ledger-expense, #dc3f4d) !important; }
@media (max-width: 1120px) {
  .ledger-detail-hero { grid-template-columns: minmax(270px, 1fr) minmax(180px, .75fr); }
}
@media (max-width: 900px) {
  .ledger-detail-header { grid-template-columns: 1fr; align-items: stretch; gap: 16px; }
  .ledger-detail-header-actions { justify-content: flex-start; }
  .ledger-metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ledger-detail-grid { grid-template-columns: 1fr; }
  .ledger-detail-side-column { height: auto; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: auto; }
  .ledger-account-info { grid-row: span 2; }
}
@media (max-width: 680px) {
  .ledger-account-page { padding: 20px 16px 48px; }
  .ledger-result-state { min-height: calc(100vh - var(--navbar-h, 52px) - 68px); }
  .ledger-detail-header .ledger-detail-account-icon { width: 68px; height: 68px; }
  .ledger-detail-header .ledger-account-identity-copy h1 { font-size: 1.5rem; }
  .ledger-detail-header-actions > * { flex: 1 1 120px; }
  .ledger-metric-grid { grid-template-columns: 1fr; }
  .ledger-detail-hero { grid-template-columns: 1fr; gap: 20px; padding: 18px; }
  .ledger-account-identity { grid-template-columns: auto minmax(0, 1fr); }
  .ledger-account-identity > .ledger-card-number { grid-column: 2; min-height: 0; margin-top: -8px; padding-left: 0; border-left: 0; }
  .ledger-account-hero-balance { padding: 17px 0 0; border-top: 1px solid var(--border); border-right: 0; border-left: 0; }
  .ledger-page-actions { justify-content: flex-start; }
  .ledger-metric-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ledger-metric-item { padding: 16px 14px; }
  .ledger-metric-item:nth-child(3) { border-left: 0; border-top: 1px solid var(--border); }
  .ledger-metric-item:nth-child(4) { border-top: 1px solid var(--border); }
  .ledger-trend-range { width: min(120px, 100%); visibility: visible; opacity: 1; }
  .ledger-balance-trend,
  .ledger-recent-transactions,
  .ledger-account-info,
  .ledger-detail-note { padding: 16px 14px; }
  .ledger-detail-side-column { grid-template-columns: 1fr; }
  .ledger-account-info { grid-row: auto; }
  .ledger-detail-note { min-height: 190px; }
}
@media (max-width: 440px) {
  .ledger-detail-title-row { align-items: flex-start; flex-direction: column; gap: 7px; }
  .ledger-detail-account-icon { width: 68px; height: 68px; }
  .ledger-metric-item { gap: 9px; }
  .ledger-metric-icon { width: 36px; height: 36px; border-radius: 10px; font-size: 1.1rem; }
  .ledger-metric-item strong { font-size: .95rem; }
}
</style>
