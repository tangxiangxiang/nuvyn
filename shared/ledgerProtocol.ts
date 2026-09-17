/**
 * Transport-safe Ledger contracts.
 *
 * Database rows use snake_case and nullable discriminator columns. These
 * camelCase DTOs are the shared public boundary for the future API and UI;
 * persistence/domain conversion belongs on the server.
 */

export type LedgerAccountType =
  | 'cash'
  | 'bank'
  | 'wallet'
  | 'credit_card'
  | 'loan'
  | 'other'

export type LedgerAccountNature = 'asset' | 'liability'
export const LEDGER_BUILTIN_ACCOUNT_ICONS = [
  { id: 'custom_builtin_boc', name: '中国银行', src: '/account-icons/boc.svg' },
  { id: 'custom_builtin_icbc', name: '工商银行', src: '/account-icons/icbc.svg' },
  { id: 'custom_builtin_cmb', name: '招商银行', src: '/account-icons/cmb.svg' },
  { id: 'custom_builtin_abc', name: '农业银行', src: '/account-icons/abc.svg' },
  { id: 'custom_builtin_psbc', name: '邮政银行', src: '/account-icons/psbc.svg' },
  { id: 'custom_builtin_ccb', name: '建设银行', src: '/account-icons/ccb.svg' },
  { id: 'custom_builtin_wechat_pay', name: '微信钱包', src: '/account-icons/wechat-pay.svg' },
  { id: 'custom_builtin_alipay', name: '支付宝', src: '/account-icons/alipay.svg' },
  { id: 'custom_builtin_unionpay', name: '云闪付', src: '/account-icons/unionpay.svg' },
] as const

export type LedgerBuiltinAccountIcon = typeof LEDGER_BUILTIN_ACCOUNT_ICONS[number]['id']
export type LedgerAccountIcon = 'wallet' | 'credit_card' | 'cash' | 'building_bank' | 'briefcase' | LedgerBuiltinAccountIcon | `custom_${string}`

export const LEDGER_DEFAULT_ACCOUNT_ICONS: readonly LedgerAccountIcon[] = [
  'wallet', 'credit_card', 'cash', 'building_bank', 'briefcase',
  ...LEDGER_BUILTIN_ACCOUNT_ICONS.map(({ id }) => id),
]

