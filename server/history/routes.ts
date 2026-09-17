// HTTP layer for the history feature. Bind the L0 (git.ts) and
// L1 (diff.ts) modules to REST-ish endpoints the L3 UI can call.
//
// Design choices, in the same spirit as the other route files:
//   - handlers are thin: parse the request, call the L0/L1 service,
//     translate the result to status + JSON
//   - validation at the boundary, not the service layer
//   - errors come back as `{ error: <reason> }` with a 4xx/5xx
//     status. The UI knows the shape.
//   - capability is cached at module load: probing `git --version`
//     on every request would be wasteful, and the binary being on
//     PATH is effectively static for the lifetime of the process.
//
// repoRoot is module-scoped (not a constant) so tests can swap it
// with `setRepoRootForTesting`. Same pattern as setContentDir in
// ../paths.ts.

import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import * as git from './git.js'
import { ensureRepo, ensureRepoWithinVaultMutation } from './repo.js'
import { computeFileDiff } from './diff.js'
import { CONTENT_DIR, readSafeRelativeFile } from '../paths.js'
import { metadataDb } from '../routes/shared.js'
import { withVaultMutation } from '../vaultMutation.js'
import { withDocumentWriteLocks } from '../documentWriteLock.js'
import {
  HistoryMetadataError,
  abortHistoryMetadataCapture,
  finalizeHistoryMetadataCapture,
  logicalHistoryPath,
  markHistoryMetadataCaptureCommitted,
  prepareHistoryMetadataCapture,
  reconcileHistoryMetadata,
  withdrawHistoryMetadataCapture,
} from './metadataRevisions.js'
import {
  HistoryRestoreConflictError,
  HistoryRestoreNotFoundError,
  ManagedDiaryHistoryRestoreUnsupportedError,
  restoreHistoricalDocument,
} from './restore.js'
import { FolderMovePathOwnedError } from '../folderMoveJournalOwnership.js'
import { DocumentMutationPolicyError } from '../documentMutationPolicy.js'
import {
  isManagedHistoryPath,
  isValidCommitSha,
  isValidHistoryPath,
  isValidHistoryRef,
  validateHistoryPaths,
} from './validation.js'
import { isManagedDiaryBodyPath, requireDiaryBodyAccess } from '../diaryAccess/guard.js'

function rejectEncryptedDiaryHistory(c: any, path: string): Response | null {
  if (!isManagedDiaryBodyPath(path)) return null
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: 'Managed Diary body History is unavailable while encrypted History is not implemented.',
    code: 'diary-history-encrypted-unsupported',
  }, 422)
}

/**
 * Where git runs — the vault root. By default this is the same
 * directory the posts API reads from (CONTENT_DIR), so the git
 * repo lives at the vault root in both dev and production. That
 * keeps path conventions consistent: `git status --porcelain`
 * returns paths relative to the vault, which match the `inbox/x.md`
 * shape the rest of Nuvyn uses everywhere (URLs, tab.path, etc.).
 *
 * In dev that means the vault gets its own `.git/` inside
 * `<project>/src/content`, separate from the project's own git
 * repo at `<project>/.git/`. That's deliberate — vault history
 * should not include code commits, and code history should not
 * include unrelated vault snapshots.
 *
 * In production, set VAULT_DIR (see ../paths.ts) to point at
 * wherever the user's vault lives; repoRoot follows automatically.
 *
 * Tests inject a tempdir via `setRepoRootForTesting`.
 */
let _repoRoot: string = CONTENT_DIR

export type HistoryMutationKind =
  | 'create-version'
  | 'repair-index'
  | 'discard-repair'
  | 'withdraw'
  | 'restore'

export type HistoryMutationHooks = {
  beforeMutation?: (kind: HistoryMutationKind) => void | Promise<void>
  /** Test-only fault injection immediately before update-ref. */
  beforeUpdateRefForTesting?: () => void | Promise<void>
  beforeRestoreCommit?: () => void | Promise<void>
  afterRestorePrepare?: () => void | Promise<void>
  afterRestoreCommit?: () => void | Promise<void>
}

