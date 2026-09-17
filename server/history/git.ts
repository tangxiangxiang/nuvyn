// Thin wrapper over the `git` CLI for the history feature.
//
// Design choices:
//   - exec via child_process.spawn (no shell) with the repo root as cwd.
//     Promisified in `run()` below so call sites look synchronous.
//   - All inputs are vetted at the API layer (paths, messages); this
//     module is the boundary that calls into git. It does NOT validate
//     paths — that is `assertSafePath` from ../paths.js, applied by
//     callers. Treat `repoRoot` as trusted.
//   - The wrapper never throws on a non-zero exit. It returns
//     `{stdout, stderr, status, code}` so callers can interpret the
//     failure (e.g. "not a git repository") without an exception
//     bubbling through a try/catch. The two exceptions: `spawn` itself
//     failing (ENOENT for git not on PATH) — that is a real configuration
//     problem, not a git error, and surfaces as a typed error.
//
// Why the CLI and not a library like simple-git: Nuvyn's history tool
// only needs log/status/show/diff/init — five commands. A lib would
// add a dependency for behavior we can describe in ~20 lines each, and
// would not improve testability (we still have to fake a real repo
// for end-to-end coverage anyway).

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { readSafeRelativeFile } from '../paths.js'
import { isManagedDiaryPath } from '../../shared/diaryProtocol.js'
import {
  NUVYN_HISTORY_INDEX_DIRECTORY,
  NUVYN_VAULT_DIRECTORY,
  NUVYN_VAULT_TRAILER_PREFIX,
  NUVYN_VERSION_TRAILER,
  NUVYN_VAULT_VERSION_TRAILER,
} from '../technicalNamespace.js'

const DEFAULT_GIT_TIMEOUT_MS = 15_000
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024

export type RunResult = {
  status: number
  stdout: string
  stderr: string
}

/**
 * Sentinel ref meaning "the file as it currently sits on disk,
 * unsaved/uncommitted". Used by the diff route so users can see
 * their pending edits vs the last committed version without having
 * to stage and commit first. NOT a valid ref for `git checkout` —
 * the restore route catches that and returns a 4xx.
 */
export const WORKTREE_REF = 'WORKTREE'

const NUVYN_VAULT_ID_VERSION = 1
const NUVYN_VAULT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class HistoryResourceLimitError extends Error {
  readonly code = 'HISTORY_RESOURCE_LIMIT'

  constructor(message: string) {
    super(message)
    this.name = 'HistoryResourceLimitError'
  }
}

/**
 * Mutation-owner rejection for encrypted managed Diary history.  Routes keep
 * their user-facing 422 guard, but the Git owner must enforce the same rule
 * before it creates a temporary index or invokes any Git plumbing command.
 */
export class ManagedDiaryHistoryUnsupportedError extends Error {
  readonly code = 'diary-history-encrypted-unsupported'

  constructor(path: string) {
    super(`managed Diary History is unsupported: ${path}`)
    this.name = 'ManagedDiaryHistoryUnsupportedError'
  }
}

function isManagedDiaryHistoryPath(filePath: string): boolean {
  return isManagedDiaryPath(filePath.replace(/\.md$/, ''))
}

function vaultIdPath(repoRoot: string): string {
  return path.join(repoRoot, NUVYN_VAULT_DIRECTORY, 'vault-id')
}

function parseVaultId(raw: string, filePath: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`invalid Nuvyn Vault ID: ${filePath}`)
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || (parsed as any).version !== NUVYN_VAULT_ID_VERSION
    || typeof (parsed as any).id !== 'string'
    || !NUVYN_VAULT_ID_RE.test((parsed as any).id)
    || Object.keys(parsed).some((key) => !['version', 'id'].includes(key))
  ) {
    throw new Error(`invalid Nuvyn Vault ID: ${filePath}`)
  }
  return (parsed as any).id.toLowerCase()
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Directory fsync is not portable (notably on Windows). The file itself
    // is already fsynced; platforms that support directory handles get the
    // stronger durability guarantee.
  }
}

async function readVaultIdFile(filePath: string): Promise<string> {
  const before = await fs.lstat(filePath)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`invalid Vault ID: ${filePath}`)
  }
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const handle = await fs.open(filePath, fs.constants.O_RDONLY | noFollow)
  try {
    const raw = await handle.readFile('utf8')
    const afterHandle = await handle.stat()
    const afterPath = await fs.lstat(filePath)
    if (
      afterPath.isSymbolicLink()
      || afterHandle.dev !== before.dev
      || afterHandle.ino !== before.ino
      || afterPath.dev !== before.dev
      || afterPath.ino !== before.ino
    ) throw new Error(`Nuvyn Vault ID changed while reading: ${filePath}`)
    return parseVaultId(raw, filePath)
  } finally {
    await handle.close()
  }
}

export async function ensureNuvynVaultId(repoRoot: string): Promise<string> {
  const filePath = vaultIdPath(repoRoot)
  const directory = path.dirname(filePath)
  try {
    const directoryStat = await fs.lstat(directory)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`invalid Nuvyn Vault ID directory: ${directory}`)
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  await fs.mkdir(directory, { recursive: true })
  let currentId: string | null = null
  try { currentId = await readVaultIdFile(filePath) } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (currentId) return currentId

  const id = randomUUID()
  const handle = await fs.open(filePath, 'wx').catch(async (error: any) => {
    if (error?.code !== 'EEXIST') throw error
    return null
  })
  if (handle) {
    try {
      await handle.writeFile(`${JSON.stringify({ version: NUVYN_VAULT_ID_VERSION, id })}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(directory)
    return id
  }
  return readVaultIdFile(filePath)
}

async function nuvynCommitMessage(repoRoot: string, message: string): Promise<string> {
  if (/^Nuvyn-(?:Version|Vault|Vault-Version):/im.test(message)) {
    throw new Error('commit message uses reserved Nuvyn history trailers')
  }
  return `${message.trim()}\n\n${NUVYN_VERSION_TRAILER}\n${NUVYN_VAULT_TRAILER_PREFIX} ${await ensureNuvynVaultId(repoRoot)}\n${NUVYN_VAULT_VERSION_TRAILER}`
}

/**
 * Error thrown when `git` itself cannot be spawned (binary missing).
 * Distinct from a non-zero exit (a legitimate git error) — the API
 * layer surfaces this as 503 / "git unavailable", not as 500.
 */
export class GitUnavailableError extends Error {
  constructor(cause: unknown) {
    super('git binary not available on PATH')
    this.name = 'GitUnavailableError'
    this.cause = cause
  }
}

export class GitOperationAbortedError extends Error {
  constructor() {
    super('git operation aborted')
    this.name = 'GitOperationAbortedError'
  }
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE_BYTES) return current
  const remaining = MAX_CAPTURE_BYTES - current.length
  return current + chunk.slice(0, remaining)
}

/**
 * Run a git subcommand. Resolves with the captured output; rejects
 * only on spawn failure (no shell escaping concerns, args are passed
 * verbatim).
 */
export function run(
  repoRoot: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Buffer | string; signal?: AbortSignal } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GitOperationAbortedError())
      return
    }
    const child = spawn('git', args, {
      cwd: repoRoot,
      windowsHide: true,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let capped = false
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(new GitOperationAbortedError())
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, DEFAULT_GIT_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => {
      const next = appendCapped(stdout, c)
      capped ||= next.length < stdout.length + c.length
      stdout = next
      if (capped) child.kill('SIGKILL')
    })
    child.stderr.on('data', (c) => {
      const next = appendCapped(stderr, c)
      capped ||= next.length < stderr.length + c.length
      stderr = next
      if (capped) child.kill('SIGKILL')
    })
    child.stdin.end(options.input)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      reject(new GitUnavailableError(err))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      const suffix = timedOut
        ? `git command timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
        : capped
          ? `git output exceeded ${MAX_CAPTURE_BYTES} bytes`
          : ''
      resolve({
        status: timedOut || capped ? -1 : (code ?? -1),
        stdout,
        stderr: suffix ? [stderr.trim(), suffix].filter(Boolean).join('\n') : stderr,
      })
    })
  })
}

/**
 * Is `repoRoot` inside a git working tree? Returns false if the
 * directory has no `.git` (e.g. a brand-new vault, or someone deleted
 * `.git` by accident). Cheap call: `git rev-parse --is-inside-work-tree`.
 */
