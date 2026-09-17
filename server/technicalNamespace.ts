/** Canonical server-side technical identifiers owned by the Nuvyn runtime. */

export const NUVYN_DATABASE_FILE_NAME = 'nuvyn.db'
export const NUVYN_MASTER_KEY_FILE_NAME = '.nuvyn-master-key'
export const NUVYN_VAULT_DIRECTORY = '.nuvyn'
export const NUVYN_SECURE_SESSION_COOKIE_NAME = '__Host-nuvyn_session'
export const NUVYN_LOCAL_SESSION_COOKIE_NAME = 'nuvyn_session'
export const NUVYN_DIARY_MIGRATION_CIPHERTEXT_PREFIX = '.nuvyn-diary-migration-ciphertext-'
export const NUVYN_HISTORY_INDEX_DIRECTORY = 'nuvyn'
export const NUVYN_VERSION_TRAILER = 'Nuvyn-Version: 1'
export const NUVYN_VAULT_TRAILER_PREFIX = 'Nuvyn-Vault:'
export const NUVYN_VAULT_VERSION_TRAILER = 'Nuvyn-Vault-Version: 1'

export type RecoveryMarkerKind =
  | 'journal'
  | 'staged'
  | 'save'
  | 'remove'
  | 'rename'
  | 'delete'
  | 'delete-inflight'
  | 'quarantine-reuse'
  | 'delete-manifest'
  | 'quarantine-manifest'
  | 'quarantine-save'
  | 'folder-gate'
  | 'ref-before'
  | 'ref-after'

const MARKER_WORD: Record<RecoveryMarkerKind, string> = {
  journal: 'journal',
  staged: 'staged',
  save: 'save',
  remove: 'remove',
  rename: 'rename',
  delete: 'delete',
  'delete-inflight': 'delete-inflight',
  'quarantine-reuse': 'quarantine-reuse',
  'delete-manifest': 'delete-manifest',
  'quarantine-manifest': 'quarantine-manifest',
  'quarantine-save': 'quarantine-save',
  'folder-gate': 'folder-gate',
  'ref-before': 'ref-before',
  'ref-after': 'ref-after',
}

/** Build a marker name. `base` is the target basename without a dot prefix. */
export function recoveryMarkerName(
  kind: RecoveryMarkerKind,
  base: string,
  token: string,
  index?: number,
): string {
  const marker = MARKER_WORD[kind]
  if (kind === 'folder-gate') return `.nuvyn-folder-gate-${token}`
  if (kind === 'delete') return `${base}.nuvyn-delete-${token}`
  if (kind === 'delete-inflight') return `${base}.nuvyn-delete-inflight-${token}`
  if (kind === 'quarantine-reuse') return `${base}.nuvyn-quarantine-reuse-${token}`
  if (kind === 'delete-manifest') return `.${base}.nuvyn-delete-manifest-${token}`
  if (kind === 'quarantine-manifest') return `.${base}.nuvyn-quarantine-manifest-${token}`
  if (kind === 'ref-before' || kind === 'ref-after') {
    const suffix = kind === 'ref-before' ? 'before' : 'after'
    return `.${base}.nuvyn-ref-${suffix}-${token}-${index ?? 0}`
  }
  return `.${base}.nuvyn-${marker}-${token}`
}

/** Prefixes used by recovery validators for the Nuvyn technical namespace. */
export function recoveryMarkerPrefix(
  kind: RecoveryMarkerKind,
  base?: string,
): string {
  const marker = MARKER_WORD[kind]
  if (base === undefined && kind !== 'folder-gate') return `.nuvyn-${marker}-`
  if (kind === 'folder-gate') return `.nuvyn-folder-gate-`
  if (kind === 'delete') return `${base ?? ''}.nuvyn-delete-`
  if (kind === 'delete-inflight') return `${base ?? ''}.nuvyn-delete-inflight-`
  if (kind === 'quarantine-reuse') return `${base ?? ''}.nuvyn-quarantine-reuse-`
  if (kind === 'delete-manifest') return `.${base ?? ''}.nuvyn-delete-manifest-`
  if (kind === 'quarantine-manifest') return `.${base ?? ''}.nuvyn-quarantine-manifest-`
  if (kind === 'ref-before') return `.${base ?? ''}.nuvyn-ref-before-`
  if (kind === 'ref-after') return `.${base ?? ''}.nuvyn-ref-after-`
  return `.${base ?? ''}.nuvyn-${marker}-`
}

export function isRecoveryMarkerName(value: string, kind: RecoveryMarkerKind): boolean {
  return value.includes(recoveryMarkerPrefix(kind))
}

export function recoveryMarkerToken(value: string, kind: RecoveryMarkerKind): string | null {
  const prefix = recoveryMarkerPrefix(kind)
  const index = value.indexOf(prefix)
  return index >= 0 ? value.slice(index + prefix.length) : null
}