let historyMutationHooks: HistoryMutationHooks | null = null

export function __setHistoryMutationHooksForTesting(
  hooks: HistoryMutationHooks | null,
): void {
  historyMutationHooks = hooks
}

export function setRepoRootForTesting(dir: string): void {
  _repoRoot = dir
}

export function __resetRepoRootForTesting(): void {
  // Mirror the module-load default: read CONTENT_DIR rather than
  // process.cwd() so resetting after a test still gives us the
  // production-shaped default.
  _repoRoot = CONTENT_DIR
}

function repoRoot(): string {
  return _repoRoot
}

function bad(c: any, msg: string, status = 400, errorCode?: string, details?: unknown) {
  c.header('Cache-Control', 'no-store')
  return c.json({ error: msg, ...(errorCode ? { code: errorCode } : {}), ...(details !== undefined ? { details } : {}) }, status)
}

const STABLE_HISTORY_ERROR_CODES = new Set([
  'HISTORY_CONTENT_CHANGED',
  'HISTORY_PATH_MOVED',
  'HISTORY_VAULT_WRITER_ACTIVE',
  'HISTORY_REPOSITORY_CHANGED',
  'HISTORY_REPOSITORY_OPERATION',
  'HISTORY_INDEX_REPAIR_CONFLICT',
  'HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED',
  'HISTORY_POST_COMMIT_EXTERNAL_MUTATION',
  'HISTORY_ATOMIC_CLEANUP_FAILED',
  'HISTORY_NOT_NUVYN_VERSION',
  'HISTORY_RESOURCE_LIMIT',
  'HISTORY_METADATA_CORRUPT',
  'HISTORY_METADATA_UNKNOWN_FIELD',
  'HISTORY_METADATA_UNSUPPORTED_SCHEMA',
  'HISTORY_METADATA_IDENTITY_CONFLICT',
  'HISTORY_METADATA_CONFLICT',
  'HISTORY_METADATA_JOURNAL_AMBIGUOUS',
  'HISTORY_METADATA_CAPTURE_FAILED',
  'HISTORY_METADATA_REVISION_WITHDRAWN',
  'HISTORY_METADATA_TREE_MISMATCH',
  'HISTORY_METADATA_BODY_MISMATCH',
  'diary-history-encrypted-unsupported',
])

function stableErrorCode(error: unknown): string | undefined {
  const code = (error as any)?.code
  return typeof code === 'string' && STABLE_HISTORY_ERROR_CODES.has(code) ? code : undefined
}

function validPathParam(c: any, value: string | undefined): string | Response {
  if (!value) return bad(c, 'path required')
  if (!isValidHistoryPath(value)) return bad(c, 'invalid path')
  return value
}

function validRefParam(
  c: any,
  value: string | undefined,
  name = 'ref',
  opts: { allowWorktree?: boolean } = {},
): string | Response {
  if (!value) return bad(c, name === 'ref' ? 'ref required' : `${name} ref required`)
  if (!isValidHistoryRef(value, opts)) return bad(c, 'invalid ref')
  return value
}

// --- capability -----------------------------------------------------------

// Probed once at module load. The result is "git on PATH" — that
// changes only at process restart, so per-request probing is wrong.
// Repos themselves can come and go (`ensureRepo` is idempotent),
// but `isRepo` is a cheap call so we do it on /capability rather
// than caching it here.
let _gitAvailable: boolean | null = null

async function probeGit(): Promise<boolean> {
  if (_gitAvailable !== null) return _gitAvailable
  try {
    const r = await git.run(repoRoot(), ['--version'])
    _gitAvailable = r.status === 0
  } catch {
    _gitAvailable = false
  }
  return _gitAvailable
}

/** Test hook: re-probe on the next capability check. */
export function __resetGitCapabilityForTesting(): void {
  _gitAvailable = null
}

const history = new Hono()