export const LEDGER_BUILTIN_ACCOUNT_ICON_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  LEDGER_BUILTIN_ACCOUNT_ICONS.map(({ id, name }) => [id, name]),
)
export interface LedgerAccountIconConfig {
  readonly defaultIcon: LedgerAccountIcon
  readonly availableIcons: readonly LedgerAccountIcon[]
  /** User icons removed from the picker but retained for restore/permanent deletion. */
  readonly archivedIcons?: readonly LedgerAccountIcon[]
  readonly customIcons: Readonly<Record<string, string>>
  readonly customIconNames: Readonly<Record<string, string>>
}
export type LedgerCategoryKind = 'income' | 'expense'
export type LedgerCategorySystemKey = 'interest' | 'fee'
export const LEDGER_BUILTIN_CATEGORY_ICONS: readonly {
  readonly kind: LedgerCategoryKind
  readonly name: string
  readonly id: LedgerAccountIcon
  readonly sortOrder: number
  readonly systemKey?: LedgerCategorySystemKey
}[] = [
  { kind: 'income', name: '工资', id: 'custom_builtin_category_income_salary', sortOrder: 1 },
  { kind: 'income', name: '奖金', id: 'custom_builtin_category_income_bonus', sortOrder: 2 },
  { kind: 'income', name: '兼职', id: 'custom_builtin_category_income_part_time', sortOrder: 3 },
  { kind: 'income', name: '投资收益', id: 'custom_builtin_category_income_investment', sortOrder: 4 },
  { kind: 'income', name: '红包 / 礼金', id: 'custom_builtin_category_income_red_packet', sortOrder: 5 },
  { kind: 'income', name: '退款', id: 'custom_builtin_category_income_refund', sortOrder: 6 },
  { kind: 'income', name: '其他', id: 'custom_builtin_category_income_other', sortOrder: 7 },
  { kind: 'expense', name: '餐饮', id: 'custom_builtin_category_expense_food', sortOrder: 1 },
  { kind: 'expense', name: '交通', id: 'custom_builtin_category_expense_transport', sortOrder: 2 },
  { kind: 'expense', name: '购物', id: 'custom_builtin_category_expense_shopping', sortOrder: 3 },
  { kind: 'expense', name: '日用', id: 'custom_builtin_category_expense_daily', sortOrder: 4 },
  { kind: 'expense', name: '住房', id: 'custom_builtin_category_expense_home', sortOrder: 5 },
  { kind: 'expense', name: '通讯', id: 'custom_builtin_category_expense_communication', sortOrder: 6 },
  { kind: 'expense', name: '订阅', id: 'custom_builtin_category_expense_subscription', sortOrder: 7 },
  { kind: 'expense', name: '娱乐', id: 'custom_builtin_category_expense_entertainment', sortOrder: 8 },
  { kind: 'expense', name: '医疗', id: 'custom_builtin_category_expense_medical', sortOrder: 9 },
  { kind: 'expense', name: '教育', id: 'custom_builtin_category_expense_education', sortOrder: 10 },
  { kind: 'expense', name: '旅行', id: 'custom_builtin_category_expense_travel', sortOrder: 11 },
  { kind: 'expense', name: '人情往来', id: 'custom_builtin_category_expense_gift', sortOrder: 12 },
  { kind: 'expense', name: '保险', id: 'custom_builtin_category_expense_insurance', sortOrder: 13 },
  { kind: 'expense', name: '利息', id: 'custom_builtin_category_expense_interest', sortOrder: 14, systemKey: 'interest' },
  { kind: 'expense', name: '手续费', id: 'custom_builtin_category_expense_fee', sortOrder: 15, systemKey: 'fee' },
  { kind: 'expense', name: '其他', id: 'custom_builtin_category_expense_other', sortOrder: 16 },
] as const
export type LedgerTransactionType = 'income' | 'expense' | 'transfer' | 'adjustment'
export type LedgerTransactionFilterType = 'income' | 'expense' | 'transfer'
export type LedgerTransferKind = 'general' | 'repayment' | 'withdrawal'
export type LedgerTransferFeeMode = 'extra' | 'deducted'
export type LedgerPeriodName = 'today' | 'week' | 'month' | 'year'
export type LedgerOverviewScope = LedgerPeriodName | 'all'

export interface LedgerSettingsDto {
  readonly baseCurrency: string
  readonly currencyExponent: number
  readonly timezone: string
  /** Monotonic lifecycle marker; never inferred from an Account list. */
  readonly hasCreatedAccount: boolean
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly accountIcons?: LedgerAccountIconConfig
}

export interface LedgerAccountDto {
  readonly id: string
  readonly name: string
  readonly type: LedgerAccountType
  readonly nature: LedgerAccountNature
  readonly icon?: LedgerAccountIcon
  readonly openingBalanceMinor: number
  readonly openingDate: string
  readonly currency: string
  readonly currencyExponent: number
  readonly note: string
  readonly cardNumber?: string
  readonly archivedAt: number | null
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly currentBalanceMinor: number
}

export interface LedgerCategoryDto {
  readonly id: string
  readonly kind: LedgerCategoryKind
  readonly name: string
  readonly normalizedName: string
  /** True when the category is a built-in default protected from lifecycle changes. */
  readonly systemKey?: LedgerCategorySystemKey
  readonly protected?: boolean
  readonly icon?: LedgerAccountIcon
  readonly archivedAt: number | null
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
}

