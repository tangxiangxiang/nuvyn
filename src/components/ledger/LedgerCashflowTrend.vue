<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { BarChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { init, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import type { BarSeriesOption } from 'echarts/charts'
import type {
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption,
} from 'echarts/components'
import type { ComposeOption, ECharts } from 'echarts/core'
import type { LedgerTrendPoint } from '../../../shared/ledgerProtocol'
import { currencyExponentFor, formatLedgerMoney, formatLedgerSignedMoney } from '../../features/ledger/money'
import { useTheme } from '../../composables/useTheme'

use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

type LedgerTrendChartOption = ComposeOption<
  | BarSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
>

const props = defineProps<{
  readonly trend: readonly LedgerTrendPoint[]
  readonly currency: string
}>()

const SERIES_LABEL = { income: '收入', expense: '支出' } as const
const BALANCE_LABEL = '收支结余'

/**
 * The chart never re-derives money. It renders the server's integer minor
 * amounts directly and only formats them at the axis, tooltip and table
 * boundary, so no financial value makes a lossy trip through the plot.
 */
function money(minor: number): string {
  return formatLedgerMoney(minor, props.currency)
}

function signedMoney(minor: number): string {
  return formatLedgerSignedMoney(minor, props.currency)
}

/**
 * ECharts owns its axis ticks, which are plain numbers rather than the
 * server's integer minor amounts. Round before formatting so a fractional or
 * out-of-range tick can never reach the minor-unit formatter.
 */
function axisMoney(value: number): string {
  if (!Number.isFinite(value)) return ''
  const minor = Math.round(value)
  if (!Number.isSafeInteger(minor)) return ''
  return formatLedgerMoney(minor, props.currency)
}

function monthParts(month: string): { readonly year: string; readonly month: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  return match === null ? null : { year: match[1], month: match[2] }
}

/**
 * The tooltip head and the screen-reader table are read without the axis for
 * context, so their month label always carries the year.
 */
function fullMonthLabel(month: string): string {
  const parts = monthParts(month)
  if (parts === null) return month
  return `${parts.year}年${Number(parts.month)}月`
}

const axisLabels = computed(() => props.trend.map((point) => {
  const parts = monthParts(point.month)
  if (parts === null) return point.month
  return `${parts.year}/${parts.month}`
}))

const allZero = computed(() => props.trend.every((point) => point.incomeMinor === 0
  && point.expenseMinor === 0
  && point.balanceMinor === 0))

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => (
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;'
  ))
}

/**
 * ECharts renders the tooltip outside this component's scoped styles, so the
 * row layout has to travel inline with the markup.
 */
function tooltipRow(label: string, value: string, swatch: string): string {
  return '<div style="display:flex;align-items:center;gap:8px;margin-top:4px">'
    + `<span style="width:8px;height:8px;border-radius:2px;flex:0 0 auto;background:${escapeHtml(swatch)}"></span>`
    + `<span style="flex:1 1 auto">${escapeHtml(label)}</span>`
    + `<span style="font-weight:650">${escapeHtml(value)}</span>`
    + '</div>'
}

function tooltipFormatter(params: unknown): string {
  const entry = Array.isArray(params) ? params[0] : params
  const dataIndex = (entry as { dataIndex?: unknown } | null | undefined)?.dataIndex
  if (typeof dataIndex !== 'number') return ''
  const point = props.trend[dataIndex]
  if (point === undefined) return ''
  const palette = currentPalette()
  return `<div style="font-weight:650">${escapeHtml(fullMonthLabel(point.month))}</div>`
    + tooltipRow(SERIES_LABEL.income, money(point.incomeMinor), palette.income)
    + tooltipRow(SERIES_LABEL.expense, money(point.expenseMinor), palette.expense)
    + tooltipRow(BALANCE_LABEL, signedMoney(point.balanceMinor), palette.muted)
}

interface TrendPalette {
  readonly income: string
  readonly expense: string
  readonly text: string
  readonly muted: string
  readonly border: string
  readonly grid: string
  readonly surface: string
}