// ---- /capability ----
history.get('/capability', async (c) => {
  const available = await probeGit()
  if (!available) {
    return c.json({ gitAvailable: false, repoInitialized: false })
  }
  // ensureRepo is idempotent; calling it here costs at most one
  // fs.access and (on the first visit) one git init. We don't
  // init eagerly at module load because tests that never touch
  // the history feature shouldn't pay the cost.
  try {
    await ensureRepo(repoRoot())
  } catch (e: any) {
    // Init failure is a real problem but we don't want capability
    // to 500 — report it as "available but not initialized" with
    // the underlying error in `initError` so the UI can show a
    // specific message (e.g. "vault sits inside another git repo").
    return c.json({
      gitAvailable: true,
      repoInitialized: false,
      initError: e?.message ?? 'init failed',
    })
  }
  return c.json({ gitAvailable: true, repoInitialized: true })
})

// ---- /status ----
// Returns the dirty (or staged) file set. The L3 UI uses this to
// render the "Changes (N)" list and the dirty-count badge on the
// ActivityBar button.
history.get('/status', async (c) => {
  if (!(await probeGit())) return c.json({ dirty: [], available: false }, 503)
  try {
    await ensureRepo(repoRoot())
    const dirty = (await git.status(repoRoot()))
      .filter((entry) => !isManagedHistoryPath(entry.path)
        && !isManagedDiaryBodyPath(entry.path)
        && isValidHistoryPath(entry.path))
    return c.json({ dirty, available: true })
  } catch (e: any) {
    return bad(c, e.message ?? 'status failed', 500, stableErrorCode(e))
  }
})

async function worktreeContentHash(filePath: string): Promise<string | null> {
  try {
    const bytes = await readSafeRelativeFile(repoRoot(), filePath)
    if (bytes === null) return null
    return createHash('sha256').update(bytes).digest('hex')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

// Capture the exact working-tree bytes that Create Version is about to commit.
// The client keeps its mutation barrier active between this request and
// POST /commits; /commits re-checks these hashes immediately before staging.
history.post('/content-hashes', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  const body = await c.req.json().catch(() => null) as { paths?: unknown } | null
  const paths = validateHistoryPaths(body?.paths)
  if (!paths) return bad(c, 'invalid paths')
  for (const filePath of paths) {
    const historyError = rejectEncryptedDiaryHistory(c, filePath)
    if (historyError) return historyError
    const bodyAccess = requireDiaryBodyAccess(c, filePath)
    if (bodyAccess) return bodyAccess
  }
  try {
    await ensureRepo(repoRoot())
    const entries = await Promise.all(paths.map(async (filePath) => (
      [filePath, await worktreeContentHash(filePath)] as const
    )))
    return c.json({ hashes: Object.fromEntries(entries) })
  } catch (e: any) {
    return bad(c, e.message ?? 'content hash failed', 500, stableErrorCode(e))
  }
})

// ---- /log ----
// Commit history, newest-first. `?path=` filters to a single file.
history.get('/log', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  const pathParam = c.req.query('path')
  const limitStr = c.req.query('limit')
  const limit = limitStr ? Math.max(1, Math.min(2000, Number(limitStr) || 200)) : 200
  if (pathParam && !isValidHistoryPath(pathParam)) return bad(c, 'invalid path')
  if (pathParam) {
    const historyError = rejectEncryptedDiaryHistory(c, pathParam)
    if (historyError) return historyError
  }
  const path = pathParam || undefined
  try {
    await ensureRepo(repoRoot())
    const commits = await git.log(repoRoot(), { path, limit })
    return c.json({ commits })
  } catch (e: any) {
    return bad(c, e.message ?? 'log failed', 500, stableErrorCode(e))
  }
})

