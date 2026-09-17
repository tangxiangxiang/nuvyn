import { classifyDiaryPath, isManagedDiaryPath } from '../shared/diaryProtocol.js'
import { isProtectedRoot } from '../shared/archiveProtocol.js'

export type DocumentMutation =
  | { operation: 'create'; destinationPath: string }
  | { operation: 'recover'; destinationPath: string }
  // Used only after History Restore has read the requested path from the
  // selected Git ref.  This is deliberately distinct from generic recovery:
  // a managed-looking Diary path is not, by itself, proof of a prior identity.
  | { operation: 'history-restore'; destinationPath: string }
  | { operation: 'write'; destinationPath: string; destinationExists: boolean }
  | { operation: 'delete'; sourcePath: string }
  | { operation: 'rename'; sourcePath: string; destinationPath: string }

export type FolderMutation =
  | { operation: 'create'; path: string }
  | { operation: 'delete'; path: string }
  | { operation: 'rename'; sourcePath: string; destinationPath: string }

export class DocumentMutationPolicyError extends Error {
  readonly code = 'DOCUMENT_MUTATION_BLOCKED'

  constructor(message: string) {
    super(message)
    this.name = 'DocumentMutationPolicyError'
  }
}

function rejectMutation(message: string): never {
  throw new DocumentMutationPolicyError(message)
}

function isDiaryPath(path: string): boolean {
  return classifyDiaryPath(path) !== 'outside'
}

function isDiaryDescendant(path: string): boolean {
  const kind = classifyDiaryPath(path)
  return kind === 'managed' || kind === 'unmanaged'
}

/** The server-side root contract shared by REST and AI mutations. */
export function validateDocumentMutation(mutation: DocumentMutation): void {
  const protectedPath = mutation.operation === 'create'
    || mutation.operation === 'recover'
    || mutation.operation === 'history-restore'
    || mutation.operation === 'write'
    ? mutation.destinationPath
    : mutation.operation === 'delete'
      ? mutation.sourcePath
      : null
  if (protectedPath && isProtectedRoot(protectedPath)) {
    rejectMutation('protected root cannot be modified')
  }

  if (mutation.operation === 'rename'
    && (isProtectedRoot(mutation.sourcePath) || isProtectedRoot(mutation.destinationPath))) {
    rejectMutation('protected root cannot be modified')
  }

  if (mutation.operation === 'create' && isDiaryPath(mutation.destinationPath)) {
    rejectMutation('Diary documents must be created through the Diary date command')
  }

  if (mutation.operation === 'recover' && isDiaryPath(mutation.destinationPath)) {
    rejectMutation('Diary recovery requires a verified prior identity; use History Restore')
  }

  if (mutation.operation === 'history-restore'
    && isDiaryPath(mutation.destinationPath)
    && !isManagedDiaryPath(mutation.destinationPath)) {
    rejectMutation('History Restore requires an existing managed date identity')
  }

  if (mutation.operation === 'write'
    && !mutation.destinationExists
    && isDiaryPath(mutation.destinationPath)) {
    rejectMutation('Diary documents must be created through the Diary date command')
  }

  if (mutation.operation === 'rename'
    && (isManagedDiaryPath(mutation.sourcePath) || isManagedDiaryPath(mutation.destinationPath))) {
    rejectMutation('managed Diary documents cannot change identity')
  }

  // The Diary namespace is reserved for the date command and trusted
  // identity-preserving flows.  A generic document rename/move must not be
  // able to manufacture either an unmanaged `diary/foo` file or a managed
  // date path.  Keep this destination rule separate from the source rule:
  // an existing unmanaged external file may still be moved out for cleanup.
  if (mutation.operation === 'rename'
    && classifyDiaryPath(mutation.destinationPath) !== 'outside') {
    rejectMutation('generic document rename/move cannot enter the Diary namespace')
  }

  // Archive descendants are intentionally ordinary content. This validator
  // still runs for every REST/AI mutation, but only reserves the root names;
  // path traversal and filesystem confinement remain enforced by paths.ts.
}

/** Folder lifecycle guard kept next to the shared document policy. */
export function validateFolderMutation(mutation: FolderMutation): void {
  if (mutation.operation === 'create') {
    if (isProtectedRoot(mutation.path)) rejectMutation('protected root cannot be modified')
    if (isDiaryDescendant(mutation.path)) rejectMutation('folders cannot be created under diary')
    return
  }

  if (mutation.operation === 'delete' && isProtectedRoot(mutation.path)) {
    rejectMutation('protected root cannot be modified')
  }

  if (mutation.operation === 'rename'
    && (isProtectedRoot(mutation.sourcePath) || isProtectedRoot(mutation.destinationPath))) {
    rejectMutation('protected root cannot be modified')
  }
}
