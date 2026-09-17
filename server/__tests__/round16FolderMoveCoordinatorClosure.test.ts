import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

import mountedApp, { __setMetadataDbForTesting } from '../index'
import { recoverInterruptedOperations } from '../crashRecovery'
import { applyMigrations } from '../db'
import {
  getDocumentMetadata,
  saveDocumentMetadata,
} from '../documentMetadata'
import {
  __setCreateOnlyMoveHooksForTesting,
  __setDirectoryMoveStrategyOverrideForTesting,
  platformDirectoryMoveStrategy,
} from '../documentFileLifecycle'
import { __resetLinkIndexForTesting } from '../linkIndex'
import { setContentDir } from '../paths'
import { __setFolderRaceHooksForTesting } from '../routes/folders'
import type { FolderMoveJournalV4 } from '../folderMoveTransaction'
import {
  terminateProcessTree,
  waitForChildClose,
} from './helpers/crashProcessTree'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  withAuthCookie,
  type AuthenticatedTestContext,
} from './helpers/auth'

const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'))
const DELETE_PREPARED_CHILD = path.join(
  import.meta.dirname,
  'fixtures',
  'folder-delete-prepared-crash-child.ts',
)

let vault: string
let originalContentDir: string
let db: Database.Database
let auth: AuthenticatedTestContext
// The folder-delete prepared-rollback fixture deliberately leaves its
// SQLite handle open and waits after announcing READY — the parent then
// force-kills it to prove durable recovery across abrupt termination. The
// child therefore owns metadata.sqlite until its stdio streams fully close
// on the parent side. On Windows that open handle blocks fs.rm until then,
// so teardown must guarantee the child is fully closed BEFORE we touch
// the temp tree.
let crashChild: ChildProcess | null = null

const PREPARED_READY = 'READY:DELETE_ROLLBACK_PREPARED'

async function ensureCrashChildClosed(): Promise<void> {
  if (!crashChild) return
  const child = crashChild
  crashChild = null
  try {
    await terminateProcessTree(child, { timeoutMs: 10_000 })
  } catch {
    // Best-effort cleanup. If the child already closed naturally or is
    // stuck in a way the helper cannot recover from, afterEach proceeds
    // anyway — fs.rm retry handles the residual SQLite handle on Windows.
  }
}