// ---- /file ----
// Raw content of `path` at `ref` (a sha, branch, or HEAD). Used by
// the diff view to fetch the "old" version of a file. `ref` defaults
// to HEAD.
history.get('/file', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  const path = c.req.query('path')
  const ref = c.req.query('ref') ?? 'HEAD'
  const validPath = validPathParam(c, path)
  if (validPath instanceof Response) return validPath
  const historyError = rejectEncryptedDiaryHistory(c, validPath)
  if (historyError) return historyError
  const bodyAccess = requireDiaryBodyAccess(c, validPath)
  if (bodyAccess) return bodyAccess
  const validRef = validRefParam(c, ref, 'ref', { allowWorktree: true })
  if (validRef instanceof Response) return validRef
  try {
    await ensureRepo(repoRoot())
    const content = await git.rawAt(repoRoot(), validRef, validPath)
    if (content === null) return bad(c, 'not found at ref', 404)
    return c.json({ path: validPath, ref: validRef, content })
  } catch (e: any) {
    return bad(c, e.message ?? 'file failed', 500, stableErrorCode(e))
  }
})

// ---- /diff ----
// Line + word diff between two refs for a single file. The two refs
// are mandatory because the L1 layer has no concept of a "default"
// side — it just takes two strings.
//
// Why this is its own endpoint instead of letting the client call
// /file twice and run L1 in the browser: the L1 logic is server
// code, and the client shouldn't be pulling a Myers impl into the
// bundle. The savings are also small — diff for a vault note is
// usually < 5KB of JSON.
history.get('/diff', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  const path = c.req.query('path')
  const oldRef = c.req.query('old')
  const newRef = c.req.query('new')
  const validPath = validPathParam(c, path)
  if (validPath instanceof Response) return validPath
  const historyError = rejectEncryptedDiaryHistory(c, validPath)
  if (historyError) return historyError
  const bodyAccess = requireDiaryBodyAccess(c, validPath)
  if (bodyAccess) return bodyAccess
  if (!oldRef || !newRef) return bad(c, 'old and new refs required')
  const validOldRef = validRefParam(c, oldRef, 'old', { allowWorktree: true })
  if (validOldRef instanceof Response) return validOldRef
  const validNewRef = validRefParam(c, newRef, 'new', { allowWorktree: true })
  if (validNewRef instanceof Response) return validNewRef
  try {
    await ensureRepo(repoRoot())
    // Resolve both sides in parallel. rawAt returns null when the
    // file did not exist at the ref — pass that through as an
    // empty string so the diff endpoint always returns the same
    // shape regardless of the file's history.
    const [oldContent, newContent] = await Promise.all([
      git.rawAt(repoRoot(), validOldRef, validPath),
      git.rawAt(repoRoot(), validNewRef, validPath),
    ])
    const diff = computeFileDiff(oldContent, newContent)
    return c.json({ path: validPath, oldRef: validOldRef, newRef: validNewRef, diff })
  } catch (e: any) {
    return bad(c, e.message ?? 'diff failed', 500, stableErrorCode(e))
  }
})

