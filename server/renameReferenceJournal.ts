import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import {
  removeDurableJournal,
  removeDurableRecoveryPayload,
  rewriteDurableJournal,
  sha256Hex,
  writeDurableJournal,
  writeDurableRecoveryPayload,
} from './atomicTextWrite.js'
import { isPhysicallyContained } from './documentFileLifecycle.js'
import { isManagedDiaryPath } from '../shared/diaryProtocol.js'
import { isRecoveryMarkerName, recoveryMarkerName } from './technicalNamespace.js'

/** The journal payload contains before/after Markdown bytes. A generic
 *  reference transaction must reject any managed-Diary identity before it
 *  hashes, serializes, or writes those payloads. */
export class ManagedDiaryReferenceJournalUnsupportedError extends Error {
  readonly code = 'diary-encrypted-reference-unsupported'

  constructor(path: string) {
    super(`managed Diary reference journal is unsupported: ${path}`)
    this.name = 'ManagedDiaryReferenceJournalUnsupportedError'
  }
}
export type RenameReferencePlan = {
  path: string
  beforeRaw: string
  afterRaw: string
}

export type RenameReferenceEntry = {
  path: string
  beforeHash: string
  afterHash: string
  beforePayload: string
  afterPayload: string
}

export type RenameReferenceJournalEntry = {
  version: 1
  op: 'document-rename-references' | 'folder-rename-references'
  phase: 'preparing' | 'roll-forward' | 'roll-back' | 'cleanup'
  srcRel: string
  destRel: string
  documentId?: string
  sourceHash?: string
  sourceDev?: number
  sourceIno?: number
  /** Folder identities carry each document's source hash so recovery
   * can verify the actual generation — a directory's dev/ino is weak
   * evidence (recycled after external delete/recreate, unreliable on
   * some Windows file systems, brand-new after a replayable move). */
  identities?: Array<{ path: string; id: string; sourceHash?: string }>
  referenceIdentities?: Array<{
    documentId: string
    sourcePath: string
    writePath: string
    beforeHash: string
    afterHash: string
  }>
  metadataDisposition?: {
    kind: 'legacy-prefix-move'
  } | {
    kind: 'folder-snapshot-owned'
    ownerJournal: string
    ownerTransactionId: string
    ownerDescriptorHash: string
    metadataHandled: boolean
  } | {
    kind: 'folder-snapshot-owner-pending'
    ownerJournal: string
    ownerTransactionId: string
    ownerDescriptorHash: string
    previousDirection: 'roll-forward' | 'roll-back'
  } | {
    /**
     * Terminal fail-closed state written when a pending binding cannot
     * acquire its owner because the owner journal never became durable.
     * The independent reference direction is restored in `phase`, while
     * this disposition prevents a later startup from replaying it without
     * an owner-backed metadata decision.
     */
    kind: 'folder-snapshot-owner-aborted'
    ownerJournal: string
    ownerTransactionId: string
    ownerDescriptorHash: string
    previousDirection: 'roll-forward' | 'roll-back'
    reason: 'owner-journal-absent'
  }
  references: RenameReferenceEntry[]
}

export type PreparedRenameReferenceJournal = {
  journalPath: string
  transactionId: string
  descriptorHash: string
  entry: RenameReferenceJournalEntry
  setDirection(direction: 'roll-forward' | 'roll-back'): Promise<void>
  bindFolderSnapshotOwner(input: {
    ownerJournal: string
    ownerTransactionId: string
  }): Promise<void>
  cleanup(): Promise<void>
}

/** Exact protocol seams for subprocess crash verification. Null in
 * production and unreachable from requests. */
export type RenameReferenceJournalCrashHooks = {
  afterPreparingJournal?: () => void | Promise<void>
  afterPayloadWrite?: (index: number, kind: 'before' | 'after') => void | Promise<void>
  afterPhaseRewrite?: (phase: 'roll-forward' | 'roll-back' | 'cleanup') => void | Promise<void>
  afterPayloadRemove?: (index: number) => void | Promise<void>
}
let __crashHooks: RenameReferenceJournalCrashHooks | null = null
export function __setRenameReferenceJournalCrashHooksForTesting(hooks: RenameReferenceJournalCrashHooks | null): void {
  __crashHooks = hooks
}

