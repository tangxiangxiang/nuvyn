// User-facing content scopes are intentionally separate from the vault's
// protected root protocol. Existing inbox/literature/archive content is all
// part of the note scope; diary and ledger are independent top-level scopes.

export const SCOPE_ROOTS = {
  note: ['inbox', 'literature', 'archive'],
  diary: ['diary'],
  ledger: ['ledger'],
} as const

export type ScopeKey = keyof typeof SCOPE_ROOTS

export function scopeRootsFor(scope: ScopeKey): readonly string[] {
  return SCOPE_ROOTS[scope]
}