// ---- /commits ----
// Create one commit from a list of paths and a message. Body:
//   { paths: string[], message: string, expected: Record<string, string | null> }
//
// `message` must be non-empty after trim — empty messages defeat
// the purpose of a manual commit. The L0 layer's addAndCommit
// guards the same condition; we duplicate the check here so the
// 400 has a clear error message and the 500 ("git commit failed:
// ...") stays for genuine git failures.
//
// Status is re-read immediately before staging. The History panel can remain
// open while another editor restores, deletes, or moves files; rejecting a
// stale batch is safer than silently committing only the paths still dirty.
history.post('/commits', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  const body = await c.req.json().catch(() => null) as
    | { paths?: unknown; message?: unknown; expected?: unknown }
    | null
  if (!body) return bad(c, 'body required')
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return bad(c, 'paths (non-empty array) required')
  }
  if (body.paths.some((p) => typeof p !== 'string' || p.length === 0)) {
    return bad(c, 'every path must be a non-empty string')
  }
  const paths = validateHistoryPaths(body.paths)
  if (!paths) return bad(c, 'invalid path')
  for (const filePath of paths) {
    const historyError = rejectEncryptedDiaryHistory(c, filePath)
    if (historyError) return historyError
    const bodyAccess = requireDiaryBodyAccess(c, filePath)
    if (bodyAccess) return bodyAccess
  }
  if (typeof body.message !== 'string' || body.message.trim().length === 0) {
    return bad(c, 'message must be a non-empty string')
  }
  if (!body.expected || typeof body.expected !== 'object' || Array.isArray(body.expected)) {
    return bad(c, 'expected content hashes required')
  }
  const record = body.expected as Record<string, unknown>
  if (Object.keys(record).length !== paths.length || paths.some((filePath) => (
    !(filePath in record)
    || !(record[filePath] === null || (typeof record[filePath] === 'string' && /^[0-9a-f]{64}$/.test(record[filePath])))
  ))) {
    return bad(c, 'invalid expected content hashes')
  }
  const expected = record as Record<string, string | null>
  const message = body.message
  try {
    return await withVaultMutation(repoRoot(), async () => {
      await ensureRepoWithinVaultMutation(repoRoot())
      await historyMutationHooks?.beforeMutation?.('create-version')
      await reconcileHistoryMetadata(metadataDb(), repoRoot())
      return withDocumentWriteLocks(paths.map(logicalHistoryPath), async () => {
        const vaultId = await git.ensureNuvynVaultId(repoRoot())
        const expectedParentSha = await git.currentHead(repoRoot())
        let capture: ReturnType<typeof prepareHistoryMetadataCapture> | null = null
        let refPublished = false
        try {
          capture = prepareHistoryMetadataCapture({
            db: metadataDb(),
            vaultId,
            expectedParentSha,
            paths,
            expectedHashes: expected,
          })
          const r = await git.addAndCommit(repoRoot(), paths, message, {
            expected,
            afterCommitObjectCreatedBeforeRefUpdate: async ({ commitSha, parentSha, treeSha }) => {
              await finalizeHistoryMetadataCapture({
                db: metadataDb(),
                repoRoot: repoRoot(),
                operationId: capture!.operationId,
                commitSha,
                parentSha,
                treeSha,
              })
            },
            afterRefUpdated: async ({ commitSha }) => {
              // Set this before the database mark. If the process/database
              // fails after Git publication, reconciliation must prove the
              // reachable bound SHA rather than aborting it as unpublished.
              refPublished = true
              markHistoryMetadataCaptureCommitted({
                db: metadataDb(),
                operationId: capture!.operationId,
                commitSha,
              })
            },
            beforeUpdateRefForTesting: async () => {
              await historyMutationHooks?.beforeUpdateRefForTesting?.()
            },
          })
          return c.json(r, 201)
        } catch (error) {
          if (capture && !refPublished) {
            try { abortHistoryMetadataCapture(metadataDb(), capture.operationId, error) } catch { /* reconcile on the next history operation */ }
          }
          throw error
        }
      })
    })
  } catch (e: any) {
    const msg = e.message ?? 'commit failed'
    if (e instanceof HistoryMetadataError && (
      e.code === 'HISTORY_METADATA_CONFLICT'
      || e.code === 'HISTORY_METADATA_JOURNAL_AMBIGUOUS'
      || e.code === 'HISTORY_METADATA_IDENTITY_CONFLICT'
    )) {
      return bad(c, msg, 409, e.code)
    }
    if (/nothing to commit|selection is stale|content changed before commit|repository changed before commit|repository operation in progress/i.test(msg)) {
      return bad(c, msg, 409, /repository operation in progress/i.test(msg)
        ? 'HISTORY_REPOSITORY_OPERATION'
        : 'HISTORY_REPOSITORY_CHANGED')
    }
    return bad(c, msg, 500, stableErrorCode(e))
  }
})

// Persisted repair transactions survive browser reloads. A repair token is
// bound server-side to the commit and exact real-index entries observed after
// synchronization failed; callers cannot use this endpoint as an arbitrary
// `git reset <paths>` primitive.
history.get('/repair-status', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  try {
    return await withVaultMutation(repoRoot(), async () => {
      await ensureRepoWithinVaultMutation(repoRoot())
      return c.json({ transactions: await git.getIndexRepairStatus(repoRoot()) })
    })
  } catch (e: any) {
    return bad(c, e.message ?? 'index repair status failed', 500, stableErrorCode(e))
  }
})