interface LedgerTransactionDtoBase {
  readonly id: string
  /** Links atomic rows that belong to one product-level operation. */
  readonly groupId?: string
  readonly amountMinor: number
  readonly occurredAt: number
  readonly location?: string
  readonly note: string
  readonly deletedAt: number | null
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface LedgerTransferBundleSummary {
  readonly chargeMinor: number
  readonly totalMinor: number
}

export interface LedgerIncomeTransactionDto extends LedgerTransactionDtoBase {
  readonly type: 'income'
  readonly accountId: string
  readonly categoryId: string
  readonly payee: string
}

export interface LedgerExpenseTransactionDto extends LedgerTransactionDtoBase {
  readonly type: 'expense'
  readonly accountId: string
  readonly categoryId: string
  readonly payee: string
}

export interface LedgerTransferTransactionDto extends LedgerTransactionDtoBase {
  readonly type: 'transfer'
  readonly transferKind: LedgerTransferKind
  readonly feeMode?: LedgerTransferFeeMode
  /** Present on read projections when a companion expense is attached. */
  readonly bundle?: LedgerTransferBundleSummary
  readonly fromAccountId: string
  readonly toAccountId: string
  readonly payee: string
}

export interface LedgerAdjustmentTransactionDto extends LedgerTransactionDtoBase {
  readonly type: 'adjustment'
  readonly accountId: string
  readonly adjustmentCalculatedBalanceMinor: number
  readonly adjustmentTargetBalanceMinor: number
}

export type LedgerTransactionDto =
  | LedgerIncomeTransactionDto
  | LedgerExpenseTransactionDto
  | LedgerTransferTransactionDto
  | LedgerAdjustmentTransactionDto

export interface LedgerAdjustmentAppliedDto {
  readonly adjustment: LedgerAdjustmentTransactionDto
  readonly account: LedgerAccountDto
  readonly noOp: false
}

export interface LedgerAdjustmentNoOpDto {
  readonly adjustment: null
  readonly account: LedgerAccountDto
  readonly noOp: true
}

export type LedgerAdjustmentMutationDto =
  | LedgerAdjustmentAppliedDto
  | LedgerAdjustmentNoOpDto

export interface LedgerIncomeCreateRequest {
  readonly type: 'income'
  readonly amountMinor: number
  readonly accountId: string
  readonly categoryId: string
  readonly occurredAt: number
  readonly location?: string
  readonly payee: string
  readonly note: string
}

export interface LedgerExpenseCreateRequest {
  readonly type: 'expense'
  readonly amountMinor: number
  readonly accountId: string
  readonly categoryId: string
  readonly occurredAt: number
  readonly location?: string
  readonly payee: string
  readonly note: string
}

export interface LedgerTransferCreateRequest {
  readonly type: 'transfer'
  readonly transferKind?: LedgerTransferKind
  /** Principal, or requested withdrawal amount before a fee is applied. */
  readonly amountMinor: number
  /** Optional companion expense. It is never included in amountMinor. */
  readonly feeMinor?: number
  /** Only applies to withdrawal fees; defaults to extra during migration. */
  readonly feeMode?: LedgerTransferFeeMode
  readonly fromAccountId: string
  readonly toAccountId: string
  readonly occurredAt: number
  readonly location?: string
  readonly payee: string
  readonly note: string
}

export interface LedgerAdjustmentCreateRequest {
  readonly type: 'adjustment'
  readonly accountId: string
  readonly targetBalanceMinor: number
  readonly expectedCalculatedBalanceMinor: number
  readonly occurredAt: number
  readonly location?: string
  readonly note: string
}

export type LedgerTransactionCreateRequest =
  | LedgerIncomeCreateRequest
  | LedgerExpenseCreateRequest
  | LedgerTransferCreateRequest
  | LedgerAdjustmentCreateRequest

export interface LedgerSettingsCreateRequest {
  readonly baseCurrency: string
  readonly timezone: string
}

export interface LedgerAccountCreateRequest {
  readonly name: string
  readonly type: LedgerAccountType
  readonly nature: LedgerAccountNature
  readonly icon?: LedgerAccountIcon
  readonly openingBalanceMinor: number
  readonly openingDate: string
  readonly currency: string
  readonly note: string
  readonly cardNumber?: string
}

export interface LedgerCategoryCreateRequest {
  readonly kind: LedgerCategoryKind
  readonly name: string
  readonly icon?: LedgerAccountIcon
}

export interface LedgerAdjustmentEndpointRequest {
  readonly targetBalanceMinor: number
  readonly expectedCalculatedBalanceMinor: number
  readonly occurredAt: number
  readonly note: string
}

export interface LedgerPageInfo {
  readonly nextCursor: string | null
  /** Total matching rows before pagination. Present on the global transaction list. */
  readonly total?: number
  /** Matching income total before pagination. Present on the global transaction list. */
  readonly incomeMinor?: number
  /** Matching expense total before pagination. Present on the global transaction list. */
  readonly expenseMinor?: number
}

/** The decoded keyset position used by the Ledger transaction query. */
export interface LedgerTransactionCursor {
  readonly occurredAt: number
  readonly createdAt: number
  readonly id: string
}

export interface LedgerTransactionQuery {
  readonly type?: LedgerTransactionFilterType | 'all'
  readonly accountId?: string
  readonly categoryId?: string
  readonly groupId?: string
  readonly from?: number
  readonly to?: number
  readonly search?: string
  readonly includeDeleted?: boolean
  readonly limit?: number
  readonly cursor?: string
  readonly offset?: number
}

export interface LedgerTransactionPageDto {
  readonly transactions: readonly LedgerTransactionDto[]
  readonly page: LedgerPageInfo
}

export interface LedgerPeriodSummary {
  readonly period: LedgerPeriodName
  readonly startAt: number
  readonly endAt: number
  readonly incomeMinor: number
  readonly expenseMinor: number
  readonly balanceMinor: number
}

export interface LedgerTrendPoint {
  readonly month: string
  readonly startAt: number
  readonly endAt: number
  readonly incomeMinor: number
  readonly expenseMinor: number
  readonly balanceMinor: number
}

export interface LedgerCategorySlice {
  readonly categoryId: string
  readonly name: string
  readonly kind: LedgerCategoryKind
  readonly amountMinor: number
}

export interface LedgerCashflowSummary {
  readonly incomeMinor: number
  readonly expenseMinor: number
  readonly balanceMinor: number
}

export interface LedgerAccountSummary extends LedgerAccountDto {
  readonly balanceIncreaseMinor: number
  readonly balanceDecreaseMinor: number
}

export interface LedgerOverviewContext {
  readonly anchorDate: string
  readonly todayDate: string
  readonly isToday: boolean
  readonly scope: LedgerOverviewScope
}

export interface LedgerOverviewDto {
  readonly context: LedgerOverviewContext
  readonly currency: string
  readonly currencyExponent: number
  readonly assetTotalMinor: number
  readonly liabilityTotalMinor: number
  readonly netWorthMinor: number
  readonly accounts: readonly LedgerAccountSummary[]
  readonly cashflow: LedgerCashflowSummary
  readonly categoryBreakdown: {
    readonly income: readonly LedgerCategorySlice[]
    readonly expense: readonly LedgerCategorySlice[]
  }
  readonly periods: readonly LedgerPeriodSummary[]
  readonly trend: readonly LedgerTrendPoint[]
  readonly recentTransactions: readonly LedgerTransactionDto[]
}

export interface LedgerMovementSummary {
  readonly balanceIncreaseMinor: number
  readonly balanceDecreaseMinor: number
}

export type LedgerAccountBalanceTrendRange = 7 | 30 | 90 | 365

export interface LedgerAccountBalanceTrendPoint {
  /** Ledger-local calendar date represented by this point. */
  readonly date: string
  /** Next local-day start for historical points; the captured instant for today. */
  readonly timestamp: number
  readonly balanceMinor: number
}

export interface LedgerAccountBalanceTrendDto {
  readonly range: LedgerAccountBalanceTrendRange
  readonly points: readonly LedgerAccountBalanceTrendPoint[]
}

export interface LedgerAccountTransactionBalance {
  readonly transactionId: string
  readonly balanceMinor: number
}

export interface LedgerAccountTransactionsDto {
  readonly account: LedgerAccountDto
  readonly movement: LedgerMovementSummary
  readonly transactions: readonly LedgerTransactionDto[]
  /** Running balances for the returned page, calculated by the server. */
  readonly transactionBalances: readonly LedgerAccountTransactionBalance[]
  readonly page: LedgerPageInfo
}