export async function isRepo(repoRoot: string): Promise<boolean> {
  const r = await run(repoRoot, ['rev-parse', '--is-inside-work-tree'])
  return r.status === 0 && r.stdout.trim() === 'true'
}

/**
 * Initialize a brand-new repo at `repoRoot` and configure
 * `core.autocrlf=false` locally so the diff output is stable across
 * platforms. Does NOT touch .gitignore / .gitattributes — that's the
 * caller's job (initRepo) so this function stays a pure git op.
 */
export async function initRepo(repoRoot: string): Promise<void> {
  // `--initial-branch=main` to avoid the "hint: Using 'master' as the
  // name for the initial branch" warning on Windows. Fall back to
  // the older flag if the installed git doesn't recognize it.
  let r = await run(repoRoot, ['init', '--initial-branch=main'])
  if (r.status !== 0) r = await run(repoRoot, ['init', '--initial-branch=master'])
  if (r.status !== 0) r = await run(repoRoot, ['init']) // ancient git
  if (r.status !== 0) {
    throw new Error(`git init failed: ${r.stderr.trim()}`)
  }
  // Disable autocrlf so the bytes we read back from `git show` match
  // the bytes we wrote. Without this, Windows machines with
  // core.autocrlf=true mangle line endings in the index.
  const cfg = await run(repoRoot, ['config', 'core.autocrlf', 'false'])
  if (cfg.status !== 0) {
    throw new Error(`git config core.autocrlf failed: ${cfg.stderr.trim()}`)
  }
}

// --- Status ----------------------------------------------------------------

/**
 * One dirty (or staged) file as `git status --porcelain` reports it.
 * `index` is the staged-letter (or ' ' for unstaged), `worktree` is
 * the worktree-letter. For untracked files the convention is "??" in
 * `index` and "?" in `worktree`. The combined two-char XY string is
 * what porcelain emits.
 */
export type StatusEntry = {
  path: string // forward-slash, relative to repo root
  index: string // ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | '?'
  worktree: string // ' ' | 'M' | 'A' | 'D' | '?' | '!'
}

const XY_RE = /^([ MADRCU?!])([ MADRCU?!]) (.+)$/

/**
 * Parse `git status --porcelain` output. Lines that don't match the
 * canonical XY-path format are dropped silently — future git versions
 * could add new codes; we'd rather return fewer entries than throw.
 */