history.post('/repair-index', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  const body = await c.req.json().catch(() => null) as { token?: unknown } | null
  if (typeof body?.token !== 'string' || !/^[0-9a-f]{32}$/.test(body.token)) {
    return bad(c, 'invalid index repair token')
  }
  const token = body.token
  try {
    return await withVaultMutation(repoRoot(), async () => {
      await ensureRepoWithinVaultMutation(repoRoot())
      await historyMutationHooks?.beforeMutation?.('repair-index')
      const result = await git.repairIndex(repoRoot(), token)
      if (!result.repaired && result.repairStatePersistenceFailed) {
        return bad(
          c,
          'Git Index changed, but the repair record could not be saved; inspect Git status manually',
          409,
          'HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED',
          {
            replacementApplied: result.replacementApplied === true,
            finalHead: result.finalHead ?? null,
          },
        )
      }
      if (!result.repaired) {
        return bad(c, 'index repair could not be verified', 409, 'HISTORY_INDEX_REPAIR_CONFLICT')
      }
      return c.json(result)
    })
  } catch (e: any) {
    const msg = e.message ?? 'index repair failed'
    if (/repository operation in progress|transaction not found|repository changed|index changed after repair|git index is locked/i.test(msg)) {
      return bad(c, msg, 409, /index changed after repair/i.test(msg)
        ? 'HISTORY_INDEX_REPAIR_CONFLICT'
        : 'HISTORY_REPOSITORY_CHANGED')
    }
    return bad(c, msg, 500, stableErrorCode(e))
  }
})

history.post('/repair-index/discard', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  const body = await c.req.json().catch(() => null) as { token?: unknown } | null
  if (typeof body?.token !== 'string' || !/^[0-9a-f]{32}$/.test(body.token)) {
    return bad(c, 'invalid index repair token')
  }
  const token = body.token
  try {
    return await withVaultMutation(repoRoot(), async () => {
      await ensureRepoWithinVaultMutation(repoRoot())
      await historyMutationHooks?.beforeMutation?.('discard-repair')
      const discarded = await git.discardIndexRepair(repoRoot(), token)
      if (!discarded) return bad(c, 'index repair transaction not found', 409)
      return c.json({ discarded: true })
    })
  } catch (e: any) {
    return bad(c, e.message ?? 'discard index repair failed', 500, stableErrorCode(e))
  }
})

// ---- /drop ----
// Remove the latest commit from history while keeping its file changes
// in the working tree. This intentionally only accepts HEAD; dropping
// older commits would require history rewriting across descendants.
history.post('/drop', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  const body = await c.req.json().catch(() => null) as
    | { sha?: unknown }
    | null
  if (!body) return bad(c, 'body required')
  if (typeof body.sha !== 'string' || body.sha.length === 0) return bad(c, 'sha required')
  if (!isValidCommitSha(body.sha)) return bad(c, 'invalid sha')
  const sha = body.sha
  try {
    return await withVaultMutation(repoRoot(), async () => {
      await ensureRepoWithinVaultMutation(repoRoot())
      await historyMutationHooks?.beforeMutation?.('withdraw')
      await reconcileHistoryMetadata(metadataDb(), repoRoot())
      const r = await git.dropHeadCommit(repoRoot(), sha)
      withdrawHistoryMetadataCapture(
        metadataDb(),
        await git.ensureNuvynVaultId(repoRoot()),
        r.droppedSha,
      )
      return c.json(r)
    })
  } catch (e: any) {
    const msg = e.message ?? 'drop failed'
    const code = stableErrorCode(e)
    if (code === 'HISTORY_NOT_NUVYN_VERSION') {
      return bad(c, msg, 409, code, e.details)
    }
    if (/only the latest version|repository changed before withdrawal|repository operation in progress|not a Nuvyn version|merge commits cannot be withdrawn/i.test(msg)) {
      return bad(c, msg, 409, /not a Nuvyn version/i.test(msg)
        ? 'HISTORY_NOT_NUVYN_VERSION'
        : /repository operation in progress/i.test(msg)
          ? 'HISTORY_REPOSITORY_OPERATION'
          : 'HISTORY_REPOSITORY_CHANGED')
    }
    if (/bad revision|unknown revision|not a valid object name|invalid withdrawal reference/i.test(msg)) return bad(c, msg, 404)
    if (e?.code === 'HISTORY_VAULT_WRITER_ACTIVE') return bad(c, msg, 409, e.code)
    return bad(c, msg, 500, stableErrorCode(e))
  }
})

