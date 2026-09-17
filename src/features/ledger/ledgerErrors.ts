/**
 * The browser-side error boundary deliberately mirrors the server's public
 * error envelope without importing server implementation modules into the
 * browser bundle.
 */
export type LedgerClientErrorCode =
  | 'ledger-validation-failed'
  | 'ledger-not-found'
  | 'ledger-duplicate-category'
  | 'ledger-archived-account'
  | 'ledger-archived-category'
  | 'ledger-invalid-account-pair'
  | 'ledger-currency-mismatch'
  | 'ledger-opening-date-conflict'
  | 'ledger-timezone-locked'
  | 'ledger-base-currency-locked'
  | 'ledger-balance-conflict'
  | 'ledger-version-conflict'
  | 'ledger-account-has-history'
  | 'ledger-account-nonzero-balance'
  | 'ledger-category-has-history'
  | 'ledger-settings-already-initialized'
  | 'ledger-transaction-type-immutable'
  | 'ledger-transaction-deleted'
  | 'ledger-adjustment-immutable'
  | 'ledger-idempotency-conflict'
  | 'ledger-invalid-currency'
  | 'ledger-invalid-timezone'
  | 'ledger-invalid-opening-date'
  | 'ledger-money-unsafe'
  | 'ledger-money-non-positive'
  | 'ledger-money-negative'
  | 'ledger-money-overflow'
  | 'ledger-invalid-decimal'
  | 'ledger-fractional-precision-exceeded'
  | 'ledger-account-not-found'
  | 'ledger-category-not-found'
  | 'ledger-transaction-not-found'
  | 'ledger-category-kind-mismatch'
  | 'ledger-write-busy'
  | 'ledger-internal-error'
  | 'auth-session-required'
  | 'ledger-malformed-response'
  | 'ledger-network-error'
  | 'ledger-recovery-storage-unavailable'
  | 'ledger-recovery-blocked'

export type LedgerErrorKind =
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'auth'
  | 'temporary'
  | 'internal'
  | 'network'
  | 'malformed'

export interface LedgerErrorDetails {
  readonly field?: string
  readonly [key: string]: unknown
}

function errorKind(status: number, code: string): LedgerErrorKind {
  if (code === 'auth-session-required' || status === 401) return 'auth'
  if (code === 'ledger-malformed-response') return 'malformed'
  if (code === 'ledger-network-error') return 'network'
  if (status === 400) return 'validation'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 503) return 'temporary'
  return 'internal'
}

export class LedgerApiError extends Error {
  readonly status: number
  readonly code: LedgerClientErrorCode | string
  readonly details: LedgerErrorDetails | null
  readonly kind: LedgerErrorKind
  /** True only when the browser did not receive a definite HTTP result. */
  readonly transportOutcomeUnknown: boolean
  /** True when a successful mutation may have committed but its result is not authoritative. */
  readonly requiresIdempotentReplay: boolean

  constructor(
    message: string,
    status: number,
    code: string,
    details: LedgerErrorDetails | null = null,
    transportOutcomeUnknown = false,
    requiresIdempotentReplay = false,
  ) {
    super(message)
    this.name = 'LedgerApiError'
    this.status = status
    this.code = code
    this.details = details
    this.kind = errorKind(status, code)
    this.transportOutcomeUnknown = transportOutcomeUnknown
    this.requiresIdempotentReplay = requiresIdempotentReplay
  }
}

export function isLedgerApiError(value: unknown): value is LedgerApiError {
  return value instanceof LedgerApiError
}

export function normalizeLedgerError(value: unknown): LedgerApiError {
  if (value instanceof LedgerApiError) return value
  if (value instanceof Error) {
    return new LedgerApiError(
      'Ledger request outcome is unknown.',
      0,
      'ledger-network-error',
      null,
      true,
    )
  }
  return new LedgerApiError(
    'Ledger request outcome is unknown.',
    0,
    'ledger-network-error',
    null,
    true,
  )
}

