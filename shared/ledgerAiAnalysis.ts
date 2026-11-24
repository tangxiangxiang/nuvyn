import type { LedgerCashflowSummary, LedgerTrendPoint } from './ledgerProtocol.js'

export const LEDGER_AI_ANALYSIS_KINDS = ['cashflow', 'spending', 'trend', 'repayment'] as const
export type LedgerAiAnalysisKind = typeof LEDGER_AI_ANALYSIS_KINDS[number]

export interface LedgerAiAnalysisScope {
  readonly kind: LedgerAiAnalysisKind
  /** Inclusive dates in the Ledger time zone. */
  readonly from: string
  readonly to: string
}

export interface LedgerAiAnalysisSnapshot {
  readonly version: 1
  readonly generatedAt: string
  readonly currency: string
  readonly currencyExponent: number
  readonly timezone: string
  readonly scope: LedgerAiAnalysisScope
  readonly activeTransactionCount: number
  readonly excludedFromStatisticsCount: number
  readonly summary: LedgerCashflowSummary & {
    readonly balanceAfterRepaymentMinor: number
    readonly repaymentInterestNetMinor: number
    readonly repaymentOutflowMinor: number
    readonly withdrawalFeeMinor: number
    /** Period cash movement including any repayments excluded from statistics. */
    readonly actualRepaymentOutflowMinor?: number
  }
  readonly expenseCategories?: readonly {
    readonly name: string
    readonly amountMinor: number
    /** Signed percentage in hundredths of a percent, relative to net expense. */
    readonly shareBasisPoints: number | null
  }[]
  readonly omittedExpenseCategoryCount?: number
  readonly trend?: readonly (LedgerTrendPoint & { readonly balanceAfterRepaymentMinor: number })[]
  readonly recurringExpenseExamples?: readonly {
    readonly payee: string
    readonly category: string
    readonly count: number
    readonly totalMinor: number
  }[]
  readonly largestExpenses?: readonly {
    readonly occurredAt: number
    readonly category: string | null
    readonly amountMinor: number
    readonly payee?: string
  }[]
}

/** Live execution phases. The chat stream's done/error events end the run. */
export const FINANCE_AGENT_PHASES = ['preparing', 'reading', 'analyzing'] as const
export type FinanceAgentPhase = typeof FINANCE_AGENT_PHASES[number]
export type FinanceAgentProgress = { type: 'finance_progress'; phase: FinanceAgentPhase }

/** Display metadata only. Never includes a tool's arguments or result. */
const financeOperations = ['accounts', 'details', ...LEDGER_AI_ANALYSIS_KINDS, 'memory_add', 'memory_update', 'memory_delete', 'query'] as const
const financeStatuses = ['running', 'success', 'failed', 'cancelled', 'reused'] as const
export type FinanceActivity = {
  id: number
  operation: typeof financeOperations[number]
  status: typeof financeStatuses[number]
}
export type FinanceActivityEvent = { type: 'finance_activity'; activity: FinanceActivity }

export function financeOperation(kind: unknown): FinanceActivity['operation'] {
  return financeOperations.find(operation => operation === kind) ?? 'query'
}

export function parseFinanceActivity(value: unknown): FinanceActivity | undefined {
  if (!value || typeof value !== 'object' || !('id' in value) || !('status' in value) || !('operation' in value)) return
  const { id, status, operation } = value
  const recognizedStatus = financeStatuses.find(item => item === status)
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !recognizedStatus) return
  return { id, operation: financeOperation(operation), status: recognizedStatus }
}
