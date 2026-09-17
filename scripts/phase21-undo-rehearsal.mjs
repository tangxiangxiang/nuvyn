// Disposable Phase 2.1 hardening rehearsal.
//
// This intentionally exercises historical server/prod.ts entry points against
// isolated vault/data copies. It never opens the developer's vault or data
// directory, and removes every temporary worktree and runtime artifact when
// finished. It is not a product migration or a replacement for production
// backup procedures.

import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'

const execFileAsync = promisify(execFile)

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const PHASE2_BASELINE_SHA = '99f4d73154349f8ebc99cb609f1a88b07937fb26'
const FOUNDATION_SHA = 'ad5d88adc4a28b3de5e1d290356a60bc542e1309'
const ACTIVATION_SHA = '9220d634e0d4da7230dafa61c02e92107447af0c'
const CURRENT_SHA = '2fce11a227055ffa6402096af12d50a3859f604c'
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const SETUP_TOKEN = 'phase21-rehearsal-setup-token-0123456789abcdef'
const OWNER_USERNAME = 'phase21-owner'
const OWNER_PASSWORD = 'phase21-rehearsal-password-0123456789'
const HISTORY_DOCUMENT_PATH = 'inbox/note.md'
const HISTORY_H1_SUBJECT = 'phase21 history H1'
const HISTORY_H2_SUBJECT = 'phase21 history H2'
const HISTORY_H1_CONTENT = 'Phase 2.1 History H1\n'
const HISTORY_H2_CONTENT = 'Phase 2.1 History H2\n'

const worktrees = []
const activeRuntimes = new Set()
let rehearsalRoot = null

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 2.1 rehearsal assertion failed: ${message}`)
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function run(command, args, { cwd = REPO_ROOT, label = command } = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    throw new Error(`Phase 2.1 rehearsal command failed: ${label}`)
  }
}

async function git(args, options = {}) {
  return run('git', args, { ...options, label: `git ${args[0] ?? ''}` })
}

async function gitText(args, cwd) {
  return (await git(args, { cwd })).stdout.trim()
}

async function assertLockfileCompatibility(ref) {
  const [historicalLock, currentLock] = await Promise.all([
    run('git', ['show', `${ref}:package-lock.json`], { label: `read ${ref} lockfile` }),
    readFile(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
  ])
  assert(historicalLock.stdout === currentLock, `historical ${ref} lockfile differs from current dependency runtime`)
}

async function createWorktree(name, ref) {
  const destination = path.join(rehearsalRoot, 'worktrees', name)
  await git(['worktree', 'add', '--detach', destination, ref])
  worktrees.push(destination)
  await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(destination, 'node_modules'), 'dir')
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: destination,
    label: `${name} production build`,
  })
  return destination
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('could not reserve a loopback port')))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function startRuntime(label, tree, instance, revokeSessionsOnStart = false) {
  const port = await reserveLoopbackPort()
  const origin = `http://127.0.0.1:${port}`
  let output = ''
  const child = spawn(process.execPath, [TSX_CLI, 'server/prod.ts'], {
    cwd: tree,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      VAULT_DIR: instance.vault,
      NUVYN_E2E_DB_PATH: path.join(instance.data, 'nuvyn.db'),
      NUVYN_PUBLIC_ORIGIN: origin,
      NUVYN_SETUP_TOKEN: SETUP_TOKEN,
      NUVYN_AUTH_REVOKE_SESSIONS_ON_START: revokeSessionsOnStart ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const collect = (chunk) => {
    output = `${output}${chunk}`.slice(-8_192)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const runtime = { label, child, origin, output: () => output }
  activeRuntimes.add(runtime)

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok && JSON.stringify(await response.json()) === JSON.stringify({ ok: true })) return runtime
    } catch {
      // Startup has not reached the listener yet.
    }
    if (child.exitCode !== null) break
    await pause(100)
  }
  await stopRuntime(runtime)
  throw new Error(`Phase 2.1 rehearsal ${label} runtime did not become healthy`)
}

async function stopRuntime(runtime) {
  if (!runtime) return
  activeRuntimes.delete(runtime)
  const { child } = runtime
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.kill('SIGTERM')
  const result = await Promise.race([
    closed.then(() => 'closed'),
    pause(10_000).then(() => 'timeout'),
  ])
  if (result === 'timeout') {
    child.kill('SIGKILL')
    await closed
  }
}