export function isTransportOutcomeUnknown(error: unknown): boolean {
  return isLedgerApiError(error) && error.transportOutcomeUnknown
}

export function shouldKeepPendingCreate(error: unknown): boolean {
  return isLedgerApiError(error)
    && (error.transportOutcomeUnknown || error.requiresIdempotentReplay)
}

/** User-facing copy stays specific enough to offer a useful recovery action. */
export function ledgerErrorMessage(error: unknown, fallback = 'Ledger 操作暂时无法完成。'): string {
  const normalized = normalizeLedgerError(error)
  switch (normalized.code) {
    case 'ledger-validation-failed':
    case 'ledger-invalid-currency':
    case 'ledger-invalid-timezone':
    case 'ledger-invalid-opening-date':
    case 'ledger-money-unsafe':
    case 'ledger-money-non-positive':
    case 'ledger-money-negative':
    case 'ledger-money-overflow':
    case 'ledger-invalid-decimal':
    case 'ledger-fractional-precision-exceeded':
      return '请检查输入内容后再保存。'
    case 'ledger-not-found':
      return '找不到这项 Ledger 数据，页面可能已经发生变化。'
    case 'ledger-archived-account':
      return '相关账户已归档，请先恢复账户。'
    case 'ledger-archived-category':
      return '相关分类已在回收站，请先恢复分类或改用其他分类。'
    case 'ledger-account-nonzero-balance':
      return '只有余额为 0 的账户才能归档。'
    case 'ledger-account-has-history':
      return '有历史记录的账户不能被永久删除。'
    case 'ledger-category-has-history':
      return '有历史记录的分类不能被永久删除。'
    case 'ledger-version-conflict':
      return '这项数据已被更新，请刷新后再试。'
    case 'ledger-balance-conflict':
      return '账户余额已发生变化，请刷新后再试。'
    case 'ledger-duplicate-category':
      return '这个分类已经存在，请选择它或换一个名称。'
    case 'ledger-category-kind-mismatch':
      return '请选择与交易类型匹配的分类。'
    case 'ledger-invalid-account-pair':
      return '请选择有效的账户类型。'
    case 'ledger-settings-already-initialized':
    case 'ledger-base-currency-locked':
    case 'ledger-timezone-locked':
      return 'Ledger 设置已经锁定，不能再修改。'
    case 'ledger-write-busy':
      return 'Ledger 暂时繁忙，本次操作没有保存。请稍后重新提交。'
    case 'auth-session-required':
      return '登录状态已失效，请重新登录。'
    case 'ledger-internal-error':
      return 'Ledger 暂时不可用，请稍后再试。'
    case 'ledger-malformed-response':
      return 'Ledger 返回了无法识别的数据，请稍后再试。'
    case 'ledger-network-error':
      return '网络连接中断，尚未确认本次操作是否保存。'
    case 'ledger-recovery-storage-unavailable':
      return '当前浏览器无法建立安全的记账恢复状态，因此这次操作没有提交。请确认当前标签页允许使用会话存储后重试。'
    case 'ledger-recovery-blocked':
      return '发现无法验证的未完成 Ledger 操作。为避免重复记账，已暂停新的提交。'
    default:
      return fallback
  }
}

/**
 * Workspace recovery handles read/rebuild failures, not mutation submission.
 * Keep the network copy away from the mutation uncertainty wording used by
 * `ledgerErrorMessage`, while retaining its explicit auth message.
 */
export function ledgerWorkspaceReadErrorMessage(error: unknown): string {
  const normalized = normalizeLedgerError(error)
  if (normalized.code === 'auth-session-required') return ledgerErrorMessage(normalized)
  return 'Ledger 数据暂时无法加载，请稍后重试。'
}

export function ledgerFieldError(error: unknown, field: string): string | null {
  const normalized = normalizeLedgerError(error)
  return normalized.details?.field === field ? ledgerErrorMessage(error) : null
}