// ---- /restore ----
// Overwrite a single file's working-tree content with the blob at
// `ref`. The file's git history is NOT touched — only the on-disk
// version changes, so the user gets the diff they were looking at
// as the new working state and can commit it themselves.
//
// Body: { path: string, ref: string }
// The caller is responsible for confirming the destructive overwrite
// in the UI; we don't gate on a `confirm` flag here because the UI
// already has the diff on screen, so the user has seen what they're
// about to replace.
//
// Returns: { path, ref, raw, mtime } on success. 404 if the file does not exist
// at that ref, 400 if the path/ref is malformed / missing.
history.post('/restore', async (c) => {
  if (!(await probeGit())) return bad(c, 'git not available', 503)
  const body = await c.req.json().catch(() => null) as
    | { path?: unknown; ref?: unknown }
    | null
  if (!body) return bad(c, 'body required')
  if (typeof body.path !== 'string' || body.path.length === 0) {
    return bad(c, 'path required')
  }
  if (typeof body.ref !== 'string' || body.ref.length === 0) {
    return bad(c, 'ref required')
  }
  const validPath = validPathParam(c, body.path)
  if (validPath instanceof Response) return validPath
  const historyError = rejectEncryptedDiaryHistory(c, validPath)
  if (historyError) return historyError
  const bodyAccess = requireDiaryBodyAccess(c, validPath)
  if (bodyAccess) return bodyAccess
  if (body.ref !== git.WORKTREE_REF && !isValidHistoryRef(body.ref)) return bad(c, 'invalid ref')
  try {
    // WORKTREE is a sentinel meaning "the file as it sits on disk".
    // Restoring TO the working tree is a no-op (you can't restore to
    // the thing you're overwriting). Reject explicitly so the caller
    // gets a clean 400 instead of a confusing git stderr.
    if (body.ref === git.WORKTREE_REF) {
      return bad(c, 'cannot restore to the working tree', 400)
    }
    const result = await restoreHistoricalDocument({
      repoRoot: repoRoot(),
      path: validPath,
      ref: body.ref,
      db: metadataDb(),
      beforeMutation: () => historyMutationHooks?.beforeMutation?.('restore'),
      beforeCommit: () => historyMutationHooks?.beforeRestoreCommit?.(),
      afterPrepare: () => historyMutationHooks?.afterRestorePrepare?.(),
      afterCommit: () => historyMutationHooks?.afterRestoreCommit?.(),
    })
    return c.json(result)
  } catch (e: any) {
    const msg = e.message ?? 'restore failed'
    if (e instanceof HistoryRestoreConflictError) {
      return bad(c, msg, 409, e.code)
    }
    if (e instanceof HistoryMetadataError) {
      return bad(c, msg, 409, e.code)
    }
    if (e instanceof FolderMovePathOwnedError) {
      return bad(c, msg, 409, 'HISTORY_PATH_MOVED')
    }
    if (e instanceof HistoryRestoreNotFoundError) {
      return bad(c, msg, 404)
    }
    if (e instanceof ManagedDiaryHistoryRestoreUnsupportedError) {
      return bad(c, msg, 422, e.code)
    }
    if (e instanceof DocumentMutationPolicyError) {
      return bad(c, msg, 422, e.code)
    }
    return bad(c, msg, 500, stableErrorCode(e))
  }
})

export default history
