import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AtomicTextWriteConflictError,
  AtomicTextWritePostCommitExternalMutationError,
  AtomicTextWriteTargetMissingError,
  UnstableTextSnapshotError,
  __setAtomicWriteTestHooksForTesting,
  __setAtomicDurableJournalTestHooksForTesting,
  atomicRemoveTextIfUnchanged,
  atomicReplaceText,
  atomicReplaceTextIfUnchanged,
  prepareAtomicTextCreate,
  prepareAtomicTextWrite,
  readStableTextSnapshot,
  removeDurableJournal,
  rewriteDurableJournal,
  writeDurableJournal,
} from '../atomicTextWrite'
import { __setDurableArtifactTestHooksForTesting } from '../durableCreateOnlyFile'
import { CONTENT_DIR, setContentDir } from '../paths'
import { DIARY_BODY_ENVELOPE_MAGIC } from '../diaryAccess/body'
import { cleanupRecoveryTempDir } from './helpers/recoveryIntegration'

const ORIGINAL_CONTENT_DIR = CONTENT_DIR
let directory = ''
let target = ''

async function temporaryFiles(): Promise<string[]> {
  return (await fs.readdir(directory)).filter((name) => name.includes('.nuvyn-save-'))
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-atomic-write-'))
  setContentDir(directory)
  target = path.join(directory, 'note.md')
  await fs.writeFile(target, 'original', 'utf8')
  await fs.chmod(target, 0o640)
})

afterEach(async () => {
  __setAtomicWriteTestHooksForTesting(null)
  __setAtomicDurableJournalTestHooksForTesting(null)
  __setDurableArtifactTestHooksForTesting(null)
  vi.restoreAllMocks()
  setContentDir(ORIGINAL_CONTENT_DIR)
  await cleanupRecoveryTempDir(directory)
})

