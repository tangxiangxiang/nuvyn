import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { sha256Hex } from '../atomicTextWrite'
import { recoverInterruptedOperations } from '../crashRecovery'
import { getDocumentMetadata, saveDocumentMetadata } from '../documentMetadata'
import { createFolderMoveGateProof } from '../folderMoveTransaction'
import {
  captureFolderMoveDirectoryEntries,
} from '../folderMoveDirectoryOwnership'
import { writeFolderMoveGateProof } from '../folderMoveGateProof'
import { captureDurableDirectoryIdentity } from '../durableDirectoryIdentity'
import {
  cleanupRecoveryTempDir,
  RECOVERY_MODEL_TIMEOUT_MS,
  throwIfRecoveryAborted,
} from './helpers/recoveryIntegration'

async function createRecoveryModelEnvironment(): Promise<{
  root: string
  db: InstanceType<typeof Database>
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-recovery-model-'))
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return { root, db }
}

function rngFor(seed: number): () => number {
  let state = seed || 0x9e3779b9
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5) | 0
    return ((state ^ (state >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

describe('deterministic rename-reference recovery model', () => {
  it('converges and is idempotent for 1000 reproducible seeds', async ({ signal }) => {
    const { root, db } = await createRecoveryModelEnvironment()
    try {
      const replaySeed = Number(process.env.NUVYN_RECOVERY_SEED || 0)
      const seeds = replaySeed > 0 ? [replaySeed] : Array.from({ length: 1000 }, (_, index) => index + 1)
      for (const seed of seeds) {
        throwIfRecoveryAborted(signal)
      const random = rngFor(seed)
      const caseDir = path.join(root, seed.toString(16))
      const prefix = seed.toString(16)
      const srcRel = `${prefix}/old`
      const destRel = `${prefix}/new`
      const sourceRaw = `# owned ${seed}\n`
      const phase = (['preparing', 'roll-forward', 'roll-back', 'cleanup'] as const)[Math.floor(random() * 4)]
      const referenceCount = Math.floor(random() * 11)
      const externalSource = phase === 'roll-back' && random() < 0.2
      const externalDestination = phase === 'roll-forward' && random() < 0.2
      const missingPayload = phase !== 'preparing' && phase !== 'cleanup' && random() < 0.15
      const thirdPartyIndex = phase !== 'preparing' && phase !== 'cleanup' && random() < 0.2 && referenceCount
        ? Math.floor(random() * referenceCount)
        : -1
      const journalName = `.old.md.nuvyn-journal-${seed.toString(16)}`
      let journal: Record<string, unknown> | null = null
      try {
        await fs.mkdir(caseDir, { recursive: true })
        const ownedAtDestination = phase === 'roll-forward' || (phase === 'roll-back' && random() < 0.5)
        const ownedAbs = path.join(caseDir, ownedAtDestination ? 'new.md' : 'old.md')
        await fs.writeFile(ownedAbs, sourceRaw)
        if (externalSource && ownedAtDestination) await fs.writeFile(path.join(caseDir, 'old.md'), `# external source ${seed}\n`)
        if (externalDestination && ownedAtDestination) await fs.writeFile(path.join(caseDir, 'new.md'), `# external destination ${seed}\n`)
        const identityPath = ownedAtDestination ? destRel : srcRel
        saveDocumentMetadata(db, { id: `id-${seed}`, path: identityPath, title: `Seed ${seed}`, updatedAt: seed })

        const references = [] as Array<Record<string, string>>
        for (let index = 0; index < referenceCount; index += 1) {
          const refRel = `${prefix}/ref-${index}`
          const beforeRaw = `[[old]] seed=${seed} ref=${index}\n`
          const afterRaw = `[[new]] seed=${seed} ref=${index}\n`
          const beforePayload = `.old.md.nuvyn-ref-before-${seed.toString(16)}-${index.toString(16)}`
          const afterPayload = `.old.md.nuvyn-ref-after-${seed.toString(16)}-${index.toString(16)}`
          await fs.writeFile(path.join(caseDir, beforePayload), beforeRaw)
          await fs.writeFile(path.join(caseDir, afterPayload), afterRaw)
          const landed = random() < 0.5
          const currentRaw = index === thirdPartyIndex
            ? `external reference ${seed}/${index}\n`
            : phase === 'roll-back'
              ? (landed ? beforeRaw : afterRaw)
              : (landed ? afterRaw : beforeRaw)
          await fs.writeFile(path.join(caseDir, `ref-${index}.md`), currentRaw)
          references.push({
            path: refRel, beforeHash: sha256Hex(beforeRaw), afterHash: sha256Hex(afterRaw),
            beforePayload, afterPayload,
          })
        }
        if (referenceCount === 0) {
          await cleanupRecoveryTempDir(caseDir)
          db.prepare('DELETE FROM documents WHERE id = ?').run(`id-${seed}`)
          continue
        }
        if (missingPayload) await fs.rm(path.join(caseDir, references[0].afterPayload))
        journal = {
          version: 1, op: 'document-rename-references', phase,
          srcRel, destRel, documentId: `id-${seed}`, sourceHash: sha256Hex(sourceRaw), references,
        }
        await fs.writeFile(path.join(caseDir, journalName), JSON.stringify(journal))

        await recoverInterruptedOperations(root, db)
        const onceNames = (await fs.readdir(caseDir)).sort()
        const onceBodies = new Map<string, string>()
        for (const name of onceNames) {
          const abs = path.join(caseDir, name)
          if ((await fs.stat(abs)).isFile()) onceBodies.set(name, await fs.readFile(abs, 'utf8'))
        }
        await recoverInterruptedOperations(root, db)
        await recoverInterruptedOperations(root, db)
        expect((await fs.readdir(caseDir)).sort(), `seed=${seed} journal=${JSON.stringify(journal)}`).toEqual(onceNames)
        for (const [name, body] of onceBodies) {
          expect(await fs.readFile(path.join(caseDir, name), 'utf8'), `seed=${seed} file=${name}`).toBe(body)
        }
        if (externalSource) expect(await fs.readFile(path.join(caseDir, 'old.md'), 'utf8')).toBe(`# external source ${seed}\n`)
        if (externalDestination) {
          expect(await fs.readFile(path.join(caseDir, 'new.md'), 'utf8')).toBe(`# external destination ${seed}\n`)
          if (missingPayload) {
            expect(getDocumentMetadata(db, destRel)?.id).toBe(`id-${seed}`)
          } else {
            expect(getDocumentMetadata(db, destRel)).toBeNull()
          }
        }
        const remainingPayloads = onceNames.filter((name) => name.includes('.nuvyn-ref-'))
        if (remainingPayloads.length) expect(onceNames).toContain(journalName)
      } catch (error) {
        throw new Error(`replay with NUVYN_RECOVERY_SEED=${seed}\ninitial=${JSON.stringify(journal)}\n${(error as Error).stack}`)
      } finally {
        await cleanupRecoveryTempDir(caseDir)
        db.prepare('DELETE FROM documents WHERE id = ?').run(`id-${seed}`)
      }
      }
    } finally {
      db.close()
      await cleanupRecoveryTempDir(root)
    }
  }, RECOVERY_MODEL_TIMEOUT_MS)
})

/** Every file under a directory, keyed by relative path. */
async function collectTree(dir: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>()
  const walk = async (current: string, rel: string): Promise<void> => {
    let dirents
    try {
      dirents = await fs.readdir(current, { withFileTypes: true })
    } catch { return }
    for (const entry of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(current, entry.name), entryRel)
      else if (entry.isFile()) tree.set(entryRel, await fs.readFile(path.join(current, entry.name), 'utf8'))
    }
  }
  await walk(dir, '')
  return tree
}

describe('deterministic replayable folder-move recovery model', () => {
  it('reconciles every split crash state and never touches external bytes for 1000 Round-9 seeds', async ({ signal }) => {
    // The Windows protocol can crash with the tree SPLIT between source
    // and destination in every combination; the journal's per-entry
    // hashes must reconcile all of them: complete forward when every
    // entry is replayable, clean the stale gate when the move never
    // started, quarantine on foreign content — never losing our bytes,
    // never touching external ones, idempotent across restarts.
    const { root, db } = await createRecoveryModelEnvironment()
    try {
      const replaySeed = Number(process.env.NUVYN_RECOVERY_SEED || 0)
      const seeds = replaySeed > 0 ? [replaySeed] : Array.from({ length: 1000 }, (_, index) => index + 1)
      for (const seed of seeds) {
        throwIfRecoveryAborted(signal)
      const random = rngFor(seed ^ 0x5eed11)
      const prefix = `fm-${seed.toString(16)}`
      const caseDir = path.join(root, prefix)
      const srcRel = `${prefix}/proj`
      const destRel = `${prefix}/ren`
      const aRaw = `# a ${seed}\n`
      const bRaw = `# b ${seed}\n`
      const imgRaw = `attachment ${seed}\n`
      // Physical entries — the journal covers EVERY file the mover
      // touches, so the model carries a non-markdown attachment with
      // no identity alongside the two documents.
      const entries: Array<{ rel: string; id: string | null; docRel: string | null; sourceHash: string; raw: string }> = [
        { rel: 'a.md', id: `a-id-${seed}`, docRel: 'a', sourceHash: sha256Hex(aRaw), raw: aRaw },
        { rel: 'img.bin', id: null, docRel: null, sourceHash: sha256Hex(imgRaw), raw: imgRaw },
        { rel: 'nested/b.md', id: `b-id-${seed}`, docRel: 'nested/b', sourceHash: sha256Hex(bRaw), raw: bRaw },
      ]
      const journalName = `.proj.nuvyn-journal-${seed.toString(16)}`
      let model: Record<string, unknown> | null = null
      try {
        await fs.mkdir(caseDir, { recursive: true })
        const srcAbs = path.join(caseDir, 'proj')
        const destAbs = path.join(caseDir, 'ren')
        const placements = entries.map(() => (['src', 'dest', 'both', 'external', 'missing'] as const)[Math.floor(random() * 5)])
        const directories = [...new Set(entries
          .map((entry) => entry.rel.includes('/')
            ? entry.rel.slice(0, entry.rel.lastIndexOf('/'))
            : null)
          .filter((dir): dir is string => dir !== null))]
          .sort()
        const externalBodies = new Map<string, string>()
        const writeExternal = async (relPath: string, body: string): Promise<void> => {
          const abs = path.join(caseDir, relPath)
          await fs.mkdir(path.dirname(abs), { recursive: true })
          await fs.writeFile(abs, body, 'utf8')
          externalBodies.set(relPath, body)
        }
        // Build the complete prepared source generation first. The
        // journal's file generations are captured before any move, so
        // even a crash state where a declared entry is now missing
        // still carries the durable generation that disappeared.
        await fs.mkdir(srcAbs, { recursive: true })
        for (const directory of directories) {
          await fs.mkdir(path.join(srcAbs, directory), { recursive: true })
        }
        for (const entry of entries) {
          await fs.writeFile(path.join(srcAbs, entry.rel), entry.raw, 'utf8')
        }
        const sourceRootIdentity =
          await captureDurableDirectoryIdentity(srcAbs)
        const sourceDirectoryGenerations =
          await captureFolderMoveDirectoryEntries(srcAbs, root)
        const preparedFileGenerations = await Promise.all(
          entries.map(async entry => {
            const stat = await fs.lstat(path.join(srcAbs, entry.rel), { bigint: true })
            return { dev: stat.dev.toString(), ino: stat.ino.toString() }
          }),
        )
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index]
          const placement = placements[index]
          const sourceEntry = path.join(srcAbs, entry.rel)
          const destinationEntry = path.join(destAbs, entry.rel)
          if (placement === 'dest' || placement === 'both') {
            await fs.mkdir(path.dirname(destinationEntry), { recursive: true })
            await fs.link(sourceEntry, destinationEntry)
          }
          if (placement === 'dest' || placement === 'external' || placement === 'missing') {
            await fs.unlink(sourceEntry)
          }
          if (placement === 'external') {
            await writeExternal(`ren/${entry.rel}`, `# external ${seed}/${index}\n`)
          }
        }
        const gateExists = placements.some((p) => p === 'dest' || p === 'both' || p === 'external') || random() < 0.6
        const gateProof = createFolderMoveGateProof()
        if (gateExists) {
          await fs.mkdir(destAbs, { recursive: true })
          // The mover drops a hidden gate token when it creates the
          // gate — recovery needs it to prove an otherwise-empty
          // destination is ours (round-8: emptiness is not proof).
          await writeFolderMoveGateProof(destAbs, gateProof)
        }
        if (gateExists && random() < 0.3) await fs.mkdir(path.join(destAbs, 'nested'), { recursive: true })
        const externalInGate = gateExists && random() < 0.25
        if (externalInGate) await writeExternal(`ren/external-gate-${seed}.md`, `# external gate ${seed}\n`)
        const metadataSides = entries.map((entry) => (entry.id ? (['src', 'dest', 'none'] as const)[Math.floor(random() * 3)] : 'none'))
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index]
          const side = metadataSides[index]
          if (side === 'src') saveDocumentMetadata(db, { id: entry.id!, path: `${srcRel}/${entry.docRel}`, title: `Seed ${seed}`, updatedAt: seed })
          if (side === 'dest') saveDocumentMetadata(db, { id: entry.id!, path: `${destRel}/${entry.docRel}`, title: `Seed ${seed}`, updatedAt: seed })
        }
        const sourceHasMetadata = metadataSides.includes('src')
        const destinationHasMetadata = metadataSides.includes('dest')
        const documentMetadataSides = metadataSides.filter(
          (_side, index) => entries[index].id !== null,
        )
        const allDocumentMetadataAtDestination =
          documentMetadataSides.length > 0
          && documentMetadataSides.every(side => side === 'dest')
        const allDocumentMetadataAtSource =
          documentMetadataSides.length > 0
          && documentMetadataSides.every(side => side === 'src')
        const allAtSource = placements.every((p) => p === 'src')
        if (gateExists) {
          for (const directory of directories) {
            await fs.mkdir(path.join(destAbs, directory), { recursive: true })
          }
        }
        const destinationDirectoryGenerations = gateExists
          ? await Promise.all(directories.map(async relativeDirectoryPath => {
              const identity = await captureDurableDirectoryIdentity(
                path.join(destAbs, relativeDirectoryPath),
              )
              return {
                relativeDirectoryPath,
                sourceDev: identity.dev,
                sourceIno: identity.ino,
                sourceBirthtimeNs: identity.birthtimeNs,
              }
            }))
          : undefined
        const durableEntries = entries.map(({
          rel,
          id,
          docRel,
          sourceHash,
        }, index) => {
          const generation = preparedFileGenerations[index]
          return {
            relativeFilePath: rel,
            sourceHash,
            sourceDev: generation.dev,
            sourceIno: generation.ino,
            ...(id
              ? { documentId: id, documentPath: `${srcRel}/${docRel}` }
              : {}),
          }
        })
        await fs.writeFile(path.join(caseDir, journalName), JSON.stringify({
          version: 4,
          op: 'folder-rename',
          phase: gateExists ? 'gate-created' : 'prepared',
          srcRel,
          destRel,
          strategy: 'replayable-move',
          sourceDev: sourceRootIdentity.dev,
          sourceIno: sourceRootIdentity.ino,
          sourceBirthtimeNs: sourceRootIdentity.birthtimeNs,
          ...(gateExists
            ? {
                ...await captureDurableDirectoryIdentity(destAbs).then(
                  identity => ({
                    destDev: identity.dev,
                    destIno: identity.ino,
                    destBirthtimeNs: identity.birthtimeNs,
                  }),
                ),
                destinationDirectoryGenerations,
              }
            : {}),
          gateProof,
          entries: durableEntries,
          directories,
          directoryGenerations: sourceDirectoryGenerations,
          metadataDisposition: { kind: 'prefix-move' },
        }))
        model = {
          placements,
          gateExists,
          externalInGate,
          sourceHasMetadata,
          destinationHasMetadata,
          allDocumentMetadataAtDestination,
          allDocumentMetadataAtSource,
          allAtSource,
        }

        const firstReport = await recoverInterruptedOperations(root, db)
        model = { ...model, actions: firstReport.actions }
        const onceTree = await collectTree(caseDir)
        await recoverInterruptedOperations(root, db)
        await recoverInterruptedOperations(root, db)
        const finalTree = await collectTree(caseDir)
        const detail = `seed=${seed} model=${JSON.stringify(model)}`

        // Idempotent across repeated startups — names AND bodies.
        // Sort by key: readdir order is not stable on Windows (NTFS),
        // so an order-sensitive entries() comparison is flaky there.
        const sortedEntries = (tree: Map<string, string>): Array<[string, string]> =>
          [...tree.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        const onceSorted = JSON.stringify(sortedEntries(onceTree))
        const finalSorted = JSON.stringify(sortedEntries(finalTree))
        expect(finalSorted, `${detail}\nonce=${onceSorted}\nfinal=${finalSorted}`).toBe(onceSorted)
        // External bytes are never modified or removed.
        for (const [relPath, body] of externalBodies) {
          expect(finalTree.get(relPath), `external ${relPath}; ${detail}`).toBe(body)
        }
        // No create-only staging may survive a recovery pass.
        expect([...finalTree.keys()].some((name) => name.includes('.nuvyn-rename-')), detail).toBe(false)
        // Our bytes are never lost: every entry resident somewhere at
        // crash time still has its content on disk afterwards.
        for (let index = 0; index < entries.length; index += 1) {
          const placement = placements[index]
          if (placement !== 'src' && placement !== 'dest' && placement !== 'both') continue
          const present = [...finalTree.values()].some((body) => sha256Hex(body) === entries[index].sourceHash)
          expect(present, `entry ${entries[index].rel} lost; ${detail}`).toBe(true)
        }
        const journalKept = [...finalTree.keys()].includes(journalName)
        // Round-8: recovery quarantines (never merges) when the
        // destination holds ANY external content — an entry at a
        // foreign generation, a missing generation, OR an undeclared
        // file inside the gate (externalInGate).
        const replayBlocked =
          placements.includes('external')
          || placements.includes('missing')
          // The create-only mover never exposes the same generation at
          // both formal paths: it links from hidden staging, then drops
          // staging. A formal source+destination duplicate therefore
          // means the source path was reused after landing and must be
          // quarantined.
          || placements.includes('both')
          || externalInGate
        const durableForwardIntent =
          !allAtSource
          || (gateExists && destinationHasMetadata && !sourceHasMetadata)
        if (!replayBlocked && durableForwardIntent) {
          // Fully replayable split: the journal must be consumed and
          // every entry must land at the destination with its content;
          // metadata follows the bytes to the destination prefix. A
          // gate-created transaction whose metadata is already wholly
          // at the destination also carries forward intent even when
          // every file is still replayable from the source.
          expect(journalKept, `journal kept; ${detail}`).toBe(false)
          for (const entry of entries) {
            expect(finalTree.get(`ren/${entry.rel}`), `entry not at dest; ${detail}`).toBe(entry.raw)
          }
          for (let index = 0; index < entries.length; index += 1) {
            if (metadataSides[index] === 'none') continue
            expect(getDocumentMetadata(db, `${destRel}/${entries[index].docRel}`)?.id, `metadata; ${detail}`).toBe(entries[index].id)
          }
        } else if (
          allAtSource
          && !externalInGate
          && !(sourceHasMetadata && destinationHasMetadata)
          && (gateExists || allDocumentMetadataAtSource)
        ) {
          // The move never started and the gate (if any) is provably
          // ours: stale journal cleaned, source intact. Destination-only
          // metadata (a crash mid-metadata-move) rolls back to the
          // source prefix alongside the bytes.
          expect(journalKept, `stale journal kept; ${detail}`).toBe(false)
          for (const entry of entries) {
            expect(finalTree.get(`proj/${entry.rel}`), `source lost; ${detail}`).toBe(entry.raw)
          }
          for (let index = 0; index < entries.length; index += 1) {
            if (metadataSides[index] === 'none') continue
            expect(getDocumentMetadata(db, `${srcRel}/${entries[index].docRel}`)?.id, `metadata rollback; ${detail}`).toBe(entries[index].id)
          }
        } else {
          // Foreign content, a missing generation, or a metadata split
          // across both prefixes: the journal stays authoritative.
          expect(journalKept, `journal dropped; ${detail}`).toBe(true)
        }
      } catch (error) {
        throw new Error(`replay with NUVYN_RECOVERY_SEED=${seed}\nmodel=${JSON.stringify(model)}\n${(error as Error).stack}`)
      } finally {
        await cleanupRecoveryTempDir(caseDir)
        for (const entry of entries) {
          if (entry.id) db.prepare('DELETE FROM documents WHERE id = ?').run(entry.id)
        }
      }
      }
    } finally {
      db.close()
      await cleanupRecoveryTempDir(root)
    }
  }, RECOVERY_MODEL_TIMEOUT_MS)
})

