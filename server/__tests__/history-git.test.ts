// End-to-end tests for the L0 git wrapper. These spawn a real `git`
// process against a temp directory, so they take a few hundred ms
// total — that's the price of confidence. Tests cover:
//
//   - isRepo: false for a fresh dir, true after init
//   - initRepo: creates main branch, autocrlf disabled
//   - status: parses XY paths correctly, picks up new/modified/deleted/untracked
//   - log: returns commits newest-first with author / date / subject
//   - log --follow: tracks a file across a rename
//   - addAndCommit: produces a sha, the committed file is in HEAD,
//                   empty message / empty paths rejected
//   - rawAt: returns the file's content at a given ref; null when the
//            file did not exist at that ref
//   - ensureRepo: writes .gitignore / .gitattributes exactly once
//   - CRLF safety: a file written with `\r\n` reads back identical
//     bytes via `git show` thanks to core.autocrlf=false
//
// Why not mock child_process.spawn: the whole point of these tests
// is to verify the wrapper's contract against the actual `git` CLI
// (different versions format --porcelain slightly differently; we
// want to catch regressions on upgrade). Mocks would test the mock.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import * as git from '../history/git.js'
import { ensureRepo } from '../history/repo.js'
import {
  cleanupHistoryTempRepo,
  describeHistoryIntegration,
} from './helpers/historyIntegration.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-history-'))
})

afterEach(async () => {
  await cleanupHistoryTempRepo(root)
})

async function write(rel: string, body: string) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, 'utf8')
}

async function setUser() {
  // A bare `git commit` outside a configured user errors out. Every
  // test that creates a commit touches this once. We use a fixed
  // name/email so log assertions are stable.
  const r = await git.run(root, ['config', 'user.name', 'Test User'])
  if (r.status !== 0) throw new Error(r.stderr)
  const e = await git.run(root, ['config', 'user.email', 'test@example.com'])
  if (e.status !== 0) throw new Error(e.stderr)
}

/**
 * Initialize the repo so subsequent tests have a working tree.
 * Does NOT commit the dotfiles — .gitattributes is empty by design
 * (see repo.ts for why) and adding it would either fail (empty file)
 * or produce a no-op commit that pollutes log assertions. The clean-
 * status test filters them out explicitly.
 */
async function initAndSeed() {
  await ensureRepo(root)
  await setUser()
}

describeHistoryIntegration('isRepo / initRepo', () => {
  it('reports false for a fresh directory', async () => {
    expect(await git.isRepo(root)).toBe(false)
  })

  it('reports true after initRepo and disables autocrlf', async () => {
    await git.initRepo(root)
    expect(await git.isRepo(root)).toBe(true)
    const cfg = await git.run(root, ['config', '--get', 'core.autocrlf'])
    expect(cfg.stdout.trim()).toBe('false')
  })
})

describeHistoryIntegration('ensureRepo', () => {
  it('writes .gitignore and .gitattributes on first call', async () => {
    await ensureRepo(root)
    expect(await git.isRepo(root)).toBe(true)
    const gi = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    expect(gi).toContain('data/')
    expect(gi).toContain('node_modules/')
    // .gitattributes is intentionally empty — see repo.ts. We still
    // create the file (so future attribute edits have a stable home)
    // and assert it's empty rather than a non-existent file.
    const ga = await fs.readFile(path.join(root, '.gitattributes'), 'utf8')
    expect(ga).toBe('')
  })

  it('does not overwrite existing .gitignore on second call', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), '# my custom rule\n', 'utf8')
    await ensureRepo(root)
    const gi = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    expect(gi).toBe('# my custom rule\n')
  })

  it('creates one persistent UUID Vault ID and keeps it across repeated opens', async () => {
    await ensureRepo(root)
    const first = await git.ensureNuvynVaultId(root)
    const stored = JSON.parse(await fs.readFile(path.join(root, '.nuvyn', 'vault-id'), 'utf8')) as {
      version: number
      id: string
    }
    expect(stored).toEqual({ version: 1, id: first })
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await git.ensureNuvynVaultId(root)).toBe(first)
  })

  it('uses one UUID when first-open callers race', async () => {
    await ensureRepo(root)
    const ids = await Promise.all(Array.from({ length: 8 }, () => git.ensureNuvynVaultId(root)))
    expect(new Set(ids).size).toBe(1)
  })

  it('keeps the same UUID after the Vault directory is moved', async () => {
    await ensureRepo(root)
    const id = await git.ensureNuvynVaultId(root)
    const moved = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-history-moved-'))
    await fs.rm(moved, { recursive: true, force: true })
    await fs.rename(root, moved)
    root = moved
    expect(await git.ensureNuvynVaultId(moved)).toBe(id)
  })

  it('fails closed when the persistent Vault ID is malformed', async () => {
    await ensureRepo(root)
    await fs.writeFile(path.join(root, '.nuvyn', 'vault-id'), '{"version":1,"id":"not-an-id"}\n', 'utf8')
    await expect(git.ensureNuvynVaultId(root)).rejects.toThrow(/invalid Nuvyn Vault ID/)
  })

  it('is a no-op on an existing repo', async () => {
    await git.initRepo(root)
    await setUser()
    await write('foo.md', 'hello')
    await git.addAndCommit(root, ['foo.md'], 'initial')
    // Sanity: foo.md is in HEAD
    expect(await git.rawAt(root, 'HEAD', 'foo.md')).toBe('hello')
    // ensureRepo should not throw and should not change HEAD
    await ensureRepo(root)
    expect(await git.rawAt(root, 'HEAD', 'foo.md')).toBe('hello')
  })

  // The vault is meant to be its own top-level git repo, separate
  // from any project that surrounds it. But for dev convenience
  // (and for users who actually want a nested vault repo) we don't
  // refuse — we log a one-time warning and init the nested repo
  // anyway. Git's built-in `.git/` ignore means the outer repo
  // doesn't see the inner one's internals as untracked files.
  it('initializes a nested vault repo when one is requested inside another', async () => {
    // `root` becomes the OUTER project repo. `vault/` is the vault
    // subfolder that the user is pointing nuvyn at.
    await git.initRepo(root)
    await setUser()
    await write('README.md', 'project readme')
    await git.addAndCommit(root, ['README.md'], 'project seed')
    const vault = path.join(root, 'vault')
    await fs.mkdir(vault, { recursive: true })

    // Silence the expected console.warn so the test output is clean.
    // We don't assert on it here — vitest's console interception is
    // unreliable across module loaders; the side-effect check below
    // is the load-bearing one.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await ensureRepo(vault)
    } finally {
      warnSpy.mockRestore()
    }
    // The nested repo was actually created — we check for the
    // literal `.git/` directory rather than `git.isRepo` (which
    // uses rev-parse --is-inside-work-tree and would also match
    // the OUTER repo at `root`).
    const vaultDotGit = path.join(vault, '.git')
    let dotGitExists = false
    try {
      const st = await fs.stat(vaultDotGit)
      dotGitExists = st.isDirectory() || st.isFile()
    } catch {
      dotGitExists = false
    }
    expect(dotGitExists).toBe(true)
    // Dotfiles made it into the nested repo's working tree.
    expect((await fs.readFile(path.join(vault, '.gitignore'), 'utf8')).length).toBeGreaterThan(0)
  }, 15_000)
})

describe('parsePorcelain', () => {
  it('parses a fresh-status output with modifications and an untracked file', () => {
    const text =
      ' M inbox/note-a.md\n' +
      'M  inbox/note-b.md\n' +
      '?? literature/new.md\n' +
      'D  archive/old.md\n'
    expect(git.parsePorcelain(text)).toEqual([
      { index: ' ', worktree: 'M', path: 'inbox/note-a.md' },
      { index: 'M', worktree: ' ', path: 'inbox/note-b.md' },
      { index: '?', worktree: '?', path: 'literature/new.md' },
      { index: 'D', worktree: ' ', path: 'archive/old.md' },
    ])
  })

  it('ignores lines that do not match the XY path shape', () => {
    expect(git.parsePorcelain('not a status line\n M foo.md\n')).toEqual([
      { index: ' ', worktree: 'M', path: 'foo.md' },
    ])
  })

  it('returns [] for empty input', () => {
    expect(git.parsePorcelain('')).toEqual([])
  })
})

