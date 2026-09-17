import type { Tab } from '../../../components/vault/tabs'

export type SavePresentationStatus =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'saving-dirty'
  | 'saved'
  | 'error'
  | 'offline'
  | 'external'

export interface DocumentSavePresentation {
  status: SavePresentationStatus
  dirty: boolean
  inFlight: boolean
  hasNewerChanges: boolean
  retryable: boolean
  attention: boolean
}

export function deriveDocumentSavePresentation(
  tab: Tab | null | undefined,
): DocumentSavePresentation {
  if (!tab) {
    return {
      status: 'idle',
      dirty: false,
      inFlight: false,
      hasNewerChanges: false,
      retryable: false,
      attention: false,
    }
  }

  const dirty = tab.raw !== tab.originalRaw || tab.revision !== tab.savedRevision
  const inFlight = tab.savingRevision !== null
  const hasNewerChanges = inFlight
    && dirty
    && tab.revision > tab.savingRevision!

  let status: SavePresentationStatus
  if (tab.saveStatus === 'external') status = 'external'
  else if (tab.saveStatus === 'offline') status = 'offline'
  else if (tab.saveStatus === 'error') status = 'error'
  else if (inFlight && hasNewerChanges) status = 'saving-dirty'
  else if (inFlight) status = 'saving'
  else if (dirty) status = 'dirty'
  else if (tab.saveStatus === 'saved') status = 'saved'
  else status = 'idle'

  const retryable = status === 'error' || status === 'offline'
  const attention = retryable || status === 'external'

  return { status, dirty, inFlight, hasNewerChanges, retryable, attention }
}