describe('deterministic folder-reference content-proof model', () => {
  it('never completes a reference transaction onto an externally recreated folder for 300 seeds', async ({ signal }) => {
    // Forged journal carrying the destination directory's real dev/ino
    // but files recreated by an external sync: the per-identity content
    // hashes are the only proof that may pass — inode+existence would
    // complete onto foreign bytes.
    const { root, db } = await createRecoveryModelEnvironment()
    try {
      const replaySeed = Number(process.env.NUVYN_RECOVERY_SEED || 0)
      const seeds = replaySeed > 0 ? [replaySeed] : Array.from({ length: 300 }, (_, index) => index + 1)
      for (const seed of seeds) {
        throwIfRecoveryAborted(signal)
      const random = rngFor(seed ^ 0xf01dab1e)
      const prefix = `fr-${seed.toString(16)}`
      const caseDir = path.join(root, prefix)
      const srcRel = `${prefix}/proj`
      const destRel = `${prefix}/ren`
      const sourceRaw = `# ours ${seed}\n`
      const externalRaw = `# external ${seed}\n`
      const content = (['ours', 'external'] as const)[Math.floor(random() * 2)]
      const journalName = `.proj.nuvyn-journal-${seed.toString(16)}`
      const beforePayload = `.proj.nuvyn-ref-before-${seed.toString(16)}-0`
      const afterPayload = `.proj.nuvyn-ref-after-${seed.toString(16)}-0`
      let model: Record<string, unknown> | null = null
      try {
        await fs.mkdir(path.join(caseDir, 'ren'), { recursive: true })
        await fs.writeFile(path.join(caseDir, 'ren', 'a.md'), content === 'external' ? externalRaw : sourceRaw, 'utf8')
        const refBefore = `[[old]] ${seed}\n`
        const refAfter = `[[new]] ${seed}\n`
        const refLanded = content !== 'external' && random() < 0.5
        await fs.writeFile(path.join(caseDir, 'ref-a.md'), refLanded ? refAfter : refBefore, 'utf8')
        await fs.writeFile(path.join(caseDir, beforePayload), refBefore, 'utf8')
        await fs.writeFile(path.join(caseDir, afterPayload), refAfter, 'utf8')
        const destStat = await fs.stat(path.join(caseDir, 'ren'))
        saveDocumentMetadata(db, { id: `id-${seed}`, path: `${destRel}/a`, title: `Seed ${seed}`, updatedAt: seed })
        await fs.writeFile(path.join(caseDir, journalName), JSON.stringify({
          version: 1, op: 'folder-rename-references', phase: 'roll-forward',
          srcRel, destRel, sourceDev: destStat.dev, sourceIno: destStat.ino,
          identities: [{ path: `${srcRel}/a`, id: `id-${seed}`, sourceHash: sha256Hex(sourceRaw) }],
          references: [{
            path: `${prefix}/ref-a`, beforeHash: sha256Hex(refBefore), afterHash: sha256Hex(refAfter),
            beforePayload, afterPayload,
          }],
        }))
        model = { content, refLanded }

        await recoverInterruptedOperations(root, db)
        const onceTree = await collectTree(caseDir)
        await recoverInterruptedOperations(root, db)
        await recoverInterruptedOperations(root, db)
        const finalTree = await collectTree(caseDir)
        const detail = `seed=${seed} model=${JSON.stringify(model)}`

        // Sort by key: readdir order is not stable on Windows (NTFS),
        // so an order-sensitive entries() comparison is flaky there.
        const sortedEntries = (tree: Map<string, string>): Array<[string, string]> =>
          [...tree.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        const onceSorted = JSON.stringify(sortedEntries(onceTree))
        const finalSorted = JSON.stringify(sortedEntries(finalTree))
        expect(finalSorted, `${detail}\nonce=${onceSorted}\nfinal=${finalSorted}`).toBe(onceSorted)
        if (content === 'external') {
          // External recreation despite the journal carrying the
          // directory's REAL dev/ino: quarantine, journal kept, the
          // foreign file and the reference rewrite untouched, identity
          // detached from the foreign bytes.
          expect(finalTree.get(journalName), detail).toBeDefined()
          expect(finalTree.get('ren/a.md'), detail).toBe(externalRaw)
          expect(finalTree.get('ref-a.md'), detail).toBe(refLanded ? refAfter : refBefore)
          expect(getDocumentMetadata(db, `${destRel}/a`), detail).toBeNull()
        } else {
          // Our generation proven by content hash: the transaction
          // completes and cleans up.
          expect(finalTree.get(journalName), detail).toBeUndefined()
          expect(finalTree.get('ref-a.md'), detail).toBe(refAfter)
          expect([...finalTree.keys()].some((name) => name.includes('.nuvyn-ref-')), detail).toBe(false)
        }
      } catch (error) {
        throw new Error(`replay with NUVYN_RECOVERY_SEED=${seed}\nmodel=${JSON.stringify(model)}\n${(error as Error).stack}`)
      } finally {
        await cleanupRecoveryTempDir(caseDir)
        db.prepare('DELETE FROM documents WHERE id = ?').run(`id-${seed}`)
      }
      }
    } finally {
      db.close()
      await cleanupRecoveryTempDir(root)
    }
  }, RECOVERY_MODEL_TIMEOUT_MS)
})

describe('deterministic legacy delete-quarantine promotion model', () => {
  it('promotes legacy artifacts without ever writing an empty manifest for 300 seeds', async ({ signal }) => {
    // Timestamp-only delete artifacts are ambiguous after upgrade:
    // always promoted to the permanent quarantine, never auto-deleted;
    // a manifest is written ONLY when there is an identity to persist
    // (an empty one would be unparseable and block the basename
    // forever).
    const { root, db } = await createRecoveryModelEnvironment()
    try {
      const replaySeed = Number(process.env.NUVYN_RECOVERY_SEED || 0)
      const seeds = replaySeed > 0 ? [replaySeed] : Array.from({ length: 300 }, (_, index) => index + 1)
      for (const seed of seeds) {
        throwIfRecoveryAborted(signal)
      const random = rngFor(seed ^ 0xde1e7e)
      const prefix = `ld-${seed.toString(16)}`
      const caseDir = path.join(root, prefix)
      const isFolder = random() < 0.5
      const withMetadata = random() < 0.5
      const targetReused = random() < 0.4
      const artifactBody = isFolder ? `# folder ${seed}\n` : `# old ${seed}\n`
      const metaPath = `${prefix}/gone`
      let model: Record<string, unknown> | null = null
      try {
        await fs.mkdir(caseDir, { recursive: true })
        if (isFolder) {
          await fs.mkdir(path.join(caseDir, `gone.nuvyn-delete-${seed}`), { recursive: true })
          await fs.writeFile(path.join(caseDir, `gone.nuvyn-delete-${seed}`, 'a.md'), artifactBody, 'utf8')
        } else {
          await fs.writeFile(path.join(caseDir, `gone.md.nuvyn-delete-${seed}`), artifactBody, 'utf8')
        }
        if (withMetadata) saveDocumentMetadata(db, { id: `id-${seed}`, path: metaPath, title: `Seed ${seed}`, updatedAt: seed })
        if (targetReused) {
          if (isFolder) {
            await fs.mkdir(path.join(caseDir, 'gone'), { recursive: true })
            await fs.writeFile(path.join(caseDir, 'gone', 'a.md'), `# reused ${seed}\n`, 'utf8')
          } else {
            await fs.writeFile(path.join(caseDir, 'gone.md'), `# reused ${seed}\n`, 'utf8')
          }
        }
        model = { isFolder, withMetadata, targetReused }

        const first = await recoverInterruptedOperations(root, db)
        const onceTree = await collectTree(caseDir)
        const second = await recoverInterruptedOperations(root, db)
        await recoverInterruptedOperations(root, db)
        const finalTree = await collectTree(caseDir)
        const detail = `seed=${seed} model=${JSON.stringify(model)}`

        // Sort by key: readdir order is not stable on Windows (NTFS),
        // so an order-sensitive entries() comparison is flaky there.
        const sortedEntries = (tree: Map<string, string>): Array<[string, string]> =>
          [...tree.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        const onceSorted = JSON.stringify(sortedEntries(onceTree))
        const finalSorted = JSON.stringify(sortedEntries(finalTree))
        expect(finalSorted, `${detail}\nonce=${onceSorted}\nfinal=${finalSorted}`).toBe(onceSorted)
        // Bytes are preserved under the permanent quarantine name —
        // a legacy artifact is never auto-deleted.
        const quarantineName = isFolder
          ? [...finalTree.keys()].map((name) => name.split('/')[0]).find((name) => name.startsWith('gone.nuvyn-quarantine-reuse-'))
          : [...finalTree.keys()].find((name) => name.startsWith('gone.md.nuvyn-quarantine-reuse-'))
        expect(quarantineName, detail).toBeDefined()
        const quarantinedBody = isFolder ? finalTree.get(`${quarantineName}/a.md`) : finalTree.get(quarantineName!)
        expect(quarantinedBody, detail).toBe(artifactBody)
        // Manifest exists if and only if there was an identity.
        const manifestPresent = [...finalTree.keys()].some((name) => name.includes('.nuvyn-quarantine-manifest-'))
        expect(manifestPresent, `first=${JSON.stringify(first.actions)}; ${detail}`).toBe(withMetadata)
        // No startup may ever report an invalid manifest for the
        // generated artifact.
        expect(second.actions.some((a) => a.detail?.includes('invalid legacy delete quarantine manifest')), detail).toBe(false)
        if (targetReused) {
          const reusedBody = isFolder ? finalTree.get('gone/a.md') : finalTree.get('gone.md')
          expect(reusedBody, detail).toBe(`# reused ${seed}\n`)
        }
        if (withMetadata) expect(getDocumentMetadata(db, metaPath), detail).toBeNull()
      } catch (error) {
        throw new Error(`replay with NUVYN_RECOVERY_SEED=${seed}\nmodel=${JSON.stringify(model)}\n${(error as Error).stack}`)
      } finally {
        await cleanupRecoveryTempDir(caseDir)
        db.prepare('DELETE FROM documents WHERE id = ?').run(`id-${seed}`)
      }
      }
    } finally {
      db.close()
      await cleanupRecoveryTempDir(root)
    }
  }, RECOVERY_MODEL_TIMEOUT_MS)
})
