import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { recoverInterruptedOperations, __setCrashRecoveryHooksForTesting } from '../crashRecovery.js'
import { applyMigrations } from '../db.js'
import { getDocumentMetadata, saveDocumentMetadata } from '../documentMetadata.js'
import {
  __setCreateOnlyMoveHooksForTesting,
  __setDirectoryMoveStrategyOverrideForTesting,
} from '../documentFileLifecycle.js'
import * as historyGit from '../history/git.js'
import {
  __resetGitCapabilityForTesting,
  __resetRepoRootForTesting,
  __setHistoryMutationHooksForTesting,
  setRepoRootForTesting,
  type HistoryMutationKind,
} from '../history/routes.js'
import app, { __setMetadataDbForTesting } from '../index.js'
import { __resetLinkIndexForTesting } from '../linkIndex.js'
import { setContentDir } from '../paths.js'
import { __setVaultMutationHooksForTesting } from '../vaultMutation.js'
import {
  terminateProcessTree,
  waitForChildClose,
} from './helpers/crashProcessTree.js'
import {
  cleanupHistoryTempRepo,
  describeHistoryIntegration,
} from './helpers/historyIntegration.js'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  withAuthCookie,
  type AuthenticatedTestContext,
} from './helpers/auth.js'

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// Node's --import flag requires a file: URL; on Windows a raw `C:\...` path
// is parsed as a malformed URL and the loader never registers, so the child
// exits silently before flushing any READY handshake. Wrap the loader in
// pathToFileURL to make the spawn cross-platform.
const TSX_LOADER = pathToFileURL(
  path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
).href
// The script entry arg, by contrast, is treated by Node CLI as a filesystem
// path (resolved against cwd) — passing it as a URL is joined literally and
// produces ENOENT. Keep this one as a raw absolute path.
const VITE_WRITER_CHILD = path.join(
  REPO_ROOT,
  'server',
  '__tests__',
  'fixtures',
  'vault-writer-vite-child.ts',
)
const originalContentDir = path.resolve(process.cwd(), 'src/content')

let vault: string
let db: Database.Database
let auth: AuthenticatedTestContext

async function write(rel: string, raw: string): Promise<void> {
  const absolute = path.join(vault, rel)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, raw, 'utf8')
}

async function initializeHistory(): Promise<void> {
  await historyGit.initRepo(vault)
  await historyGit.run(vault, ['config', 'user.name', 'Cross Feature Test'])
  await historyGit.run(vault, ['config', 'user.email', 'cross-feature@example.test'])
  __resetGitCapabilityForTesting()
}

async function commit(paths: string[], message: string): Promise<historyGit.CommitResult> {
  return historyGit.addAndCommit(vault, paths, message)
}