describeHistoryIntegration('status', () => {
  beforeEach(initAndSeed)

  it('returns [] when the working tree is clean (ignoring the seeded dotfiles)', async () => {
    // The vault's own .gitignore / .gitattributes are untracked by
    // design (we don't auto-commit them — see initAndSeed). The
    // production code path hides them via `git status --ignored`
    // semantics, but for tests it's clearer to assert that the only
    // entries are the two dotfiles and nothing else.
    const s = await git.status(root)
    const paths = s.map((e) => e.path)
    expect(paths.sort()).toEqual(['.gitattributes', '.gitignore'])
  })

  it('reports modified, new, and untracked files', async () => {
    await write('inbox/clean.md', 'tracked')
    await git.addAndCommit(root, ['inbox/clean.md'], 'seed')
    // Now modify clean.md and add a brand-new untracked file.
    await write('inbox/clean.md', 'tracked (changed)')
    await write('inbox/fresh.md', 'untracked')
    const s = await git.status(root)
    const byPath = Object.fromEntries(s.map((e) => [e.path, e]))
    expect(byPath['inbox/clean.md'].worktree).toBe('M')
    expect(byPath['inbox/fresh.md']).toEqual({ index: '?', worktree: '?', path: 'inbox/fresh.md' })
  })
})

describeHistoryIntegration('addAndCommit + log', () => {
  beforeEach(initAndSeed)

  it('creates a commit, returns its sha, and log reports it', async () => {
    await write('inbox/a.md', 'one')
    await write('inbox/b.md', 'two')
    const r = await git.addAndCommit(root, ['inbox/a.md', 'inbox/b.md'], 'first commit')
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(r.filesCommitted.sort()).toEqual(['inbox/a.md', 'inbox/b.md'])
    const log = await git.log(root)
    // No seed commit: initAndSeed leaves the working tree without an
    // initial commit, so the first user commit is also the only one.
    expect(log).toHaveLength(1)
    expect(log[0].sha).toBe(r.sha)
    expect(log[0].subject).toBe('first commit')
    expect(log[0].parents).toEqual([])
    expect(log[0].author).toBe('Test User')
    expect(log[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(log[0].files.sort()).toEqual(['inbox/a.md', 'inbox/b.md'])
    const message = await git.run(root, ['show', '-s', '--format=%B', r.sha])
    expect(message.stdout).toContain('Nuvyn-Version: 1')
    expect(message.stdout).toContain('Nuvyn-Vault: ')
    expect(message.stdout).toContain('Nuvyn-Vault-Version: 1')
  })

  it('commits only selected paths when an unrelated file is already staged', async () => {
    await write('selected.md', 'selected')
    await write('staged-elsewhere.md', 'staged elsewhere')
    const stage = await git.run(root, ['add', '--', 'staged-elsewhere.md'])
    expect(stage.status).toBe(0)

    const result = await git.addAndCommit(root, ['selected.md'], 'selected only')

    expect(result.filesCommitted).toEqual(['selected.md'])
    expect(await git.rawAt(root, 'HEAD', 'selected.md')).toBe('selected')
    expect(await git.rawAt(root, 'HEAD', 'staged-elsewhere.md')).toBeNull()
    expect(await git.status(root)).toContainEqual(expect.objectContaining({
      path: 'staged-elsewhere.md',
      index: 'A',
      worktree: ' ',
    }))
  })

  it('commits the validated snapshot when the worktree changes before staging', async () => {
    await write('race.md', 'click-time content')
    const expected = {
      'race.md': createHash('sha256').update('click-time content').digest('hex'),
    }

    const result = await git.addAndCommit(root, ['race.md'], 'fixed snapshot', {
      expected,
      beforeStageForTesting: async () => {
        await write('race.md', 'changed after validation')
      },
    })

    expect(await git.rawAt(root, result.sha, 'race.md')).toBe('click-time content')
    expect(await fs.readFile(path.join(root, 'race.md'), 'utf8')).toBe('changed after validation')
    expect(await git.status(root)).toContainEqual(expect.objectContaining({
      path: 'race.md',
      worktree: 'M',
    }))
  })

  it('rejects with CAS conflict when HEAD changes before update-ref', async () => {
    await write('selected.md', 'selected snapshot')
    const expected = {
      'selected.md': createHash('sha256').update('selected snapshot').digest('hex'),
    }

    await expect(git.addAndCommit(root, ['selected.md'], 'must lose CAS', {
      expected,
      beforeUpdateRefForTesting: async () => {
        await write('other.md', 'external commit')
        expect((await git.run(root, ['add', '--', 'other.md'])).status).toBe(0)
        expect((await git.run(root, ['commit', '-m', 'external'])).status).toBe(0)
      },
    })).rejects.toThrow('repository changed before commit')

    expect(await git.rawAt(root, 'HEAD', 'other.md')).toBe('external commit')
    expect(await git.rawAt(root, 'HEAD', 'selected.md')).toBeNull()
  })

  it('rejects a HEAD change after staged-intent classification before temporary-index init', async () => {
    await write('a.md', 'one')
    const first = await git.addAndCommit(root, ['a.md'], 'one')
    await write('a.md', 'two')
    const second = await git.addAndCommit(root, ['a.md'], 'two')
    await write('a.md', 'three')
    const expected = { 'a.md': createHash('sha256').update('three').digest('hex') }

    await expect(git.addAndCommit(root, ['a.md'], 'must not commit', {
      expected,
      beforeTemporaryIndexForTesting: async () => {
        expect((await git.run(root, ['reset', '--soft', first.sha])).status).toBe(0)
      },
    })).rejects.toThrow('repository changed before commit')

    expect((await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(first.sha)
    expect((await git.run(root, ['diff', '--cached', '--quiet', first.sha, '--', 'a.md'])).status).toBe(1)
    expect((await git.run(root, ['show', ':a.md'])).stdout).toBe('two')
    expect(await git.getIndexRepairStatus(root)).toEqual([])
    expect(second.sha).not.toBe(first.sha)
  })

  it('reports index refresh degradation after a successful CAS commit', async () => {
    await write('a.md', 'snapshot')
    const syncIndexForTesting = vi.fn().mockResolvedValue({
      status: 1,
      stdout: '',
      stderr: 'index.lock exists',
    })
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: {
        'a.md': createHash('sha256').update('snapshot').digest('hex'),
      },
      syncIndexForTesting,
    })

    expect(result.indexRefreshFailed).toBe(true)
    expect(result.indexRepair).toMatchObject({
      head: result.sha,
      paths: ['a.md'],
    })
    expect(syncIndexForTesting).toHaveBeenCalledTimes(3)
    expect(await git.rawAt(root, result.sha, 'a.md')).toBe('snapshot')
    await expect(git.repairIndex(root, result.indexRepair!.token)).resolves.toEqual({ repaired: true })
    expect((await git.status(root)).find((entry) => entry.path === 'a.md')).toBeUndefined()
    expect(await git.getIndexRepairStatus(root)).toEqual([])
  })

  it('does not let a staged write enter Create Version Repair metadata', async () => {
    await write('a.md', 'snapshot')
    let externalAdd: git.RunResult | undefined
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
      beforeRepairMetadataWriteForTesting: async () => {
        await write('a.md', 'new staged intent')
        externalAdd = await git.run(root, ['add', '--', 'a.md'])
      },
    })

    expect(externalAdd?.status).not.toBe(0)
    expect(result.repairStatePersistenceFailed).toBe(false)
    expect(result.indexRepair).toMatchObject({
      paths: ['a.md'],
      expectedIndex: { 'a.md': [] },
    })
    expect(await git.getIndexRepairStatus(root)).toEqual([
      expect.objectContaining({ token: result.indexRepair!.token, expectedIndex: { 'a.md': [] } }),
    ])
    await expect(git.repairIndex(root, result.indexRepair!.token)).resolves.toEqual({ repaired: true })
    expect((await git.status(root)).find((entry) => entry.path === 'a.md')).toMatchObject({
      index: ' ',
      worktree: 'M',
    })
  })

  it('keeps earlier repair transactions across later commits and accumulates failures', async () => {
    const failSync = vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' })
    await write('a.md', 'A')
    const first = await git.addAndCommit(root, ['a.md'], 'A', {
      expected: { 'a.md': createHash('sha256').update('A').digest('hex') },
      syncIndexForTesting: failSync,
    })

    await write('b.md', 'B')
    await git.addAndCommit(root, ['b.md'], 'B', {
      expected: { 'b.md': createHash('sha256').update('B').digest('hex') },
    })
    expect((await git.getIndexRepairStatus(root)).map((item) => item.paths)).toEqual([['a.md']])

    await write('c.md', 'C')
    await git.addAndCommit(root, ['c.md'], 'C', {
      expected: { 'c.md': createHash('sha256').update('C').digest('hex') },
      syncIndexForTesting: failSync,
    })
    expect((await git.getIndexRepairStatus(root)).flatMap((item) => item.paths).sort()).toEqual([
      'a.md',
      'c.md',
    ])
    expect(first.indexRepair?.token).toBeTruthy()
  }, 15_000)

  it('repairs A after unrelated B is staged and preserves B in the index', async () => {
    await write('a.md', 'A')
    const first = await git.addAndCommit(root, ['a.md'], 'A', {
      expected: { 'a.md': createHash('sha256').update('A').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
    })
    await write('b.md', 'staged B')
    expect((await git.run(root, ['add', '--', 'b.md'])).status).toBe(0)

    await expect(git.repairIndex(root, first.indexRepair!.token)).resolves.toEqual({ repaired: true })

    expect((await git.run(root, ['show', ':b.md'])).stdout).toBe('staged B')
    expect((await git.run(root, ['diff', '--cached', '--quiet', 'HEAD', '--', 'b.md'])).status).toBe(1)
    expect((await git.run(root, ['diff', '--cached', '--quiet', 'HEAD', '--', 'a.md'])).status).toBe(0)
  }, 10_000)

  it('repairs A after Nuvyn successfully commits unrelated B', async () => {
    await write('a.md', 'A')
    const first = await git.addAndCommit(root, ['a.md'], 'A', {
      expected: { 'a.md': createHash('sha256').update('A').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
    })
    await write('b.md', 'B')
    await git.addAndCommit(root, ['b.md'], 'B', {
      expected: { 'b.md': createHash('sha256').update('B').digest('hex') },
    })

    await expect(git.repairIndex(root, first.indexRepair!.token)).resolves.toEqual({ repaired: true })

    expect((await git.status(root)).filter((entry) => ['a.md', 'b.md'].includes(entry.path))).toEqual([])
  }, 15_000)

  it('refuses repair after the user changes the real index entry', async () => {
    await write('a.md', 'snapshot')
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
    })

    await write('a.md', 'user staged this')
    expect((await git.run(root, ['add', '--', 'a.md'])).status).toBe(0)
    await expect(git.repairIndex(root, result.indexRepair!.token)).rejects.toThrow(
      'index changed after repair was requested',
    )
    expect(await git.getIndexRepairStatus(root)).toEqual([
      expect.objectContaining({ token: result.indexRepair!.token, status: 'superseded' }),
    ])
    expect((await git.run(root, ['show', ':a.md'])).stdout).toBe('user staged this')
  }, 20_000)

  it('holds index.lock across validation and atomic replacement', async () => {
    await write('a.md', 'snapshot')
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
    })
    await write('a.md', 'edit during repair')
    let externalAdd: git.RunResult | undefined

    await expect(git.repairIndex(root, result.indexRepair!.token, {
      afterIndexLockForTesting: async () => {
        externalAdd = await git.run(root, ['add', '--', 'a.md'])
      },
    })).resolves.toEqual({ repaired: true })

    expect(externalAdd?.status).not.toBe(0)
    expect(externalAdd?.stderr).toMatch(/index\.lock|another git process/i)
    expect((await git.run(root, ['diff', '--cached', '--quiet', 'HEAD', '--', 'a.md'])).status).toBe(0)
    expect((await git.status(root)).find((entry) => entry.path === 'a.md')?.worktree).toBe('M')
  }, 10_000)

  it('keeps a repair transaction when HEAD changes immediately before index replacement', async () => {
    await write('a.md', 'snapshot')
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
    })
    let movedHead = ''

    await expect(git.repairIndex(root, result.indexRepair!.token, {
      beforeIndexReplaceForTesting: async () => {
        const oldHead = (await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()
        const tree = (await git.run(root, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
        const commit = await git.run(root, ['commit-tree', tree, '-p', oldHead, '-m', 'external ref move'])
        movedHead = commit.stdout.trim()
        expect((await git.run(root, ['update-ref', 'HEAD', movedHead, oldHead])).status).toBe(0)
      },
    })).resolves.toMatchObject({ repaired: false, replacementApplied: true, finalHead: expect.any(String) })

    expect(movedHead).toBeTruthy()
    expect(await git.getIndexRepairStatus(root)).toEqual([
      expect.objectContaining({
        token: result.indexRepair!.token,
        status: 'pending',
        head: movedHead,
      }),
    ])
    await expect(git.repairIndex(root, result.indexRepair!.token)).resolves.toEqual({ repaired: true })
    expect(await git.getIndexRepairStatus(root)).toEqual([])
  }, 10_000)

  it('reports degraded conflict when a replaced Index cannot persist its new repair record', async () => {
    await write('a.md', 'snapshot')
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
    })
    let movedHead = ''

    const repaired = await git.repairIndex(root, result.indexRepair!.token, {
      beforeIndexReplaceForTesting: async () => {
        const oldHead = (await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()
        const tree = (await git.run(root, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
        const commit = await git.run(root, ['commit-tree', tree, '-p', oldHead, '-m', 'external ref move'])
        movedHead = commit.stdout.trim()
        expect((await git.run(root, ['update-ref', 'HEAD', movedHead, oldHead])).status).toBe(0)
      },
      beforeRepairStatePersistenceForTesting: async () => {
        throw new Error('disk full')
      },
    })
    expect(repaired).toEqual({
      repaired: false,
      replacementApplied: true,
      repairStatePersistenceFailed: true,
      finalHead: movedHead,
    })

    expect((await git.run(root, ['show', ':a.md'])).stdout).toBe('snapshot')
    expect(await git.getIndexRepairStatus(root)).toEqual([
      expect.objectContaining({ token: result.indexRepair!.token, head: result.sha }),
    ])
  }, 10_000)

  it('reports degraded success when repaired Index metadata cannot be cleared', async () => {
    await write('a.md', 'snapshot')
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
    })

    await expect(git.repairIndex(root, result.indexRepair!.token, {
      beforeRepairStatePersistenceForTesting: async () => {
        throw new Error('disk full')
      },
    })).resolves.toEqual({
      repaired: true,
      repairStatePersistenceFailed: true,
    })

    expect((await git.run(root, ['diff', '--cached', '--quiet', 'HEAD', '--', 'a.md'])).status).toBe(0)
    expect(await git.getIndexRepairStatus(root)).toEqual([
      expect.objectContaining({ token: result.indexRepair!.token }),
    ])
  }, 10_000)

  it('discards only repair metadata and preserves newer staged content', async () => {
    await write('a.md', 'snapshot')
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
    })
    await write('a.md', 'user staged this')
    expect((await git.run(root, ['add', '--', 'a.md'])).status).toBe(0)

    await expect(git.discardIndexRepair(root, result.indexRepair!.token)).resolves.toBe(true)

    expect(await git.getIndexRepairStatus(root)).toEqual([])
    expect((await git.run(root, ['show', ':a.md'])).stdout).toBe('user staged this')
  })

  it('reports repair-state persistence degradation without failing an existing commit', async () => {
    await write('a.md', 'snapshot')
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      syncIndexForTesting: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: 'locked' }),
      beforeRepairStatePersistenceForTesting: async () => {
        throw new Error('disk full')
      },
    })

    expect(result).toMatchObject({
      indexRefreshFailed: true,
      repairStatePersistenceFailed: true,
    })
    expect(result.indexRepair).toBeUndefined()
    expect(await git.rawAt(root, 'HEAD', 'a.md')).toBe('snapshot')
  })

  it('does not fail a commit when clearing old repair state cannot be persisted', async () => {
    await write('a.md', 'snapshot')
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      beforeRepairStatePersistenceForTesting: async () => {
        throw new Error('read-only repair state')
      },
    })

    expect(result).toMatchObject({
      indexRefreshFailed: false,
      repairStatePersistenceFailed: true,
    })
    expect(await git.rawAt(root, 'HEAD', 'a.md')).toBe('snapshot')
  })

  it('quarantines corrupt repair state before committing', async () => {
    const repairDir = path.join(root, '.git', 'nuvyn')
    await fs.mkdir(repairDir, { recursive: true })
    await fs.writeFile(path.join(repairDir, 'index-repair.json'), '{broken', 'utf8')
    await write('a.md', 'snapshot')

    await expect(git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
    })).resolves.toMatchObject({ indexRefreshFailed: false })

    const files = await fs.readdir(repairDir)
    expect(files.some((name) => name.startsWith('index-repair.json.corrupt-'))).toBe(true)
  })

  it('migrates a valid version 1 repair file to version 2 without quarantine', async () => {
    await write('seed.md', 'seed')
    const seed = await git.addAndCommit(root, ['seed.md'], 'seed', {
      expected: { 'seed.md': createHash('sha256').update('seed').digest('hex') },
    })
    const repairDir = path.join(root, '.git', 'nuvyn')
    const repairPath = path.join(repairDir, 'index-repair.json')
    await fs.mkdir(repairDir, { recursive: true })
    const token = 'a'.repeat(32)
    await fs.writeFile(repairPath, JSON.stringify({
      version: 1,
      transactions: [{
        token,
        head: seed.sha,
        paths: ['a.md'],
        expectedIndex: { 'a.md': [] },
      }],
    }), 'utf8')

    expect(await git.getIndexRepairStatus(root)).toEqual([
      expect.objectContaining({ token, status: 'pending', paths: ['a.md'] }),
    ])
    const migrated = JSON.parse(await fs.readFile(repairPath, 'utf8')) as { version: number }
    expect(migrated.version).toBe(2)
    expect((await fs.readdir(repairDir)).some((name) => name.includes('.corrupt-'))).toBe(false)
  })

  it('fails the repair-storage preflight before moving HEAD', async () => {
    await fs.writeFile(path.join(root, '.git', 'nuvyn'), 'not a directory', 'utf8')
    await write('a.md', 'snapshot')

    await expect(git.addAndCommit(root, ['a.md'], 'must not commit', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
    })).rejects.toThrow()

    expect((await git.run(root, ['rev-parse', '--verify', 'HEAD'])).status).not.toBe(0)
  })

  it('does not report index repair success when HEAD changes between check and reset', async () => {
    await write('a.md', 'snapshot')
    let movedHead = false
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      expected: { 'a.md': createHash('sha256').update('snapshot').digest('hex') },
      beforeIndexResetForTesting: async (_sha, attempt) => {
        if (attempt !== 0 || movedHead) return
        movedHead = true
        await write('other.md', 'external')
        expect((await git.run(root, ['add', '--', 'other.md'])).status).toBe(0)
        expect((await git.run(root, ['commit', '-m', 'external', '--', 'other.md'])).status).toBe(0)
      },
    })

    expect(result.indexRefreshFailed).toBe(true)
    expect(await git.rawAt(root, 'HEAD', 'other.md')).toBe('external')
    expect(await git.rawAt(root, 'HEAD', 'a.md')).toBe('snapshot')
  })

  it('records the installed Index generation and final HEAD when Create Version loses a HEAD race at rename', async () => {
    await write('a.md', 'snapshot')
    let externalHead = ''
    const result = await git.addAndCommit(root, ['a.md'], 'committed', {
      beforeIndexResetForTesting: async (_sha, attempt) => {
        if (attempt !== 0) return
        await write('unrelated.md', 'staged separately')
        expect((await git.run(root, ['add', '--', 'unrelated.md'])).status).toBe(0)
      },
      beforeIndexReplaceForTesting: async () => {
        const oldHead = (await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()
        const tree = (await git.run(root, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
        const commit = await git.run(root, ['commit-tree', tree, '-p', oldHead, '-m', 'external ref move'])
        externalHead = commit.stdout.trim()
        expect((await git.run(root, ['update-ref', 'HEAD', externalHead, oldHead])).status).toBe(0)
      },
    })

    expect(result).toMatchObject({
      indexRefreshFailed: true,
      repairStatePersistenceFailed: false,
      indexRepair: expect.objectContaining({ head: externalHead, paths: ['a.md'] }),
    })
    expect(externalHead).toBeTruthy()
    expect((await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(externalHead)
    expect((await git.run(root, ['show', ':a.md'])).stdout).toBe('snapshot')
    expect((await git.status(root)).find((entry) => entry.path === 'unrelated.md')).toMatchObject({
      index: 'A',
      worktree: ' ',
    })

    await expect(git.repairIndex(root, result.indexRepair!.token)).resolves.toEqual({ repaired: true })
    expect((await git.run(root, ['show', ':a.md'])).stdout).toBe('snapshot')
    expect((await git.status(root)).find((entry) => entry.path === 'unrelated.md')).toMatchObject({
      index: 'A',
      worktree: ' ',
    })
  }, 15_000)

  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
    it(`rejects Create Version while ${marker} is present`, async () => {
      await write('blocked.md', 'snapshot')
      await fs.writeFile(path.join(root, '.git', marker), 'deadbeef'.repeat(5), 'utf8')

      await expect(git.addAndCommit(root, ['blocked.md'], 'blocked', {
        expected: {
          'blocked.md': createHash('sha256').update('snapshot').digest('hex'),
        },
      })).rejects.toThrow('repository operation in progress')

      expect(await git.rawAt(root, 'HEAD', 'blocked.md')).toBeNull()
    })
  }

  it('rejects when a repository operation starts after snapshot capture', async () => {
    await write('blocked-late.md', 'snapshot')

    await expect(git.addAndCommit(root, ['blocked-late.md'], 'blocked late', {
      expected: {
        'blocked-late.md': createHash('sha256').update('snapshot').digest('hex'),
      },
      beforeUpdateRefForTesting: async () => {
        await fs.writeFile(
          path.join(root, '.git', 'MERGE_HEAD'),
          'deadbeef'.repeat(5),
          'utf8',
        )
      },
    })).rejects.toThrow('repository operation in progress')

    expect(await git.rawAt(root, 'HEAD', 'blocked-late.md')).toBeNull()
  })

  it('rejects an empty path list', async () => {
    await expect(git.addAndCommit(root, [], 'x')).rejects.toThrow(/path/i)
  })

  it('rejects an empty message', async () => {
    await write('a.md', 'x')
    await expect(git.addAndCommit(root, ['a.md'], '   ')).rejects.toThrow(/message/i)
  })

  it('throws "nothing to commit" when all paths are clean', async () => {
    await write('a.md', 'x')
    await git.addAndCommit(root, ['a.md'], 'first')
    await expect(git.addAndCommit(root, ['a.md'], 'second')).rejects.toThrow(/nothing to commit/i)
  })

  it('preserves same-path staged intent after Create Version', async () => {
    await write('a.md', 'base')
    await git.addAndCommit(root, ['a.md'], 'base')
    await write('a.md', 'terminal staged content')
    expect((await git.run(root, ['add', '--', 'a.md'])).status).toBe(0)
    await write('a.md', 'nuvyn version content')

    const result = await git.addAndCommit(root, ['a.md'], 'nuvyn version')

    expect(await git.rawAt(root, result.sha, 'a.md')).toBe('nuvyn version content')
    expect((await git.run(root, ['show', ':a.md'])).stdout).toBe('terminal staged content')
    expect((await git.status(root)).find((entry) => entry.path === 'a.md')).toMatchObject({
      index: 'M',
      worktree: 'M',
    })
  })

  it('returns commits newest-first', async () => {
    await write('a.md', '1')
    const r1 = await git.addAndCommit(root, ['a.md'], 'one')
    // Tiny sleep so the committer-date timestamp differs at second
    // resolution. ISO author dates in `log` are second-precision, so
    // without this the two commits can have the same date and the
    // ordering assertion would be flaky on fast machines.
    await new Promise((r) => setTimeout(r, 1100))
    await write('a.md', '2')
    const r2 = await git.addAndCommit(root, ['a.md'], 'two')
    const log = await git.log(root)
    expect(log.map((c) => c.subject)).toEqual(['two', 'one'])
    expect(log[0].sha).toBe(r2.sha)
    expect(log[1].sha).toBe(r1.sha)
    expect(log[0].parents).toEqual([r1.sha])
    // No seed commit, no orphan history entries.
  })

  it('with `path` filter, only returns commits touching that file', async () => {
    await write('a.md', '1')
    await git.addAndCommit(root, ['a.md'], 'touch a')
    await write('b.md', '1')
    await git.addAndCommit(root, ['b.md'], 'touch b')
    const logA = await git.log(root, { path: 'a.md' })
    const logB = await git.log(root, { path: 'b.md' })
    expect(logA.map((c) => c.subject)).toEqual(['touch a'])
    expect(logB.map((c) => c.subject)).toEqual(['touch b'])
  })

  it('logs a renamed file under its new path (no follow, so old-path commit is not pulled in)', async () => {
    // We do not enable --follow: it has a known false-positive on
    // brand-new file paths (it pulls in earlier commits of unrelated
    // files with the same name). Once a real rename-history UI is
    // built, this is the test that will need to grow with it.
    await write('old-name.md', 'content')
    await git.addAndCommit(root, ['old-name.md'], 'initial')
    const mv = await git.run(root, ['mv', 'old-name.md', 'new-name.md'])
    expect(mv.status).toBe(0)
    await git.addAndCommit(root, ['new-name.md'], 'rename')
    const logNew = await git.log(root, { path: 'new-name.md' })
    expect(logNew.map((c) => c.subject)).toEqual(['rename'])
  })

  // Regression: a freshly-initialized repo (no commits yet) used to
  // throw `git log failed: ... does not have any commits yet`. That
  // bubbled up to /api/history/log as a 500, the client returned
  // `{ error: ... }` (no `commits` field), and the History panel
  // crashed on `h.log.value.length`. `log()` should treat the empty
  // repo as a successful empty list.
  it('returns [] for a freshly-initialized repo with no commits', async () => {
    await ensureRepo(root)
    const log = await git.log(root)
    expect(log).toEqual([])
  })

  it('rejects managed Diary paths before any Git mutation, including mixed batches', async () => {
    await write('seed.md', '# seed\n')
    await git.addAndCommit(root, ['seed.md'], 'seed')
    const beforeHead = (await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()
    await write('ordinary.md', '# ordinary\n')
    await write('diary/2026-08-31.md', 'D8_3_BODY_SECRET_not-markdown\n')

    await expect(git.addAndCommit(
      root,
      ['ordinary.md', 'diary/2026-08-31.md'],
      'must reject mixed Diary batch',
    )).rejects.toMatchObject({ code: 'diary-history-encrypted-unsupported' })

    // The owner rejects before temporary-index creation, staging, commit-tree,
    // or ref movement: neither the Note subset nor the managed path changes
    // repository state, and the working tree bytes remain untouched.
    expect((await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(beforeHead)
    expect(await git.rawAt(root, 'HEAD', 'ordinary.md')).toBeNull()
    expect(await git.rawAt(root, 'HEAD', 'diary/2026-08-31.md')).toBeNull()
    expect(await fs.readFile(path.join(root, 'ordinary.md'), 'utf8')).toBe('# ordinary\n')
    expect(await fs.readFile(path.join(root, 'diary/2026-08-31.md'), 'utf8'))
      .toBe('D8_3_BODY_SECRET_not-markdown\n')
    expect(await git.status(root)).toEqual(expect.arrayContaining([
      { index: '?', worktree: '?', path: 'ordinary.md' },
      { index: '?', worktree: '?', path: 'diary/2026-08-31.md' },
    ]))
  })
})

describeHistoryIntegration('dropHeadCommit', () => {
  beforeEach(initAndSeed)

  it('withdraws only the latest version, preserves Worktree bytes, and keeps unrelated staged entries', async () => {
    await write('a.md', 'v1\n')
    const first = await git.addAndCommit(root, ['a.md'], 'v1')
    await write('a.md', 'v2\n')
    const latest = await git.addAndCommit(root, ['a.md'], 'v2')
    await write('a.md', 'edited after version\n')
    await write('unrelated.md', 'staged separately\n')
    expect((await git.run(root, ['add', '--', 'unrelated.md'])).status).toBe(0)

    const result = await git.dropHeadCommit(root, latest.sha)

    expect(result).toMatchObject({
      sha: first.sha,
      droppedSha: latest.sha,
      filesChanged: ['a.md'],
      indexRefreshFailed: false,
      repairStatePersistenceFailed: false,
    })
    expect(await fs.readFile(path.join(root, 'a.md'), 'utf8')).toBe('edited after version\n')
    expect((await git.run(root, ['show', ':a.md'])).stdout).toBe('v1\n')
    expect((await git.run(root, ['show', ':unrelated.md'])).stdout).toBe('staged separately\n')
    expect((await git.status(root))).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'a.md', index: ' ', worktree: 'M' }),
      expect.objectContaining({ path: 'unrelated.md', index: 'A', worktree: ' ' }),
    ]))
  }, 15_000)

  it('preserves same-path staged intent while withdrawing', async () => {
    await write('a.md', 'v1\n')
    const first = await git.addAndCommit(root, ['a.md'], 'v1')
    await write('a.md', 'v2\n')
    const latest = await git.addAndCommit(root, ['a.md'], 'v2')
    await write('a.md', 'terminal staged content\n')
    expect((await git.run(root, ['add', '--', 'a.md'])).status).toBe(0)
    await write('a.md', 'worktree after staged content\n')

    const result = await git.dropHeadCommit(root, latest.sha.slice(0, 12))

    expect(result.sha).toBe(first.sha)
    expect((await git.run(root, ['show', ':a.md'])).stdout).toBe('terminal staged content\n')
  }, 15_000)

  it('rejects a foreign commit even when it is the current HEAD', async () => {
    await write('a.md', 'v1\n')
    const first = await git.addAndCommit(root, ['a.md'], 'v1')
    const tree = (await git.run(root, ['rev-parse', `${first.sha}^{tree}`])).stdout.trim()
    const foreign = await git.run(root, ['commit-tree', tree, '-p', first.sha, '-m', 'manual commit'])
    expect(foreign.status).toBe(0)
    expect((await git.run(root, ['update-ref', 'HEAD', foreign.stdout.trim(), first.sha])).status).toBe(0)

    await expect(git.dropHeadCommit(root, foreign.stdout.trim())).rejects.toThrow(
      'not a Nuvyn version for this vault',
    )
  }, 15_000)

  it('withdraws the first version without deleting files or unrelated staged entries', async () => {
    await write('root.md', 'root version\n')
    const first = await git.addAndCommit(root, ['root.md'], 'root')
    await write('later.md', 'staged separately\n')
    expect((await git.run(root, ['add', '--', 'later.md'])).status).toBe(0)

    const result = await git.dropHeadCommit(root, first.sha)

    expect(result).toMatchObject({ sha: '', droppedSha: first.sha, filesChanged: ['root.md'] })
    expect(await git.log(root)).toEqual([])
    expect(await fs.readFile(path.join(root, 'root.md'), 'utf8')).toBe('root version\n')
    expect((await git.run(root, ['ls-files', '--error-unmatch', 'root.md'])).status).not.toBe(0)
    expect((await git.run(root, ['show', ':later.md'])).stdout).toBe('staged separately\n')
  }, 15_000)

  it('rejects an older version and uses CAS without overwriting an external version', async () => {
    await write('a.md', 'v1')
    const first = await git.addAndCommit(root, ['a.md'], 'v1')
    await write('a.md', 'v2')
    const latest = await git.addAndCommit(root, ['a.md'], 'v2')
    await expect(git.dropHeadCommit(root, first.sha)).rejects.toThrow(
      'only the latest version can be withdrawn',
    )

    let externalSha = ''
    await expect(git.dropHeadCommit(root, latest.sha, {
      beforeUpdateRefForTesting: async () => {
        const tree = (await git.run(root, ['rev-parse', `${latest.sha}^{tree}`])).stdout.trim()
        const external = await git.run(root, ['commit-tree', tree, '-p', latest.sha, '-m', 'external'])
        externalSha = external.stdout.trim()
        expect((await git.run(root, ['update-ref', 'HEAD', externalSha, latest.sha])).status).toBe(0)
      },
    })).rejects.toThrow('repository changed before withdrawal')
    expect(await git.run(root, ['rev-parse', 'HEAD'])).toMatchObject({
      status: 0,
      stdout: `${externalSha}\n`,
    })
  }, 15_000)

  it('returns degraded success and a persistent Repair transaction after Index synchronization fails', async () => {
    await write('a.md', 'v1')
    const first = await git.addAndCommit(root, ['a.md'], 'v1')
    await write('a.md', 'v2')
    const latest = await git.addAndCommit(root, ['a.md'], 'v2')

    const result = await git.dropHeadCommit(root, latest.sha, {
      syncIndexForTesting: vi.fn().mockResolvedValue(false),
    })

    expect(result).toMatchObject({
      sha: first.sha,
      droppedSha: latest.sha,
      indexRefreshFailed: true,
      repairStatePersistenceFailed: false,
      indexRepair: expect.objectContaining({ head: first.sha, paths: ['a.md'] }),
    })
    expect(await git.getIndexRepairStatus(root)).toEqual([
      expect.objectContaining({ token: result.indexRepair!.token, paths: ['a.md'] }),
    ])
  }, 15_000)

  it('records the installed Index generation and final HEAD when Withdraw loses a HEAD race at rename', async () => {
    await write('a.md', 'v1')
    await git.addAndCommit(root, ['a.md'], 'v1')
    await write('a.md', 'v2')
    const latest = await git.addAndCommit(root, ['a.md'], 'v2')
    let externalHead = ''

    const result = await git.dropHeadCommit(root, latest.sha, {
      beforeUpdateRefForTesting: async () => {
        await write('unrelated.md', 'staged separately')
        expect((await git.run(root, ['add', '--', 'unrelated.md'])).status).toBe(0)
      },
      beforeIndexReplaceForTesting: async () => {
        const oldHead = (await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()
        const tree = (await git.run(root, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
        const commit = await git.run(root, ['commit-tree', tree, '-p', oldHead, '-m', 'external ref move'])
        externalHead = commit.stdout.trim()
        expect((await git.run(root, ['update-ref', 'HEAD', externalHead, oldHead])).status).toBe(0)
      },
    })

    expect(result).toMatchObject({
      indexRefreshFailed: true,
      repairStatePersistenceFailed: false,
      indexRepair: expect.objectContaining({ head: externalHead, paths: ['a.md'] }),
    })
    expect((await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(externalHead)
    expect((await git.status(root)).find((entry) => entry.path === 'unrelated.md')).toMatchObject({
      index: 'A',
      worktree: ' ',
    })
    await expect(git.repairIndex(root, result.indexRepair!.token)).resolves.toEqual({ repaired: true })
    expect((await git.status(root)).find((entry) => entry.path === 'unrelated.md')).toMatchObject({
      index: 'A',
      worktree: ' ',
    })
  }, 15_000)

  it('does not let a staged write enter Withdraw Repair metadata', async () => {
    await write('a.md', 'v1')
    await git.addAndCommit(root, ['a.md'], 'v1')
    await write('a.md', 'v2')
    const latest = await git.addAndCommit(root, ['a.md'], 'v2')
    const originalIndexOid = (await git.run(root, ['rev-parse', `${latest.sha}:a.md`])).stdout.trim()
    let externalAdd: git.RunResult | undefined

    const result = await git.dropHeadCommit(root, latest.sha, {
      syncIndexForTesting: vi.fn().mockResolvedValue(false),
      beforeRepairMetadataWriteForTesting: async () => {
        await write('a.md', 'withdraw staged intent')
        externalAdd = await git.run(root, ['add', '--', 'a.md'])
      },
    })

    expect(externalAdd?.status).not.toBe(0)
    expect(result.repairStatePersistenceFailed).toBe(false)
    expect(result.indexRepair).toMatchObject({
      paths: ['a.md'],
      expectedIndex: {
        'a.md': [{ mode: '100644', oid: originalIndexOid, stage: 0 }],
      },
    })
    expect(await git.getIndexRepairStatus(root)).toEqual([
      expect.objectContaining({
        token: result.indexRepair!.token,
        expectedIndex: { 'a.md': [{ mode: '100644', oid: originalIndexOid, stage: 0 }] },
      }),
    ])
    await expect(git.repairIndex(root, result.indexRepair!.token)).resolves.toEqual({ repaired: true })
    expect((await git.status(root)).find((entry) => entry.path === 'a.md')).toMatchObject({
      index: ' ',
      worktree: 'M',
    })
  }, 15_000)

  it('repairs a failed Index synchronization after withdrawing the first version', async () => {
    await write('root.md', 'root')
    const first = await git.addAndCommit(root, ['root.md'], 'root')
    const result = await git.dropHeadCommit(root, first.sha, {
      syncIndexForTesting: vi.fn().mockResolvedValue(false),
    })

    expect(result).toMatchObject({
      sha: '',
      indexRefreshFailed: true,
      indexRepair: expect.objectContaining({ head: null, paths: ['root.md'] }),
    })
    expect((await git.run(root, ['ls-files', '--error-unmatch', 'root.md'])).status).toBe(0)

    await expect(git.repairIndex(root, result.indexRepair!.token)).resolves.toEqual({ repaired: true })
    expect((await git.run(root, ['ls-files', '--error-unmatch', 'root.md'])).status).not.toBe(0)
    expect(await fs.readFile(path.join(root, 'root.md'), 'utf8')).toBe('root')
  }, 15_000)

  it('repairs a withdrawn-root transaction after an unrelated new version is created', async () => {
    await write('root.md', 'root')
    const first = await git.addAndCommit(root, ['root.md'], 'root')
    const dropped = await git.dropHeadCommit(root, first.sha, {
      syncIndexForTesting: vi.fn().mockResolvedValue(false),
    })
    expect(dropped.indexRepair).toMatchObject({ head: null, paths: ['root.md'] })

    await write('unrelated.md', 'new version')
    const unrelated = await git.addAndCommit(root, ['unrelated.md'], 'unrelated')
    expect(await git.getIndexRepairStatus(root)).toEqual([
      expect.objectContaining({ token: dropped.indexRepair!.token, head: null, paths: ['root.md'] }),
    ])

    await expect(git.repairIndex(root, dropped.indexRepair!.token)).resolves.toEqual({ repaired: true })

    expect(await git.getIndexRepairStatus(root)).toEqual([])
    expect((await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(unrelated.sha)
    expect((await git.run(root, ['show', ':unrelated.md'])).stdout).toBe('new version')
    expect((await git.run(root, ['ls-files', '--error-unmatch', 'root.md'])).status).not.toBe(0)
    expect(await fs.readFile(path.join(root, 'root.md'), 'utf8')).toBe('root')
  }, 15_000)

  it('does not report failure after withdrawal when Repair metadata cannot be persisted', async () => {
    await write('a.md', 'v1')
    await git.addAndCommit(root, ['a.md'], 'v1')
    await write('a.md', 'v2')
    const latest = await git.addAndCommit(root, ['a.md'], 'v2')

    const result = await git.dropHeadCommit(root, latest.sha, {
      syncIndexForTesting: vi.fn().mockResolvedValue(false),
      beforeRepairStatePersistenceForTesting: async () => {
        throw new Error('disk full')
      },
    })

    expect(result).toMatchObject({
      droppedSha: latest.sha,
      indexRefreshFailed: true,
      repairStatePersistenceFailed: true,
    })
    expect((await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()).not.toBe(latest.sha)
  }, 15_000)

  it.each(['MERGE_HEAD', 'rebase-merge'])('rejects withdrawal while %s is present', async (marker) => {
    await write('a.md', 'version')
    const latest = await git.addAndCommit(root, ['a.md'], 'version')
    const markerPath = path.join(root, '.git', marker)
    if (marker.includes('-')) await fs.mkdir(markerPath, { recursive: true })
    else await fs.writeFile(markerPath, latest.sha, 'utf8')

    await expect(git.dropHeadCommit(root, latest.sha)).rejects.toThrow(
      'repository operation in progress',
    )
    expect((await git.run(root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(latest.sha)
  }, 15_000)
})

// Regression: a fresh vault in production used to fail its first
// commit with "fatal: Author identity unknown" because `git init`
// doesn't set a committer identity, and the `node` user inside the
// container has no `~/.gitconfig` to fall back to. The existing
// `addAndCommit` tests pre-set the user in beforeEach (setUser()),
// so the unset path was never exercised. `addAndCommit` should
// lazily write a default identity before committing.
describeHistoryIntegration('addAndCommit author identity', () => {
  // Init the repo but do NOT configure user.name / user.email —
  // mirrors what `git init` looks like in a fresh container, and
  // mirrors what a hand-init'd vault looks like.
  beforeEach(async () => {
    await ensureRepo(root)
  })

  // Snapshot the env so we can mutate it for the override test and
  // restore between cases — vitest runs tests in the same process,
  // and env-var leakage would silently break other test files.
  const originalEnv = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k]
    }
    Object.assign(process.env, originalEnv)
  })

  it('writes a default user.name + user.email when none is configured', async () => {
    // Sanity: ensureRepo created the repo, but local identity is not
    // set. (The dev machine's global config is irrelevant — our code
    // scopes the check to --local so it always writes a per-vault
    // identity when one is missing.)
    const nameBefore = await git.run(root, ['config', '--local', '--get', 'user.name'])
    expect(nameBefore.status).not.toBe(0)

    await write('a.md', 'one')
    const r = await git.addAndCommit(root, ['a.md'], 'first')

    // Commit went through.
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/)
    // Local identity was lazily written — defaults to "nuvyn" /
    // "nuvyn@localhost" (or whatever GIT_AUTHOR_* env vars are set
    // to, but here neither is).
    const nameAfter = await git.run(root, ['config', '--local', '--get', 'user.name'])
    const emailAfter = await git.run(root, ['config', '--local', '--get', 'user.email'])
    expect(nameAfter.stdout.trim()).toBe('nuvyn')
    expect(emailAfter.stdout.trim()).toBe('nuvyn@localhost')
    // ... and the commit's author reflects it.
    const log = await git.log(root)
    expect(log[0].author).toBe('nuvyn')
  })

  it('uses GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL env vars when set', async () => {
    process.env.GIT_AUTHOR_NAME = 'Real Name'
    process.env.GIT_AUTHOR_EMAIL = 'real@example.com'

    await write('a.md', 'one')
    await git.addAndCommit(root, ['a.md'], 'first')

    const name = await git.run(root, ['config', '--local', '--get', 'user.name'])
    const email = await git.run(root, ['config', '--local', '--get', 'user.email'])
    expect(name.stdout.trim()).toBe('Real Name')
    expect(email.stdout.trim()).toBe('real@example.com')
  })

  it('does not overwrite an already-configured identity', async () => {
    // Simulate a vault cloned from another machine where the user
    // already set their own LOCAL identity. We write with --local
    // explicitly to match what our code checks.
    await git.run(root, ['config', '--local', 'user.name', 'Existing User'])
    await git.run(root, ['config', '--local', 'user.email', 'existing@example.com'])

    await write('a.md', 'one')
    await git.addAndCommit(root, ['a.md'], 'first')

    // Even with no env var, the existing local identity is preserved.
    const name = await git.run(root, ['config', '--local', '--get', 'user.name'])
    const email = await git.run(root, ['config', '--local', '--get', 'user.email'])
    expect(name.stdout.trim()).toBe('Existing User')
    expect(email.stdout.trim()).toBe('existing@example.com')
  })
})

// Pure-function tests for `parseLog` against synthetic git log output.
// These don't spawn git — they assert the parser handles the format
// the L0 wrapper feeds it, including the multi-line body case where
// `body` itself contains newlines (the field is everything after
// `subject` and can span multiple lines). The naive
// `block.indexOf('\n')` shortcut would treat the first body newline
// as the header / file-list boundary, so `files[]` would absorb the
// rest of the body and `files[0]` would be a body line, not a path.
describe('parseLog (synthetic input)', () => {
  // The format the L0 wrapper produces:
  //   NUL<sha>\x00<parents>\x00<author>\x00<date>\x00<subject>\x00<body>\x00\n<file1>\x00<file2>...
  // The whole stream is NUL-framed; commit messages cannot inject a
  // NUL, and names are emitted by Git with -z.
  function makeBlock(header: string[], body: string, files: string[]): string {
    return `\x00${[...header, body].join('\x00')}\x00\n${files.join('\x00')}\x00`
  }

  it('extracts the full multi-line body and only the file paths in files[]', () => {
    const block = makeBlock(
      [
        'a'.repeat(40),
        '',
        'txx',
        '2026-06-25T09:02:20+08:00',
        'fix(history): auto-pick a file when clicking a commit with none selected',
      ],
      [
        'Clicking a commit row in the timeline was a no-op when no file was',
        'selected: the handler stored the sha on selectedOldRef and returned,',
        'leaving the DiffView stuck on "No file selected". The user sees a',
        'dead timeline with no feedback.',
        '',
        'Prefer a useful default instead: pick the first file in that',
        'commit, falling back to the first dirty file in the working tree.',
        'If neither has anything, show a toast telling the user to open a',
        'file first. The click now always produces a visible diff (or an',
        'explicit error), so the timeline is never silently dead.',
      ].join('\n'),
      ['src/components/vault/HistoryPanel.vue'],
    )
    const records = git.parseLog(block)
    expect(records).toHaveLength(1)
    expect(records[0].body).toContain('Clicking a commit row in the timeline')
    expect(records[0].body).toContain('silently dead.')
    // The files list is ONLY the path, not the body lines that happen
    // to come before the trailing NUL.
    expect(records[0].files).toEqual(['src/components/vault/HistoryPanel.vue'])
  })

  it('still parses correctly when the body is a single line', () => {
    const block = makeBlock(
      ['b'.repeat(40), 'parent-b', 'txx', '2026-06-24T20:13:19+08:00', 'single-line body commit'],
      'Adds a single-file restore action that overwrites a files',
      ['src/components/vault/DiffView.vue'],
    )
    const records = git.parseLog(block)
    expect(records[0].body).toBe('Adds a single-file restore action that overwrites a files')
    expect(records[0].files).toEqual(['src/components/vault/DiffView.vue'])
  })

  it('parses an empty body and a multi-file change set', () => {
    const block = makeBlock(
      ['c'.repeat(40), 'parent-c', 'txx', '2026-06-25T09:00:00+08:00', 'multi-file commit'],
      '',
      ['server/history/git.ts', 'server/history/routes.ts', 'src/style.css'],
    )
    const records = git.parseLog(block)
    expect(records[0].body).toBe('')
    expect(records[0].files).toEqual(['server/history/git.ts', 'server/history/routes.ts', 'src/style.css'])
  })

  it('returns multiple records when the input has more than one NUL-framed block', () => {
    const a = makeBlock(['a'.repeat(40), '', 'txx', '2026-06-25T09:00:00+08:00', 'first'], '', ['a.md'])
    const b = makeBlock(['b'.repeat(40), 'parent-b', 'txx', '2026-06-25T09:01:00+08:00', 'second'], 'body', ['b.md'])
    const text = a + b
    const records = git.parseLog(text)
    expect(records.map((r) => r.subject)).toEqual(['first', 'second'])
    expect(records.map((r) => r.files)).toEqual([['a.md'], ['b.md']])
    expect(records.map((r) => r.parents)).toEqual([[], ['parent-b']])
  })
})

describeHistoryIntegration('rawAt', () => {
  beforeEach(initAndSeed)

  it('returns the file content at HEAD', async () => {
    await write('note.md', 'version 1')
    const r1 = await git.addAndCommit(root, ['note.md'], 'v1')
    await write('note.md', 'version 2')
    const r2 = await git.addAndCommit(root, ['note.md'], 'v2')
    expect(await git.rawAt(root, r1.sha, 'note.md')).toBe('version 1')
    expect(await git.rawAt(root, r2.sha, 'note.md')).toBe('version 2')
    expect(await git.rawAt(root, 'HEAD', 'note.md')).toBe('version 2')
  })

  it('returns null when the file did not exist at the ref', async () => {
    await write('a.md', '1')
    const r1 = await git.addAndCommit(root, ['a.md'], 'seed')
    await write('b.md', '2')
    await git.addAndCommit(root, ['b.md'], 'add b')
    expect(await git.rawAt(root, r1.sha, 'b.md')).toBeNull()
  })

  // The WORKTREE ref is a sentinel meaning "the file as it sits on
  // disk right now", distinct from any committed version. The diff
  // route uses it so users can see their uncommitted edits without
  // having to stage + commit first.
  it('returns the on-disk content for the WORKTREE sentinel', async () => {
    await write('note.md', 'committed version')
    await git.addAndCommit(root, ['note.md'], 'seed')
    // Overwrite on disk WITHOUT committing — the working tree now
    // diverges from HEAD. WORKTREE should reflect the on-disk bytes.
    await write('note.md', 'uncommitted edits')
    expect(await git.rawAt(root, git.WORKTREE_REF, 'note.md')).toBe('uncommitted edits')
    // HEAD still reports the committed version, so the two sides
    // actually differ (which is what makes the worktree-vs-HEAD
    // diff meaningful).
    expect(await git.rawAt(root, 'HEAD', 'note.md')).toBe('committed version')
  })

  it('returns null for WORKTREE when the file does not exist on disk', async () => {
    // No write() — the file doesn't exist in the working tree at all.
    // Same contract as a missing git ref: null, not throw, so the
    // diff endpoint can render the "did not exist" path uniformly.
    expect(await git.rawAt(root, git.WORKTREE_REF, 'ghost.md')).toBeNull()
  })

  // Regression: on a freshly-initialized vault with no commits, the
  // HistoryPanel's default selection is HEAD~1..HEAD. Both refs resolve
  // to "unknown revision / ambiguous argument" — earlier code threw,
  // which surfaced as a 500 on /api/history/diff and broke the panel
  // before the user could even make their first commit. Now both
  // resolve to null and the panel renders an empty diff / preview.
  it('returns null for HEAD~1 on an empty repo (no commits yet)', async () => {
    // initAndSeed has already initialized a repo but made no commits.
    expect(await git.rawAt(root, 'HEAD~1', 'note.md')).toBeNull()
    expect(await git.rawAt(root, 'HEAD', 'note.md')).toBeNull()
  })

  it('returns null for an unknown symbolic ref', async () => {
    // 'main' doesn't exist on this fresh repo (no commits → no branch).
    // Bad symbolic refs should map to null, not throw.
    expect(await git.rawAt(root, 'main', 'note.md')).toBeNull()
    expect(await git.rawAt(root, 'nonexistent-branch', 'note.md')).toBeNull()
  })
})

describeHistoryIntegration('CRLF safety', () => {
  // This is the test that justifies the `core.autocrlf=false` config
  // in initRepo. On a Windows machine with `core.autocrlf=true`, a
  // file written with `\r\n` would have its `\r` stripped in the
  // index, and `git show` would return LF bytes — meaning the diff
  // sees a phantom "\r stripped" change on every commit. With our
  // local config, what's in the index is what's in the working tree.
  beforeEach(initAndSeed)

  it('round-trips CRLF line endings byte-for-byte', async () => {
    const body = 'line one\r\nline two\r\nline three\r\n'
    const abs = path.join(root, 'crlf.md')
    await fs.writeFile(abs, body, 'utf8')
    const r = await git.addAndCommit(root, ['crlf.md'], 'crlf test')
    const read = await git.rawAt(root, r.sha, 'crlf.md')
    expect(read).toBe(body)
  })
})

describeHistoryIntegration('resolveCommit', () => {
  // Restore resolves once, then reads by immutable object id. The L0 layer no
  // longer owns a direct working-tree overwrite primitive.
  beforeEach(initAndSeed)

  it('freezes HEAD to the commit that was current at resolution time', async () => {
    await write('note.md', 'v1 content\n')
    const r1 = await git.addAndCommit(root, ['note.md'], 'v1')
    const resolved = await git.resolveCommit(root, 'HEAD')
    await write('note.md', 'v2 content\n')
    const r2 = await git.addAndCommit(root, ['note.md'], 'v2')

    expect(resolved).toBe(r1.sha)
    expect(resolved).not.toBe(r2.sha)
    expect(await git.rawAt(root, resolved!, 'note.md')).toBe('v1 content\n')
  })

  it('resolves an immutable SHA to itself', async () => {
    await write('note.md', 'stable\n')
    const r = await git.addAndCommit(root, ['note.md'], 'stable')
    expect(await git.resolveCommit(root, r.sha)).toBe(r.sha)
  })

  it('returns null when the ref does not exist', async () => {
    await write('note.md', 'content\n')
    await git.addAndCommit(root, ['note.md'], 'init')
    expect(await git.resolveCommit(root, 'deadbeef'.repeat(5))).toBeNull()
  })
})