describe('atomic text writes', () => {
  it('fsyncs the parent directory after journal creation and removal', async () => {
    const journal = path.join(directory, '.note.md.nuvyn-journal-aaaa')
    const opened: string[] = []
    const originalOpen = fs.open.bind(fs)
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      opened.push(String(args[0]))
      return originalOpen(...args)
    })
    try {
      await writeDurableJournal(journal, { version: 1, op: 'test' })
      expect(opened).toContain(directory)
      opened.length = 0
      await removeDurableJournal(journal)
      expect(opened).toContain(directory)
    } finally { open.mockRestore() }
  })

  it('replaces complete content, preserves mode, and removes its temporary file', async () => {
    const before = await fs.stat(target)
    await atomicReplaceText(target, 'complete replacement', { mode: before.mode })

    const after = await fs.stat(target)
    expect(await fs.readFile(target, 'utf8')).toBe('complete replacement')
    expect(after.mode & 0o777).toBe(before.mode & 0o777)
    expect(await temporaryFiles()).toEqual([])
  })

  it('keeps the original intact and cleans up when rename fails', async () => {
    const renameError = Object.assign(new Error('rename failed'), { code: 'EIO' })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(renameError)

    await expect(atomicReplaceText(target, 'replacement')).rejects.toThrow('rename failed')
    expect(rename).toHaveBeenCalledOnce()
    expect(await fs.readFile(target, 'utf8')).toBe('original')
    expect(await temporaryFiles()).toEqual([])
  })

  it('can discard a prepared complete write without touching the target', async () => {
    const prepared = await prepareAtomicTextWrite(target, 'replacement')
    expect(await fs.readFile(target, 'utf8')).toBe('original')
    expect(await temporaryFiles()).toHaveLength(1)

    await prepared.rollback()
    expect(await fs.readFile(target, 'utf8')).toBe('original')
    expect(await temporaryFiles()).toEqual([])
  })

  it('atomically creates without replacing an existing target', async () => {
    const prepared = await prepareAtomicTextCreate(target, 'replacement')
    await expect(prepared.commit()).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(target, 'utf8')).toBe('original')
    expect(await temporaryFiles()).toEqual([])

    const missing = path.join(directory, 'created.md')
    const create = await prepareAtomicTextCreate(missing, 'created')
    await create.commit()
    expect(await fs.readFile(missing, 'utf8')).toBe('created')
    expect(await temporaryFiles()).toEqual([])
  })

  it('does not remove a replacement at the temporary pathname after ownership changes', async () => {
    const missing = path.join(directory, 'missing.md')
    const prepared = await prepareAtomicTextCreate(missing, 'created')
    const moved = `${prepared.temporaryPath}.quarantined`
    await fs.rename(prepared.temporaryPath, moved)
    await fs.writeFile(prepared.temporaryPath, 'external occupant', 'utf8')

    await expect(prepared.rollback()).rejects.toMatchObject({
      name: 'AtomicTextWriteOwnershipError',
    })
    expect(await fs.readFile(prepared.temporaryPath, 'utf8')).toBe('external occupant')
    expect(await fs.readFile(moved, 'utf8')).toBe('created')
  })

  it('does not link a replacement when the temporary pathname is replaced', async () => {
    const missing = path.join(directory, 'missing-commit.md')
    const prepared = await prepareAtomicTextCreate(missing, 'created')
    await fs.rename(prepared.temporaryPath, `${prepared.temporaryPath}.quarantined`)
    await fs.writeFile(prepared.temporaryPath, 'external occupant', 'utf8')

    await expect(prepared.commit()).rejects.toMatchObject({
      name: 'AtomicTextWriteOwnershipError',
    })
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(prepared.temporaryPath, 'utf8')).toBe('external occupant')
  })

  it('does not adopt an external file when the parent is replaced after close', async () => {
    const folder = path.join(directory, 'folder')
    const movedFolder = path.join(directory, 'folder-original')
    const missing = path.join(folder, 'note.md')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-atomic-outside-'))
    let outsideTemp = ''
    await fs.mkdir(folder)

    __setAtomicWriteTestHooksForTesting({
      afterTemporaryCloseBeforeIdentity: async (temporaryPath) => {
        outsideTemp = path.join(outside, path.basename(temporaryPath))
        await fs.rename(folder, movedFolder)
        await fs.symlink(outside, folder)
        await fs.writeFile(outsideTemp, 'external occupant', 'utf8')
      },
    })

    try {
      await expect(prepareAtomicTextCreate(missing, 'created')).rejects.toMatchObject({
        code: 'HISTORY_PATH_MOVED',
      })
      expect(await fs.readFile(outsideTemp, 'utf8')).toBe('external occupant')
      const movedEntries = await fs.readdir(movedFolder)
      expect(movedEntries).toHaveLength(1)
      expect(movedEntries[0]).toMatch(/^\.note\.md\.nuvyn-save-/)
    } finally {
      __setAtomicWriteTestHooksForTesting(null)
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('does not write document bytes when the parent is replaced before temporary open', async () => {
    const folder = path.join(directory, 'open-race')
    const movedFolder = path.join(directory, 'open-race-original')
    const missing = path.join(folder, 'note.md')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-atomic-open-outside-'))
    let outsideTemp = ''
    await fs.mkdir(folder)

    __setAtomicWriteTestHooksForTesting({
      afterParentIdentityBeforeTemporaryOpen: async (temporaryPath) => {
        outsideTemp = path.join(outside, path.basename(temporaryPath))
        await fs.rename(folder, movedFolder)
        await fs.symlink(outside, folder)
      },
    })

    try {
      await expect(prepareAtomicTextCreate(missing, 'secret document bytes')).rejects.toMatchObject({
        code: 'HISTORY_PATH_MOVED',
      })
      await expect(fs.readFile(outsideTemp, 'utf8')).resolves.toBe('')
      expect(await fs.readdir(outside)).toEqual([path.basename(outsideTemp)])
      expect(await fs.readdir(movedFolder)).toEqual([])
    } finally {
      __setAtomicWriteTestHooksForTesting(null)
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('does not rename a prepared temporary file through a replaced parent', async () => {
    const folder = path.join(directory, 'replace-race')
    const movedFolder = path.join(directory, 'replace-race-original')
    const note = path.join(folder, 'note.md')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-atomic-replace-outside-'))
    await fs.mkdir(folder)
    await fs.writeFile(note, 'original', 'utf8')

    __setAtomicWriteTestHooksForTesting({
      beforeUnconditionalReplaceRename: async () => {
        await fs.rename(folder, movedFolder)
        await fs.symlink(outside, folder)
        await fs.writeFile(path.join(outside, 'note.md'), 'external', 'utf8')
      },
    })

    try {
      await expect(atomicReplaceText(note, 'secret replacement')).rejects.toMatchObject({
        code: 'HISTORY_PATH_MOVED',
      })
      expect(await fs.readFile(path.join(outside, 'note.md'), 'utf8')).toBe('external')
      expect(await fs.readFile(path.join(movedFolder, 'note.md'), 'utf8')).toBe('original')
      expect(await fs.readdir(movedFolder)).toHaveLength(2)
    } finally {
      __setAtomicWriteTestHooksForTesting(null)
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('retries a snapshot when content changes between read and stat', async () => {
    const readFile = vi.spyOn(fs, 'readFile')
      .mockResolvedValueOnce('B')
      .mockResolvedValueOnce('C')
      .mockResolvedValueOnce('C')
      .mockResolvedValueOnce('C')

    const snapshot = await readStableTextSnapshot(target)

    expect(snapshot.raw).toBe('C')
    expect(readFile).toHaveBeenCalledTimes(4)
  })

  it('fails closed when the content never stabilizes', async () => {
    const readFile = vi.spyOn(fs, 'readFile')
      .mockResolvedValueOnce('B')
      .mockResolvedValueOnce('C')
      .mockResolvedValueOnce('B')
      .mockResolvedValueOnce('C')
      .mockResolvedValueOnce('B')
      .mockResolvedValueOnce('C')

    await expect(readStableTextSnapshot(target)).rejects
      .toBeInstanceOf(UnstableTextSnapshotError)
    expect(readFile).toHaveBeenCalledTimes(6)
  })

  it('does not restore over content that changed after the original replacement', async () => {
    await fs.writeFile(target, 'external C', 'utf8')

    await expect(atomicReplaceTextIfUnchanged(
      target,
      'written B',
      'previous A',
    )).rejects.toBeInstanceOf(AtomicTextWriteConflictError)

    expect(await fs.readFile(target, 'utf8')).toBe('external C')
    expect(await temporaryFiles()).toEqual([])
  })
})

describe('managed Diary create rollback provenance', () => {
  function managedPath(): string {
    return path.join(directory, 'diary', '2026-08-31.md')
  }

  it('rejects the generic managed delete owner with no caller-controlled bypass', async () => {
    const managed = managedPath()
    await fs.mkdir(path.dirname(managed), { recursive: true })
    const existing = `${DIARY_BODY_ENVELOPE_MAGIC}existing-generation`
    await fs.writeFile(managed, existing, 'utf8')

    await expect(atomicRemoveTextIfUnchanged(managed, existing)).rejects.toMatchObject({
      name: 'ManagedDiaryDeleteUnsupportedError',
      code: 'diary-encrypted-delete-unsupported',
    })
    // JavaScript callers cannot opt into managed deletion by passing the old
    // boolean (or any equivalent third argument); the owner ignores it and
    // still enforces the managed-path rejection.
    await expect((atomicRemoveTextIfUnchanged as any)(managed, existing, {
      allowManagedDiary: true,
    })).rejects.toMatchObject({ name: 'ManagedDiaryDeleteUnsupportedError' })
    expect(await fs.readFile(managed, 'utf8')).toBe(existing)
  })

  it('rolls back only a committed generation through the create capability', async () => {
    const managed = managedPath()
    const created = `${DIARY_BODY_ENVELOPE_MAGIC}created-generation`
    await fs.mkdir(path.dirname(managed), { recursive: true })
    __setAtomicWriteTestHooksForTesting({
      afterCreateCommitBeforeCleanup: () => { throw new Error('post-commit create failure') },
    })
    const prepared = await prepareAtomicTextCreate(managed, created)

    await expect(prepared.commit()).rejects.toThrow('post-commit create failure')
    const result = await prepared.rollbackCreatedGenerationIfStillOwned()

    expect(result).toMatchObject({ removed: true })
    await expect(fs.stat(managed)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await temporaryFiles()).toEqual([])
  })

  it('preserves an external replacement at the reused target path', async () => {
    const managed = managedPath()
    const created = `${DIARY_BODY_ENVELOPE_MAGIC}created-generation`
    const external = `${DIARY_BODY_ENVELOPE_MAGIC}external-generation`
    await fs.mkdir(path.dirname(managed), { recursive: true })
    const prepared = await prepareAtomicTextCreate(managed, created)
    await prepared.commit()

    await fs.rename(managed, `${managed}.old-generation`)
    await fs.writeFile(managed, external, 'utf8')

    await expect(prepared.rollbackCreatedGenerationIfStillOwned()).rejects.toMatchObject({
      name: 'AtomicTextWriteOwnershipError',
    })
    expect(await fs.readFile(managed, 'utf8')).toBe(external)
  })
})

/**
 * The ownership protocol: the commit takes ownership of the current
 * generation FIRST (atomic rename aside), verifies the staged bytes,
 * and only then links the replacement in create-only. There is no
 * check-to-rename window — an external writer winning any race keeps
 * its bytes and the call fails closed. These tests pin that contract
 * at the helper level; the REST/AI routes build on it.
 */
describe('ownership-verified commit (no check-to-rename window)', () => {
  /** Every on-disk intermediate the protocol can create. */
  async function intermediateFiles(): Promise<string[]> {
    return (await fs.readdir(directory)).filter((name) =>
      name.includes('.nuvyn-save-')
        || name.includes('.nuvyn-staged-')
        || name.includes('.nuvyn-remove-'))
  }

  it('replaces when the expectation still holds, preserving mode, leaving no intermediates', async () => {
    const before = await fs.stat(target)

    await atomicReplaceTextIfUnchanged(target, 'original', 'replacement')

    const after = await fs.stat(target)
    expect(await fs.readFile(target, 'utf8')).toBe('replacement')
    expect(after.mode & 0o777).toBe(before.mode & 0o777)
    expect(await intermediateFiles()).toEqual([])
  })

  it('detects an external save that lands before the takeover and keeps the external bytes', async () => {
    // The reviewer scenario: target holds base A, the caller verified A
    // and prepared B, and an external writer saves C in the final
    // window before the commit touches the path. The external save must
    // travel with the generation into staging and be detected there —
    // never silently overwritten.
    const originalRename = fs.rename.bind(fs)
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      await fs.writeFile(target, 'external C', 'utf8')
      return originalRename(from as string, to as string)
    })
    try {
      await expect(atomicReplaceTextIfUnchanged(
        target,
        'base A',
        'nuvyn B',
      )).rejects.toBeInstanceOf(AtomicTextWriteConflictError)

      expect(await fs.readFile(target, 'utf8')).toBe('external C')
      expect(await intermediateFiles()).toEqual([])
    } finally {
      rename.mockRestore()
    }
  })

  it('preserves an external file recreated after the takeover (create-only commit loses to EEXIST)', async () => {
    // After the current generation is staged, an external writer
    // recreates the path. The create-only link(2) commit must fail
    // closed and leave the external file untouched.
    const originalLink = fs.link.bind(fs)
    const link = vi.spyOn(fs, 'link').mockImplementationOnce(async () => {
      await fs.writeFile(target, 'external C', 'utf8')
      throw Object.assign(new Error('link exists'), { code: 'EEXIST' })
    })
    try {
      const prepared = await prepareAtomicTextWrite(target, 'nuvyn B')
      await expect(prepared.commit('original')).rejects.toMatchObject({
        name: 'AtomicTextWriteConflictError',
        current: expect.objectContaining({ raw: 'external C' }),
      })

      expect(await fs.readFile(target, 'utf8')).toBe('external C')
      expect(await intermediateFiles()).toEqual([])
    } finally {
      link.mockRestore()
    }
  })

  it('quarantines same-inode old-FD writes after replacement is linked', async () => {
    const externalHandle = await fs.open(target, 'r+')
    let stagedPath = ''
    __setAtomicWriteTestHooksForTesting({
      beforeReplacementStagedCleanup: async (staged) => {
        stagedPath = staged
        await externalHandle.truncate(0)
        await externalHandle.writeFile('external through old fd', 'utf8')
        await externalHandle.sync()
      },
    })

    try {
      await expect(atomicReplaceTextIfUnchanged(target, 'original', 'replacement'))
        .rejects.toBeInstanceOf(AtomicTextWritePostCommitExternalMutationError)
      expect(await fs.readFile(target, 'utf8')).toBe('replacement')
      expect(await fs.readFile(stagedPath, 'utf8')).toBe('external through old fd')
      expect((await fs.readdir(directory)).some((name) => name.includes('.nuvyn-journal-'))).toBe(true)
    } finally {
      await externalHandle.close()
    }
  })

  it('reports a missing target instead of recreating it from stale expectations', async () => {
    const prepared = await prepareAtomicTextWrite(target, 'nuvyn B')
    await fs.rm(target)

    await expect(prepared.commit('original')).rejects
      .toBeInstanceOf(AtomicTextWriteTargetMissingError)

    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await intermediateFiles()).toEqual([])
  })

  it('removes a file whose bytes still match the expectation', async () => {
    await atomicRemoveTextIfUnchanged(target, 'original')

    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await intermediateFiles()).toEqual([])
  })

  it('does not remove bytes an external writer replaced, and resolves without error', async () => {
    // The caller's write is already gone — the external bytes win and
    // the removal is a no-op, not a failure.
    await fs.writeFile(target, 'external C', 'utf8')

    await atomicRemoveTextIfUnchanged(target, 'our write A')

    expect(await fs.readFile(target, 'utf8')).toBe('external C')
    expect(await intermediateFiles()).toEqual([])
  })

  it('treats an already-missing target as a no-op removal', async () => {
    await fs.rm(target)

    await atomicRemoveTextIfUnchanged(target, 'whatever')

    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await intermediateFiles()).toEqual([])
  })

  it('fails closed when the remove target parent is replaced before takeover', async () => {
    const folder = path.join(directory, 'remove-race')
    const movedFolder = path.join(directory, 'remove-race-original')
    const note = path.join(folder, 'note.md')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-atomic-remove-outside-'))
    await fs.mkdir(folder)
    await fs.writeFile(note, 'original', 'utf8')

    __setAtomicWriteTestHooksForTesting({
      beforeAtomicRemoveRename: async () => {
        await fs.rename(folder, movedFolder)
        await fs.symlink(outside, folder)
        await fs.writeFile(path.join(outside, 'note.md'), 'external', 'utf8')
      },
    })

    try {
      await expect(atomicRemoveTextIfUnchanged(note, 'original')).rejects.toMatchObject({
        code: 'HISTORY_PATH_MOVED',
      })
      expect(await fs.readFile(path.join(outside, 'note.md'), 'utf8')).toBe('external')
      expect(await fs.readFile(path.join(movedFolder, 'note.md'), 'utf8')).toBe('original')
    } finally {
      __setAtomicWriteTestHooksForTesting(null)
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('keeps a replaced staged pathname instead of deleting its external occupant', async () => {
    let moved = ''
    __setAtomicWriteTestHooksForTesting({
      beforeAtomicRemoveUnlink: async (stagedPath) => {
        moved = `${stagedPath}.quarantined`
        await fs.rename(stagedPath, moved)
        await fs.writeFile(stagedPath, 'external occupant', 'utf8')
      },
    })

    try {
      await expect(atomicRemoveTextIfUnchanged(target, 'original')).rejects.toMatchObject({
        code: 'HISTORY_PATH_MOVED',
      })
      expect(await fs.readFile(moved, 'utf8')).toBe('original')
      expect(await fs.readFile(moved.replace(/\.quarantined$/, ''), 'utf8'))
        .toBe('external occupant')
    } finally {
      __setAtomicWriteTestHooksForTesting(null)
    }
  })

  it('restores the formal path when an old FD changes the staged inode before remove', async () => {
    const externalHandle = await fs.open(target, 'r+')
    __setAtomicWriteTestHooksForTesting({
      beforeAtomicRemoveUnlink: async () => {
        await externalHandle.truncate(0)
        await externalHandle.writeFile('external through old fd', 'utf8')
        await externalHandle.sync()
      },
    })

    try {
      await expect(atomicRemoveTextIfUnchanged(target, 'original'))
        .rejects.toBeInstanceOf(AtomicTextWritePostCommitExternalMutationError)
      expect(await fs.readFile(target, 'utf8')).toBe('external through old fd')
      expect((await fs.readdir(directory)).some((name) => name.includes('.nuvyn-remove-'))).toBe(false)
    } finally {
      await externalHandle.close()
    }
  })

  it('does not overwrite a target claimed while restoring a changed remove generation', async () => {
    const externalHandle = await fs.open(target, 'r+')
    let stagedPath = ''
    __setAtomicWriteTestHooksForTesting({
      beforeAtomicRemoveUnlink: async (staged) => {
        stagedPath = staged
        await externalHandle.truncate(0)
        await externalHandle.writeFile('external through old fd', 'utf8')
        await externalHandle.sync()
        await fs.writeFile(target, 'new external target', 'utf8')
      },
    })

    try {
      await expect(atomicRemoveTextIfUnchanged(target, 'original'))
        .rejects.toBeInstanceOf(AtomicTextWritePostCommitExternalMutationError)
      expect(await fs.readFile(target, 'utf8')).toBe('new external target')
      expect(await fs.readFile(stagedPath, 'utf8')).toBe('external through old fd')
    } finally {
      await externalHandle.close()
    }
  })
})

describe('durable artifact proof cleanup', () => {
  it('does not rename a journal temporary through a replaced parent', async () => {
    const folder = path.join(directory, 'journal-race')
    const movedFolder = path.join(directory, 'journal-race-original')
    const journal = path.join(folder, '.note.md.nuvyn-journal-proof')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-journal-outside-'))
    await fs.mkdir(folder)
    await writeDurableJournal(journal, { phase: 'old' })
    __setAtomicDurableJournalTestHooksForTesting({
      beforeDurableJournalRename: async () => {
        await fs.rename(folder, movedFolder)
        await fs.symlink(outside, folder)
        await fs.writeFile(path.join(outside, path.basename(journal)), 'external occupant', 'utf8')
      },
    })

    try {
      await expect(rewriteDurableJournal(journal, { phase: 'new' })).rejects.toMatchObject({
        code: 'HISTORY_PATH_MOVED',
      })
      expect(await fs.readFile(path.join(outside, path.basename(journal)), 'utf8'))
        .toBe('external occupant')
      expect(JSON.parse(await fs.readFile(path.join(movedFolder, path.basename(journal)), 'utf8')))
        .toEqual({ phase: 'old' })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('does not unlink a journal occupant changed after the first proof', async () => {
    const journal = path.join(directory, '.note.md.nuvyn-journal-proof')
    await writeDurableJournal(journal, { phase: 'old' })
    let moved = ''
    __setDurableArtifactTestHooksForTesting({
      beforeDurableArtifactUnlink: async (artifactPath) => {
        moved = `${artifactPath}.quarantine`
        await fs.rename(artifactPath, moved)
        await fs.writeFile(artifactPath, 'external occupant', 'utf8')
      },
    })

    await expect(removeDurableJournal(journal)).rejects.toThrow()
    expect(await fs.readFile(journal, 'utf8')).toBe('external occupant')
    expect(await fs.readFile(moved, 'utf8')).toContain('old')
  })
})