type PrepareRenameReferenceJournalInput = {
  sourceAbs: string
  srcRel: string
  destRel: string
  references: readonly RenameReferencePlan[]
  referenceIdentities?: readonly {
    documentId: string
    sourcePath: string
    writePath: string
  }[]
} & ({
  op: 'document-rename-references'
  documentId: string
} | {
  op: 'folder-rename-references'
  documentId?: never
  identities: readonly { path: string; id: string; sourceHash: string }[]
})

export async function prepareRenameReferenceJournal(input: PrepareRenameReferenceJournalInput): Promise<PreparedRenameReferenceJournal | null> {
  const candidatePaths = [
    input.srcRel,
    input.destRel,
    ...input.references.map((reference) => reference.path),
    ...(input.referenceIdentities?.flatMap((identity) => [identity.sourcePath, identity.writePath]) ?? []),
    ...(input.op === 'folder-rename-references' ? input.identities.map((identity) => identity.path) : []),
  ]
  const managedPath = candidatePaths
    .map((value) => value.replace(/\.md$/, ''))
    .find((value) => isManagedDiaryPath(value))
  if (managedPath) throw new ManagedDiaryReferenceJournalUnsupportedError(managedPath)
  if (!input.references.length) return null
  if (input.op === 'document-rename-references' && !input.documentId) {
    throw new Error('document rename reference journal requires a documentId')
  }
  const dir = path.dirname(input.sourceAbs)
  const base = path.basename(input.sourceAbs)
  const transactionId = randomUUID()
  const journalPath = path.join(dir, recoveryMarkerName('journal', base, transactionId))
  const references = input.references.map((reference, index) => ({
    path: reference.path,
    beforeHash: sha256Hex(reference.beforeRaw),
    afterHash: sha256Hex(reference.afterRaw),
    beforePayload: recoveryMarkerName('ref-before', base, transactionId, index),
    afterPayload: recoveryMarkerName('ref-after', base, transactionId, index),
  }))
  const payloadPaths = references.flatMap((reference) => [
    path.join(dir, reference.beforePayload),
    path.join(dir, reference.afterPayload),
  ])
  const sourceStat = input.op === 'folder-rename-references' ? await fs.stat(input.sourceAbs) : null
  const referenceIdentities = input.referenceIdentities?.map((identity) => {
    const reference = references.find(item => item.path === identity.writePath)
    if (!reference) {
      throw new Error(
        `reference metadata identity has no matching write path: ${identity.writePath}`,
      )
    }
    return {
      ...identity,
      beforeHash: reference.beforeHash,
      afterHash: reference.afterHash,
    }
  })
  const baseEntry: Omit<RenameReferenceJournalEntry, 'phase'> = {
    version: 1,
    op: input.op,
    srcRel: input.srcRel,
    destRel: input.destRel,
    documentId: input.documentId,
    sourceHash: input.op === 'document-rename-references'
      ? sha256Hex(await fs.readFile(input.sourceAbs, 'utf8'))
      : undefined,
    sourceDev: sourceStat?.dev,
    sourceIno: sourceStat?.ino,
    identities: input.op === 'folder-rename-references' ? [...input.identities] : undefined,
    referenceIdentities,
    metadataDisposition: { kind: 'legacy-prefix-move' },
    references,
  }
  const descriptorHash = hashRenameReferenceBundleDescriptor({
    ...baseEntry,
    phase: 'preparing',
  }, transactionId)
  let metadataDisposition: RenameReferenceJournalEntry['metadataDisposition']
    = baseEntry.metadataDisposition
  await writeDurableJournal(journalPath, { ...baseEntry, phase: 'preparing' })
  if (__crashHooks?.afterPreparingJournal) await __crashHooks.afterPreparingJournal()
  const removePayloads = async (): Promise<void> => {
    for (let index = 0; index < payloadPaths.length; index += 1) {
      await removeDurableRecoveryPayload(payloadPaths[index])
      if (__crashHooks?.afterPayloadRemove) await __crashHooks.afterPayloadRemove(index)
    }
  }
  try {
    for (let index = 0; index < references.length; index += 1) {
      await writeDurableRecoveryPayload(path.join(dir, references[index].beforePayload), input.references[index].beforeRaw)
      if (__crashHooks?.afterPayloadWrite) await __crashHooks.afterPayloadWrite(index, 'before')
      await writeDurableRecoveryPayload(path.join(dir, references[index].afterPayload), input.references[index].afterRaw)
      if (__crashHooks?.afterPayloadWrite) await __crashHooks.afterPayloadWrite(index, 'after')
    }
    let phase: RenameReferenceJournalEntry['phase'] = 'roll-forward'
    await rewriteDurableJournal(journalPath, { ...baseEntry, phase })
    if (__crashHooks?.afterPhaseRewrite) await __crashHooks.afterPhaseRewrite(phase)
    return {
      journalPath,
      transactionId,
      descriptorHash,
      get entry() {
        return { ...baseEntry, metadataDisposition, phase }
      },
      async setDirection(direction) {
        phase = direction
        await rewriteDurableJournal(journalPath, {
          ...baseEntry,
          metadataDisposition,
          phase,
        })
        if (__crashHooks?.afterPhaseRewrite) await __crashHooks.afterPhaseRewrite(phase)
      },
      async bindFolderSnapshotOwner(owner) {
        metadataDisposition = {
          kind: 'folder-snapshot-owned',
          ...owner,
          ownerDescriptorHash: descriptorHash,
          metadataHandled: false,
        }
        await rewriteDurableJournal(journalPath, {
          ...baseEntry,
          metadataDisposition,
          phase,
        })
      },
      async cleanup() {
        phase = 'cleanup'
        await rewriteDurableJournal(journalPath, {
          ...baseEntry,
          metadataDisposition,
          phase,
        })
        if (__crashHooks?.afterPhaseRewrite) await __crashHooks.afterPhaseRewrite(phase)
        await removePayloads()
        await removeDurableJournal(journalPath)
      },
    }
  } catch (error) {
    // The preparing journal remains authoritative until every declared
    // payload has been removed. Startup recovery can repeat this cleanup.
    try {
      await removePayloads()
      await removeDurableJournal(journalPath)
    } catch {
      // Retain the preparing journal whenever cleanup is incomplete.
      // Startup recovery can repeat removal without orphaning payloads.
    }
    throw error
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validRelativePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every(segment =>
      segment.length > 0 && segment !== '.' && segment !== '..')
}

function stableCanonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonical).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableCanonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function renameReferenceBundleDescriptor(
  entry: RenameReferenceJournalEntry,
  transactionId: string,
): Record<string, unknown> {
  return {
    version: entry.version,
    op: entry.op,
    transactionId,
    srcRel: entry.srcRel,
    destRel: entry.destRel,
    documentId: entry.documentId,
    sourceHash: entry.sourceHash,
    identities: entry.identities,
    referenceIdentities: entry.referenceIdentities,
    references: entry.references,
  }
}

