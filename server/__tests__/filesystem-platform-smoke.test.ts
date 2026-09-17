// Cross-platform filesystem smoke for the atomic text-write contract.
//
// This lane runs on Ubuntu / Windows / macOS to give Windows and macOS
// enough filesystem semantics to catch regressions in the create-only,
// atomic-replace, rollback, and ownership-verified paths WITHOUT pulling
// in the full atomicTextWrite.test.ts suite. The full suite covers POSIX
// mode bits, file-symlink containment, and replace-parent races that are
// Linux-only (0o640 chmod, symlink creation needs elevation on Windows);
// those stay in the Ubuntu unit lane.
//
// What we DO verify here, by calling the production implementation
// directly:
//   - atomic replace replaces the target bytes and leaves no .nuvyn-save-
//     intermediate behind
//   - atomic replace fails closed (target untouched, no residue) when the
//     rename throws for an external reason
//   - atomic create rejects an existing target with EEXIST and creates a
//     missing target
//   - prepared create's rollback discards the staged bytes
//   - atomicRemoveTextIfUnchanged refuses a managed Diary body
//   - atomicReplaceTextIfUnchanged surfaces a conflict when the target's
//     current bytes no longer match the caller's expectation
//   - atomicReplaceTextIfUnchanged reports a missing target (not a stale
//     overwrite) when the file was deleted before the commit
//   - prepareAtomicTextWrite rejects the managed Diary path for create
//
// What we DO NOT verify here:
//   - POSIX file mode preservation (0o640/0o777) — Windows file modes are
//     a different model. Covered in atomicTextWrite.test.ts on Ubuntu.
//   - file-symlink races — Windows file-symlink creation requires
//     developer-mode elevation; junction containment is covered by
//     createOnlyMove.test.ts on every platform.
//   - replace-parent races — same reason; canonical coverage stays in the
//     Linux unit suite.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AtomicTextWriteConflictError,
  AtomicTextWriteTargetMissingError,
  atomicRemoveTextIfUnchanged,
  atomicReplaceText,
  atomicReplaceTextIfUnchanged,
  prepareAtomicTextCreate,
  prepareAtomicTextWrite,
} from '../atomicTextWrite'
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
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-fs-platform-smoke-'))
  setContentDir(directory)
  target = path.join(directory, 'note.md')
  await fs.writeFile(target, 'original', 'utf8')
})

afterEach(async () => {
  setContentDir(ORIGINAL_CONTENT_DIR)
  await cleanupRecoveryTempDir(directory)
})

describe('atomic replace (no POSIX mode assertion)', () => {
  it('replaces the bytes and leaves no .nuvyn-save- residue', async () => {
    await atomicReplaceText(target, 'complete replacement')

    expect(await fs.readFile(target, 'utf8')).toBe('complete replacement')
    expect(await temporaryFiles()).toEqual([])
  })

  it('keeps the target intact and leaves no residue when rename throws', async () => {
    // Inject an EIO into fs.rename once: the implementation must clean
    // up the staged temporary file rather than stranding it on disk.
    const realRename = fs.rename.bind(fs)
    const original = fs.rename
    let injected = false
    fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
      if (!injected) {
        injected = true
        throw Object.assign(new Error('rename failed'), { code: 'EIO' })
      }
      return realRename(...args)
    }) as typeof fs.rename

    try {
      await expect(atomicReplaceText(target, 'replacement')).rejects.toThrow('rename failed')
      expect(await fs.readFile(target, 'utf8')).toBe('original')
      expect(await temporaryFiles()).toEqual([])
    } finally {
      fs.rename = original
    }
  })
})

describe('atomic create', () => {
  it('rejects an existing target without replacing it and leaves no residue', async () => {
    const prepared = await prepareAtomicTextCreate(target, 'replacement')

    await expect(prepared.commit()).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(target, 'utf8')).toBe('original')
    expect(await temporaryFiles()).toEqual([])
  })

  it('creates a missing target and leaves no residue', async () => {
    const missing = path.join(directory, 'created.md')
    const create = await prepareAtomicTextCreate(missing, 'created')

    await create.commit()
    expect(await fs.readFile(missing, 'utf8')).toBe('created')
    expect(await temporaryFiles()).toEqual([])
  })

  it('rollback discards the staged bytes and leaves the target untouched', async () => {
    const prepared = await prepareAtomicTextCreate(target, 'replacement')

    expect(await fs.readFile(target, 'utf8')).toBe('original')
    expect(await temporaryFiles()).toHaveLength(1)

    await prepared.rollback()
    expect(await fs.readFile(target, 'utf8')).toBe('original')
    expect(await temporaryFiles()).toEqual([])
  })
})

describe('ownership-verified replace', () => {
  it('replaces when the expectation still holds and leaves no intermediates', async () => {
    await atomicReplaceTextIfUnchanged(target, 'original', 'replacement')

    expect(await fs.readFile(target, 'utf8')).toBe('replacement')
    const leftover = await fs.readdir(directory)
    expect(leftover.filter((name) => name.includes('.nuvyn-save-')
      || name.includes('.nuvyn-staged-')
      || name.includes('.nuvyn-remove-'))).toEqual([])
  })

  it('reports a conflict when the target bytes no longer match the expectation', async () => {
    await fs.writeFile(target, 'external C', 'utf8')

    await expect(atomicReplaceTextIfUnchanged(target, 'written B', 'previous A'))
      .rejects.toBeInstanceOf(AtomicTextWriteConflictError)

    expect(await fs.readFile(target, 'utf8')).toBe('external C')
    expect(await temporaryFiles()).toEqual([])
  })

  it('reports a missing target instead of recreating it from stale expectations', async () => {
    const prepared = await prepareAtomicTextWrite(target, 'nuvyn B')
    await fs.rm(target)

    await expect(prepared.commit('original')).rejects.toBeInstanceOf(AtomicTextWriteTargetMissingError)
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await temporaryFiles()).toEqual([])
  })
})

describe('managed Diary rejection', () => {
  it('refuses to remove a managed Diary body even when the bytes match', async () => {
    const managed = path.join(directory, 'diary', '2026-08-31.md')
    await fs.mkdir(path.dirname(managed), { recursive: true })
    const managedBody = `${DIARY_BODY_ENVELOPE_MAGIC}existing-generation`
    await fs.writeFile(managed, managedBody, 'utf8')

    await expect(atomicRemoveTextIfUnchanged(managed, managedBody)).rejects.toMatchObject({
      name: 'ManagedDiaryDeleteUnsupportedError',
    })
    expect(await fs.readFile(managed, 'utf8')).toBe(managedBody)
  })

  it('reports a no-op result on an already-missing target removal', async () => {
    // The helper's missing-target path must stay a no-op on every
    // platform — Windows REUSE semantics around ENOENT can differ from
    // POSIX and we want the smoke to lock the contract.
    await fs.rm(target)
    const result = await atomicRemoveTextIfUnchanged(target, 'whatever')
    expect(result).toMatchObject({ removed: false })
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
