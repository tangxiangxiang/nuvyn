// The vault protocol reserves the top-level system folders (inbox / literature
// / archive / diary), but archive descendants are ordinary user content.
// These predicates are pure so the Vue UI and Node server can share the same
// root contract without turning archive membership into a permission gate.

export const PROTECTED_ROOTS: ReadonlySet<string> = new Set(['inbox', 'literature', 'archive', 'diary'])

/** True for any path inside the advisory archive area. */
export function isInArchive(path: string | null | undefined): boolean {
  if (!path) return false
  const p = path.toLowerCase()
  return p === 'archive' || p.startsWith('archive/')
}

/** True for top-level system folders that must keep their names. */
export function isProtectedRoot(path: string | null | undefined): boolean {
  return !!path && PROTECTED_ROOTS.has(path.toLowerCase())
}

/** Why a path is structurally locked, or null when it is ordinary content. */
export type ReadonlyReason = 'root' | null
export function readonlyReason(path: string | null | undefined): ReadonlyReason {
  return isProtectedRoot(path) ? 'root' : null
}

/** True for entries whose name/content can be renamed or deleted. */
export function canModify(path: string | null | undefined): boolean {
  return !!path && !isProtectedRoot(path)
}

/**
 * True when the protected-root policy allows a move for this path.
 *
 * This is intentionally a path-only policy predicate. It does not claim that
 * every entity kind has a move capability: files are currently draggable,
 * while folders do not have a general re-parent operation in Nuvyn.
 */
export function canMove(path: string | null | undefined): boolean {
  return !!path && !isProtectedRoot(path)
}

/** True for folders that may receive a directly created note. */
export function canCreateFileChild(path: string | null | undefined): boolean {
  return !!path
}

/** User-facing error message for a blocked operation, or null when allowed. */
export function blockedMessage(
  path: string | null | undefined,
  op: 'rename' | 'delete' | 'move' | 'create-file' | 'create-folder',
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (!isProtectedRoot(path)) return null
  const label = path!
  if (op === 'rename') return t('file_tree.protected_rename', { path: label })
  if (op === 'delete') return t('file_tree.protected_delete', { path: label })
  if (op === 'move') return t('file_tree.protected_move', { path: label })
  // Files and folders can be created inside every protected root.
  return null
}