export function hashRenameReferenceBundleDescriptor(
  entry: RenameReferenceJournalEntry,
  transactionId: string,
): string {
  return createHash('sha256')
    .update(stableCanonical(renameReferenceBundleDescriptor(entry, transactionId)))
    .digest('hex')
}

/** Shared structural parser for the durable reference companion used by
 * both ordinary reference recovery and Round-17B metadata provenance. */
export function parseRenameReferenceJournalObject(
  value: unknown,
): RenameReferenceJournalEntry | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<RenameReferenceJournalEntry>
  if (entry.version !== 1
    || (entry.op !== 'document-rename-references'
      && entry.op !== 'folder-rename-references')
    || (entry.phase !== 'preparing'
      && entry.phase !== 'roll-forward'
      && entry.phase !== 'roll-back'
      && entry.phase !== 'cleanup')
    || typeof entry.srcRel !== 'string' || !validRelativePath(entry.srcRel)
    || typeof entry.destRel !== 'string' || !validRelativePath(entry.destRel)
    || entry.srcRel === entry.destRel
    || !Array.isArray(entry.references)
    || entry.references.length === 0
    || !entry.references.every(reference =>
      reference && typeof reference.path === 'string'
      && typeof reference.beforeHash === 'string'
      && SHA256_RE.test(reference.beforeHash)
      && typeof reference.afterHash === 'string'
      && SHA256_RE.test(reference.afterHash)
      && reference.beforeHash !== reference.afterHash
      && typeof reference.beforePayload === 'string'
      && typeof reference.afterPayload === 'string'
      && reference.beforePayload !== reference.afterPayload)) {
    return null
  }
  if (new Set(entry.references.map(item => item.path)).size !== entry.references.length
    || !entry.references.every(item => validRelativePath(item.path))) return null
  const payloadNames = entry.references.flatMap(item =>
    [item.beforePayload, item.afterPayload])
  if (new Set(payloadNames).size !== payloadNames.length
    || !payloadNames.every(name => path.basename(name) === name)) return null
  if (entry.op === 'document-rename-references') {
    if (typeof entry.documentId !== 'string' || entry.documentId.length === 0
      || typeof entry.sourceHash !== 'string'
      || !SHA256_RE.test(entry.sourceHash)) return null
  } else {
    if (!Array.isArray(entry.identities) || entry.identities.length === 0
      || !entry.identities.every(identity =>
        identity && typeof identity.path === 'string'
        && validRelativePath(identity.path)
        && (identity.path === entry.srcRel
          || identity.path.startsWith(`${entry.srcRel}/`))
        && typeof identity.id === 'string' && identity.id.length > 0
        && (identity.sourceHash === undefined
          || (typeof identity.sourceHash === 'string'
            && SHA256_RE.test(identity.sourceHash))))) return null
    if (new Set(entry.identities.map(identity => identity.path)).size
        !== entry.identities.length
      || new Set(entry.identities.map(identity => identity.id)).size
        !== entry.identities.length) return null
    const hashes = entry.identities.filter(identity =>
      identity.sourceHash !== undefined).length
    if (hashes !== 0 && hashes !== entry.identities.length) return null
  }
  if (entry.referenceIdentities !== undefined
    && (!Array.isArray(entry.referenceIdentities)
      || !entry.referenceIdentities.every(identity =>
        identity && typeof identity.documentId === 'string'
        && identity.documentId.length > 0
        && typeof identity.sourcePath === 'string'
        && validRelativePath(identity.sourcePath)
        && typeof identity.writePath === 'string'
        && validRelativePath(identity.writePath)
        && typeof identity.beforeHash === 'string'
        && SHA256_RE.test(identity.beforeHash)
        && typeof identity.afterHash === 'string'
        && SHA256_RE.test(identity.afterHash)))) {
    return null
  }
  if (entry.referenceIdentities) {
    if (new Set(entry.referenceIdentities.map(item => item.documentId)).size
      !== entry.referenceIdentities.length) return null
    const operationPaths = new Set<string>()
    for (const identity of entry.referenceIdentities) {
      const matches = entry.references.filter(reference =>
        reference.path === identity.writePath)
      if (matches.length !== 1
        || operationPaths.has(identity.writePath)
        || identity.beforeHash !== matches[0].beforeHash
        || identity.afterHash !== matches[0].afterHash) return null
      operationPaths.add(identity.writePath)
    }
  }
  if (entry.metadataDisposition !== undefined) {
    const disposition = entry.metadataDisposition
    if (!disposition || typeof disposition !== 'object') return null
    if (disposition.kind === 'legacy-prefix-move') {
      if (Object.keys(disposition).length !== 1) return null
    } else if (disposition.kind === 'folder-snapshot-owned') {
      if (path.basename(disposition.ownerJournal) !== disposition.ownerJournal
        || !isRecoveryMarkerName(disposition.ownerJournal, 'journal')
        || !UUID_RE.test(disposition.ownerTransactionId)
        || !SHA256_RE.test(disposition.ownerDescriptorHash)
        || typeof disposition.metadataHandled !== 'boolean') return null
    } else if (disposition.kind === 'folder-snapshot-owner-pending') {
      if (path.basename(disposition.ownerJournal) !== disposition.ownerJournal
        || !isRecoveryMarkerName(disposition.ownerJournal, 'journal')
        || !UUID_RE.test(disposition.ownerTransactionId)
        || !SHA256_RE.test(disposition.ownerDescriptorHash)
        || (disposition.previousDirection !== 'roll-forward'
          && disposition.previousDirection !== 'roll-back')) return null
    } else if (disposition.kind === 'folder-snapshot-owner-aborted') {
      if (path.basename(disposition.ownerJournal) !== disposition.ownerJournal
        || !isRecoveryMarkerName(disposition.ownerJournal, 'journal')
        || !UUID_RE.test(disposition.ownerTransactionId)
        || !SHA256_RE.test(disposition.ownerDescriptorHash)
        || (disposition.previousDirection !== 'roll-forward'
          && disposition.previousDirection !== 'roll-back')
        || disposition.reason !== 'owner-journal-absent') return null
    } else {
      return null
    }
  }
  return entry as RenameReferenceJournalEntry
}

