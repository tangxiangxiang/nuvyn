// Unit tests for the create-only move primitives that protect rename
// destinations and rollback sources from external writers (round 5):
// POSIX rename(2) atomically REPLACES targets, so every move that can
// race an external editor (Obsidian/vim/sync ignore in-process locks)
// must be create-only — link(2) for files, an mkdir gate for folders.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { getDocumentMetadata, saveDocumentMetadata } from '../documentMetadata'
import {
  RenameDestinationOccupiedError,
  RenameSourceReusedError,
  UnsupportedDirectoryMoveError,
  createOnlyMoveDirectory,
  createOnlyMoveFile,
  executeReplayableFolderMove,
  renameDocumentWithMetadata,
  __setCreateOnlyMoveHooksForTesting,
} from '../documentFileLifecycle'
import { cleanupRecoveryTempDir } from './helpers/recoveryIntegration'

let dir: string
let db: InstanceType<typeof Database>

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-move-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
})

afterEach(async () => {
  __setCreateOnlyMoveHooksForTesting(null)
  db.close()
  await cleanupRecoveryTempDir(dir)
})

async function names(): Promise<string[]> {
  return fs.readdir(dir)
}

describe('createOnlyMoveFile', () => {
  it('never overwrites an external destination when hard links are unsupported', async () => {
    const from = path.join(dir, 'old.md')
    const to = path.join(dir, 'new.md')
    await fs.writeFile(from, '# ours\n', 'utf8')
    const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'EPERM' }))
    const realStat = fs.stat.bind(fs)
    const stat = vi.spyOn(fs, 'stat').mockImplementationOnce(async (candidate) => {
      expect(candidate).toBe(to)
      await fs.writeFile(to, '# external\n', 'utf8')
      throw Object.assign(new Error('not found at check time'), { code: 'ENOENT' })
    }).mockImplementation(realStat)
    try {
      await expect(createOnlyMoveFile(from, to)).rejects.toMatchObject({ code: 'EPERM' })
      expect(await fs.readFile(to, 'utf8')).toBe('# external\n')
      expect(await fs.readFile(from, 'utf8')).toBe('# ours\n')
    } finally {
      link.mockRestore()
      stat.mockRestore()
    }
  })

  it('reports source reuse when a non-EEXIST link failure leaves the old generation staged', async () => {
    const from = path.join(dir, 'old.md')
    const to = path.join(dir, 'new.md')
    await fs.writeFile(from, '# ours\n', 'utf8')
    const link = vi.spyOn(fs, 'link').mockImplementationOnce(async () => {
      await fs.writeFile(from, '# external\n', 'utf8')
      throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' })
    })
    try {
      const error = await createOnlyMoveFile(from, to).catch((caught) => caught)
      expect(error).toBeInstanceOf(RenameSourceReusedError)
      expect(error.destinationOccupied).toBe(false)
      expect(error.survivingPath).toBe('staging')
      expect(await fs.readFile(from, 'utf8')).toBe('# external\n')
      expect((await names()).some((name) => name.includes('.nuvyn-rename-'))).toBe(true)
    } finally { link.mockRestore() }
  })

  it('moves a file and leaves no staging residue', async () => {
    await fs.writeFile(path.join(dir, 'old.md'), '# doc\n', 'utf8')

    await createOnlyMoveFile(path.join(dir, 'old.md'), path.join(dir, 'new.md'))

    expect(await fs.readFile(path.join(dir, 'new.md'), 'utf8')).toBe('# doc\n')
    expect(await names()).toEqual(['new.md'])
  })

  it('fails closed when an external writer claimed the destination, preserving both files', async () => {
    await fs.writeFile(path.join(dir, 'old.md'), '# ours\n', 'utf8')
    await fs.writeFile(path.join(dir, 'new.md'), '# external\n', 'utf8')

    await expect(
      createOnlyMoveFile(path.join(dir, 'old.md'), path.join(dir, 'new.md')),
    ).rejects.toBeInstanceOf(RenameDestinationOccupiedError)

    // The external destination wins; the source is restored create-only.
    expect(await fs.readFile(path.join(dir, 'new.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(dir, 'old.md'), 'utf8')).toBe('# ours\n')
    expect((await names()).some((name) => name.includes('.nuvyn-rename-'))).toBe(false)
  })

  it('moves to a nested destination and fsyncs nothing over an existing parent file', async () => {
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(dir, 'old.md'), '# doc\n', 'utf8')

    await createOnlyMoveFile(path.join(dir, 'old.md'), path.join(dir, 'sub', 'moved.md'))

    expect(await fs.readFile(path.join(dir, 'sub', 'moved.md'), 'utf8')).toBe('# doc\n')
    expect(await fs.readdir(path.join(dir, 'sub'))).toEqual(['moved.md'])
    expect((await names()).some((name) => name.includes('.nuvyn-rename-'))).toBe(false)
  })
})

