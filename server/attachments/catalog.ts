import type {
  AttachmentIndexStatus,
  AttachmentListQuery,
  AttachmentPage,
  AttachmentResourceType,
  AttachmentSource,
  AttachmentSourceStatus,
  AttachmentSummary,
  ManagedAttachment,
} from '../../shared/attachmentProtocol.js'

export interface AttachmentAdapterResult {
  items: ManagedAttachment[]
  complete: boolean
  errorCode?: 'source-unavailable' | 'scan-limited'
}

export interface AttachmentCatalogAdapter {
  source: AttachmentSource
  scan(signal: AbortSignal): Promise<AttachmentAdapterResult>
}

export interface AttachmentCatalogAdapters {
  boardAssets: AttachmentCatalogAdapter
  vaultFiles: AttachmentCatalogAdapter
  boardMaterials: AttachmentCatalogAdapter
}

interface CatalogSnapshot {
  resources: ManagedAttachment[]
  sources: Record<AttachmentSource, AttachmentSourceStatus>
  complete: boolean
  refreshedAt: number
}

const SOURCES: readonly AttachmentSource[] = ['board-asset', 'vault-file', 'board-material']
const TYPE_VALUES: readonly AttachmentResourceType[] = ['image', 'file', 'material']

function pendingSources(): Record<AttachmentSource, AttachmentSourceStatus> {
  return {
    'board-asset': { state: 'pending', itemCount: 0 },
    'vault-file': { state: 'pending', itemCount: 0 },
    'board-material': { state: 'pending', itemCount: 0 },
  }
}

function stableKey(resource: ManagedAttachment): string {
  switch (resource.key.kind) {
    case 'asset': return `asset:${resource.key.id}`
    case 'vault-file': return `vault-file:${resource.key.path}`
    case 'board-material': return `board-material:${resource.key.id}`
  }
}

function compareResources(left: ManagedAttachment, right: ManagedAttachment): number {
  return (left.displayName ?? stableKey(left)).localeCompare(right.displayName ?? stableKey(right), undefined, { sensitivity: 'base' })
    || left.source.localeCompare(right.source)
    || stableKey(left).localeCompare(stableKey(right))
}

export class AttachmentCatalog {
  private snapshot: CatalogSnapshot | null = null
  private activePromise: Promise<void> | null = null
  private activeController: AbortController | null = null
  private generation = 0
  private readonly adapters: AttachmentCatalogAdapters
  private readonly now: () => number

  constructor(
    adapters: AttachmentCatalogAdapters,
    now: () => number = Date.now,
  ) {
    this.adapters = adapters
    this.now = now
  }

  getIndexStatus(): AttachmentIndexStatus {
    const snapshot = this.snapshot
    return {
      ready: snapshot !== null,
      refreshing: this.activePromise !== null,
      complete: snapshot?.complete ?? null,
      refreshedAt: snapshot?.refreshedAt || null,
      sources: snapshot ? structuredClone(snapshot.sources) : pendingSources(),
    }
  }

  async ensureReady(): Promise<void> {
    if (this.snapshot) return
    await this.refresh()
  }

  /**
   * Refresh is deduplicated for ordinary readers. An explicit refresh
   * supersedes the prior generation and aborts its filesystem traversal;
   * generation checks prevent a slow adapter from publishing stale results.
   */
  refresh(supersede = false): Promise<void> {
    if (this.activePromise && !supersede) return this.activePromise
    if (this.activePromise && supersede) this.activeController?.abort()

    const generation = ++this.generation
    const controller = new AbortController()
    this.activeController = controller
    const adapters: AttachmentCatalogAdapter[] = [
      this.adapters.boardAssets,
      this.adapters.vaultFiles,
      this.adapters.boardMaterials,
    ]
    const promise = (async () => {
      const results = await Promise.allSettled(adapters.map((adapter) => adapter.scan(controller.signal)))
      if (generation !== this.generation) return

      const resources: ManagedAttachment[] = []
      const sources = pendingSources()
      let complete = true
      results.forEach((result, index) => {
        const adapter = adapters[index]!
        if (result.status === 'rejected') {
          complete = false
          sources[adapter.source] = { state: 'failed', itemCount: 0, errorCode: 'source-unavailable' }
          return
        }
        resources.push(...result.value.items)
        const sourceComplete = result.value.complete
        complete = complete && sourceComplete
        sources[adapter.source] = {
          state: sourceComplete ? 'ready' : 'failed',
          itemCount: result.value.items.length,
          ...(!sourceComplete ? { errorCode: result.value.errorCode ?? 'source-unavailable' } : {}),
        }
      })
      resources.sort(compareResources)
      this.snapshot = {
        resources,
        sources,
        complete,
        refreshedAt: this.now(),
      }
    })().finally(() => {
      if (generation === this.generation) {
        this.activePromise = null
        this.activeController = null
      }
    })
    this.activePromise = promise
    return promise
  }

  async getSummary(): Promise<AttachmentSummary> {
    await this.ensureReady()
    return this.summarize(this.snapshot!)
  }

  async list(query: AttachmentListQuery): Promise<AttachmentPage> {
    await this.ensureReady()
    const snapshot = this.snapshot!
    const search = query.search?.trim().toLocaleLowerCase() ?? ''
    const filtered = snapshot.resources.filter((resource) => {
      if (query.type && resource.type !== query.type) return false
      if (query.source && resource.source !== query.source) return false
      if (query.referenceStatus && resource.referenceStatus !== query.referenceStatus) return false
      if (!search) return true
      const key = stableKey(resource)
      const pathOrId = resource.key.kind === 'vault-file' ? resource.key.path : resource.key.id
      return `${resource.displayName ?? ''}\n${pathOrId}\n${resource.mimeType ?? ''}`.toLocaleLowerCase().includes(search)
        || key.toLocaleLowerCase().includes(search)
    })
    const offset = query.offset ?? 0
    const limit = query.limit ?? 30
    const status = this.getIndexStatus()
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
      summary: this.summarize(snapshot),
      indexStatus: status,
    }
  }

  private summarize(snapshot: CatalogSnapshot): AttachmentSummary {
    const sources = Object.fromEntries(SOURCES.map((source) => [source, { count: 0, knownBytes: 0 }])) as AttachmentSummary['sources']
    let knownBytes = 0
    let unknownByteSizeCount = 0
    let unknownReferenceCount = 0
    for (const resource of snapshot.resources) {
      const source = sources[resource.source]
      source.count += 1
      if (resource.byteSize === null) unknownByteSizeCount += 1
      else {
        source.knownBytes += resource.byteSize
        knownBytes += resource.byteSize
      }
      if (resource.referenceStatus === 'unknown') unknownReferenceCount += 1
    }
    return {
      total: snapshot.resources.length,
      knownBytes,
      unknownByteSizeCount,
      unknownReferenceCount,
      sources,
      complete: snapshot.complete,
    }
  }
}

export function isAttachmentSource(value: unknown): value is AttachmentSource {
  return typeof value === 'string' && SOURCES.includes(value as AttachmentSource)
}

export function isAttachmentType(value: unknown): value is AttachmentResourceType {
  return typeof value === 'string' && TYPE_VALUES.includes(value as AttachmentResourceType)
}

export function isAttachmentReferenceStatus(value: unknown): value is ManagedAttachment['referenceStatus'] {
  return value === 'referenced' || value === 'unreferenced' || value === 'unknown'
}
