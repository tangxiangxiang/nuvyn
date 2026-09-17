import type { LibraryItems } from '@excalidraw/excalidraw/types'
import {
  createIndexedDbBoardLibraryStore,
  type BoardLibraryStore,
} from './libraryStore'

export interface BoardLibraryPersistenceAdapter {
  load(metadata: { source: 'load' | 'save' }): Promise<{ libraryItems: LibraryItems } | null>
  save(data: { libraryItems: LibraryItems }): Promise<void>
}

export function createBoardLibraryPersistenceAdapter(
  store: BoardLibraryStore,
): BoardLibraryPersistenceAdapter {
  let lastSavedFingerprint: string | null = null
  let saveQueue: Promise<void> = Promise.resolve()

  function fingerprint(libraryItems: LibraryItems): string | null {
    try {
      return JSON.stringify(libraryItems)
    } catch {
      // Excalidraw emits JSON-shaped LibraryItems. Keep the fallback so a
      // future upstream shape cannot turn a library update into an editor
      // crash merely because it is not serializable for de-duplication.
      return null
    }
  }

  function saveLibraryItems(libraryItems: LibraryItems): Promise<void> {
    const nextFingerprint = fingerprint(libraryItems)
    const task = saveQueue.then(async () => {
      if (nextFingerprint !== null && nextFingerprint === lastSavedFingerprint) return
      await store.save(libraryItems)
      if (nextFingerprint !== null) lastSavedFingerprint = nextFingerprint
    })
    // Keep the queue usable after a failed write while preserving the
    // rejection for the caller that needs to report the failure.
    saveQueue = task.catch(() => {})
    return task
  }

  return {
    async load(_metadata) {
      try {
        return { libraryItems: await store.load() }
      } catch (error) {
        // A library store failure must not take down the Board canvas. The
        // official Excalidraw hook will still keep the current in-memory
        // library usable and will report later save failures in the canvas.
        console.error('Nuvyn Board Library could not be loaded', error)
        return null
      }
    },
    async save({ libraryItems }) {
      await saveLibraryItems(libraryItems)
    },
  }
}

export const boardLibraryPersistenceAdapter = createBoardLibraryPersistenceAdapter(
  createIndexedDbBoardLibraryStore(),
)

export function persistBoardLibraryItems(
  libraryItems: LibraryItems,
  onError?: (error: unknown) => void,
): Promise<void> {
  return boardLibraryPersistenceAdapter.save({ libraryItems }).catch((error) => {
    try {
      onError?.(error)
    } catch {
      // Error reporting must never replace the persistence failure or affect
      // the Excalidraw canvas.
    }
    throw error
  })
}

export function currentBoardLibraryReturnUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const url = new URL(window.location.href)
  url.hash = ''
  return url.toString()
}

export interface BoardLibraryInstallHashGuard {
  dispose(): void
}

function currentLibraryInstallHash(): string | null {
  if (typeof window === 'undefined' || !window.location.hash) return null
  const hash = new URLSearchParams(window.location.hash.slice(1))
  return hash.has('addLibrary') ? window.location.hash : null
}

export function createBoardLibraryInstallHashGuard(): BoardLibraryInstallHashGuard {
  const handledHashes = new Set<string>()
  const initialHash = currentLibraryInstallHash()
  if (initialHash) handledHashes.add(initialHash)

  const onHashChange = (event: HashChangeEvent): void => {
    const installHash = currentLibraryInstallHash()
    if (!installHash) return
    if (!handledHashes.has(installHash)) {
      handledHashes.add(installHash)
      return
    }

    // Excalidraw's official useHandleLibrary listener will process the first
    // occurrence. If the same callback is delivered again before/after a
    // React Island update, stop that duplicate and leave a clean Board URL.
    event.preventDefault()
    event.stopImmediatePropagation()
    const url = new URL(window.location.href)
    const hash = new URLSearchParams(url.hash.slice(1))
    hash.delete('addLibrary')
    url.hash = hash.toString()
    window.history.replaceState({}, document.title, url.toString())
  }

  if (typeof window !== 'undefined') window.addEventListener('hashchange', onHashChange)

  return {
    dispose(): void {
      if (typeof window !== 'undefined') window.removeEventListener('hashchange', onHashChange)
    },
  }
}