describe('createOnlyMoveDirectory', () => {
  it('moves a whole tree with the platform default strategy and leaves no gate or source residue', async () => {
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    await fs.mkdir(path.join(dir, 'src', 'nested'))
    await fs.writeFile(path.join(dir, 'src', 'nested', 'b.md'), '# b\n', 'utf8')

    const moved = await createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'))

    expect(moved.restored).toBe(true)
    expect(await fs.readFile(path.join(dir, 'dest', 'a.md'), 'utf8')).toBe('# a\n')
    expect(await fs.readFile(path.join(dir, 'dest', 'nested', 'b.md'), 'utf8')).toBe('# b\n')
    expect(await names()).toEqual(['dest'])
  })

  it('fails closed when an external folder claimed the destination', async () => {
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    await fs.mkdir(path.join(dir, 'dest'))
    await fs.writeFile(path.join(dir, 'dest', 'external.md'), '# external\n', 'utf8')

    const moved = await createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'))

    expect(moved).toEqual({ restored: false })
    expect(await fs.readFile(path.join(dir, 'dest', 'external.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(dir, 'src', 'a.md'), 'utf8')).toBe('# a\n')
  })

  it('fails closed when the destination is an external EMPTY directory', async () => {
    // The gate's job: rename(2) would silently REPLACE an empty
    // directory, destroying external state. mkdir's EEXIST must fail
    // the move closed BEFORE the rename is ever attempted.
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    await fs.mkdir(path.join(dir, 'dest'))

    const moved = await createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'))

    expect(moved).toEqual({ restored: false })
    // External empty directory preserved; source tree untouched.
    expect(await fs.readdir(path.join(dir, 'dest'))).toEqual([])
    expect(await fs.readFile(path.join(dir, 'src', 'a.md'), 'utf8')).toBe('# a\n')
  })

  it('fails closed when the destination path holds a FILE', async () => {
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'dest'), '# a file, not a folder\n', 'utf8')

    const moved = await createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'))

    expect(moved).toEqual({ restored: false })
    expect(await fs.readFile(path.join(dir, 'dest'), 'utf8')).toBe('# a file, not a folder\n')
    expect((await fs.stat(path.join(dir, 'src'))).isDirectory()).toBe(true)
  })

  it('fails closed when external content lands inside the mkdir gate before the rename', async () => {
    // The dangerous in-flight window: our own empty gate directory is
    // claimed by an external writer between mkdir and rename. rename
    // then fails (ENOTEMPTY) and rmdir proves the directory is no
    // longer ours — the source tree must stay untouched. Explicitly
    // the atomic strategy: the replayable protocol's parity check is
    // covered in its own describe block below.
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    __setCreateOnlyMoveHooksForTesting({
      afterMkdirGate: async (gateDir) => {
        await fs.writeFile(path.join(gateDir, 'external.md'), '# external\n', 'utf8')
      },
    })

    const moved = await createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'), 'atomic-rename')

    expect(moved).toEqual({ restored: false })
    expect(await fs.readFile(path.join(dir, 'dest', 'external.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(dir, 'src', 'a.md'), 'utf8')).toBe('# a\n')
  })

  it('reports an unsupported platform move as a typed error instead of a raw rename failure', async () => {
    // Platforms where rename(2) cannot replace a directory (Windows)
    // fail the atomic strategy with EPERM; the guard must surface a
    // typed error the route maps to a clear 501 — never a raw errno.
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('no directory replace'), { code: 'EPERM' }))
    try {
      await expect(
        createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'), 'atomic-rename'),
      ).rejects.toBeInstanceOf(UnsupportedDirectoryMoveError)
      expect(await fs.stat(path.join(dir, 'dest')).then(() => true, () => false)).toBe(false)
      expect(await fs.readFile(path.join(dir, 'src', 'a.md'), 'utf8')).toBe('# a\n')
    } finally { rename.mockRestore() }
  })
})

describe('createOnlyMoveDirectory (replayable per-file protocol)', () => {
  // rename(2) cannot replace a directory on Windows — even an empty
  // one — so the folder move runs as journaled per-file create-only
  // links instead. These tests force the strategy so every platform
  // exercises the exact protocol Windows runs in production.
  it('moves the whole tree through create-only per-file links and leaves no gate or source residue', async () => {
    await fs.mkdir(path.join(dir, 'src', 'nested'), { recursive: true })
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    await fs.writeFile(path.join(dir, 'src', 'nested', 'b.md'), '# b\n', 'utf8')

    const moved = await createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'), 'replayable-move')

    expect(moved.restored).toBe(true)
    expect(await fs.readFile(path.join(dir, 'dest', 'a.md'), 'utf8')).toBe('# a\n')
    expect(await fs.readFile(path.join(dir, 'dest', 'nested', 'b.md'), 'utf8')).toBe('# b\n')
    expect(await names()).toEqual(['dest'])
  })

  it('fails closed when the destination is an external EMPTY directory', async () => {
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    await fs.mkdir(path.join(dir, 'dest'))

    const moved = await createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'), 'replayable-move')

    expect(moved).toEqual({ restored: false })
    expect(await fs.readdir(path.join(dir, 'dest'))).toEqual([])
    expect(await fs.readFile(path.join(dir, 'src', 'a.md'), 'utf8')).toBe('# a\n')
  })

  it('rolls every already-moved entry back when an external writer claims a destination path mid-move', async () => {
    // The replayable move's defining race: entry a.md has already
    // landed at the destination when an external writer claims the
    // NEXT entry's path. The whole move must fail closed with EVERY
    // moved entry back at its source — a missing rollback would strand
    // a.md at the destination (mutation M11).
    await fs.mkdir(path.join(dir, 'src', 'nested'), { recursive: true })
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# ours a\n', 'utf8')
    await fs.writeFile(path.join(dir, 'src', 'nested', 'b.md'), '# ours b\n', 'utf8')
    __setCreateOnlyMoveHooksForTesting({
      afterReplayableMovedEntry: async (entryRel) => {
        if (entryRel === 'a.md') {
          await fs.mkdir(path.join(dir, 'dest', 'nested'), { recursive: true })
          await fs.writeFile(path.join(dir, 'dest', 'nested', 'b.md'), '# external\n', 'utf8')
        }
      },
    })

    const moved = await createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'), 'replayable-move')

    expect(moved).toEqual({ restored: false })
    // Both our entries are back at the source; the external file wins.
    expect(await fs.readFile(path.join(dir, 'src', 'a.md'), 'utf8')).toBe('# ours a\n')
    expect(await fs.readFile(path.join(dir, 'src', 'nested', 'b.md'), 'utf8')).toBe('# ours b\n')
    expect(await fs.readFile(path.join(dir, 'dest', 'nested', 'b.md'), 'utf8')).toBe('# external\n')
    expect(await fs.stat(path.join(dir, 'dest', 'a.md')).then(() => true, () => false)).toBe(false)
    expect((await names()).some((name) => name.includes('.nuvyn-rename-'))).toBe(false)
  })

  it('fails closed when external content lands inside the gate before the move ends', async () => {
    // The replayable parity of the atomic protocol's ENOTEMPTY gate
    // check: an external file dropped into our destination mid-move
    // fails the whole move closed with every entry rolled back.
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    __setCreateOnlyMoveHooksForTesting({
      afterReplayableMovedEntry: async () => {
        await fs.writeFile(path.join(dir, 'dest', 'external.md'), '# external\n', 'utf8')
      },
    })

    const moved = await createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'), 'replayable-move')

    expect(moved).toEqual({ restored: false })
    expect(await fs.readFile(path.join(dir, 'dest', 'external.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(dir, 'src', 'a.md'), 'utf8')).toBe('# a\n')
    expect(await fs.stat(path.join(dir, 'dest', 'a.md')).then(() => true, () => false)).toBe(false)
  })

  it('fails closed without moving when the folder contains a symlink', async () => {
    // link(2) FOLLOWS symlinks — moving one would hardlink an external
    // inode into the destination. The move must refuse before any
    // entry moves and prune its own gate.
    if (process.platform === 'win32') return // file symlinks need elevation on Windows; junction escape is covered by the containment tests
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    await fs.symlink(path.join(dir, 'src', 'a.md'), path.join(dir, 'src', 'link.md'))

    await expect(
      createOnlyMoveDirectory(path.join(dir, 'src'), path.join(dir, 'dest'), 'replayable-move'),
    ).rejects.toBeInstanceOf(UnsupportedDirectoryMoveError)

    expect(await fs.stat(path.join(dir, 'dest')).then(() => true, () => false)).toBe(false)
    expect(await fs.readFile(path.join(dir, 'src', 'a.md'), 'utf8')).toBe('# a\n')
  })

  it('creates the unpredictable gate token O_EXCL and fsyncs it plus its parent', async () => {
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
    const secret = 'a'.repeat(64)
    const realOpen = fs.open.bind(fs)
    const opened: Array<{ target: string; flags: string | number; sync: ReturnType<typeof vi.spyOn> }> = []
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args)
      const sync = vi.spyOn(handle, 'sync')
      opened.push({ target: String(args[0]), flags: args[1], sync })
      return handle
    })
    __setCreateOnlyMoveHooksForTesting({
      afterReplayableGate: async (gateDir) => {
        expect(await fs.readFile(path.join(gateDir, '.nuvyn-folder-gate-durability-id'), 'utf8')).toBe(secret)
      },
    })
    try {
      await executeReplayableFolderMove(
        path.join(dir, 'src'), path.join(dir, 'dest'), ['a.md'],
        { gateToken: 'durability-id', gateTokenValue: secret, vaultRoot: dir } as any,
      )
      const markerOpen = opened.find((item) => path.basename(item.target) === '.nuvyn-folder-gate-durability-id')
      expect(markerOpen?.flags).toBe('wx')
      expect(markerOpen?.sync).toHaveBeenCalled()
      const parentSync = opened.find((item) => path.resolve(item.target) === path.join(dir, 'dest') && item.flags === 'r')
      expect(parentSync?.sync).toHaveBeenCalled()
    } finally { open.mockRestore() }
  })

  it('contains the destination gate before creating its token', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-move-outside-'))
    try {
      await fs.mkdir(path.join(dir, 'src'))
      await fs.writeFile(path.join(dir, 'src', 'a.md'), '# a\n', 'utf8')
      await fs.symlink(outside, path.join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      __setCreateOnlyMoveHooksForTesting({
        afterReplayableGate: async (gateDir) => {
          // If this hook fires, mkdir/token creation already escaped the
          // vault. Leave durable evidence outside so cleanup cannot make
          // the violation look harmless.
          await fs.writeFile(path.join(gateDir, 'outside-sentinel'), 'escaped', 'utf8')
        },
      })

      await expect(executeReplayableFolderMove(
        path.join(dir, 'src'),
        path.join(dir, 'escape', 'dest'),
        ['a.md'],
        { gateToken: 'gate-id', vaultRoot: dir },
      )).rejects.toBeInstanceOf(UnsupportedDirectoryMoveError)

      expect(await fs.stat(path.join(outside, 'dest')).then(() => true, () => false)).toBe(false)
      expect(await fs.readFile(path.join(dir, 'src', 'a.md'), 'utf8')).toBe('# a\n')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('re-checks rollback containment immediately before each reverse syscall', async () => {
    if (process.platform === 'win32') return // file symlink creation requires elevation; junction containment is covered above
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-move-rollback-outside-'))
    try {
      await fs.mkdir(path.join(dir, 'src', 'nested'), { recursive: true })
      await fs.writeFile(path.join(dir, 'src', 'nested', 'a.md'), '# ours\n', 'utf8')
      __setCreateOnlyMoveHooksForTesting({
        afterReplayableMovedEntry: async (entryRel) => {
          if (entryRel !== 'nested/a.md') return
          // The forward move emptied src/nested. Replace that directory
          // with an escape and force final parity to roll the entry back.
          await fs.rmdir(path.join(dir, 'src', 'nested'))
          await fs.symlink(outside, path.join(dir, 'src', 'nested'), 'dir')
          await fs.writeFile(path.join(dir, 'dest', 'external.md'), '# external\n', 'utf8')
        },
      })

      await expect(executeReplayableFolderMove(
        path.join(dir, 'src'),
        path.join(dir, 'dest'),
        ['nested/a.md'],
        { directories: ['nested'], gateToken: 'rollback-id', vaultRoot: dir },
      )).rejects.toBeInstanceOf(UnsupportedDirectoryMoveError)

      // The reverse link must never follow src/nested into `outside`.
      expect(await fs.stat(path.join(outside, 'a.md')).then(() => true, () => false)).toBe(false)
      expect(await fs.readFile(path.join(dir, 'dest', 'nested', 'a.md'), 'utf8')).toBe('# ours\n')
      expect(await fs.readFile(path.join(dir, 'dest', 'external.md'), 'utf8')).toBe('# external\n')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('renameDocumentWithMetadata (create-only default)', () => {
  it('never replaces an external destination file and leaves metadata untouched', async () => {
    await fs.writeFile(path.join(dir, 'old.md'), '# ours\n', 'utf8')
    await fs.writeFile(path.join(dir, 'new.md'), '# external\n', 'utf8')
    saveDocumentMetadata(db, { id: 'move-id', path: 'old', title: 'Old', updatedAt: 1 })

    await expect(renameDocumentWithMetadata({
      db, fromPath: 'old', toPath: 'new',
      fromAbs: path.join(dir, 'old.md'), toAbs: path.join(dir, 'new.md'),
    })).rejects.toBeInstanceOf(RenameDestinationOccupiedError)

    expect(await fs.readFile(path.join(dir, 'new.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(dir, 'old.md'), 'utf8')).toBe('# ours\n')
    // The metadata move never ran: identity still on the source path.
    expect(getDocumentMetadata(db, 'old')?.id).toBe('move-id')
    expect(getDocumentMetadata(db, 'new')).toBeNull()
  })

  it('moves file AND metadata on the happy path', async () => {
    await fs.writeFile(path.join(dir, 'old.md'), '# ours\n', 'utf8')
    saveDocumentMetadata(db, { id: 'move-id', path: 'old', title: 'Old', updatedAt: 1 })

    await renameDocumentWithMetadata({
      db, fromPath: 'old', toPath: 'new',
      fromAbs: path.join(dir, 'old.md'), toAbs: path.join(dir, 'new.md'),
    })

    expect(await fs.readFile(path.join(dir, 'new.md'), 'utf8')).toBe('# ours\n')
    expect(getDocumentMetadata(db, 'new')?.id).toBe('move-id')
    expect(getDocumentMetadata(db, 'old')).toBeNull()
    expect((await names()).some((name) => name.includes('.nuvyn-rename-'))).toBe(false)
  })

  it('rollback never overwrites a re-used source path; identity follows the bytes', async () => {
    // The reviewer's rollback scenario: the forward move succeeds, the
    // metadata move then fails, and an external writer re-creates the
    // source path before the rollback runs. The create-only rollback
    // must fail closed (RenameSourceReusedError) with the external
    // file preserved — never a plain rename back over it.
    await fs.writeFile(path.join(dir, 'old.md'), '# ours\n', 'utf8')
    saveDocumentMetadata(db, { id: 'move-id', path: 'old', title: 'Old', updatedAt: 1 })

    await expect(renameDocumentWithMetadata({
      db, fromPath: 'old', toPath: 'new',
      fromAbs: path.join(dir, 'old.md'), toAbs: path.join(dir, 'new.md'),
      moveMetadata: () => {
        // External writer re-uses the now-empty source path, then the
        // metadata move "fails".
        writeFileSync(path.join(dir, 'old.md'), '# external\n', 'utf8')
        throw new Error('injected metadata move failure')
      },
    })).rejects.toBeInstanceOf(RenameSourceReusedError)

    // External source file untouched; our bytes stayed at the destination.
    expect(await fs.readFile(path.join(dir, 'old.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(dir, 'new.md'), 'utf8')).toBe('# ours\n')
    expect((await names()).some((name) => name.includes('.nuvyn-rename-'))).toBe(false)
  })
})