function waitForStdoutMarker(
  child: ChildProcess,
  marker: string,
  getStdout: () => string,
  getStderr: () => string,
): Promise<void> {
  const stdoutStream = child.stdout
  if (!stdoutStream) {
    return Promise.reject(new Error('crash child stdout is not available'))
  }

  const closePromise = waitForChildClose(child)
  return new Promise<void>((resolve, reject) => {
    let settled = false

    const cleanup = (): void => {
      stdoutStream.off('data', inspect)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const inspect = (): void => {
      if (getStdout().includes(marker)) finish()
    }

    stdoutStream.on('data', inspect)
    inspect()

    void closePromise.then((result) => {
      if (!getStdout().includes(marker)) {
        finish(new Error(
          `crash child closed (code=${result.code}, signal=${result.signal}) before `
          + `${marker}; stderr: ${getStderr().slice(0, 500)}`,
        ))
      }
    }, (error) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

beforeEach(async () => {
  originalContentDir = path.resolve(process.cwd(), 'src/content')
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-round16-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  auth = createAuthenticatedTestContext({ db })
  __setMetadataDbForTesting(db)
  setContentDir(vault)
  __resetLinkIndexForTesting()
  __setDirectoryMoveStrategyOverrideForTesting(null)
})

afterEach(async () => {
  // Tear down the crash child first so the still-open SQLite handle
  // (held by the child until its stdio streams close on the parent) does
  // not block fs.rm on Windows. terminateProcessTree is a no-op for a
  // child that already closed naturally.
  await ensureCrashChildClosed()
  vi.restoreAllMocks()
  __setCreateOnlyMoveHooksForTesting(null)
  __setDirectoryMoveStrategyOverrideForTesting(null)
  __setFolderRaceHooksForTesting(null)
  __setMetadataDbForTesting(null)
  closeAuthTestContext(auth)
  db.close()
  setContentDir(originalContentDir)
  __resetLinkIndexForTesting()
  await fs.rm(vault, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 10 : 3,
    retryDelay: 100,
  })
})

async function seedFolder(folder = 'proj'): Promise<void> {
  await fs.mkdir(path.join(vault, folder))
  await fs.writeFile(path.join(vault, folder, 'a.md'), '# hello\n')
  saveDocumentMetadata(db, {
    id: `${folder}-a-id`,
    path: `${folder}/a`,
    title: 'Hello',
    updatedAt: 1,
  })
}

async function patchFolder(
  source = 'proj',
  destination = 'ren',
  updateReferences = false,
): Promise<Response> {
  return mountedApp.fetch(withAuthCookie(auth, new Request(`http://localhost/api/folders/${source}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newPath: destination, updateReferences }),
  })))
}

async function readOnlyV4Journal(): Promise<{
  absolutePath: string
  journal: FolderMoveJournalV4
}> {
  const candidates = (await fs.readdir(vault)).filter(name => name.includes('.nuvyn-journal-'))
  const parsed = await Promise.all(candidates.map(async name => {
    const absolutePath = path.join(vault, name)
    const journal = JSON.parse(await fs.readFile(absolutePath, 'utf8')) as { version?: number }
    return journal.version === 4
      ? { absolutePath, journal: journal as FolderMoveJournalV4 }
      : null
  }))
  const journals = parsed.filter((item): item is NonNullable<typeof item> => item !== null)
  expect(journals).toHaveLength(1)
  const only = journals[0]!
  return {
    absolutePath: only.absolutePath,
    journal: only.journal,
  }
}

describe.runIf(platformDirectoryMoveStrategy === 'atomic-rename')(
  'Round-16 HTTP atomic executor ownership',
  () => {
  beforeEach(() => {
    __setDirectoryMoveStrategyOverrideForTesting('atomic-rename')
  })
  it('keeps a real post-rename stat failure under durable recovery ownership', async () => {
    await seedFolder()
    let renameLanded = false
    let injected = false
    const realStat = fs.stat.bind(fs)
    const realLstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(async (target, options) => {
      if (renameLanded && !injected && String(target) === path.join(vault, 'ren')) {
        injected = true
        throw Object.assign(new Error('injected post-rename stat failure'), { code: 'EIO' })
      }
      return realLstat(target, options as never)
    })
    __setCreateOnlyMoveHooksForTesting({
      afterAtomicRenameBeforeParity: () => { renameLanded = true },
    })

    const response = await patchFolder()

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/recovery journal retained/),
    })
    const persisted = await readOnlyV4Journal()
    expect(persisted.journal.phase).toBe('gate-created')
    expect(persisted.journal.sourceBirthtimeNs).toMatch(/^[1-9]\d*$/)
    expect(persisted.journal.destBirthtimeNs).toMatch(/^[1-9]\d*$/)
    expect(persisted.journal.directoryGenerations?.every(
      row => /^[1-9]\d*$/.test(row.sourceBirthtimeNs ?? ''),
    )).toBe(true)
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('proj-a-id')
    expect(getDocumentMetadata(db, 'ren/a')).toBeNull()
    await expect(realStat(path.join(vault, 'proj'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(vault, 'ren', 'a.md'), 'utf8')).toBe('# hello\n')

    vi.restoreAllMocks()
    __setCreateOnlyMoveHooksForTesting(null)
    const first = await recoverInterruptedOperations(vault, db)
    expect(first.actions).toContainEqual(expect.objectContaining({
      action: 'completed-rename',
      detail: 'v4 metadata-committed transaction verified and cleaned',
    }))
    expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('proj-a-id')
    await expect(fs.stat(persisted.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' })
    const second = await recoverInterruptedOperations(vault, db)
    expect(second.actions).toEqual([])
  })

  it('does not enter the legacy outer rollback when the landed generation mismatches', async () => {
    await seedFolder()
    const ownedStash = path.join(vault, 'owned-stash')
    __setCreateOnlyMoveHooksForTesting({
      afterAtomicRenameBeforeParity: async (_source, destination) => {
        await fs.rename(destination, ownedStash)
        await fs.mkdir(destination)
        await fs.writeFile(path.join(destination, 'a.md'), '# external\n')
      },
    })

    const response = await patchFolder()

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/generation.*recovery journal retained/i),
    })
    const persisted = await readOnlyV4Journal()
    expect(persisted.journal.phase).toBe('gate-created')
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('proj-a-id')
    expect(getDocumentMetadata(db, 'ren/a')).toBeNull()
    expect(await fs.readFile(path.join(vault, 'ren', 'a.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(ownedStash, 'a.md'), 'utf8')).toBe('# hello\n')

    __setCreateOnlyMoveHooksForTesting(null)
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions).toContainEqual({
      file: path.basename(persisted.absolutePath),
      action: 'quarantined',
      detail: 'atomic gate-created state cannot prove either an intact gate or a landed source generation',
    })
    expect(await fs.readFile(path.join(vault, 'ren', 'a.md'), 'utf8')).toBe('# external\n')
    expect(await fs.stat(persisted.absolutePath)).toBeDefined()
  })

  it('rereads a gate-created journal after the files-landed rewrite fails', async () => {
    await seedFolder()
    let renameLanded = false
    let injected = false
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (renameLanded && !injected
        && String(from).includes('.rewrite-')
        && String(to).includes('.nuvyn-journal-')) {
        injected = true
        throw Object.assign(new Error('injected files-landed rewrite failure'), { code: 'EIO' })
      }
      return realRename(from, to)
    })
    __setCreateOnlyMoveHooksForTesting({
      afterAtomicRenameBeforeParity: () => { renameLanded = true },
    })

    const response = await patchFolder()

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/durable phase gate-created.*recovery journal retained/i),
    })
    const persisted = await readOnlyV4Journal()
    expect(persisted.journal.phase).toBe('gate-created')
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('proj-a-id')
    expect(getDocumentMetadata(db, 'ren/a')).toBeNull()
    expect(await fs.readFile(path.join(vault, 'ren', 'a.md'), 'utf8')).toBe('# hello\n')
  })
  },
)

describe('Round-16 prepared snapshot restore recovery', () => {
  it('resumes a delete rollback killed immediately after its prepared journal', async () => {
    await fs.mkdir(path.join(vault, 'gone'))
    await fs.writeFile(path.join(vault, 'gone', 'a.md'), '# delete rollback\n')
    const dbPath = path.join(vault, 'metadata.sqlite')
    const persistedDb = new Database(dbPath)
    persistedDb.pragma('foreign_keys = ON')
    applyMigrations(persistedDb)
    saveDocumentMetadata(persistedDb, {
      id: 'delete-a-id',
      path: 'gone/a',
      title: 'Delete rollback',
      updatedAt: 1,
    })
    persistedDb.close()

    // Promote the child to module scope so afterEach can terminate it even
    // if this test throws or times out. The fixture announces the durable
    // prepared point and waits with its SQLite handle open; the parent then
    // force-kills the process tree at that exact point.
    const child = spawn(process.execPath, [TSX_CLI, DELETE_PREPARED_CHILD], {
      env: {
        ...process.env,
        NUVYN_FOLDER_VAULT: vault,
        NUVYN_FOLDER_DB: dbPath,
      },
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    })
    crashChild = child
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', chunk => { stdout += chunk.toString() })
    child.stderr!.on('data', chunk => { stderr += chunk.toString() })

    await waitForStdoutMarker(child, PREPARED_READY, () => stdout, () => stderr)
    expect(stdout, stderr).toContain(PREPARED_READY)

    // The child is intentionally still alive here. A true hard kill avoids
    // Node/native-addon teardown in the child and models abrupt termination.
    // Wait for `close` (exit + stdio streams closed) before inspecting the
    // journal so the open SQLite handle is fully released on Windows.
    const closed = await terminateProcessTree(child, { timeoutMs: 10_000 })
    if (process.platform === 'win32') {
      expect(closed.code !== null || closed.signal !== null).toBe(true)
    } else {
      expect(closed.signal === 'SIGKILL' || closed.code === 137).toBe(true)
    }

    const prepared = await readOnlyV4Journal()
    expect(prepared.journal.phase).toBe('prepared')
    expect(prepared.journal.metadataDisposition.kind).toBe('snapshot-restore')
    const preparedSourceStat = await fs.stat(
      path.join(vault, prepared.journal.srcRel),
      { bigint: true },
    )
    expect(prepared.journal.sourceDev).toBe(preparedSourceStat.dev.toString())
    expect(prepared.journal.sourceIno).toBe(preparedSourceStat.ino.toString())
    expect(prepared.journal.sourceBirthtimeNs)
      .toBe(preparedSourceStat.birthtimeNs.toString())
    await expect(fs.stat(path.join(vault, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' })

    const recoveryDb = new Database(dbPath)
    try {
      const first = await recoverInterruptedOperations(vault, recoveryDb)
      expect(first.actions).toContainEqual(expect.objectContaining({
        action: 'completed-rename',
        detail: 'v4 metadata-committed transaction verified and cleaned',
      }))
      expect(await fs.readFile(path.join(vault, 'gone', 'a.md'), 'utf8')).toBe('# delete rollback\n')
      expect(getDocumentMetadata(recoveryDb, 'gone/a')?.id).toBe('delete-a-id')
      await expect(fs.stat(prepared.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' })

      const second = await recoverInterruptedOperations(vault, recoveryDb)
      expect(second.actions).toEqual([])
      expect(getDocumentMetadata(recoveryDb, 'gone/a')?.id).toBe('delete-a-id')
    } finally {
      recoveryDb.close()
    }
  }, 30_000)
})

describe('Round-16 reverse final verification', () => {
  beforeEach(() => {
    // This test validates the shared metadata-committed final
    // verifier, not platform-specific atomic directory rename support.
    //
    // Force the replayable protocol so Windows reaches the intended
    // reverse metadata / final parity seam instead of returning 501
    // for an unsupported atomic directory rename.
    __setDirectoryMoveStrategyOverrideForTesting('replayable-move')
  })

  it('retains the rollback journal when the restored directory inode is externally replaced', async () => {
    await seedFolder()
    await fs.writeFile(path.join(vault, 'ref.md'), 'see [[proj/a]]\n')
    await mountedApp.fetch(withAuthCookie(auth, new Request('http://localhost/api/links/index')))
    const replacementStash = path.join(vault, 'restored-owned-a.md')
    __setFolderRaceHooksForTesting({
      afterRenamePlanBuilt: async () => {
        await fs.writeFile(path.join(vault, 'ref.md'), 'external save\n')
      },
    })
    __setCreateOnlyMoveHooksForTesting({
      afterReverseMetadataBeforeFinalVerify: async (source) => {
        await fs.rename(path.join(source, 'a.md'), replacementStash)
        await fs.writeFile(path.join(source, 'a.md'), '# external replacement\n')
      },
    } as Parameters<typeof __setCreateOnlyMoveHooksForTesting>[0])

    const response = await patchFolder('proj', 'ren', true)

    expect(response.status).toBe(500)
    const persisted = await readOnlyV4Journal()
    expect(persisted.journal.phase).toBe('metadata-committed')
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('proj-a-id')
    expect(getDocumentMetadata(db, 'ren/a')).toBeNull()
    expect(await fs.readFile(path.join(vault, 'proj', 'a.md'), 'utf8')).toBe('# external replacement\n')
    expect(await fs.readFile(replacementStash, 'utf8')).toBe('# hello\n')

    __setFolderRaceHooksForTesting(null)
    __setCreateOnlyMoveHooksForTesting(null)
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions).toContainEqual({
      file: path.basename(persisted.absolutePath),
      action: 'quarantined',
      detail: 'metadata-committed destination exact parity failed',
    })
    expect(await fs.stat(persisted.absolutePath)).toBeDefined()
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('proj-a-id')
    expect(await fs.readFile(path.join(vault, 'proj', 'a.md'), 'utf8')).toBe('# external replacement\n')
  })
})