function request(method: string, requestPath: string, body?: unknown): Promise<Response> {
  return app.fetch(withAuthCookie(auth, new Request(`http://localhost${requestPath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })))
}

function folderMove(from: string, to: string): Promise<Response> {
  return request('PATCH', `/api/folders/${from}`, { newPath: to })
}

async function expectedHash(rel: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(path.join(vault, rel))).digest('hex')
}

async function expectHistoryQueuesBehindFolder(input: {
  kind: HistoryMutationKind
  pause: 'gate-created' | 'files-landed'
  historyRequest: () => Promise<Response>
  after?: (folderResponse: Response, historyResponse: Response) => void | Promise<void>
}): Promise<void> {
  const folderPaused = deferred()
  const releaseFolder = deferred()
  const historyEntered = deferred<HistoryMutationKind>()
  const historyQueued = deferred<string>()

  __setCreateOnlyMoveHooksForTesting(input.pause === 'gate-created'
    ? {
        afterGateCreated: async () => {
          folderPaused.resolve()
          await releaseFolder.promise
        },
      }
    : {
        afterFilesLanded: async () => {
          folderPaused.resolve()
          await releaseFolder.promise
        },
      })
  __setHistoryMutationHooksForTesting({
    beforeMutation: async (kind) => {
      if (kind === input.kind) historyEntered.resolve(kind)
    },
  })
  __setVaultMutationHooksForTesting({
    onWait: async (root) => {
      historyQueued.resolve(root)
    },
  })

  const moving = folderMove('proj', 'ren')
  await folderPaused.promise
  const history = input.historyRequest()
  const first = await Promise.race([
    historyQueued.promise.then((root) => ({ state: 'queued' as const, root })),
    historyEntered.promise.then((kind) => ({ state: 'entered' as const, kind })),
  ])
  releaseFolder.resolve()
  const [folderResponse, historyResponse] = await Promise.all([moving, history])
  expect(first).toEqual({ state: 'queued', root: await fs.realpath(vault) })
  await input.after?.(folderResponse, historyResponse)
}

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-history-folder-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  auth = createAuthenticatedTestContext({ db })
  setContentDir(vault)
  setRepoRootForTesting(vault)
  __setMetadataDbForTesting(db)
  __resetLinkIndexForTesting()
  __setDirectoryMoveStrategyOverrideForTesting(null)
  await initializeHistory()
})

afterEach(async () => {
  __setCrashRecoveryHooksForTesting(null)
  __setCreateOnlyMoveHooksForTesting(null)
  __setDirectoryMoveStrategyOverrideForTesting(null)
  __setHistoryMutationHooksForTesting(null)
  __setVaultMutationHooksForTesting(null)
  __setMetadataDbForTesting(null)
  __resetRepoRootForTesting()
  __resetGitCapabilityForTesting()
  __resetLinkIndexForTesting()
  setContentDir(originalContentDir)
  closeAuthTestContext(auth)
  db.close()
  await cleanupHistoryTempRepo(vault)
})

describeHistoryIntegration('History mutations × folder-move v4', () => {
  it('RED-1: Restore cannot enter while the source generation is journal-owned', async () => {
    await write('proj/a.md', 'committed\n')
    const historical = await commit(['proj/a.md'], 'seed source')
    await write('proj/a.md', 'uncommitted source bytes\n')
    saveDocumentMetadata(db, { id: 'stable-a', path: 'proj/a', title: 'A', updatedAt: 1 })

    await expectHistoryQueuesBehindFolder({
      kind: 'restore',
      pause: 'gate-created',
      historyRequest: () => request('POST', '/api/history/restore', {
        path: 'proj/a.md',
        ref: historical.sha,
      }),
      after: async (folderResponse, restoreResponse) => {
        expect(folderResponse.status).toBe(200)
        expect(restoreResponse.status).toBe(409)
        expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8'))
          .toBe('uncommitted source bytes\n')
        expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('stable-a')
      },
    })
  }, 30_000)

  it('RED-2: Restore cannot claim a replayable journal-owned destination', async () => {
    __setDirectoryMoveStrategyOverrideForTesting('replayable-move')
    await write('ren/a.md', 'historical destination\n')
    const historical = await commit(['ren/a.md'], 'destination history')
    await fs.rename(path.join(vault, 'ren'), path.join(vault, 'proj'))
    await commit(['ren/a.md', 'proj/a.md'], 'move away from destination')
    saveDocumentMetadata(db, { id: 'stable-a', path: 'proj/a', title: 'A', updatedAt: 1 })

    await expectHistoryQueuesBehindFolder({
      kind: 'restore',
      pause: 'gate-created',
      historyRequest: () => request('POST', '/api/history/restore', {
        path: 'ren/a.md',
        ref: historical.sha,
      }),
      after: async (folderResponse, restoreResponse) => {
        expect(folderResponse.status).toBe(200)
        expect(restoreResponse.status).toBe(200)
        expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('stable-a')
        expect((await fs.readdir(vault)).some((name) => name.includes('.nuvyn-journal-')))
          .toBe(false)
      },
    })
  }, 30_000)

  it('RED-3: Restore cannot mutate a files-landed generation before metadata commits', async () => {
    __setDirectoryMoveStrategyOverrideForTesting('replayable-move')
    await write('ren/a.md', 'historical destination\n')
    const historical = await commit(['ren/a.md'], 'destination history')
    await fs.rename(path.join(vault, 'ren'), path.join(vault, 'proj'))
    await commit(['ren/a.md', 'proj/a.md'], 'move away from destination')
    saveDocumentMetadata(db, { id: 'stable-a', path: 'proj/a', title: 'A', updatedAt: 1 })

    await expectHistoryQueuesBehindFolder({
      kind: 'restore',
      pause: 'files-landed',
      historyRequest: () => request('POST', '/api/history/restore', {
        path: 'ren/a.md',
        ref: historical.sha,
      }),
      after: async (folderResponse, restoreResponse) => {
        expect(folderResponse.status).toBe(200)
        expect(restoreResponse.status).toBe(200)
        expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('stable-a')
      },
    })
  }, 30_000)

  it('RED-4: Withdraw serializes its HEAD, Real Index, and Repair settlement', async () => {
    await write('proj/a.md', 'v1\n')
    await commit(['proj/a.md'], 'v1')
    await write('proj/a.md', 'v2\n')
    const latest = await commit(['proj/a.md'], 'v2')
    saveDocumentMetadata(db, { id: 'stable-a', path: 'proj/a', title: 'A', updatedAt: 1 })

    await expectHistoryQueuesBehindFolder({
      kind: 'withdraw',
      pause: 'files-landed',
      historyRequest: () => request('POST', '/api/history/drop', { sha: latest.sha }),
      after: async (folderResponse, withdrawResponse) => {
        expect(folderResponse.status).toBe(200)
        expect(withdrawResponse.status).toBe(200)
        expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('stable-a')
        expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('v2\n')
      },
    })
  }, 30_000)

  it('RED-5: Create Version cannot commit a half-moved namespace', async () => {
    await write('proj/a.md', 'base\n')
    const base = await commit(['proj/a.md'], 'base')
    await write('proj/a.md', 'pending version\n')
    const expected = await expectedHash('proj/a.md')
    saveDocumentMetadata(db, { id: 'stable-a', path: 'proj/a', title: 'A', updatedAt: 1 })

    await expectHistoryQueuesBehindFolder({
      kind: 'create-version',
      pause: 'gate-created',
      historyRequest: () => request('POST', '/api/history/commits', {
        paths: ['proj/a.md'],
        message: 'must not commit old namespace',
        expected: { 'proj/a.md': expected },
      }),
      after: async (folderResponse, commitResponse) => {
        expect(folderResponse.status).toBe(200)
        expect(commitResponse.status).toBe(409)
        expect((await historyGit.run(vault, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(base.sha)
      },
    })
  }, 30_000)

  it('RED-6: Index Repair cannot replace the Real Index during a folder move', async () => {
    await write('proj/a.md', 'base\n')
    const degraded = await historyGit.addAndCommit(vault, ['proj/a.md'], 'base', {
      syncIndexForTesting: async () => ({ status: 1, stdout: '', stderr: 'injected' }),
    })
    expect(degraded.indexRepair).toBeDefined()
    saveDocumentMetadata(db, { id: 'stable-a', path: 'proj/a', title: 'A', updatedAt: 1 })

    await expectHistoryQueuesBehindFolder({
      kind: 'repair-index',
      pause: 'files-landed',
      historyRequest: () => request('POST', '/api/history/repair-index', {
        token: degraded.indexRepair!.token,
      }),
      after: async (folderResponse, repairResponse) => {
        expect(folderResponse.status).toBe(200)
        expect(repairResponse.status).toBe(200)
        expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('stable-a')
      },
    })
  }, 30_000)

  it('recovery owns the same mutation boundary as History Restore', async () => {
    await write('note.md', 'v1\n')
    const historical = await commit(['note.md'], 'v1')
    await write('note.md', 'v2\n')

    const recoveryPaused = deferred()
    const releaseRecovery = deferred()
    const historyEntered = deferred<HistoryMutationKind>()
    const historyQueued = deferred<string>()
    __setCrashRecoveryHooksForTesting({
      afterRecoveryStarted: async () => {
        recoveryPaused.resolve()
        await releaseRecovery.promise
      },
    })
    __setHistoryMutationHooksForTesting({
      beforeMutation: async (kind) => historyEntered.resolve(kind),
    })
    __setVaultMutationHooksForTesting({
      onWait: async (root) => historyQueued.resolve(root),
    })

    const recovery = recoverInterruptedOperations(vault, db)
    await recoveryPaused.promise
    const restore = request('POST', '/api/history/restore', {
      path: 'note.md',
      ref: historical.sha,
    })
    const first = await Promise.race([
      historyQueued.promise.then((root) => ({ state: 'queued' as const, root })),
      historyEntered.promise.then((kind) => ({ state: 'entered' as const, kind })),
    ])
    releaseRecovery.resolve()
    await expect(recovery).resolves.toEqual({ actions: [] })
    expect((await restore).status).toBe(200)
    expect(first).toEqual({ state: 'queued', root: await fs.realpath(vault) })
  })
})

type ServerOutcome =
  | { kind: 'listening'; output: string }
  | { kind: 'exit'; code: number | null; output: string }

function spawnProd(cwd: string, sharedVault: string): ChildProcess {
  return spawn(process.execPath, ['--import', TSX_LOADER, VITE_WRITER_CHILD], {
    cwd,
    env: {
      ...process.env,
      VAULT_DIR: sharedVault,
      PORT: '0',
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
}

function serverOutcome(child: ChildProcess): Promise<ServerOutcome> {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const inspect = (): void => {
      if (!settled && /READY:VITE_MUTATION_SERVER/.test(output)) {
        settled = true
        resolve({ kind: 'listening', output })
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      inspect()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      inspect()
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      resolve({ kind: 'exit', code, output })
    })
  })
}

describeHistoryIntegration('RED-7: one active writer process per canonical Vault', () => {
  it('fails the second production process closed before it listens', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-writer-process-'))
    const sharedVault = path.join(fixture, 'vault')
    const cwdA = path.join(fixture, 'a')
    const cwdB = path.join(fixture, 'b')
    await fs.mkdir(sharedVault, { recursive: true })
    await fs.mkdir(cwdA)
    await fs.mkdir(cwdB)
    const first = spawnProd(cwdA, sharedVault)
    const firstClose = waitForChildClose(first)
    void firstClose.catch(() => {})
    let second: ChildProcess | null = null
    try {
      const firstOutcome = await serverOutcome(first)
      expect(firstOutcome.kind, firstOutcome.output).toBe('listening')
      second = spawnProd(cwdB, sharedVault)
      void waitForChildClose(second).catch(() => {})
      const outcome = await serverOutcome(second)
      expect(outcome.kind, outcome.output).toBe('exit')
      if (outcome.kind === 'exit') {
        expect(outcome.code).not.toBe(0)
        expect(outcome.output).toMatch(/Vault writer/i)
      }
    } finally {
      await Promise.all([
        terminateProcessTree(first, { timeoutMs: 10_000 }),
        ...(second ? [terminateProcessTree(second, { timeoutMs: 10_000 })] : []),
      ])
      await fs.rm(fixture, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 10 : 3,
        retryDelay: 100,
      })
    }
  }, 30_000)
})
