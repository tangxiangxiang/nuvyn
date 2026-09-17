export const METADATA_VERSION_OVERFLOW = 'METADATA_VERSION_OVERFLOW' as const

export class MetadataVersionError extends Error {
  readonly code = METADATA_VERSION_OVERFLOW

  constructor(message = 'metadata version cannot advance beyond Number.MAX_SAFE_INTEGER') {
    super(message)
    this.name = 'MetadataVersionError'
  }
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MetadataVersionError(`${label} must be a non-negative safe integer`)
  }
}

function candidateTimestamp(value: number): number {
  if (!Number.isFinite(value)) throw new MetadataVersionError('metadata candidate time must be finite')
  const candidate = Math.trunc(value)
  assertSafeNonNegativeInteger(candidate, 'metadata candidate time')
  return candidate
}

/** Advance one real metadata mutation strictly beyond its current version. */
export function nextMetadataUpdatedAt(current: number, now = Date.now()): number {
  assertSafeNonNegativeInteger(current, 'metadata current version')
  const candidate = candidateTimestamp(now)
  if (current === Number.MAX_SAFE_INTEGER) throw new MetadataVersionError()
  return Math.max(candidate, current + 1)
}

/**
 * Mint the one timestamp stored in a durable batch journal. The caller must
 * pass every current version in the batch; the result is strictly above each
 * one and can therefore be replayed deterministically by the journal.
 */
export function nextMetadataBatchUpdatedAt(currents: readonly number[], now = Date.now()): number {
  const candidate = candidateTimestamp(now)
  let maximum = 0
  for (const current of currents) {
    assertSafeNonNegativeInteger(current, 'metadata current version')
    if (current === Number.MAX_SAFE_INTEGER) throw new MetadataVersionError()
    maximum = Math.max(maximum, current)
  }
  return Math.max(candidate, maximum + 1)
}