export type DurableRenameReferenceBundle = {
  journalPath: string
  transactionId: string
  descriptorHash: string
  entry: RenameReferenceJournalEntry
  payloadPaths: string[]
  proofStrength: 'strong' | 'weak'
}

function parseTransactionBinding(
  journalPath: string,
): { sourceBase: string; transactionId: string; isUuid: boolean } | null {
  const name = path.basename(journalPath)
  const match = /^\.(.+)\.nuvyn-journal-([a-z0-9-]+)$/i.exec(name)
  if (!match) return null
  return {
    sourceBase: match[1],
    transactionId: match[2],
    isUuid: UUID_RE.test(match[2]),
  }
}

/**
 * The single durable trust boundary for both ordinary reference recovery and
 * folder snapshot provenance.  It validates structure, filename binding,
 * payload type/containment and payload bytes before returning a usable bundle.
 */
export async function parseAndValidateDurableRenameReferenceBundle(input: {
  contentDir: string
  journalPath: string
  value?: unknown
}): Promise<DurableRenameReferenceBundle | null> {
  const binding = parseTransactionBinding(input.journalPath)
  if (!binding) return null
  try {
    const stat = await fs.lstat(input.journalPath)
    if (!stat.isFile() || stat.isSymbolicLink()
      || !await isPhysicallyContained(input.contentDir, input.journalPath)) {
      return null
    }
  } catch {
    return null
  }
  let value = input.value
  if (value === undefined) {
    try {
      value = JSON.parse(await fs.readFile(input.journalPath, 'utf8'))
    } catch {
      return null
    }
  }
  const entry = parseRenameReferenceJournalObject(value)
  if (!entry) return null
  if (!binding.isUuid && entry.metadataDisposition !== undefined) return null
  const payloadPaths: string[] = []
  for (let index = 0; index < entry.references.length; index += 1) {
    const reference = entry.references[index]
    const expectedBefore = recoveryMarkerName(
      'ref-before',
      binding.sourceBase,
      binding.transactionId,
      index,
    )
    const expectedAfter = recoveryMarkerName(
      'ref-after',
      binding.sourceBase,
      binding.transactionId,
      index,
    )
    if (reference.beforePayload !== expectedBefore
      || reference.afterPayload !== expectedAfter) return null
    for (const [name, expectedHash] of [
      [reference.beforePayload, reference.beforeHash],
      [reference.afterPayload, reference.afterHash],
    ] as const) {
      const payloadPath = path.join(path.dirname(input.journalPath), name)
      try {
        const stat = await fs.lstat(payloadPath)
        if (!stat.isFile() || stat.isSymbolicLink()
          || !await isPhysicallyContained(input.contentDir, payloadPath)
          || sha256Hex(await fs.readFile(payloadPath, 'utf8')) !== expectedHash) {
          return null
        }
      } catch {
        return null
      }
      payloadPaths.push(payloadPath)
    }
  }
  return {
    journalPath: input.journalPath,
    transactionId: binding.transactionId,
    descriptorHash: hashRenameReferenceBundleDescriptor(
      entry,
      binding.transactionId,
    ),
    entry,
    payloadPaths,
    proofStrength: (entry.op === 'folder-rename-references'
      && entry.identities?.every(item => item.sourceHash !== undefined))
      || entry.op === 'document-rename-references'
      ? 'strong' : 'weak',
  }
}

export async function markRenameReferenceMetadataHandled(input: {
  contentDir: string
  journalPath: string
  ownerJournal: string
  ownerTransactionId: string
  ownerDescriptorHash: string
}): Promise<boolean> {
  const bundle = await parseAndValidateDurableRenameReferenceBundle(input)
  const disposition = bundle?.entry.metadataDisposition
  if (!bundle || disposition?.kind !== 'folder-snapshot-owned'
    || disposition.ownerJournal !== input.ownerJournal
    || disposition.ownerTransactionId !== input.ownerTransactionId
    || disposition.ownerDescriptorHash !== input.ownerDescriptorHash) {
    return false
  }
  if (disposition.metadataHandled) return true
  await rewriteDurableJournal(input.journalPath, {
    ...bundle.entry,
    metadataDisposition: { ...disposition, metadataHandled: true },
  })
  return true
}

export async function readRenameReferenceJournal(
  journalPath: string,
): Promise<RenameReferenceJournalEntry | null> {
  try {
    return parseRenameReferenceJournalObject(
      JSON.parse(await fs.readFile(journalPath, 'utf8')),
    )
  } catch {
    return null
  }
}