export function parsePorcelain(text: string): StatusEntry[] {
  const out: StatusEntry[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const m = XY_RE.exec(line)
    if (!m) continue
    // Porcelain v1 uses quoted paths with C-style escapes for non-ASCII.
    // We only consume ASCII file names from the vault, so the unquote
    // is a no-op for our inputs but is here as a guard.
    const raw = m[3]
    const path = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\([\\"])/g, '$1') : raw
    out.push({ index: m[1], worktree: m[2], path })
  }
  return out
}

export async function status(repoRoot: string): Promise<StatusEntry[]> {
  // `-uall` enumerates each file inside untracked directories. The
  // default (`normal`) collapses a wholly-untracked dir like
  // `inbox/` into a single `?? inbox/` line, which would surface in
  // the History panel as one row representing the directory — useless
  // for selection, diff, or "Commit N files" counting. `-uall` still
  // honours `.gitignore` (files matching an ignore pattern remain
  // hidden); the trade-off is just longer output on a fresh vault.
  const r = await run(repoRoot, ['status', '--porcelain', '--untracked-files=all'])
  if (r.status !== 0) {
    throw new Error(`git status failed: ${r.stderr.trim()}`)
  }
  return parsePorcelain(r.stdout)
}

// --- Log -------------------------------------------------------------------

export type CommitRecord = {
  sha: string
  /** First-parent history semantics are used by the comparison UI. */
  parents: string[]
  author: string
  /** ISO-8601, local repo time (committer date). */
  date: string
  subject: string
  body: string
  /** Paths touched by this commit, in `git show --name-only` order. */
  files: string[]
}

const LOG_FORMAT = [
  '%x00%H', // NUL-framed record start + sha
  '%P', // parent commit SHAs, space-separated
  '%an', // author name
  '%aI', // author date, strict ISO
  '%s', // subject (first line)
  '%b', // body (everything after subject)
].join('%x00') + '%x00' // trailing NUL terminates the last field

/**
 * Read commit history, newest-first. If `path` is given, only commits
 * touching that path are returned (`--follow` makes git track renames).
 * Caps at `limit` entries (default 200 — vault histories stay small,
 * UI can paginate later if it ever matters).
 */
export async function log(
  repoRoot: string,
  opts: { path?: string; limit?: number } = {},
): Promise<CommitRecord[]> {
  const limit = opts.limit ?? 200
  const args = [
    'log',
    `--pretty=format:${LOG_FORMAT}`,
    '--name-only',
    '-z',
    `-n${limit}`,
  ]
  if (opts.path) {
    // No `--follow` for now: on a vanilla "create new file" commit,
    // `--follow` falsely attributes earlier commits of unrelated files
    // to this path. Nuvyn notes are rarely renamed; if/when a user
    // actually renames a note and wants the history merged, we can
    // add a follow=true opt. Keep the args list flat — `--` separates
    // rev args from path args so a path that starts with `-` is safe.
    args.push('--', opts.path)
  }
  const r = await run(repoRoot, args)
  if (r.status !== 0) {
    // "your current branch 'main' does not have any commits yet" is
    // a normal, expected state for a freshly-initialized vault — the
    // repo exists, the user just hasn't committed anything. Treat it
    // as an empty log rather than a server fault; the route returns
    // `{ commits: [] }` with 200, and the History panel shows
    // "No commits yet." The wording varies across git versions
    // (older git said "ambiguous argument 'HEAD'", git 2.3+ says
    // "does not have any commits yet") so we match on a substring
    // that both share.
    if (/does not have any commits yet/i.test(r.stderr)
        || /ambiguous argument ['"]?HEAD['"]?/i.test(r.stderr)) {
      return []
    }
    throw new Error(`git log failed: ${r.stderr.trim()}`)
  }
  return parseLog(r.stdout)
}

export function parseLog(text: string): CommitRecord[] {
  if (!text) return []
  const tokens = text.split('\x00')
  const starts: number[] = []
  const shaRe = /^[0-9a-f]{40,64}$/i
  const isoRe = /^\d{4}-\d{2}-\d{2}T/
  for (let index = 1; index + 5 < tokens.length; index += 1) {
    if (
      shaRe.test(tokens[index] ?? '')
      && tokens[index - 1] === ''
      && isoRe.test(tokens[index + 3] ?? '')
    ) starts.push(index)
  }

  return starts.flatMap((start, position) => {
    const nextStart = starts[position + 1] ?? tokens.length
    const sha = tokens[start]!
    const parentField = tokens[start + 1] ?? ''
    const author = tokens[start + 2] ?? ''
    const date = tokens[start + 3] ?? ''
    const subject = tokens[start + 4] ?? ''
    const body = tokens[start + 5] ?? ''
    const files = tokens
      .slice(start + 6, nextStart)
      .map((value) => value.trim())
      .filter(Boolean)
    return [{
      sha,
      parents: parentField ? parentField.split(' ').filter(Boolean) : [],
      author,
      date,
      subject,
      body,
      files,
    }]
  })
}

// --- Show / raw content at a ref ------------------------------------------

/**
 * Read the raw content of `path` as it exists at `ref` (a commit sha,
 * branch name, etc.). Returns null if the file does not exist at that
 * ref (e.g. it was added later or deleted earlier). Throws on a
 * genuine git error.
 *
 * The flag combo `--text` + `-z` + `<sha>:<path>` is a code-path with
 * very few failure modes. The exit status is the only reliable signal
 * for "file does not exist at this ref" (git prints the error and
 * exits 128).
 */
export async function rawAt(
  repoRoot: string,
  ref: string,
  filePath: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  // "WORKTREE" is a sentinel meaning "the file as it sits on disk
  // right now, before staging or committing". It's not a real git
  // ref — we read the file from the working tree directly. Used by
  // the diff route so the user can see their uncommitted edits
  // without having to stage + commit first.
  if (ref === WORKTREE_REF) {
    try {
      return await readSafeRelativeFile(repoRoot, filePath, 'utf8', {
        maxBytes: options.maxBytes,
        signal: options.signal,
      }) as string | null
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null
      throw e
    }
  }
  if (options.maxBytes !== undefined) {
    const size = await run(repoRoot, ['cat-file', '-s', `${ref}:${filePath}`], { signal: options.signal })
    if (size.status === 0) {
      const bytes = Number(size.stdout.trim())
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error(`git cat-file returned an invalid size for ${filePath}`)
      }
      if (bytes > options.maxBytes) {
        throw new HistoryResourceLimitError(
          `history file exceeds the ${options.maxBytes}-byte AI diff limit: ${filePath}`,
        )
      }
    }
  }
  const r = await run(repoRoot, ['show', `${ref}:${filePath}`], { signal: options.signal })
  if (r.status === 0) return r.stdout
  // Six error patterns all mean "no such (ref, path) tuple" — or in the
  // empty-repo case, "no such ref at all". We treat all of them as null
  // rather than throwing because the caller — the diff route — wants
  // to render "this file did not exist in the old version" gracefully,
  // AND the HistoryPanel wants the first commit on a fresh vault to
  // land cleanly (a 500 on HEAD~1/HEAD would crash the panel before
  // the user even has anything to commit).
  if (
    /does not exist/i.test(r.stderr) ||
    /bad revision/i.test(r.stderr) ||
    /exists on disk, but not in/i.test(r.stderr) ||
    /not in /i.test(r.stderr) ||
    // Empty repo / bad symbolic ref. We cover the three shapes git
    // actually emits so the empty-vault flow doesn't 500:
    //   - "fatal: invalid object name 'HEAD~1'"  (no commits → HEAD~1)
    //   - "fatal: ambiguous argument 'HEAD'..." (depends on git version)
    //   - "fatal: unknown revision or path not in the working tree"
    // None of these are bugs the caller can do anything about, so
    // collapsing them all to null keeps the diff route happy on the
    // very first commit attempt.
    /invalid object name/i.test(r.stderr) ||
    /ambiguous argument/i.test(r.stderr) ||
    /unknown revision/i.test(r.stderr)
  ) {
    return null
  }
  throw new Error(`git show failed: ${r.stderr.trim()}`)
}

/** Resolve a caller-supplied History ref once to an immutable commit SHA. */
export async function resolveCommit(repoRoot: string, ref: string): Promise<string | null> {
  const result = await run(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (result.status !== 0) return null
  const sha = result.stdout.trim()
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null
}

// --- Commit ----------------------------------------------------------------

/**
 * Make sure the vault repo has a `user.name` + `user.email` configured
 * before the first commit. A bare `git init` (which is what
 * `initRepo` does) does NOT set a committer identity — git only
 * complains when you actually try to commit, so the failure surfaces
 * late and far from the cause.
 *
 * We use local config (the default scope of `git config`, no
 * `--global`) so:
 *   - the identity is per-vault, not per-user — a single `node`
 *     container user can host multiple vaults with different
 *     identities.
 *   - we don't touch `~/.gitconfig` inside the container, which
 *     would be lost on every redeploy anyway.
 *   - the local config wins over any global config (git precedence:
 *     local > global > system), so the env-var override actually
 *     applies even on dev machines that have a global identity set.
 *
 * Identity source, in priority order:
 *   1. Whatever is already in the repo's LOCAL config (preserved —
 *      a vault cloned from another machine keeps its real author).
 *   2. GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL env vars (so operators can
 *      pick a per-host identity without rebuilding the image).
 *   3. "nuvyn" / "nuvyn@localhost" as a last-resort default.
 *
 * `git config --local --get` exits non-zero on a missing key — that's
 * the "is local config set?" check. We intentionally do NOT use
 * `--get` (effective) for the check, because a global identity set
 * on the host would mask the env-var override path on dev machines.
 */
async function ensureAuthorIdentity(repoRoot: string): Promise<void> {
  const name = process.env.GIT_AUTHOR_NAME?.trim() || 'nuvyn'
  const email = process.env.GIT_AUTHOR_EMAIL?.trim() || 'nuvyn@localhost'

  const haveName = (await run(repoRoot, ['config', '--local', '--get', 'user.name'])).status === 0
  if (!haveName) {
    const r = await run(repoRoot, ['config', '--local', 'user.name', name])
    if (r.status !== 0) {
      throw new Error(`git config user.name failed: ${r.stderr.trim()}`)
    }
  }
  const haveEmail = (await run(repoRoot, ['config', '--local', '--get', 'user.email'])).status === 0
  if (!haveEmail) {
    const r = await run(repoRoot, ['config', '--local', 'user.email', email])
    if (r.status !== 0) {
      throw new Error(`git config user.email failed: ${r.stderr.trim()}`)
    }
  }
}

export type CommitResult = {
  sha: string
  filesCommitted: string[]
  indexRefreshFailed?: boolean
  indexRepair?: IndexRepairTransaction
  repairStatePersistenceFailed?: boolean
}

export type DropCommitResult = {
  sha: string
  droppedSha: string
  filesChanged: string[]
  indexRefreshFailed: boolean
  indexRepair?: IndexRepairTransaction
  repairStatePersistenceFailed: boolean
}

export type IndexEntryFingerprint = {
  mode: string
  oid: string
  stage: number
}

export type IndexRepairTransaction = {
  token: string
  status: 'pending' | 'superseded'
  head: string | null
  paths: string[]
  expectedIndex: Record<string, IndexEntryFingerprint[]>
}

export type IndexSyncResult = {
  synchronized: boolean
  replacementApplied: boolean
  finalHead: string | null
  replacementExpectedIndex?: Record<string, IndexEntryFingerprint[]>
}

type IndexRepairFile = {
  version: 2
  transactions: IndexRepairTransaction[]
}

type PreviousIndexRepairFile = {
  version: 1
  transactions: Array<Omit<IndexRepairTransaction, 'status'> & {
    status?: IndexRepairTransaction['status']
    expectedIndexHash?: string | null
  }>
}

export type ExpectedContentHashes = Record<string, string | null>

const repoMutationTails = new Map<string, Promise<void>>()

async function withRepoMutation<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot)
  const previous = repoMutationTails.get(key) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(operation)
  const tail = result.then(() => {}, () => {})
  repoMutationTails.set(key, tail)
  try {
    return await result
  } finally {
    if (repoMutationTails.get(key) === tail) repoMutationTails.delete(key)
  }
}

const REPOSITORY_OPERATION_MARKERS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
]