/** Mirrors the light tokens so a stylesheet-less environment still renders. */
const FALLBACK_PALETTE: TrendPalette = {
  income: '#18794e',
  expense: '#b42318',
  text: '#111827',
  muted: '#6b7280',
  border: '#e5e7eb',
  grid: '#edf0f4',
  surface: '#ffffff',
}

const host = ref<HTMLElement | null>(null)
const plot = ref<HTMLElement | null>(null)
const chart = shallowRef<ECharts | null>(null)
const { theme } = useTheme()
let resizeObserver: ResizeObserver | null = null

/**
 * ECharts cannot read CSS custom properties, so the appearance tokens are
 * resolved from the live host element instead of being duplicated in JS.
 */
function currentPalette(): TrendPalette {
  const element = host.value
  if (element === null || typeof getComputedStyle !== 'function') return FALLBACK_PALETTE
  const styles = getComputedStyle(element)
  const token = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    income: token('--ledger-trend-income', FALLBACK_PALETTE.income),
    expense: token('--ledger-trend-expense', FALLBACK_PALETTE.expense),
    text: token('--text-h', FALLBACK_PALETTE.text),
    muted: token('--text-muted', FALLBACK_PALETTE.muted),
    border: token('--border', FALLBACK_PALETTE.border),
    grid: token('--ledger-trend-grid', FALLBACK_PALETTE.grid),
    surface: token('--bg', FALLBACK_PALETTE.surface),
  }
}

function buildOption(): LedgerTrendChartOption {
  const palette = currentPalette()
  return {
    animationDuration: 280,
    grid: { top: 38, left: 8, right: 8, bottom: 4, containLabel: true },
    legend: {
      top: 0,
      left: 'center',
      icon: 'roundRect',
      itemWidth: 9,
      itemHeight: 9,
      itemGap: 14,
      textStyle: { color: palette.muted, fontSize: 11 },
      data: [SERIES_LABEL.income, SERIES_LABEL.expense],
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: palette.border, width: 1, type: 'dashed' } },
      backgroundColor: palette.surface,
      borderColor: palette.border,
      extraCssText: 'box-shadow:0 8px 24px rgba(0,0,0,.08);border-radius:8px',
      textStyle: { color: palette.text, fontSize: 12 },
      formatter: tooltipFormatter,
    },
    xAxis: {
      type: 'category',
      data: axisLabels.value,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.border } },
      axisLabel: { color: palette.muted, fontSize: 11, interval: 0, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      // A trend of twelve all-zero months has no range for ECharts to scale, so
      // pin one major unit of headroom rather than letting the axis collapse.
      ...(allZero.value ? { min: 0, max: 10 ** currencyExponentFor(props.currency) } : {}),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.muted, fontSize: 11, formatter: axisMoney },
      splitLine: { lineStyle: { color: palette.grid, type: 'solid' } },
    },
    series: [
      {
        name: SERIES_LABEL.income,
        type: 'bar',
        barMaxWidth: 20,
        itemStyle: { color: palette.income, borderRadius: [3, 3, 0, 0] },
        data: props.trend.map((point) => point.incomeMinor),
      },
      {
        name: SERIES_LABEL.expense,
        type: 'bar',
        barMaxWidth: 20,
        itemStyle: { color: palette.expense, borderRadius: [3, 3, 0, 0] },
        data: props.trend.map((point) => point.expenseMinor),
      },
    ],
  }
}

/**
 * `buildOption` always produces a complete, self-contained option, so it
 * replaces the previous one rather than merging into it.
 *
 * Merging would carry properties the new option no longer sets. The axis
 * bounds are the live case: leaving an all-zero trend drops the pinned
 * `min`/`max`, and a merge would keep the old one-major-unit ceiling while the
 * series jumped to a real amount — the first transaction a new user records
 * would render against a stale axis.
 */
function applyOption(): void {
  chart.value?.setOption(buildOption(), { notMerge: true })
}

