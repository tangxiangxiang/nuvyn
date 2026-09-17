import { LedgerError } from './errors.js'

export const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER

function safeIntegerError(field: string): LedgerError {
  return new LedgerError(
    'ledger-money-unsafe',
    400,
    `${field} must be a safe integer`,
    { field },
  )
}

function assertSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw safeIntegerError(field)
  }
}

/** Validate a signed integer minor-unit value. */
export function assertSafeMinor(
  value: unknown,
  field = 'amountMinor',
): asserts value is number {
  assertSafeInteger(value, field)
}

/** Validate a strictly positive integer minor-unit value. */
export function assertPositiveMinor(
  value: unknown,
  field = 'amountMinor',
): asserts value is number {
  assertSafeInteger(value, field)
  if (value <= 0) {
    throw new LedgerError(
      'ledger-money-non-positive',
      400,
      `${field} must be greater than zero`,
      { field },
    )
  }
}

/** Validate an integer that may not be negative. */
export function assertNonNegativeSafeInteger(
  value: unknown,
  field = 'value',
): asserts value is number {
  assertSafeInteger(value, field)
  if (value < 0) {
    throw new LedgerError(
      'ledger-money-negative',
      400,
      `${field} must not be negative`,
      { field },
    )
  }
}

function checkedResult(value: number, operation: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new LedgerError(
      'ledger-money-overflow',
      400,
      `${operation} exceeds the safe integer range`,
    )
  }
  return value
}

/** Add two safe minor-unit values and reject an unsafe result. */
export function checkedAddMinor(a: number, b: number): number {
  assertSafeInteger(a, 'leftMinor')
  assertSafeInteger(b, 'rightMinor')
  return checkedResult(a + b, 'minor-unit addition')
}

/** Subtract two safe minor-unit values and reject an unsafe result. */
export function checkedSubMinor(a: number, b: number): number {
  assertSafeInteger(a, 'leftMinor')
  assertSafeInteger(b, 'rightMinor')
  return checkedResult(a - b, 'minor-unit subtraction')
}

/** Sum safe values without allowing aggregate overflow to be hidden. */
export function checkedSumMinor(values: Iterable<number>): number {
  let total = 0
  for (const value of values) total = checkedAddMinor(total, value)
  return total
}