async function repositoryOperationInProgress(repoRoot: string): Promise<boolean> {
  const gitDirResult = await run(repoRoot, ['rev-parse', '--absolute-git-dir'])
  if (gitDirResult.status !== 0) {
    throw new Error(`git rev-parse git-dir failed: ${gitDirResult.stderr.trim()}`)
  }
  const gitDir = gitDirResult.stdout.trim()
  for (const marker of REPOSITORY_OPERATION_MARKERS) {
    try {
      await fs.stat(path.join(gitDir, marker))
      return true
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return false
}

async function assertRepositoryIdle(repoRoot: string): Promise<void> {
  if (await repositoryOperationInProgress(repoRoot)) {
    throw new Error('repository operation in progress')
  }
}

async function readCurrentHead(repoRoot: string): Promise<string | null> {
  const head = await run(repoRoot, ['rev-parse', '--verify', 'HEAD'])
  return head.status === 0 ? head.stdout.trim() : null
}

/** Read the current branch tip as an immutable parent proof for a caller. */
export async function currentHead(repoRoot: string): Promise<string | null> {
  return readCurrentHead(repoRoot)
}

/**
 * Return whether an immutable commit is reachable from the vault history tip.
 * Merely finding the object with `cat-file` is not enough: commit-tree creates
 * the object before update-ref publishes it, and an unpublished object must
 * remain distinguishable from a durable history revision during recovery.
 */
export async function isCommitReachable(repoRoot: string, commitSha: string): Promise<boolean> {
  const head = await readCurrentHead(repoRoot)
  if (!head) return false
  const result = await run(repoRoot, ['merge-base', '--is-ancestor', commitSha, head])
  if (result.status === 0) return true
  // `merge-base --is-ancestor` uses status 1 for a valid, unrelated commit.
  // Any other status means Git could not prove reachability and must not be
  // collapsed into the safe "not published" branch during reconciliation.
  if (result.status === 1) return false
  throw new Error(`git reachability proof failed: ${result.stderr.trim() || result.stdout.trim()}`)
}

async function absoluteGitDir(repoRoot: string): Promise<string> {
  const result = await run(repoRoot, ['rev-parse', '--absolute-git-dir'])
  if (result.status !== 0) {
    throw new Error(`git rev-parse git-dir failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

async function repairFilePath(repoRoot: string): Promise<string> {
  return path.join(await absoluteGitDir(repoRoot), NUVYN_HISTORY_INDEX_DIRECTORY, 'index-repair.json')
}

function validRepairTransaction(transaction: any): boolean {
  return (
    transaction
    && typeof transaction.token === 'string'
    && /^[0-9a-f]{32}$/.test(transaction.token)
    && (transaction.head === null || /^[0-9a-f]{40,64}$/.test(transaction.head))
    && Array.isArray(transaction.paths)
    && transaction.paths.length > 0
    && transaction.paths.every((filePath: string) => (
      typeof filePath === 'string'
      && !path.isAbsolute(filePath)
      && !filePath.split('/').includes('..')
      && filePath.endsWith('.md')
    ))
    && transaction.expectedIndex
    && typeof transaction.expectedIndex === 'object'
    && transaction.paths.every((filePath: string) => {
      const entries = transaction.expectedIndex[filePath]
      return Array.isArray(entries) && entries.every((entry) => (
        entry
        && /^\d{6}$/.test(entry.mode)
        && /^[0-9a-f]{40,64}$/.test(entry.oid)
        && Number.isInteger(entry.stage)
        && entry.stage >= 0
        && entry.stage <= 3
      ))
    })
  )
}

function validRepairFile(value: unknown): value is IndexRepairFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<IndexRepairFile>
  return file.version === 2
    && Array.isArray(file.transactions)
    && file.transactions.every((transaction) => (
      validRepairTransaction(transaction)
      && (transaction.status === 'pending' || transaction.status === 'superseded')
    ))
}

function validPreviousRepairFile(value: unknown): value is PreviousIndexRepairFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<PreviousIndexRepairFile>
  return file.version === 1
    && Array.isArray(file.transactions)
    && file.transactions.every((transaction) => (
      validRepairTransaction(transaction)
      && (transaction.status === undefined
        || transaction.status === 'pending'
        || transaction.status === 'superseded')
    ))
}

async function readIndexRepairFile(repoRoot: string): Promise<IndexRepairFile> {
  const filePath = await repairFilePath(repoRoot)
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
    return { version: 2, transactions: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (validRepairFile(parsed)) return parsed
  if (validPreviousRepairFile(parsed)) {
    const migrated: IndexRepairFile = {
      version: 2,
      transactions: parsed.transactions.map(({ expectedIndexHash: _ignored, ...transaction }) => ({
        ...transaction,
        status: transaction.status ?? 'pending',
      })),
    }
    // Migration write failures surface to the caller and leave the legal v1
    // file in place. They must never be mistaken for corrupt data.
    await writeIndexRepairFile(repoRoot, migrated)
    return migrated
  }

  const quarantined = `${filePath}.corrupt-${Date.now()}-${randomUUID()}.json`
  await fs.rename(filePath, quarantined)
  return { version: 2, transactions: [] }
}

async function ensureIndexRepairStorageReady(repoRoot: string): Promise<void> {
  await readIndexRepairFile(repoRoot)
  const filePath = await repairFilePath(repoRoot)
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const probe = path.join(directory, `.write-test-${process.pid}-${randomUUID()}`)
  try {
    const handle = await fs.open(probe, 'wx')
    try {
      await handle.writeFile('ready')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } finally {
    await fs.rm(probe, { force: true })
  }
}

async function writeIndexRepairFile(repoRoot: string, state: IndexRepairFile): Promise<void> {
  const filePath = await repairFilePath(repoRoot)
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  if (state.transactions.length === 0) {
    await fs.rm(filePath, { force: true })
    return
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, filePath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function indexFingerprint(
  repoRoot: string,
  filePath: string,
  env?: NodeJS.ProcessEnv,
): Promise<IndexEntryFingerprint[]> {
  const result = await run(repoRoot, ['ls-files', '--stage', '--', filePath], { env })
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`)
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t/.exec(line)
    if (!match) throw new Error(`invalid index entry for ${filePath}`)
    return { mode: match[1], oid: match[2], stage: Number(match[3]) }
  })
}

async function captureIndexFingerprints(
  repoRoot: string,
  paths: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<Record<string, IndexEntryFingerprint[]>> {
  return Object.fromEntries(await Promise.all(paths.map(async (filePath) => (
    [filePath, await indexFingerprint(repoRoot, filePath, env)] as const
  ))))
}

function sameIndexEntries(
  left: readonly IndexEntryFingerprint[],
  right: readonly IndexEntryFingerprint[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function settleIndexRepairPaths(
  repoRoot: string,
  paths: readonly string[],
): Promise<void> {
  const settled = new Set(paths)
  const state = await readIndexRepairFile(repoRoot)
  const transactions = state.transactions.map((transaction) => {
    const remaining = transaction.paths.filter((filePath) => !settled.has(filePath))
    return {
      ...transaction,
      paths: remaining,
      expectedIndex: Object.fromEntries(remaining.map((filePath) => (
        [filePath, transaction.expectedIndex[filePath] ?? []]
      ))),
    }
  }).filter((transaction) => transaction.paths.length > 0)
  await writeIndexRepairFile(repoRoot, { version: 2, transactions })
}

async function recordIndexRepair(
  repoRoot: string,
  head: string | null,
  paths: readonly string[],
  expectedIndex: Record<string, IndexEntryFingerprint[]>,
  options: { beforeMetadataWriteForTesting?: () => Promise<void> } = {},
): Promise<IndexRepairTransaction> {
  const gitDir = await absoluteGitDir(repoRoot)
  const lockPath = path.join(gitDir, 'index.lock')
  let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    lockHandle = await fs.open(lockPath, 'wx')
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new Error('git index is locked')
    throw error
  }
  try {
    // The expected state is captured before the commit/withdraw operation.
    // Re-capturing here would trust a staged change that arrived after the
    // synchronization check and could later authorize clearing it.
    for (const filePath of paths) {
      if (!sameIndexEntries(
        await indexFingerprint(repoRoot, filePath),
        expectedIndex[filePath] ?? [],
      )) {
        throw new Error(`index changed before repair metadata was persisted: ${filePath}`)
      }
    }
    const state = await readIndexRepairFile(repoRoot)
    const replaced = new Set(paths)
    const retained = state.transactions.map((transaction) => {
      const remaining = transaction.paths.filter((filePath) => !replaced.has(filePath))
      return {
        ...transaction,
        paths: remaining,
        expectedIndex: Object.fromEntries(remaining.map((filePath) => (
          [filePath, transaction.expectedIndex[filePath] ?? []]
        ))),
      }
    }).filter((transaction) => transaction.paths.length > 0)
    const transaction: IndexRepairTransaction = {
      token: randomUUID().replaceAll('-', ''),
      status: 'pending',
      head,
      paths: [...paths],
      expectedIndex: Object.fromEntries(paths.map((filePath) => (
        [filePath, expectedIndex[filePath] ?? []]
      ))),
    }
    await options.beforeMetadataWriteForTesting?.()
    await writeIndexRepairFile(repoRoot, {
      version: 2,
      transactions: [...retained, transaction],
    })
    return transaction
  } finally {
    await lockHandle?.close().catch(() => {})
    await fs.rm(lockPath, { force: true })
  }
}

export async function getIndexRepairStatus(repoRoot: string): Promise<IndexRepairTransaction[]> {
  return withRepoMutation(repoRoot, async () => (
    (await readIndexRepairFile(repoRoot)).transactions
  ))
}

async function repairIndexWithLock(
  repoRoot: string,
  transaction: IndexRepairTransaction,
  currentHead: string | null,
  options: {
    afterIndexLockForTesting?: () => Promise<void>
    beforeIndexReplaceForTesting?: () => Promise<void>
  } = {},
): Promise<{
  repaired: boolean
  finalHead?: string | null
  replacementApplied: boolean
  replacementExpectedIndex?: Record<string, IndexEntryFingerprint[]>
}> {
  const gitDir = await absoluteGitDir(repoRoot)
  const indexPath = path.join(gitDir, 'index')
  const lockPath = path.join(gitDir, 'index.lock')
  let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    lockHandle = await fs.open(lockPath, 'wx')
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new Error('git index is locked')
    throw error
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-index-repair-'))
  const tempIndex = path.join(tempDir, 'index')
  const indexEnv = { GIT_INDEX_FILE: tempIndex }
  let committedLock = false
  try {
    let originalBytes: Buffer | null
    try {
      originalBytes = await fs.readFile(indexPath)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      originalBytes = null
    }
    for (const filePath of transaction.paths) {
      if (!sameIndexEntries(
        await indexFingerprint(repoRoot, filePath),
        transaction.expectedIndex[filePath] ?? [],
      )) throw new Error(`index changed after repair was requested: ${filePath}`)
    }

    // Standard Git writers observe index.lock, so an external `git add`
    // cannot enter after this validation and before the atomic replacement.
    await options.afterIndexLockForTesting?.()

    if (originalBytes === null) {
      const empty = await run(repoRoot, ['read-tree', '--empty'], { env: indexEnv })
      if (empty.status !== 0) throw new Error(`git read-tree failed: ${empty.stderr.trim()}`)
    } else {
      await fs.writeFile(tempIndex, originalBytes)
    }
    const reset = currentHead === null
      ? await run(repoRoot, ['update-index', '--force-remove', '--', ...transaction.paths], { env: indexEnv })
      : await run(repoRoot, ['reset', '-q', currentHead, '--', ...transaction.paths], { env: indexEnv })
    if (reset.status !== 0 || await repositoryOperationInProgress(repoRoot)) {
      return { repaired: false, replacementApplied: false }
    }
    const afterHead = await readCurrentHead(repoRoot)
    const verified = currentHead === null
      ? Object.values(
          await captureIndexFingerprints(repoRoot, transaction.paths, indexEnv),
        ).every((entries) => entries.length === 0)
      : (await run(
          repoRoot,
          ['diff', '--cached', '--quiet', currentHead, '--', ...transaction.paths],
          { env: indexEnv },
        )).status === 0
    if (afterHead !== currentHead || !verified) {
      return { repaired: false, replacementApplied: false }
    }
    for (const filePath of transaction.paths) {
      if (!sameIndexEntries(
        await indexFingerprint(repoRoot, filePath),
        transaction.expectedIndex[filePath] ?? [],
      )) throw new Error(`index changed after repair was requested: ${filePath}`)
    }

    const repairedBytes = await fs.readFile(tempIndex)
    const replacementExpectedIndex = await captureIndexFingerprints(
      repoRoot,
      transaction.paths,
      indexEnv,
    )
    await lockHandle.truncate(0)
    await lockHandle.writeFile(repairedBytes)
    await lockHandle.sync()
    await lockHandle.close()
    lockHandle = undefined
    await options.beforeIndexReplaceForTesting?.()
    await fs.rename(lockPath, indexPath)
    committedLock = true
    const finalHead = await readCurrentHead(repoRoot)
    if (finalHead !== currentHead) {
      return {
        repaired: false,
        finalHead,
        replacementApplied: true,
        replacementExpectedIndex,
      }
    }
    return {
      repaired: true,
      finalHead: currentHead,
      replacementApplied: true,
      replacementExpectedIndex,
    }
  } finally {
    await lockHandle?.close().catch(() => {})
    if (!committedLock) await fs.rm(lockPath, { force: true })
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

async function syncIndexPaths(
  repoRoot: string,
  paths: readonly string[],
  fixedHead?: string,
  options: {
    syncIndexForTesting?: (commitSha: string) => Promise<IndexSyncResult | RunResult>
    beforeIndexResetForTesting?: (commitSha: string, attempt: number) => Promise<void>
    afterIndexLockForTesting?: () => Promise<void>
    beforeIndexReplaceForTesting?: () => Promise<void>
    preservePaths?: readonly string[]
    expectedIndex?: Record<string, IndexEntryFingerprint[]>
  } = {},
): Promise<IndexSyncResult> {
  let last: IndexSyncResult = {
    synchronized: false,
    replacementApplied: false,
    finalHead: await readCurrentHead(repoRoot),
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await repositoryOperationInProgress(repoRoot)) {
      return { ...last, finalHead: await readCurrentHead(repoRoot) }
    }
    const before = await run(repoRoot, ['rev-parse', '--verify', 'HEAD'])
    if (before.status !== 0) {
      return { ...last, finalHead: await readCurrentHead(repoRoot) }
    }
    const target = fixedHead ?? before.stdout.trim()
    if (before.stdout.trim() !== target) {
      return { ...last, finalHead: await readCurrentHead(repoRoot) }
    }
    await options.beforeIndexResetForTesting?.(target, attempt)
    if (options.syncIndexForTesting) {
      const reset = await options.syncIndexForTesting(target)
      last = 'synchronized' in reset
        ? reset
        : {
            synchronized: reset.status === 0 && !(await repositoryOperationInProgress(repoRoot)),
            replacementApplied: false,
            finalHead: await readCurrentHead(repoRoot),
          }
      if (last.synchronized || last.replacementApplied) return last
    } else {
      last = await syncDroppedIndexPaths(repoRoot, paths, target, {
        afterIndexLockForTesting: options.afterIndexLockForTesting,
        beforeIndexReplaceForTesting: options.beforeIndexReplaceForTesting,
        preservePaths: options.preservePaths,
        expectedIndex: options.expectedIndex,
      })
      if (last.synchronized || last.replacementApplied) return last
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
  }
  return last
}

async function stagedIntentPaths(
  repoRoot: string,
  paths: readonly string[],
  head: string | null,
): Promise<string[]> {
  const result: string[] = []
  for (const filePath of paths) {
    if (head === null) {
      if ((await indexFingerprint(repoRoot, filePath)).length > 0) result.push(filePath)
      continue
    }
    const diff = await run(repoRoot, ['diff', '--cached', '--quiet', head, '--', filePath])
    if (diff.status === 1) result.push(filePath)
    else if (diff.status !== 0) throw new Error(`staged intent check failed: ${filePath}`)
  }
  return result
}

async function pathsUnchangedSinceIndexCapture(
  repoRoot: string,
  paths: readonly string[],
  expectedIndex: Record<string, IndexEntryFingerprint[]>,
): Promise<string[]> {
  const unchanged: string[] = []
  for (const filePath of paths) {
    if (sameIndexEntries(
      await indexFingerprint(repoRoot, filePath),
      expectedIndex[filePath] ?? [],
    )) unchanged.push(filePath)
  }
  return unchanged
}

export async function repairIndex(
  repoRoot: string,
  token: string,
  options: {
    afterIndexLockForTesting?: () => Promise<void>
    beforeIndexReplaceForTesting?: () => Promise<void>
    beforeRepairStatePersistenceForTesting?: () => Promise<void>
  } = {},
): Promise<{
  repaired: boolean
  repairStatePersistenceFailed?: boolean
  replacementApplied?: boolean
  finalHead?: string | null
}> {
  return withRepoMutation(repoRoot, async () => {
    await assertRepositoryIdle(repoRoot)
    const state = await readIndexRepairFile(repoRoot)
    const transaction = state.transactions.find((item) => item.token === token)
    if (!transaction) throw new Error('index repair transaction not found')
    if (transaction.status === 'superseded') {
      throw new Error('index changed after repair was requested')
    }

    const currentHead = await readCurrentHead(repoRoot)
    const compatible = transaction.head === null
      || currentHead === transaction.head
      || (currentHead !== null
        && transaction.head !== null
        && (await run(repoRoot, ['merge-base', '--is-ancestor', transaction.head, currentHead])).status === 0)
    if (!compatible) throw new Error('index repair repository changed')

    let attempt: Awaited<ReturnType<typeof repairIndexWithLock>>
    try {
      attempt = await repairIndexWithLock(repoRoot, transaction, currentHead, options)
    } catch (error: any) {
      if (/index changed after repair was requested/i.test(error?.message ?? '')) {
        const transactions = state.transactions.map((item) => (
          item.token === token ? { ...item, status: 'superseded' as const } : item
        ))
        await writeIndexRepairFile(repoRoot, { version: 2, transactions }).catch(() => {})
      }
      throw error
    }
    if (!attempt.repaired) {
      const replacementHead = attempt.finalHead
      if (
        attempt.replacementApplied
        && replacementHead !== undefined
        && attempt.replacementExpectedIndex
      ) {
        const transactions = state.transactions.map((item) => (
          item.token === token
            ? {
                ...item,
                status: 'pending' as const,
                head: replacementHead,
                expectedIndex: attempt.replacementExpectedIndex!,
              }
            : item
        ))
        try {
          await options.beforeRepairStatePersistenceForTesting?.()
          await writeIndexRepairFile(repoRoot, { version: 2, transactions })
        } catch {
          // The real Index was already replaced, but the old transaction is
          // no longer a valid proof for it. Never report a normal conflict
          // while hiding that the replacement's repair record was not saved.
          return {
            repaired: false,
            replacementApplied: true,
            repairStatePersistenceFailed: true,
            finalHead: replacementHead,
          }
        }
        return {
          repaired: false,
          replacementApplied: true,
          finalHead: replacementHead,
        }
      }
      return {
        repaired: false,
        replacementApplied: attempt.replacementApplied,
        finalHead: attempt.finalHead,
      }
    }
    const next = state.transactions.filter((item) => item.token !== token)
    try {
      await options.beforeRepairStatePersistenceForTesting?.()
      await writeIndexRepairFile(repoRoot, { version: 2, transactions: next })
      return { repaired: true }
    } catch {
      // The real Index has already been replaced atomically. Failure to clear
      // the recovery metadata is degraded success, never a failed repair.
      return { repaired: true, repairStatePersistenceFailed: true }
    }
  })
}

export async function discardIndexRepair(repoRoot: string, token: string): Promise<boolean> {
  return withRepoMutation(repoRoot, async () => {
    const state = await readIndexRepairFile(repoRoot)
    const transactions = state.transactions.filter((item) => item.token !== token)
    if (transactions.length === state.transactions.length) return false
    await writeIndexRepairFile(repoRoot, { version: 2, transactions })
    return true
  })
}

async function captureExpectedFiles(
  repoRoot: string,
  paths: readonly string[],
  expected: ExpectedContentHashes,
): Promise<Map<string, Buffer | null>> {
  const captured = new Map<string, Buffer | null>()
  const changed: string[] = []
  for (const filePath of paths) {
    let bytes: Buffer | null
    try {
      bytes = await readSafeRelativeFile(repoRoot, filePath) as Buffer | null
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      bytes = null
    }
    const actual = bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected[filePath]) changed.push(filePath)
    captured.set(filePath, bytes)
  }
  if (changed.length > 0) throw new Error(`content changed before commit: ${changed.join(', ')}`)
  return captured
}

/**
 * `git add` each of `paths` and create one commit with `message`. All
 * paths are relative to `repoRoot` and use forward slashes (the same
 * shape `git status` reports). Throws if the resulting commit touches
 * zero files (nothing to commit). Manual Nuvyn versions intentionally use
 * plumbing commands for deterministic snapshot/CAS semantics, so ordinary
 * `git commit` hooks and signing do not run here. When `expected` is supplied,
 * this function owns the complete
 * transaction: dirty validation, byte capture, temporary-index staging,
 * staged-blob verification, and commit all run under the per-repo mutex.
 */
export async function addAndCommit(
  repoRoot: string,
  paths: string[],
  message: string,
  options: {
    expected?: ExpectedContentHashes
    /** Production seam used by the generic metadata capture journal. It is
     * invoked after commit-tree has created the immutable object and before
     * update-ref can publish it. Test-only hooks remain separate below. */
    afterCommitObjectCreatedBeforeRefUpdate?: (context: {
      commitSha: string
      parentSha: string | null
      treeSha: string
      paths: readonly string[]
    }) => void | Promise<void>
    /** Production seam used to publish the durable metadata journal only
     * after update-ref has successfully advanced HEAD. */
    afterRefUpdated?: (context: {
      commitSha: string
      parentSha: string | null
      treeSha: string
      paths: readonly string[]
    }) => void | Promise<void>
    /** Test-only fault injection for the commit-tree failure boundary. */
    beforeCommitTreeForTesting?: () => Promise<void>
    beforeStageForTesting?: () => Promise<void>
    beforeTemporaryIndexForTesting?: () => Promise<void>
    beforeUpdateRefForTesting?: () => Promise<void>
    syncIndexForTesting?: (commitSha: string) => Promise<IndexSyncResult | RunResult>
    beforeIndexResetForTesting?: (commitSha: string, attempt: number) => Promise<void>
    afterIndexLockForTesting?: () => Promise<void>
    beforeIndexReplaceForTesting?: () => Promise<void>
    beforeRepairStatePersistenceForTesting?: () => Promise<void>
    beforeRepairMetadataWriteForTesting?: () => Promise<void>
  } = {},
): Promise<CommitResult> {
  if (paths.length === 0) {
    throw new Error('addAndCommit: at least one path is required')
  }
  if (message.trim().length === 0) {
    throw new Error('addAndCommit: message must not be empty')
  }
  // This is deliberately before withRepoMutation(), mkdtemp(), and every
  // Git command.  Check the complete batch first so a Note + managed Diary
  // selection is rejected atomically rather than committing a Note subset.
  const managedPath = paths.find(isManagedDiaryHistoryPath)
  if (managedPath) throw new ManagedDiaryHistoryUnsupportedError(managedPath)
  return withRepoMutation(repoRoot, async () => {
  await assertRepositoryIdle(repoRoot)
  await ensureIndexRepairStorageReady(repoRoot)
  const indexBefore = await captureIndexFingerprints(repoRoot, paths)
  const headAtStart = await readCurrentHead(repoRoot)
  const preservePaths = await stagedIntentPaths(repoRoot, paths, headAtStart)
  const resetPaths = paths.filter((filePath) => !preservePaths.includes(filePath))
  let captured: Map<string, Buffer | null> | null = null
  if (options.expected) {
    const dirtyPaths = new Set((await status(repoRoot)).map((entry) => entry.path))
    const stalePaths = paths.filter((filePath) => !dirtyPaths.has(filePath))
    if (stalePaths.length > 0) {
      throw new Error(`selection is stale; no longer changed: ${stalePaths.join(', ')}`)
    }
    captured = await captureExpectedFiles(repoRoot, paths, options.expected)
  }

  // A fresh vault in production (or a vault that was `git init`-ed by
  // hand without setting a user.name / user.email) makes `git commit`
  // fail with "Author identity unknown", which the route maps to 500.
  // Write a local identity before committing so the first commit just
  // works. Only writes keys that aren't already set — an existing
  // identity (e.g. a vault cloned from another machine, or a repo
  // where the user manually set their own name) is preserved.
  // Identity comes from GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL env vars
  // when set, falling back to "nuvyn" / "nuvyn@localhost" — the env
  // vars match git's own convention for per-command overrides and let
  // operators pick the identity per-host without touching the image.
  await ensureAuthorIdentity(repoRoot)
  await options.beforeStageForTesting?.()

  // stagedIntentPaths() was derived from headAtStart. Do not rebuild the
  // temporary index from a later HEAD: a concurrent soft reset could turn
  // previously unstaged paths into user-owned staged intent.
  await options.beforeTemporaryIndexForTesting?.()
  const currentHeadBeforeTemporaryIndex = await readCurrentHead(repoRoot)
  if (currentHeadBeforeTemporaryIndex !== headAtStart) {
    throw new Error('repository changed before commit')
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-history-index-'))
  const indexPath = path.join(tempDir, 'index')
  const indexEnv = { GIT_INDEX_FILE: indexPath }
  try {
    const headBefore: RunResult = headAtStart === null
      ? { status: 1, stdout: '', stderr: '' }
      : { status: 0, stdout: `${headAtStart}\n`, stderr: '' }
    const initialize = headBefore.status === 0
      ? await run(repoRoot, ['read-tree', headBefore.stdout.trim()], { env: indexEnv })
      : await run(repoRoot, ['read-tree', '--empty'], { env: indexEnv })
    if (initialize.status !== 0) throw new Error(`git read-tree failed: ${initialize.stderr.trim()}`)

    if (captured) {
      for (const filePath of paths) {
        const bytes = captured.get(filePath) ?? null
        if (bytes === null) {
          const remove = await run(repoRoot, ['update-index', '--force-remove', '--', filePath], { env: indexEnv })
          if (remove.status !== 0) throw new Error(`git update-index failed: ${remove.stderr.trim()}`)
          const verify = await run(repoRoot, ['ls-files', '--stage', '--', filePath], { env: indexEnv })
          if (verify.status !== 0 || verify.stdout.trim().length > 0) {
            throw new Error(`staged content verification failed: ${filePath}`)
          }
          continue
        }
        const blob = await run(
          repoRoot,
          ['hash-object', '-w', `--path=${filePath}`, '--stdin'],
          { input: bytes },
        )
        if (blob.status !== 0) throw new Error(`git hash-object failed: ${blob.stderr.trim()}`)
        const oid = blob.stdout.trim()
        const stage = await run(
          repoRoot,
          ['update-index', '--add', '--cacheinfo', '100644', oid, filePath],
          { env: indexEnv },
        )
        if (stage.status !== 0) throw new Error(`git update-index failed: ${stage.stderr.trim()}`)
        const verify = await run(repoRoot, ['ls-files', '--stage', '--', filePath], { env: indexEnv })
        if (verify.status !== 0 || !verify.stdout.includes(oid)) {
          throw new Error(`staged content verification failed: ${filePath}`)
        }
      }
    } else {
      const add = await run(repoRoot, ['add', '--', ...paths], { env: indexEnv })
      if (add.status !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`)
    }
  const tree = await run(repoRoot, ['write-tree'], { env: indexEnv })
  if (tree.status !== 0) throw new Error(`git write-tree failed: ${tree.stderr.trim()}`)
  const treeSha = tree.stdout.trim()
  if (headBefore.status === 0) {
    const previousTree = await run(repoRoot, ['rev-parse', `${headBefore.stdout.trim()}^{tree}`])
    if (previousTree.status !== 0) {
      throw new Error(`git rev-parse tree failed: ${previousTree.stderr.trim()}`)
    }
    if (previousTree.stdout.trim() === treeSha) throw new Error('nothing to commit')
  }

  // This is deliberately a plumbing commit. Running hooks or signing would
  // require a separate product policy that preserves the fixed-tree and CAS
  // guarantees below.
  const commitArgs = ['commit-tree', treeSha]
  if (headBefore.status === 0) commitArgs.push('-p', headBefore.stdout.trim())
  commitArgs.push('-m', await nuvynCommitMessage(repoRoot, message))
  await options.beforeCommitTreeForTesting?.()
  const commit = await run(repoRoot, commitArgs)
  if (commit.status !== 0) {
    throw new Error(`git commit-tree failed: ${commit.stderr.trim() || commit.stdout.trim()}`)
  }
  const commitSha = commit.stdout.trim()

  await options.afterCommitObjectCreatedBeforeRefUpdate?.({
    commitSha,
    parentSha: headBefore.status === 0 ? headBefore.stdout.trim() : null,
    treeSha,
    paths: [...paths],
  })
  await options.beforeUpdateRefForTesting?.()
  await assertRepositoryIdle(repoRoot)
  const expectedHead = headBefore.status === 0 ? headBefore.stdout.trim() : '0'.repeat(40)
  const updateHead = await run(repoRoot, ['update-ref', 'HEAD', commitSha, expectedHead])
  if (updateHead.status !== 0) throw new Error('repository changed before commit')
  await options.afterRefUpdated?.({
    commitSha,
    parentSha: headBefore.status === 0 ? headBefore.stdout.trim() : null,
    treeSha,
    paths: [...paths],
  })

  // Query the immutable commit we created, never the mutable HEAD ref.
  const show = await run(repoRoot, ['show', '--name-only', '--pretty=', commitSha])
  const filesCommitted = show.status === 0
    ? show.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    : paths

  // HEAD is already committed. Index repair is auxiliary and must never turn
  // a successful version into an API failure. Retry transient index.lock
  // contention, bind reset to our immutable SHA, and report degradation.
  const indexSync = resetPaths.length === 0
    ? {
        synchronized: true,
        replacementApplied: false,
        finalHead: await readCurrentHead(repoRoot),
      }
    : await syncIndexPaths(repoRoot, resetPaths, commitSha, {
        ...options,
        preservePaths: [],
        expectedIndex: Object.fromEntries(
          resetPaths.map((filePath) => [filePath, indexBefore[filePath] ?? []]),
        ),
      })
  const indexRefreshFailed = resetPaths.length > 0 && !indexSync.synchronized
  let indexRepair: IndexRepairTransaction | undefined
  let repairStatePersistenceFailed = false
  try {
    await options.beforeRepairStatePersistenceForTesting?.()
    const replacementExpectedIndex = indexSync.replacementApplied
      ? indexSync.replacementExpectedIndex
      : undefined
    const repairPaths = indexRefreshFailed
      ? replacementExpectedIndex
        ? resetPaths
        : await pathsUnchangedSinceIndexCapture(repoRoot, resetPaths, indexBefore)
      : resetPaths
    if (indexRefreshFailed && repairPaths.length > 0) {
      indexRepair = await recordIndexRepair(
        repoRoot,
        indexSync.finalHead,
        repairPaths,
        replacementExpectedIndex
          ? Object.fromEntries(repairPaths.map((filePath) => [
              filePath,
              replacementExpectedIndex[filePath] ?? [],
            ]))
          : Object.fromEntries(repairPaths.map((filePath) => [filePath, indexBefore[filePath] ?? []])),
        { beforeMetadataWriteForTesting: options.beforeRepairMetadataWriteForTesting },
      )
    } else if (!indexRefreshFailed) {
      await settleIndexRepairPaths(repoRoot, resetPaths)
    }
  } catch {
    repairStatePersistenceFailed = true
  }
  return {
    sha: commitSha,
    filesCommitted,
    indexRefreshFailed,
    indexRepair,
    repairStatePersistenceFailed,
  }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
  })
}

async function syncDroppedIndexPaths(
  repoRoot: string,
  paths: readonly string[],
  targetHead: string | null,
  options: {
    afterIndexLockForTesting?: () => Promise<void>
    beforeIndexReplaceForTesting?: () => Promise<void>
    preservePaths?: readonly string[]
    expectedIndex?: Record<string, IndexEntryFingerprint[]>
  } = {},
): Promise<IndexSyncResult> {
  const gitDir = await absoluteGitDir(repoRoot)
  const indexPath = path.join(gitDir, 'index')
  const lockPath = path.join(gitDir, 'index.lock')
  let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    lockHandle = await fs.open(lockPath, 'wx')
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      return {
        synchronized: false,
        replacementApplied: false,
        finalHead: await readCurrentHead(repoRoot),
      }
    }
    throw error
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-index-drop-'))
  const tempIndex = path.join(tempDir, 'index')
  const indexEnv = { GIT_INDEX_FILE: tempIndex }
  let committedLock = false
  try {
    try {
      await fs.copyFile(indexPath, tempIndex)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      const empty = await run(repoRoot, ['read-tree', '--empty'], { env: indexEnv })
      if (empty.status !== 0) throw new Error(`git read-tree failed: ${empty.stderr.trim()}`)
    }

    await options.afterIndexLockForTesting?.()
    if (options.expectedIndex) {
      for (const filePath of paths) {
        if (!sameIndexEntries(
          await indexFingerprint(repoRoot, filePath),
          options.expectedIndex[filePath] ?? [],
        )) {
          return {
            synchronized: false,
            replacementApplied: false,
            finalHead: await readCurrentHead(repoRoot),
          }
        }
      }
    }
    const preserve = new Set(options.preservePaths ?? [])
    const resetPaths = paths.filter((filePath) => !preserve.has(filePath))
    const update = resetPaths.length === 0
      ? { status: 0, stdout: '', stderr: '' }
      : targetHead === null
        ? await run(repoRoot, ['update-index', '--force-remove', '--', ...resetPaths], { env: indexEnv })
        : await run(repoRoot, ['reset', '-q', targetHead, '--', ...resetPaths], { env: indexEnv })
    if (update.status !== 0 || await repositoryOperationInProgress(repoRoot)) {
      return {
        synchronized: false,
        replacementApplied: false,
        finalHead: await readCurrentHead(repoRoot),
      }
    }
    if (await readCurrentHead(repoRoot) !== targetHead) {
      return {
        synchronized: false,
        replacementApplied: false,
        finalHead: await readCurrentHead(repoRoot),
      }
    }

    const verified = targetHead === null
      ? Object.values(await captureIndexFingerprints(repoRoot, resetPaths, indexEnv))
          .every((entries) => entries.length === 0)
      : resetPaths.length === 0
        || (await run(
            repoRoot,
            ['diff', '--cached', '--quiet', targetHead, '--', ...resetPaths],
            { env: indexEnv },
          )).status === 0
    const preservedEntries = await Promise.all([...preserve].map(async (filePath) => (
      sameIndexEntries(
        // The temporary index starts as the real index, so preserved paths
        // must still match the fingerprint captured before the lock.
        await indexFingerprint(repoRoot, filePath, indexEnv),
        options.expectedIndex?.[filePath] ?? [],
      )
    )))
    const preserved = preservedEntries.every(Boolean)
    if (!verified || (preserve.size > 0 && (!options.expectedIndex || !preserved))) {
      return {
        synchronized: false,
        replacementApplied: false,
        finalHead: await readCurrentHead(repoRoot),
      }
    }

    const replacementExpectedIndex = await captureIndexFingerprints(
      repoRoot,
      resetPaths,
      indexEnv,
    )

    const replacement = await fs.readFile(tempIndex)
    await lockHandle.truncate(0)
    await lockHandle.writeFile(replacement)
    await lockHandle.sync()
    await lockHandle.close()
    lockHandle = undefined
    await options.beforeIndexReplaceForTesting?.()
    await fs.rename(lockPath, indexPath)
    committedLock = true
    const finalHead = await readCurrentHead(repoRoot)
    return {
      synchronized: finalHead === targetHead,
      replacementApplied: true,
      finalHead,
      replacementExpectedIndex,
    }
  } finally {
    await lockHandle?.close().catch(() => {})
    if (!committedLock) await fs.rm(lockPath, { force: true })
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

export async function dropHeadCommit(
  repoRoot: string,
  sha: string,
  options: {
    beforeUpdateRefForTesting?: () => Promise<void>
    syncIndexForTesting?: (targetHead: string | null, paths: readonly string[]) => Promise<IndexSyncResult | boolean>
    afterIndexLockForTesting?: () => Promise<void>
    beforeIndexReplaceForTesting?: () => Promise<void>
    beforeRepairStatePersistenceForTesting?: () => Promise<void>
    beforeRepairMetadataWriteForTesting?: () => Promise<void>
  } = {},
): Promise<DropCommitResult> {
  return withRepoMutation(repoRoot, async () => {
    await assertRepositoryIdle(repoRoot)
    await ensureIndexRepairStorageReady(repoRoot)
    const resolvedSha = await resolveCommit(repoRoot, sha)
    if (!resolvedSha) throw new Error('invalid withdrawal reference')
    const head = await readCurrentHead(repoRoot)
    if (head !== resolvedSha) throw new Error('only the latest version can be withdrawn')

    const parentsResult = await run(repoRoot, ['rev-list', '--parents', '-n', '1', resolvedSha])
    if (parentsResult.status !== 0) {
      throw new Error(`cannot inspect withdrawal commit: ${parentsResult.stderr.trim()}`)
    }
    const parentFields = parentsResult.stdout.trim().split(/\s+/).filter(Boolean)
    if (parentFields.length > 2) throw new Error('merge commits cannot be withdrawn')
    const parent = parentFields[1] ?? null

    const messageResult = await run(repoRoot, ['show', '-s', '--format=%B', resolvedSha])
    if (messageResult.status !== 0) {
      throw new Error(`cannot inspect withdrawal commit: ${messageResult.stderr.trim()}`)
    }
    const vaultId = await ensureNuvynVaultId(repoRoot)
    const lines = messageResult.stdout.split(/\r?\n/).map((line) => line.trim())
    const canonicalVersions = lines.filter((line) => line === NUVYN_VERSION_TRAILER)
    const canonicalVaults = lines
      .map((line) => /^Nuvyn-Vault:\s*(.+)$/i.exec(line)?.[1] ?? null)
      .filter((value): value is string => value !== null)
    const canonicalVaultVersions = lines
      .map((line) => /^Nuvyn-Vault-Version:\s*(.+)$/i.exec(line)?.[1] ?? null)
      .filter((value): value is string => value !== null)
    const canonicalValid = canonicalVersions.length === 1
      && canonicalVaults.length === 1
      && (canonicalVaultVersions.length === 0
        || (canonicalVaultVersions.length === 1 && canonicalVaultVersions[0] === '1'))
      && canonicalVaults[0] === vaultId
    if (!canonicalValid) {
      throw Object.assign(
        new Error('commit is not a Nuvyn version for this vault'),
        { code: 'HISTORY_NOT_NUVYN_VERSION' },
      )
    }

    const show = await run(repoRoot, ['show', '--no-renames', '--name-only', '--pretty=', resolvedSha])
    if (show.status !== 0) throw new Error(`git show failed: ${show.stderr.trim()}`)
    const filesChanged = show.stdout
      .split('\n')
      .map((filePath) => filePath.trim())
      .filter((filePath) => filePath.endsWith('.md'))
    const indexBefore = await captureIndexFingerprints(repoRoot, filesChanged)
    const preservePaths = await stagedIntentPaths(repoRoot, filesChanged, head)
    const resetPaths = filesChanged.filter((filePath) => !preservePaths.includes(filePath))

    await options.beforeUpdateRefForTesting?.()
    await assertRepositoryIdle(repoRoot)
    const update = parent === null
      ? await run(repoRoot, ['update-ref', '-d', 'HEAD', sha])
      : await run(repoRoot, ['update-ref', 'HEAD', parent, sha])
    if (update.status !== 0) throw new Error('repository changed before withdrawal')

    let indexSync: IndexSyncResult
    try {
      indexSync = filesChanged.length === 0
        ? {
            synchronized: true,
            replacementApplied: false,
            finalHead: await readCurrentHead(repoRoot),
          }
        : options.syncIndexForTesting
          ? await (async () => {
              const result = await options.syncIndexForTesting!(parent, filesChanged)
              return typeof result === 'boolean'
                ? {
                    synchronized: result,
                    replacementApplied: false,
                    finalHead: await readCurrentHead(repoRoot),
                  }
                : result
            })()
          : await syncDroppedIndexPaths(repoRoot, filesChanged, parent, {
              ...options,
              preservePaths,
              expectedIndex: indexBefore,
            })
    } catch {
      indexSync = {
        synchronized: false,
        replacementApplied: false,
        finalHead: await readCurrentHead(repoRoot),
      }
    }
    const indexRefreshFailed = !indexSync.synchronized

    const finalHead = await readCurrentHead(repoRoot)
    let indexRepair: IndexRepairTransaction | undefined
    let repairStatePersistenceFailed = false
    try {
      await options.beforeRepairStatePersistenceForTesting?.()
      const replacementExpectedIndex = indexSync.replacementApplied
        ? indexSync.replacementExpectedIndex
        : undefined
      const repairPaths = indexRefreshFailed
        ? replacementExpectedIndex
          ? resetPaths
          : await pathsUnchangedSinceIndexCapture(repoRoot, resetPaths, indexBefore)
        : resetPaths
      if (indexRefreshFailed && repairPaths.length > 0) {
        indexRepair = await recordIndexRepair(
          repoRoot,
          indexSync.finalHead,
          repairPaths,
          replacementExpectedIndex
            ? Object.fromEntries(repairPaths.map((filePath) => [
                filePath,
                replacementExpectedIndex[filePath] ?? [],
              ]))
            : Object.fromEntries(repairPaths.map((filePath) => [filePath, indexBefore[filePath] ?? []])),
          { beforeMetadataWriteForTesting: options.beforeRepairMetadataWriteForTesting },
        )
      } else if (!indexRefreshFailed) {
        await settleIndexRepairPaths(repoRoot, resetPaths)
      }
    } catch {
      repairStatePersistenceFailed = true
    }

    return {
      sha: finalHead ?? '',
      droppedSha: resolvedSha,
      filesChanged,
      indexRefreshFailed,
      indexRepair,
      repairStatePersistenceFailed,
    }
  })
}
