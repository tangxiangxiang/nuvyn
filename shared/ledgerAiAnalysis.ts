import type { LedgerCashflowSummary, LedgerTrendPoint } from './ledgerProtocol.js'

export const LEDGER_AI_ANALYSIS_KINDS = ['cashflow', 'spending', 'trend', 'repayment'] as const
export type LedgerAiAnalysisKind = typeof LEDGER_AI_ANALYSIS_KINDS[number]

export interface LedgerAiAnalysisScope {
  readonly kind: LedgerAiAnalysisKind
  /** Inclusive dates in the Ledger time zone. */
  readonly from: string
  readonly to: string
}

export interface LedgerAiAnalysisApproval {
  readonly id: string
  readonly scope: LedgerAiAnalysisScope
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