async function api(runtime, pathname, { method = 'GET', cookie, body } = {}) {
  const headers = { accept: 'application/json' }
  if (cookie) headers.cookie = cookie
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    headers.origin = runtime.origin
  }
  const response = await fetch(`${runtime.origin}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text === '' ? null : JSON.parse(text) } catch { /* response assertion reports the status */ }
  return { response, status: response.status, json }
}

function expectStatus(result, status, label) {
  assert(result.status === status, `${label} returned HTTP ${result.status}, expected ${status}`)
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  const cookie = values.find((value) => value.startsWith('nuvyn_session='))
  assert(cookie, 'authentication response did not create a Nuvyn session')
  return cookie.split(';', 1)[0]
}

async function setupOwner(runtime) {
  const setup = await api(runtime, '/api/auth/setup', {
    method: 'POST',
    body: { bootstrapToken: SETUP_TOKEN, username: OWNER_USERNAME, password: OWNER_PASSWORD },
  })
  expectStatus(setup, 201, 'owner setup')
  assert(setup.json?.authenticated === true, 'owner setup did not authenticate the created owner')
  return cookieFrom(setup.response)
}

async function login(runtime) {
  const login = await api(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: OWNER_USERNAME, password: OWNER_PASSWORD },
  })
  expectStatus(login, 200, 'owner login')
  assert(login.json?.authenticated === true, 'owner login did not authenticate')
  return cookieFrom(login.response)
}

async function expectAuthenticated(runtime, cookie, label) {
  const status = await api(runtime, '/api/auth/status', { cookie })
  expectStatus(status, 200, `${label} auth status`)
  assert(status.json?.authenticated === true && status.json?.setupRequired === false, `${label} owner session is not active`)
}

async function postDetail(runtime, cookie, documentPath) {
  const detail = await api(runtime, `/api/posts/${documentPath}`, { cookie })
  expectStatus(detail, 200, `read ${documentPath}`)
  assert(detail.json?.metadata?.updatedAt !== undefined, `${documentPath} has no metadata version token`)
  return detail.json
}

async function createPost(runtime, cookie, documentPath, title) {
  const created = await api(runtime, '/api/posts', {
    method: 'POST', cookie, body: { path: documentPath, title },
  })
  expectStatus(created, 201, `create ${documentPath}`)
}

async function patchMetadata(runtime, cookie, documentPath, body) {
  const patched = await api(runtime, `/api/metadata/documents/${documentPath}`, {
    method: 'PATCH', cookie, body,
  })
  expectStatus(patched, 200, `patch metadata for ${documentPath}`)
  return patched.json
}

async function tagId(runtime, cookie, normalizedName) {
  const tags = await api(runtime, '/api/tags', { cookie })
  expectStatus(tags, 200, 'list managed tags')
  const found = Array.isArray(tags.json)
    ? tags.json.find((tag) => tag.normalizedName === normalizedName)
    : null
  assert(found && Number.isSafeInteger(found.id), `could not find ${normalizedName} tag`)
  return found.id
}

async function applyOperation(runtime, cookie, operation) {
  const preview = await api(runtime, '/api/tags/operations/preview', {
    method: 'POST', cookie, body: operation,
  })
  expectStatus(preview, 200, 'ordinary operation Preview')
  assert(typeof preview.json?.planFingerprint === 'string', 'ordinary operation Preview omitted its fingerprint')
  const applied = await api(runtime, '/api/tags/operations/apply', {
    method: 'POST', cookie, body: { operation, planFingerprint: preview.json.planFingerprint },
  })
  expectStatus(applied, 200, 'ordinary operation Apply')
  return applied.json
}

async function applyMerge(runtime, cookie) {
  const sourceTagId = await tagId(runtime, cookie, 'java')
  const destinationTagId = await tagId(runtime, cookie, 'backend')
  return applyOperation(runtime, cookie, { kind: 'merge', sourceTagId, destinationTagId })
}

async function fileEvidence(vault, relativePath) {
  const absolute = path.join(vault, relativePath)
  const [bytes, metadata] = await Promise.all([
    readFile(absolute),
    stat(absolute, { bigint: true }),
  ])
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mtimeNs: metadata.mtimeNs.toString(),
  }
}

async function createHistoryCommit(runtime, cookie, vault, documentPath, message) {
  const evidence = await fileEvidence(vault, documentPath)
  const committed = await api(runtime, '/api/history/commits', {
    method: 'POST',
    cookie,
    body: {
      paths: [documentPath],
      message,
      expected: { [documentPath]: evidence.sha256 },
    },
  })
  expectStatus(committed, 201, `History commit ${message}`)
  assert(typeof committed.json?.sha === 'string' && /^[0-9a-f]{40}$/.test(committed.json.sha), `History commit ${message} omitted its SHA`)
  return committed.json
}

async function readHistoryEvidence(runtime, cookie, documentPath, label) {
  const log = await api(runtime, `/api/history/log?path=${encodeURIComponent(documentPath)}`, { cookie })
  expectStatus(log, 200, `${label} History log`)
  const commits = Array.isArray(log.json?.commits) ? log.json.commits : null
  assert(commits, `${label} History log did not return a commit list`)
  const selected = commits.filter((commit) => (
    commit?.subject === HISTORY_H1_SUBJECT || commit?.subject === HISTORY_H2_SUBJECT
  ))
  assert(selected.length === 2, `${label} History log did not preserve both representative revisions`)

  const expectedContent = new Map([
    [HISTORY_H1_SUBJECT, HISTORY_H1_CONTENT],
    [HISTORY_H2_SUBJECT, HISTORY_H2_CONTENT],
  ])
  const evidence = []
  for (const commit of selected) {
    assert(typeof commit?.sha === 'string' && /^[0-9a-f]{40}$/.test(commit.sha), `${label} History revision has no valid SHA`)
    assert(Array.isArray(commit.parents), `${label} History revision has no parent list`)
    assert(Array.isArray(commit.files) && commit.files.includes(documentPath), `${label} History revision does not name ${documentPath}`)
    const file = await api(runtime, `/api/history/file?path=${encodeURIComponent(documentPath)}&ref=${encodeURIComponent(commit.sha)}`, { cookie })
    expectStatus(file, 200, `${label} History file at ${commit.subject}`)
    assert(file.json?.content === expectedContent.get(commit.subject), `${label} ${commit.subject} content was not restored through the History API`)
    evidence.push({
      sha: commit.sha,
      parents: [...commit.parents],
      subject: commit.subject,
      files: [...commit.files],
      content: file.json.content,
    })
  }
  return evidence
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function databaseSnapshot(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const associationIdsPresent = (db.prepare('PRAGMA table_info(document_tags)').all())
      .some((column) => column.name === 'association_id')
    const documents = db.prepare(`
      SELECT id, path, title, summary, created_at, updated_at
      FROM documents ORDER BY id COLLATE BINARY
    `).all()
    const tags = db.prepare(`
      SELECT id, name, normalized_name FROM tags ORDER BY id
    `).all()
    const memberships = db.prepare(`
      SELECT document_id, tag_id FROM document_tags ORDER BY document_id COLLATE BINARY, tag_id
    `).all()
    const associations = associationIdsPresent
      ? db.prepare(`
        SELECT association_id, document_id, tag_id
        FROM document_tags ORDER BY association_id
      `).all()
      : []
    const hasUndoRecords = tableExists(db, 'tag_undo_records')
    const hasUndoState = tableExists(db, 'tag_undo_state')
    return {
      version: db.prepare('SELECT version FROM schema_version').get().version,
      journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      foreignKeyCheck: db.prepare('PRAGMA foreign_key_check').all(),
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      documents,
      tags,
      memberships,
      associations,
      hasUndoRecords,
      hasUndoState,
      undoRecordCount: hasUndoRecords
        ? db.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get().count
        : 0,
      undoDeltaCount: tableExists(db, 'tag_undo_association_deltas')
        ? db.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get().count
        : 0,
      undoState: hasUndoState
        ? db.prepare(`
          SELECT database_generation, current_record_id, last_superseded_record_id
          FROM tag_undo_state WHERE state_id = 1
        `).get()
        : null,
      undoRecord: hasUndoRecords
        ? db.prepare(`
          SELECT record_id, lifecycle, database_generation, identity_contract_version, record_contract_version
          FROM tag_undo_records ORDER BY committed_at DESC, record_id DESC LIMIT 1
        `).get()
        : null,
    }
  } finally {
    db.close()
  }
}

function assertHealthyDatabase(snapshot, label) {
  assert(snapshot.journalMode === 'wal', `${label} database is not in WAL mode`)
  assert(JSON.stringify(snapshot.foreignKeyCheck) === '[]', `${label} database has foreign-key violations`)
  assert(snapshot.integrity === 'ok', `${label} database integrity check failed`)
}

async function copyInstance(source, destination) {
  await mkdir(path.dirname(destination.vault), { recursive: true })
  // Node's fs.cp preserves timestamps at its portable precision, which can
  // round a macOS nanosecond mtime. The rehearsal explicitly needs byte AND
  // mtime evidence, so use the platform archival copier for the complete
  // stopped instance. The fallback retains the same isolated, full-tree
  // behavior where an archival copier is unavailable.
  if (process.platform === 'darwin') {
    await Promise.all([
      run('ditto', [source.vault, destination.vault], { label: 'archive-copy vault' }),
      run('ditto', [source.data, destination.data], { label: 'archive-copy data' }),
    ])
    return
  }
  if (process.platform === 'linux') {
    await Promise.all([
      run('cp', ['-a', source.vault, destination.vault], { label: 'archive-copy vault' }),
      run('cp', ['-a', source.data, destination.data], { label: 'archive-copy data' }),
    ])
    return
  }
  await Promise.all([
    cp(source.vault, destination.vault, {
      recursive: true, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true,
    }),
    cp(source.data, destination.data, {
      recursive: true, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true,
    }),
  ])
}

async function replaceWithBackup(source, destination) {
  await Promise.all([
    rm(destination.vault, { recursive: true, force: true }),
    rm(destination.data, { recursive: true, force: true }),
  ])
  await copyInstance(source, destination)
}

function instance(name) {
  return {
    vault: path.join(rehearsalRoot, 'instances', name, 'vault'),
    data: path.join(rehearsalRoot, 'instances', name, 'data'),
  }
}

async function assertCompleteBackup(backup) {
  const [vaultEntries, dataEntries] = await Promise.all([
    readdir(backup.vault),
    readdir(backup.data),
  ])
  assert(vaultEntries.includes('.git'), 'complete backup omitted vault .git')
  assert(vaultEntries.includes('.nuvyn'), 'complete backup omitted vault .nuvyn')
  assert(dataEntries.includes('nuvyn.db'), 'complete backup omitted SQLite data')
}

async function initializeVault(vault) {
  await mkdir(path.join(vault, '.nuvyn'), { recursive: true })
  await writeFile(path.join(vault, '.nuvyn', 'phase21-rehearsal-marker'), 'isolated hardening rehearsal\n', 'utf8')
  // Production creates this ownership record while a server is alive. It is
  // operational state, not a History or Tag Management mutation, so make the
  // isolated Git baseline model the normal untracked-vault convention.
  await writeFile(path.join(vault, '.gitignore'), [
    '.nuvyn/vault-writer.json',
    '.nuvyn/vault-writer.takeover/',
    '.nuvyn/vault-id',
    '',
  ].join('\n'), 'utf8')
  await git(['init', '--quiet'], { cwd: vault })
  await git(['config', 'user.name', 'Nuvyn Phase 2.1 Rehearsal'], { cwd: vault })
  await git(['config', 'user.email', 'phase21-rehearsal@example.invalid'], { cwd: vault })
}

async function commitVaultBaseline(vault) {
  await git(['add', '--all'], { cwd: vault })
  await git(['commit', '--quiet', '-m', 'phase 2 rehearsal baseline'], { cwd: vault })
  const status = await gitText(['status', '--porcelain'], vault)
  assert(status === '', 'baseline vault is not clean after its initial History commit')
  return captureGitBaseline(vault)
}

async function captureGitBaseline(vault) {
  return {
    head: await gitText(['rev-parse', 'HEAD'], vault),
    history: await gitText(['log', '--format=%H'], vault),
  }
}

async function assertGitUnchanged(vault, baseline, label) {
  assert(await gitText(['rev-parse', 'HEAD'], vault) === baseline.head, `${label} changed Git HEAD`)
  assert(await gitText(['status', '--porcelain'], vault) === '', `${label} changed the Git working tree`)
  assert(await gitText(['log', '--format=%H'], vault) === baseline.history, `${label} added Git History entries`)
}

async function insertOrphanTag(dataDir) {
  const db = new Database(path.join(dataDir, 'nuvyn.db'))
  try {
    db.pragma('foreign_keys = ON')
    db.prepare('INSERT INTO tags (name, normalized_name) VALUES (?, ?)').run('Orphan', 'orphan')
  } finally {
    db.close()
  }
}

async function removeUndoState(dataDir) {
  const db = new Database(path.join(dataDir, 'nuvyn.db'))
  try {
    db.pragma('foreign_keys = ON')
    db.prepare('DELETE FROM tag_undo_state').run()
  } finally {
    db.close()
  }
}

async function assertOldUndoUnavailable(runtime, cookie, label) {
  const undo = await api(runtime, '/api/tags/undo', { cookie })
  expectStatus(undo, 404, `${label} Undo endpoint`)
}

async function runActivationBoundary({ foundationTree, activationTree, backup, cookie }) {
  const foundation = instance('foundation')
  await copyInstance(backup, foundation)
  let foundationRuntime
  try {
    foundationRuntime = await startRuntime('T2.1-0 foundation', foundationTree, foundation)
    await expectAuthenticated(foundationRuntime, cookie, 'T2.1-0 foundation')
    await assertOldUndoUnavailable(foundationRuntime, cookie, 'T2.1-0 foundation')
    const sourceTagId = await tagId(foundationRuntime, cookie, 'java')
    await applyOperation(foundationRuntime, cookie, {
      kind: 'rename', sourceTagId, destinationName: 'JAVA',
    })
  } finally {
    await stopRuntime(foundationRuntime)
  }
  const foundationSnapshot = databaseSnapshot(path.join(foundation.data, 'nuvyn.db'))
  assertHealthyDatabase(foundationSnapshot, 'T2.1-0 foundation')
  assert(foundationSnapshot.version === 8, 'T2.1-0 foundation did not install its repaired provenance schema')
  assert(foundationSnapshot.associations.length === foundationSnapshot.memberships.length, 'T2.1-0 foundation did not assign association IDs')
  assert(foundationSnapshot.undoRecordCount === 0, 'T2.1-0 foundation created a reversible record before activation')
  assert(foundationSnapshot.undoState?.current_record_id === null, 'T2.1-0 foundation advanced the Undo pointer before activation')

  const activation = instance('activation')
  const unhealthy = instance('activation-unhealthy')
  await Promise.all([copyInstance(foundation, activation), copyInstance(foundation, unhealthy)])
  let activationRuntime
  try {
    activationRuntime = await startRuntime('T2.1-1 activation', activationTree, activation)
    await expectAuthenticated(activationRuntime, cookie, 'T2.1-1 activation')
    const result = await applyMerge(activationRuntime, cookie)
    assert(result?.kind === 'merge', 'T2.1-1 activation did not complete the supported first ordinary operation')
  } finally {
    await stopRuntime(activationRuntime)
  }
  const activationSnapshot = databaseSnapshot(path.join(activation.data, 'nuvyn.db'))
  assertHealthyDatabase(activationSnapshot, 'T2.1-1 activation')
  assert(activationSnapshot.undoRecordCount === 1, 'T2.1-1 first ordinary operation did not create exactly one Undo parent')
  assert(activationSnapshot.undoDeltaCount > 0, 'T2.1-1 first Merge created no durable child deltas')
  assert(activationSnapshot.undoRecord?.lifecycle === 'latest', 'T2.1-1 first Undo parent is not latest')
  assert(activationSnapshot.undoRecord?.record_id === activationSnapshot.undoState?.current_record_id, 'T2.1-1 Undo pointer does not name the durable parent')
  assert(typeof activationSnapshot.undoRecord?.database_generation === 'string' && activationSnapshot.undoRecord.database_generation.length > 0, 'T2.1-1 Undo parent lacks a generation')
  assert(activationSnapshot.undoRecord?.identity_contract_version === 'tag-identity-v1', 'T2.1-1 Undo parent has an invalid identity contract')
  assert(activationSnapshot.undoRecord?.record_contract_version === 'tag-undo-record-v1', 'T2.1-1 Undo parent has an invalid record contract')

  const beforeUnhealthy = databaseSnapshot(path.join(unhealthy.data, 'nuvyn.db'))
  await removeUndoState(unhealthy.data)
  let unhealthyRuntime
  try {
    unhealthyRuntime = await startRuntime('T2.1-1 unhealthy foundation', activationTree, unhealthy)
    await expectAuthenticated(unhealthyRuntime, cookie, 'T2.1-1 unhealthy foundation')
    const sourceTagId = await tagId(unhealthyRuntime, cookie, 'java')
    const destinationTagId = await tagId(unhealthyRuntime, cookie, 'backend')
    const preview = await api(unhealthyRuntime, '/api/tags/operations/preview', {
      method: 'POST', cookie, body: { kind: 'merge', sourceTagId, destinationTagId },
    })
    expectStatus(preview, 200, 'unhealthy foundation ordinary Preview')
    const apply = await api(unhealthyRuntime, '/api/tags/operations/apply', {
      method: 'POST', cookie,
      body: {
        operation: { kind: 'merge', sourceTagId, destinationTagId },
        planFingerprint: preview.json.planFingerprint,
      },
    })
    expectStatus(apply, 503, 'unhealthy foundation ordinary Apply')
    assert(apply.json?.code === 'TAG_MANAGEMENT_UNAVAILABLE', 'unhealthy foundation returned the wrong fail-closed code')
  } finally {
    await stopRuntime(unhealthyRuntime)
  }
  const afterUnhealthy = databaseSnapshot(path.join(unhealthy.data, 'nuvyn.db'))
  assert(JSON.stringify(afterUnhealthy.documents) === JSON.stringify(beforeUnhealthy.documents), 'unhealthy foundation mutated document versions')
  assert(JSON.stringify(afterUnhealthy.tags) === JSON.stringify(beforeUnhealthy.tags), 'unhealthy foundation mutated the tag graph')
  assert(JSON.stringify(afterUnhealthy.memberships) === JSON.stringify(beforeUnhealthy.memberships), 'unhealthy foundation mutated tag memberships')
  assert(afterUnhealthy.undoRecordCount === 0, 'unhealthy foundation produced a record-less ordinary success')
}

async function runUpgradeBackupRestore({ oldTree, currentTree, backup, cookie, gitBaseline, originalEvidence, oldGraph, oldHistoryEvidence }) {
  const upgraded = instance('upgraded')
  await copyInstance(backup, upgraded)
  assert(JSON.stringify(await fileEvidence(upgraded.vault, 'inbox/note.md')) === JSON.stringify(originalEvidence), 'complete backup copy changed Markdown evidence before current startup')
  let currentRuntime
  try {
    currentRuntime = await startRuntime('current Phase 2.1', currentTree, upgraded)
    await expectAuthenticated(currentRuntime, cookie, 'current Phase 2.1')
    const beforeOperation = databaseSnapshot(path.join(upgraded.data, 'nuvyn.db'))
    assertHealthyDatabase(beforeOperation, 'current migrated')
    assert(beforeOperation.version === 8, 'current runtime did not apply the current 0007/0008 schema')
    assert(JSON.stringify(beforeOperation.documents) === JSON.stringify(oldGraph.documents), 'upgrade changed document identities or metadata')
    assert(JSON.stringify(beforeOperation.tags) === JSON.stringify(oldGraph.tags), 'upgrade changed tag identities')
    assert(JSON.stringify(beforeOperation.memberships) === JSON.stringify(oldGraph.memberships), 'upgrade changed logical memberships')
    assert(beforeOperation.associations.length === beforeOperation.memberships.length, 'upgrade did not assign one association ID per membership')
    assert(new Set(beforeOperation.associations.map((row) => row.association_id)).size === beforeOperation.associations.length, 'upgrade association IDs are not unique')
    assert(beforeOperation.associations.every((row) => Number.isSafeInteger(row.association_id) && row.association_id > 0), 'upgrade created an invalid association ID')
    assert(beforeOperation.undoRecordCount === 0, 'migration created an Undo record')
    assert((await fileEvidence(upgraded.vault, 'inbox/note.md')).sha256 === originalEvidence.sha256, 'upgrade changed Markdown bytes')
    assert((await fileEvidence(upgraded.vault, 'inbox/note.md')).mtimeNs === originalEvidence.mtimeNs, 'upgrade changed Markdown mtime')
    await assertGitUnchanged(upgraded.vault, gitBaseline, 'current migration')
    const currentHistoryBefore = await readHistoryEvidence(currentRuntime, cookie, HISTORY_DOCUMENT_PATH, 'current pre-management')
    assert(JSON.stringify(currentHistoryBefore) === JSON.stringify(oldHistoryEvidence), 'current startup did not expose the restored representative History revisions')

    const merge = await applyMerge(currentRuntime, cookie)
    assert(merge?.kind === 'merge', 'current runtime did not accept the old ordinary Merge request shape')
    const afterOrdinary = databaseSnapshot(path.join(upgraded.data, 'nuvyn.db'))
    assert(afterOrdinary.undoRecordCount === 1, 'current first ordinary operation did not create one Undo record')
    assert(afterOrdinary.undoDeltaCount > 0, 'current first ordinary Merge did not create child deltas')
    assert(afterOrdinary.undoRecord?.record_id === afterOrdinary.undoState?.current_record_id, 'current first record did not advance the current pointer')

    const sourceAfterMerge = await postDetail(currentRuntime, cookie, 'inbox/note')
    await patchMetadata(currentRuntime, cookie, 'inbox/note', { summary: 'later unrelated summary' })
    const availability = await api(currentRuntime, '/api/tags/undo', { cookie })
    expectStatus(availability, 200, 'current Undo availability')
    assert(availability.json?.state === 'available' && availability.json?.recordId === afterOrdinary.undoRecord.record_id, 'current Undo availability is not authoritative')
    const preview = await api(currentRuntime, '/api/tags/undo/preview', {
      method: 'POST', cookie, body: { recordId: availability.json.recordId },
    })
    expectStatus(preview, 200, 'current Undo Preview')
    assert(preview.json?.allowedToApply === true && typeof preview.json.undoFingerprint === 'string', 'current Undo Preview is not actionable')
    const undo = await api(currentRuntime, '/api/tags/undo/apply', {
      method: 'POST', cookie,
      body: { recordId: availability.json.recordId, undoFingerprint: preview.json.undoFingerprint },
    })
    expectStatus(undo, 200, 'current Undo Apply')
    const afterUndo = await api(currentRuntime, '/api/tags/undo', { cookie })
    expectStatus(afterUndo, 200, 'current consumed Undo availability')
    assert(afterUndo.json?.state === 'consumed' && afterUndo.json?.reasonCode === 'UNDO_ALREADY_APPLIED', 'current Undo did not produce consumed state')
    const sourceAfterUndo = await postDetail(currentRuntime, cookie, 'inbox/note')
    assert(sourceAfterUndo.metadata?.summary === 'later unrelated summary', 'Undo overwrote a later unrelated summary')
    assert(new Set(sourceAfterUndo.metadata?.tags).has('Java'), 'Undo did not restore the original source membership')
    assert(!new Set(sourceAfterUndo.metadata?.tags).has('Backend'), 'Undo retained the operation-owned destination membership')
    assert(sourceAfterMerge.raw === sourceAfterUndo.raw, 'metadata-only Merge/Undo changed Markdown bytes')
    assert((await fileEvidence(upgraded.vault, 'inbox/note.md')).sha256 === originalEvidence.sha256, 'Merge/Undo changed Markdown bytes')
    assert((await fileEvidence(upgraded.vault, 'inbox/note.md')).mtimeNs === originalEvidence.mtimeNs, 'Merge/Undo changed Markdown mtime')
    const currentHistoryAfter = await readHistoryEvidence(currentRuntime, cookie, HISTORY_DOCUMENT_PATH, 'current post-Undo')
    assert(JSON.stringify(currentHistoryAfter) === JSON.stringify(oldHistoryEvidence), 'Tag Management or Undo added or changed an application History revision')
    await assertGitUnchanged(upgraded.vault, gitBaseline, 'current ordinary Merge and Undo')
  } finally {
    await stopRuntime(currentRuntime)
  }

  const upgradedSnapshot = databaseSnapshot(path.join(upgraded.data, 'nuvyn.db'))
  assertHealthyDatabase(upgradedSnapshot, 'current post-Undo')
  assert(upgradedSnapshot.undoRecordCount === 1 && upgradedSnapshot.undoRecord?.lifecycle === 'consumed', 'current post-Undo record lifecycle is not durable')

  await replaceWithBackup(backup, upgraded)
  const restoredBeforeStart = databaseSnapshot(path.join(upgraded.data, 'nuvyn.db'))
  assert(restoredBeforeStart.version === 6, 'restore did not return the matching Phase 2 v6 database')
  assert(JSON.stringify(await fileEvidence(upgraded.vault, 'inbox/note.md')) === JSON.stringify(originalEvidence), 'complete restore changed Markdown evidence before old startup')
  let oldRuntime
  try {
    oldRuntime = await startRuntime('restored Phase 2', oldTree, upgraded, true)
    const revoked = await api(oldRuntime, '/api/auth/status', { cookie })
    expectStatus(revoked, 200, 'restored session revocation status')
    assert(revoked.json?.authenticated === false && revoked.json?.setupRequired === false, 'restored startup revocation did not invalidate the prior session')
    const restoredCookie = await login(oldRuntime)
    await expectAuthenticated(oldRuntime, restoredCookie, 'restored Phase 2')
    const restoredSource = await postDetail(oldRuntime, restoredCookie, 'inbox/note')
    assert(new Set(restoredSource.metadata?.tags).has('Java'), 'restored old runtime lost the source tag')
    assert(restoredSource.metadata?.summary !== 'later unrelated summary', 'restored old runtime is reading upgraded data instead of the backup')
    await assertOldUndoUnavailable(oldRuntime, restoredCookie, 'restored Phase 2')
    const restoredHistory = await readHistoryEvidence(oldRuntime, restoredCookie, HISTORY_DOCUMENT_PATH, 'restored Phase 2')
    assert(JSON.stringify(restoredHistory) === JSON.stringify(oldHistoryEvidence), 'restored old runtime did not expose the original application History revisions')
  } finally {
    await stopRuntime(oldRuntime)
  }
  const restoredSnapshot = databaseSnapshot(path.join(upgraded.data, 'nuvyn.db'))
  assertHealthyDatabase(restoredSnapshot, 'restored Phase 2')
  assert(restoredSnapshot.version === 6, 'old runtime did not remain on the restored v6 database')
  assert(JSON.stringify(restoredSnapshot.documents) === JSON.stringify(oldGraph.documents), 'restore changed document metadata')
  assert(JSON.stringify(restoredSnapshot.tags) === JSON.stringify(oldGraph.tags), 'restore changed tag identities')
  assert(JSON.stringify(restoredSnapshot.memberships) === JSON.stringify(oldGraph.memberships), 'restore changed memberships')
  assert((await fileEvidence(upgraded.vault, 'inbox/note.md')).sha256 === originalEvidence.sha256, 'restore changed Markdown checksum')
  assert((await fileEvidence(upgraded.vault, 'inbox/note.md')).mtimeNs === originalEvidence.mtimeNs, 'restore changed Markdown mtime')
  await assertGitUnchanged(upgraded.vault, gitBaseline, 'restored old runtime')
}

async function cleanup() {
  await Promise.allSettled([...activeRuntimes].map((runtime) => stopRuntime(runtime)))
  for (const worktree of [...worktrees].reverse()) {
    await git(['worktree', 'remove', '--force', worktree]).catch(() => {})
  }
  await git(['worktree', 'prune']).catch(() => {})
  if (rehearsalRoot) await rm(rehearsalRoot, { recursive: true, force: true })
}

async function main() {
  assert(
    await gitText(['merge-base', CURRENT_SHA, 'HEAD'], REPO_ROOT) === CURRENT_SHA,
    'current checkout does not include the required 2fce baseline',
  )
  await Promise.all([
    assertLockfileCompatibility(PHASE2_BASELINE_SHA),
    assertLockfileCompatibility(FOUNDATION_SHA),
    assertLockfileCompatibility(ACTIVATION_SHA),
  ])
  rehearsalRoot = await mkdtemp(path.join(os.tmpdir(), 'nuvyn-phase21-undo-rehearsal-'))
  await mkdir(path.join(rehearsalRoot, 'worktrees'), { recursive: true })
  // Git serializes worktree registration internally. Keep the production
  // builds sequential too, so the rehearsal remains deterministic on a
  // developer laptop and never races the repository's worktree metadata.
  const oldTree = await createWorktree('phase2-old', PHASE2_BASELINE_SHA)
  const foundationTree = await createWorktree('t21-foundation', FOUNDATION_SHA)
  const activationTree = await createWorktree('t21-activation', ACTIVATION_SHA)
  const currentTree = await createWorktree('current', CURRENT_SHA)

  const old = instance('old')
  await mkdir(old.data, { recursive: true })
  await initializeVault(old.vault)
  let oldRuntime
  let cookie
  try {
    oldRuntime = await startRuntime('Phase 2 baseline', oldTree, old)
    cookie = await setupOwner(oldRuntime)
    await expectAuthenticated(oldRuntime, cookie, 'Phase 2 baseline')
    await createPost(oldRuntime, cookie, 'inbox/note', 'Undo Source')
    await createPost(oldRuntime, cookie, 'inbox/destination', 'Undo Destination')
    const source = await postDetail(oldRuntime, cookie, 'inbox/note')
    const destination = await postDetail(oldRuntime, cookie, 'inbox/destination')
    await patchMetadata(oldRuntime, cookie, 'inbox/note', { tags: ['Java'], expectedUpdatedAt: source.metadata.updatedAt })
    await patchMetadata(oldRuntime, cookie, 'inbox/destination', { tags: ['Backend'], expectedUpdatedAt: destination.metadata.updatedAt })
    await assertOldUndoUnavailable(oldRuntime, cookie, 'Phase 2 baseline')
  } finally {
    await stopRuntime(oldRuntime)
  }
  await insertOrphanTag(old.data)
  await commitVaultBaseline(old.vault)
  let oldHistoryEvidence
  try {
    oldRuntime = await startRuntime('Phase 2 baseline History', oldTree, old)
    await expectAuthenticated(oldRuntime, cookie, 'Phase 2 baseline History')
    await writeFile(path.join(old.vault, HISTORY_DOCUMENT_PATH), HISTORY_H1_CONTENT, 'utf8')
    await createHistoryCommit(oldRuntime, cookie, old.vault, HISTORY_DOCUMENT_PATH, HISTORY_H1_SUBJECT)
    await writeFile(path.join(old.vault, HISTORY_DOCUMENT_PATH), HISTORY_H2_CONTENT, 'utf8')
    await createHistoryCommit(oldRuntime, cookie, old.vault, HISTORY_DOCUMENT_PATH, HISTORY_H2_SUBJECT)
    oldHistoryEvidence = await readHistoryEvidence(oldRuntime, cookie, HISTORY_DOCUMENT_PATH, 'Phase 2 baseline')
  } finally {
    await stopRuntime(oldRuntime)
  }
  const gitBaseline = await captureGitBaseline(old.vault)
  const originalEvidence = await fileEvidence(old.vault, HISTORY_DOCUMENT_PATH)
  const oldGraph = databaseSnapshot(path.join(old.data, 'nuvyn.db'))
  assertHealthyDatabase(oldGraph, 'Phase 2 baseline')
  assert(oldGraph.version === 6, 'Phase 2 baseline did not create a v6 database')
  assert(oldGraph.associations.length === 0, 'Phase 2 baseline unexpectedly contains v7 association IDs')
  assert(oldGraph.tags.some((tag) => tag.normalized_name === 'orphan'), 'Phase 2 baseline orphan tag fixture is missing')

  const backup = instance('backup')
  await copyInstance(old, backup)
  await assertCompleteBackup(backup)
  assert(JSON.stringify(await fileEvidence(backup.vault, 'inbox/note.md')) === JSON.stringify(originalEvidence), 'complete pre-upgrade backup changed Markdown evidence')
  await runActivationBoundary({ foundationTree, activationTree, backup, cookie })
  await runUpgradeBackupRestore({
    oldTree,
    currentTree,
    backup,
    cookie,
    gitBaseline,
    originalEvidence,
    oldGraph,
    oldHistoryEvidence,
  })

  console.log(JSON.stringify({
    status: 'PASS',
    phase2Baseline: PHASE2_BASELINE_SHA,
    foundation: FOUNDATION_SHA,
    activation: ACTIVATION_SHA,
    current: CURRENT_SHA,
    evidence: {
      isolatedOldRuntime: true,
      completeBackupAndRestore: true,
      noReverseMigration: true,
      activationBoundary: true,
      sessionRevocationOnRestoredStartup: true,
      applicationHistoryRestore: true,
    },
  }, null, 2))
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Phase 2.1 rehearsal failed')
  process.exitCode = 1
} finally {
  await cleanup()
}
