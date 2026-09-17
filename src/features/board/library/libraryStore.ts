import type { LibraryItems } from '@excalidraw/excalidraw/types'
import {
  NUVYN_BOARD_LIBRARY_DATABASE_NAME,
  openNamedIndexedDb,
} from '../../../technicalNamespace'

export const BOARD_LIBRARY_DATABASE_NAME = NUVYN_BOARD_LIBRARY_DATABASE_NAME
export const BOARD_LIBRARY_DATABASE_VERSION = 1
export const BOARD_LIBRARY_STORE_NAME = 'library'
export const BOARD_LIBRARY_RECORD_KEY = 'user'

interface BoardLibraryRecord {
  key: typeof BOARD_LIBRARY_RECORD_KEY
  version: typeof BOARD_LIBRARY_DATABASE_VERSION
  libraryItems: LibraryItems
}

export interface BoardLibraryStore {
  load(): Promise<LibraryItems>
  save(libraryItems: LibraryItems): Promise<void>
  clear(): Promise<void>
}

export class BoardLibraryStoreError extends Error {
  readonly code: 'BOARD_LIBRARY_UNAVAILABLE' | 'BOARD_LIBRARY_OPERATION_FAILED'

  constructor(
    message: string,
    code: 'BOARD_LIBRARY_UNAVAILABLE' | 'BOARD_LIBRARY_OPERATION_FAILED' = 'BOARD_LIBRARY_OPERATION_FAILED',
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'BoardLibraryStoreError'
    this.code = code
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

async function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return openNamedIndexedDb(factory, BOARD_LIBRARY_DATABASE_NAME, BOARD_LIBRARY_DATABASE_VERSION, (request) => {
    const database = request.result
    if (!database.objectStoreNames.contains(BOARD_LIBRARY_STORE_NAME)) {
      database.createObjectStore(BOARD_LIBRARY_STORE_NAME, { keyPath: 'key' })
    }
  })
}

function isLibraryRecord(value: unknown): value is BoardLibraryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<BoardLibraryRecord>
  return record.key === BOARD_LIBRARY_RECORD_KEY
    && record.version === BOARD_LIBRARY_DATABASE_VERSION
    && Array.isArray(record.libraryItems)
}

function cloneLibraryItems(libraryItems: LibraryItems): LibraryItems {
  return typeof structuredClone === 'function'
    ? structuredClone(libraryItems)
    : libraryItems
}

export function createIndexedDbBoardLibraryStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): BoardLibraryStore {
  let databasePromise: Promise<IDBDatabase> | null = null

  function database(): Promise<IDBDatabase> {
    if (!factory) {
      return Promise.reject(new BoardLibraryStoreError(
        'IndexedDB is unavailable',
        'BOARD_LIBRARY_UNAVAILABLE',
      ))
    }
    if (!databasePromise) {
      const cached = openDatabase(factory)
        .then((database) => {
          const release = () => {
            if (databasePromise === cached) databasePromise = null
          }
          database.onversionchange = () => {
            database.close()
            release()
          }
          database.onclose = release
          return database
        })
        .catch((error: unknown) => {
          if (databasePromise === cached) databasePromise = null
          throw new BoardLibraryStoreError('IndexedDB could not be opened', 'BOARD_LIBRARY_UNAVAILABLE', { cause: error })
        })
      databasePromise = cached
    }
    return databasePromise
  }

  async function run<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
    try {
      return await operation(await database())
    } catch (error) {
      if (error instanceof BoardLibraryStoreError) throw error
      throw new BoardLibraryStoreError('IndexedDB operation failed', 'BOARD_LIBRARY_OPERATION_FAILED', { cause: error })
    }
  }

  return {
    load() {
      return run(async (database) => {
        const transaction = database.transaction(BOARD_LIBRARY_STORE_NAME, 'readonly')
        const value = await requestResult(transaction.objectStore(BOARD_LIBRARY_STORE_NAME).get(BOARD_LIBRARY_RECORD_KEY))
        await transactionDone(transaction)
        return isLibraryRecord(value) ? cloneLibraryItems(value.libraryItems) : []
      })
    },

    save(libraryItems) {
      return run(async (database) => {
        const transaction = database.transaction(BOARD_LIBRARY_STORE_NAME, 'readwrite')
        const record: BoardLibraryRecord = {
          key: BOARD_LIBRARY_RECORD_KEY,
          version: BOARD_LIBRARY_DATABASE_VERSION,
          libraryItems: cloneLibraryItems(libraryItems),
        }
        transaction.objectStore(BOARD_LIBRARY_STORE_NAME).put(record)
        await transactionDone(transaction)
      })
    },

    clear() {
      return run(async (database) => {
        const transaction = database.transaction(BOARD_LIBRARY_STORE_NAME, 'readwrite')
        transaction.objectStore(BOARD_LIBRARY_STORE_NAME).delete(BOARD_LIBRARY_RECORD_KEY)
        await transactionDone(transaction)
      })
    },
  }
}

export interface MemoryBoardLibraryStore extends BoardLibraryStore {
  seed(libraryItems: LibraryItems): void
}

export function createMemoryBoardLibraryStore(): MemoryBoardLibraryStore {
  let libraryItems: LibraryItems = []
  return {
    async load() {
      return cloneLibraryItems(libraryItems)
    },
    async save(nextLibraryItems) {
      libraryItems = cloneLibraryItems(nextLibraryItems)
    },
    async clear() {
      libraryItems = []
    },
    seed(nextLibraryItems) {
      libraryItems = cloneLibraryItems(nextLibraryItems)
    },
  }
}
