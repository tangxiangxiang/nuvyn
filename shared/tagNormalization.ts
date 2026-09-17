/**
 * The one persistent Tag identity contract shared by the browser, server,
 * imports, migrations, and tests.
 *
 * This module is deliberately dependency-free. In particular, do not add
 * locale, DOM, Vue, SQLite, or Node imports here: the exact same JavaScript
 * operations must run in every layer.
 */

export const TAG_IDENTITY_CONTRACT_VERSION = 'tag-identity-v1' as const
export const MAX_PERSISTENT_TAG_LENGTH = 100
export const MAX_DOCUMENT_TAGS = 50

export type TagValidationErrorCode =
  | 'INVALID_TAG'
  | 'TAG_LIMIT_EXCEEDED'

export type NormalizedTag = {
  displayName: string
  normalizedName: string
}

export type PersistentTagValidation =
  | {
      ok: true
      displayName: string
      normalizedName: string
    }
  | {
      ok: false
      code: TagValidationErrorCode
      message: string
    }

/** A stable error for callers that need to map shared validation failures. */
export class TagNormalizationError extends Error {
  readonly code: TagValidationErrorCode

  constructor(code: TagValidationErrorCode, message: string) {
    super(message)
    this.name = 'TagNormalizationError'
    this.code = code
  }
}

// Keep ordinary Unicode joiners/variation selectors valid for scripts and
// emoji. Reject Cc plus line separators, BOM, bidi controls, and isolating
// format controls that can alter how a tag is displayed or logged.
const FORBIDDEN_TAG_CHARACTERS = /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u206A-\u206F\uFEFF]/u

/**
 * Canonical persistent identity:
 * trim -> remove exactly one leading # -> trim -> toLowerCase.
 * No Unicode normalization is performed.
 */
export function normalizeTagIdentity(raw: string | null | undefined): string {
  if (raw == null) return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withoutOneHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  return withoutOneHash.trim().toLowerCase()
}

/** Display form uses the same structural cleanup but preserves casing. */
export function normalizeTagDisplay(raw: string | null | undefined): string {
  if (raw == null) return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withoutOneHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  return withoutOneHash.trim()
}

function invalid(message: string): PersistentTagValidation {
  return { ok: false, code: 'INVALID_TAG', message }
}

/** Validate one value before it can become a persistent tag. */
export function validatePersistentTag(raw: unknown): PersistentTagValidation {
  if (typeof raw !== 'string') return invalid('tag must be a string')
  if (raw.length > MAX_PERSISTENT_TAG_LENGTH) {
    return invalid(`tag must be at most ${MAX_PERSISTENT_TAG_LENGTH} UTF-16 code units`)
  }
  if (FORBIDDEN_TAG_CHARACTERS.test(raw)) {
    return invalid('tag contains a forbidden control or formatting character')
  }

  const displayName = normalizeTagDisplay(raw)
  const normalizedName = normalizeTagIdentity(raw)
  if (!displayName || !normalizedName) return invalid('tag must not be empty')
  if (displayName.length > MAX_PERSISTENT_TAG_LENGTH) {
    return invalid(`normalized tag display must be at most ${MAX_PERSISTENT_TAG_LENGTH} UTF-16 code units`)
  }
  if (normalizedName.length > MAX_PERSISTENT_TAG_LENGTH) {
    return invalid(`normalized tag identity must be at most ${MAX_PERSISTENT_TAG_LENGTH} UTF-16 code units`)
  }
  return { ok: true, displayName, normalizedName }
}

function throwValidation(result: Exclude<PersistentTagValidation, { ok: true }>): never {
  throw new TagNormalizationError(result.code, result.message)
}

/** Normalize, validate, and deduplicate one document's tag list. */
export function normalizeAndDedupeTags(values: readonly unknown[]): NormalizedTag[] {
  if (!Array.isArray(values)) {
    throw new TagNormalizationError('INVALID_TAG', 'tags must be an array')
  }
  if (values.length > MAX_DOCUMENT_TAGS) {
    throw new TagNormalizationError(
      'TAG_LIMIT_EXCEEDED',
      `tags must contain at most ${MAX_DOCUMENT_TAGS} entries`,
    )
  }
  const seen = new Set<string>()
  const result: NormalizedTag[] = []
  for (const raw of values) {
    const validation = validatePersistentTag(raw)
    if (!validation.ok) throwValidation(validation)
    if (seen.has(validation.normalizedName)) continue
    seen.add(validation.normalizedName)
    result.push({
      displayName: validation.displayName,
      normalizedName: validation.normalizedName,
    })
  }
  return result
}