function handleWindowResize(): void {
  chart.value?.resize()
}

/**
 * The section is laid out by the Dashboard grid, so the container can change
 * width without the window ever resizing.
 */
function observeResize(element: HTMLElement): void {
  if (typeof ResizeObserver !== 'function') {
    window.addEventListener('resize', handleWindowResize)
    return
  }
  resizeObserver = new ResizeObserver(handleWindowResize)
  resizeObserver.observe(element)
}

function createChart(): void {
  const element = plot.value
  if (element === null || chart.value !== null) return
  chart.value = init(element)
  observeResize(element)
  applyOption()
}

function destroyChart(): void {
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', handleWindowResize)
  chart.value?.dispose()
  chart.value = null
}

const hasTrend = computed(() => props.trend.length > 0)

onMounted(() => {
  if (hasTrend.value) createChart()
})

// Scope and date changes reuse the live instance; only an empty trend, which
// renders no container at all, may tear it down.
watch(hasTrend, async (present) => {
  await nextTick()
  if (present) createChart()
  else destroyChart()
})

watch([() => props.trend, () => props.currency, () => theme.value], () => {
  applyOption()
}, { flush: 'post' })

onBeforeUnmount(destroyChart)
</script>

<template>
  <div ref="host" class="ledger-cashflow-trend" data-testid="ledger-cashflow-trend">
    <template v-if="trend.length">
      <div
        ref="plot"
        class="ledger-cashflow-trend-plot"
        data-testid="ledger-cashflow-trend-canvas"
        aria-hidden="true"
      />
      <!-- The visually-hidden rule sits on a wrapper rather than the table:
           `width: 1px` + `overflow: hidden` is not reliably honoured by a
           `display: table` box, and a plain block is what the rule is for. -->
      <div class="sr-only" data-testid="ledger-cashflow-trend-table">
        <table>
          <caption>收支趋势：每月收入、支出与收支结余</caption>
          <thead>
            <tr>
              <th scope="col">月份</th>
              <th scope="col">收入</th>
              <th scope="col">支出</th>
              <th scope="col">收支结余</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="point in trend" :key="point.month">
              <th scope="row">{{ fullMonthLabel(point.month) }}</th>
              <td>{{ money(point.incomeMinor) }}</td>
              <td>{{ money(point.expenseMinor) }}</td>
              <td>{{ signedMoney(point.balanceMinor) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else class="ledger-inline-empty" data-testid="ledger-cashflow-trend-empty">
      还没有趋势数据，开始记账后这里会逐步出现变化。
    </p>
  </div>
</template>

<style scoped>
/* Reuses the Ledger income/expense semantics already on the Dashboard, lifted
   in dark mode so the bars stay legible on the dark surface. Follows the
   token pattern in style.css: baseline, OS preference, then the explicit
   data-theme pin. */
.ledger-cashflow-trend {
  --ledger-trend-income: #18794e;
  --ledger-trend-expense: #b42318;
  --ledger-trend-grid: #edf0f4;
}
@media (prefers-color-scheme: dark) {
  .ledger-cashflow-trend {
    --ledger-trend-income: #4cc38a;
    --ledger-trend-expense: #f87171;
    --ledger-trend-grid: #2b3442;
  }
}
:root[data-theme='light'] .ledger-cashflow-trend {
  --ledger-trend-income: #18794e;
  --ledger-trend-expense: #b42318;
  --ledger-trend-grid: #edf0f4;
}
:root[data-theme='dark'] .ledger-cashflow-trend {
  --ledger-trend-income: #4cc38a;
  --ledger-trend-expense: #f87171;
  --ledger-trend-grid: #2b3442;
}
.ledger-cashflow-trend-plot { width: 100%; height: 280px; }
.ledger-inline-empty { margin: 0; color: var(--text-muted); font-size: .78rem; line-height: 1.45; }
@media (max-width: 760px) {
  .ledger-cashflow-trend-plot { height: 230px; }
}
</style>
