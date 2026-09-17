// Tests for the AI tool surface in server/ai/tools.ts.
//
// Pattern: a fresh temp dir per test, `setContentDir` to redirect
// the workspace root, exercise the executor (or readPostIfExists
// directly), then restore the original CONTENT_DIR and clean up.
// This mirrors the `fs.mkdtemp` pattern used by `tree.test.ts` and
// keeps the test files completely out of the real `src/content/`.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setContentDir, CONTENT_DIR } from '../paths'
import {
  TOOL_DEFINITIONS,
  executeToolCall,
  readPostIfExists,
  __setRenameRaceHooksForTesting,
  type ToolContext,
} from '../ai/tools'
import { applyMigrations } from '../db'
import { getDocumentMetadata, saveDocumentMetadata, snapshotDocumentMetadataDatabase } from '../documentMetadata'
import { applyTagOperation, previewTagOperation, type TagOperationRequest } from '../tagManagement'
import { applyTagUndo, getTagUndoAvailability, previewTagUndo } from '../tagUndo'
import { __resetLinkIndexForTesting, getIndex as getLinkIndex, LinkIndex } from '../linkIndex'
import {
  documentWriteLockWaitersForTesting,
  pendingDocumentWriteLocksForTesting,
  VAULT_STRUCTURE_LOCK,
} from '../documentWriteLock'
import {
  deriveToolSafetyPolicy,
  type ToolSafetyPolicy,
} from '../ai/tool-safety'
import type { AiLiveContextSnapshot } from '../../src/composables/vault/aiLiveContext'

const ORIGINAL_CONTENT_DIR = CONTENT_DIR

function makeTempContentDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvyn-tools-test-'))
  const content = path.join(tmp, 'content')
  fs.mkdirSync(content, { recursive: true })
  return content
}

function writeFile(relPath: string, content: string): string {
  const abs = path.join(CONTENT_DIR, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return abs
}

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
applyMigrations(db)
const ctx: ToolContext = { signal: new AbortController().signal, db }

beforeEach(() => {
  db.exec('DELETE FROM metadata_migrations; DELETE FROM documents; DELETE FROM tags;')
})

afterAll(() => db.close())

// --- readPostIfExists -------------------------------------------------------

describe('readPostIfExists', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir) })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('returns null for a non-existent file', () => {
    expect(readPostIfExists('nope/missing')).toBeNull()
  })

  it('returns parsed {raw, content, frontmatter, stat} for a real file', () => {
    writeFile('a/note.md', '---\ntitle: hi\n---\n\nbody text\n')
    const r = readPostIfExists('a/note')
    expect(r).not.toBeNull()
    expect(r!.raw).toContain('body text')
    expect(r!.content.trim()).toBe('body text')
    expect(r!.frontmatter).toEqual({ title: 'hi' })
    expect(r!.stat.size).toBeGreaterThan(0)
  })

  it('throws for an unsafe path (rejects traversal)', () => {
    expect(() => readPostIfExists('../escape')).toThrow(/invalid path/)
  })
})

// --- read_file --------------------------------------------------------------

describe('read_file', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir) })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('returns body and database metadata separately', async () => {
    writeFile('a/note.md', '---\ntitle: hi\n---\n\nbody text\n')
    saveDocumentMetadata(db, { path: 'a/note', title: 'Database title', summary: 'Stored summary', tags: ['db'] })
    const r = await executeToolCall('read_file', { path: 'a/note' }, ctx)
    expect(r.isError).toBe(false)
    const payload = JSON.parse(r.content)
    expect(payload.path).toBe('a/note')
    expect(payload.content.trim()).toBe('body text')
    expect(payload.metadata).toMatchObject({ title: 'Database title', summary: 'Stored summary', tags: ['db'] })
    expect(payload.legacyFrontmatter).toEqual({ title: 'hi' })
    expect(payload.raw).toBeUndefined()
    expect(payload.size).toBeGreaterThan(0)
    expect(typeof payload.mtime).toBe('number')
  })

  it('returns is_error when the file does not exist', async () => {
    const r = await executeToolCall('read_file', { path: 'nope/missing' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/does not exist/)
  })

  it('returns is_error when path is missing', async () => {
    const r = await executeToolCall('read_file', {}, ctx)
    expect(r.isError).toBe(true)
  })

  it('returns is_error for an unsafe path', async () => {
    const r = await executeToolCall('read_file', { path: '../escape' }, ctx)
    expect(r.isError).toBe(true)
  })

  it('fails closed for managed Diary body reads and writes without the session capability', async () => {
    writeFile('diary/2000-05-03.md', 'private diary body')
    const lockedContext: ToolContext = {
      ...ctx,
      diaryBodyAccess: () => false,
    }

    const read = await executeToolCall('read_file', { path: 'diary/2000-05-03' }, lockedContext)
    const write = await executeToolCall('write_file', {
      path: 'diary/2000-05-03',
      content: 'should not be written',
    }, lockedContext)

    expect(read.isError).toBe(true)
    expect(read.content).toContain('diary-locked')
    expect(read.content).not.toContain('private diary body')
    expect(write.isError).toBe(true)
    expect(fs.readFileSync(path.join(contentDir, 'diary/2000-05-03.md'), 'utf8'))
      .toBe('private diary body')
  })
})

// --- list_files -------------------------------------------------------------

describe('list_files', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir) })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('lists the root when scope is missing', async () => {
    fs.mkdirSync(path.join(contentDir, 'a'), { recursive: true })
    fs.mkdirSync(path.join(contentDir, 'b'), { recursive: true })
    writeFile('c.md', 'x')
    const r = await executeToolCall('list_files', {}, ctx)
    expect(r.isError).toBe(false)
    const list = JSON.parse(r.content) as { path: string; isDir: boolean }[]
    const names = list.map((e) => e.path).sort()
    expect(names).toEqual(['a', 'b', 'c'])
  })

  it('lists entries in a subdirectory', async () => {
    fs.mkdirSync(path.join(contentDir, 'a'), { recursive: true })
    writeFile('a/x.md', 'x')
    writeFile('a/y.md', 'y')
    const r = await executeToolCall('list_files', { scope: 'a' }, ctx)
    expect(r.isError).toBe(false)
    const list = JSON.parse(r.content) as { path: string; isDir: boolean }[]
    expect(list.map((e) => e.path).sort()).toEqual(['a/x', 'a/y'])
  })

  it('returns is_error for a missing directory', async () => {
    const r = await executeToolCall('list_files', { scope: 'nope' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/does not exist/)
  })
})

// --- create_file ------------------------------------------------------------

describe('create_file', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir) })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('creates a new file and reports a write change', async () => {
    const r = await executeToolCall('create_file', { path: 'a/new', content: 'hello' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.changed?.kind).toBe('write')
    expect(r.changed?.path).toBe('a/new')
    expect(fs.readFileSync(path.join(contentDir, 'a/new.md'), 'utf8')).toBe('hello')
    expect(getDocumentMetadata(db, 'a/new')?.title).toBe('new')
  })

  it('fails if the file already exists', async () => {
    writeFile('a/exists.md', 'old')
    const r = await executeToolCall('create_file', { path: 'a/exists', content: 'new' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/already exists/)
    expect(fs.readFileSync(path.join(contentDir, 'a/exists.md'), 'utf8')).toBe('old')
  })

  it('rejects YAML Frontmatter', async () => {
    const r = await executeToolCall('create_file', { path: 'a/yaml', content: '---\ntitle: Wrong\n---\n\nBody' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/update_metadata/)
    expect(fs.existsSync(path.join(contentDir, 'a/yaml.md'))).toBe(false)
  })

  it('can create a note directly in archive', async () => {
    const r = await executeToolCall('create_file', { path: 'archive/new', content: 'created' }, ctx)
    expect(r.isError).toBe(false)
    expect(fs.readFileSync(path.join(contentDir, 'archive/new.md'), 'utf8')).toBe('created')
  })

  it('restores an absent file, its old documentId, and migrations exactly when metadata commit fails', async () => {
    saveDocumentMetadata(db, { id: 'old-document-id', path: 'a/ghost', title: 'Old', tags: ['keep'] })
    db.prepare(`INSERT INTO metadata_migrations
      (path, document_id, original_path, status, source_hash, error, updated_at, frontmatter_backup, cleaned_hash)
      VALUES (?, ?, '', 'cleaned', 'source', '', 11, 'backup', 'cleaned')`)
      .run('a/ghost', 'old-document-id')
    const before = snapshotDocumentMetadataDatabase(db)
    db.exec(`CREATE TRIGGER fail_new_ghost_metadata BEFORE INSERT ON documents
      WHEN NEW.path = 'a/ghost' AND NEW.title != 'Old'
      BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END`)
    try {
      const result = await executeToolCall('create_file', { path: 'a/ghost', content: 'new body' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/injected metadata failure/)
      expect(fs.existsSync(path.join(contentDir, 'a/ghost.md'))).toBe(false)
      expect(snapshotDocumentMetadataDatabase(db)).toEqual(before)
      expect(getDocumentMetadata(db, 'a/ghost')?.id).toBe('old-document-id')
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_new_ghost_metadata')
    }
  })

  it('never replaces a file an external writer lands between the check and the create', async () => {
    // create_file commits through link(2) (create-only): if an
    // external writer lands the target after the exists-check, the
    // commit fails with EEXIST and the external bytes must survive.
    const link = vi.spyOn(fs.promises, 'link').mockImplementationOnce(async (_existing, newPath) => {
      await fs.promises.writeFile(String(newPath), 'external writer', 'utf8')
      throw Object.assign(new Error('link EEXIST'), { code: 'EEXIST' })
    })
    try {
      const result = await executeToolCall('create_file', { path: 'a/race', content: 'ai body' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/EEXIST/)
      expect(fs.readFileSync(path.join(contentDir, 'a/race.md'), 'utf8')).toBe('external writer')
      expect(getDocumentMetadata(db, 'a/race')).toBeFalsy()
    } finally {
      link.mockRestore()
    }
  })
})

// --- write_file -------------------------------------------------------------

describe('write_file', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir) })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('overwrites an existing file', async () => {
    writeFile('a/x.md', 'old')
    const r = await executeToolCall('write_file', { path: 'a/x', content: 'new' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.changed?.kind).toBe('write')
    expect(fs.readFileSync(path.join(contentDir, 'a/x.md'), 'utf8')).toBe('new')
    expect(getDocumentMetadata(db, 'a/x')?.updatedAt).toBeGreaterThan(0)
  })

  it('creates a new file in a fresh subdirectory', async () => {
    const r = await executeToolCall('write_file', { path: 'deep/nested/x', content: 'x' }, ctx)
    expect(r.isError).toBe(false)
    expect(fs.readFileSync(path.join(contentDir, 'deep/nested/x.md'), 'utf8')).toBe('x')
  })

  it('returns is_error for an unsafe path', async () => {
    const r = await executeToolCall('write_file', { path: '../escape', content: 'x' }, ctx)
    expect(r.isError).toBe(true)
  })

  it('may update an archived note and create another one', async () => {
    writeFile('archive/existing.md', 'old')
    const update = await executeToolCall('write_file', { path: 'archive/existing', content: 'new' }, ctx)
    const create = await executeToolCall('write_file', { path: 'archive/new', content: 'new' }, ctx)
    expect(update.isError).toBe(false)
    expect(create.isError).toBe(false)
    expect(fs.readFileSync(path.join(contentDir, 'archive/existing.md'), 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(contentDir, 'archive/new.md'), 'utf8')).toBe('new')
  })
})

// --- patch_file -------------------------------------------------------------

describe('patch_file', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir) })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('replaces a single match', async () => {
    writeFile('a/x.md', 'hello world')
    const r = await executeToolCall('patch_file', { path: 'a/x', old_string: 'world', new_string: 'planet' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.changed?.kind).toBe('write')
    expect(fs.readFileSync(path.join(contentDir, 'a/x.md'), 'utf8')).toBe('hello planet')
  })

  it('replaces all matches when replace_all=true', async () => {
    writeFile('a/x.md', 'foo foo foo')
    const r = await executeToolCall('patch_file', { path: 'a/x', old_string: 'foo', new_string: 'bar', replace_all: true }, ctx)
    expect(r.isError).toBe(false)
    expect(fs.readFileSync(path.join(contentDir, 'a/x.md'), 'utf8')).toBe('bar bar bar')
  })

  it('fails with current body when old_string is missing', async () => {
    writeFile('a/x.md', 'hello')
    const r = await executeToolCall('patch_file', { path: 'a/x', old_string: 'nope', new_string: 'x' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/not found/)
    expect(r.content).toMatch(/hello/)
  })

  it('fails with match locations when old_string is ambiguous', async () => {
    writeFile('a/x.md', 'foo\nfoo\nfoo')
    const r = await executeToolCall('patch_file', { path: 'a/x', old_string: 'foo', new_string: 'bar' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/matches 3 times/)
    expect(r.content).toMatch(/match 1/)
  })

  it('rejects empty old_string', async () => {
    writeFile('a/x.md', 'hello')
    const r = await executeToolCall('patch_file', { path: 'a/x', old_string: '', new_string: 'x' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/non-empty/)
  })

  it('rejects identical old_string and new_string', async () => {
    writeFile('a/x.md', 'hello')
    const r = await executeToolCall('patch_file', { path: 'a/x', old_string: 'hello', new_string: 'hello' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/identical/)
  })
})

// --- delete_file ------------------------------------------------------------

describe('delete_file', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir) })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('deletes a file and reports a delete change', async () => {
    writeFile('a/x.md', 'x')
    const r = await executeToolCall('delete_file', { path: 'a/x' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.changed?.kind).toBe('delete')
    expect(r.changed?.path).toBe('a/x')
    expect(fs.existsSync(path.join(contentDir, 'a/x.md'))).toBe(false)
    expect(getDocumentMetadata(db, 'a/x')).toBeNull()
  })

  it('returns is_error when the file does not exist', async () => {
    const r = await executeToolCall('delete_file', { path: 'a/nope' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/does not exist/)
  })

  it('restores all metadata tables and the file when staged unlink fails', async () => {
    const abs = writeFile('a/fail-delete.md', 'keep me')
    saveDocumentMetadata(db, { id: 'delete-id', path: 'a/fail-delete', title: 'Keep', tags: ['tag'] })
    db.prepare(`INSERT INTO metadata_migrations
      (path, document_id, original_path, status, source_hash, error, updated_at, frontmatter_backup, cleaned_hash)
      VALUES (?, ?, '', 'cleaned', '', '', 12, '', 'hash')`)
      .run('a/fail-delete', 'delete-id')
    const before = snapshotDocumentMetadataDatabase(db)
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('injected unlink failure'), { code: 'EIO' })
    })
    try {
      const result = await executeToolCall('delete_file', { path: 'a/fail-delete' }, ctx)
      expect(result.isError).toBe(true)
      expect(fs.readFileSync(abs, 'utf8')).toBe('keep me')
      expect(snapshotDocumentMetadataDatabase(db)).toEqual(before)
    } finally {
      unlink.mockRestore()
    }
  })

  it('gives a re-used path a fresh documentId and quarantines the old generation', async () => {
    // Path-reuse identity contract: when an external writer recreates
    // the path while the staged unlink is failing, the old documentId
    // must NOT be restored onto the foreign bytes — the new file gets
    // a fresh identity and the old generation stays quarantined.
    const abs = writeFile('reuse/victim.md', '# Old\n')
    saveDocumentMetadata(db, { id: 'victim-old-id', path: 'reuse/victim', title: 'Old' })
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      fs.writeFileSync(abs, '# new generation\n', 'utf8')
      throw Object.assign(new Error('injected unlink failure'), { code: 'EIO' })
    })
    try {
      const result = await executeToolCall('delete_file', { path: 'reuse/victim' }, ctx)
      expect(result.isError).toBe(true)
      expect(fs.readFileSync(abs, 'utf8')).toBe('# new generation\n')
      const metadata = getDocumentMetadata(db, 'reuse/victim')
      expect(metadata).not.toBeNull()
      expect(metadata!.id).not.toBe('victim-old-id')
      const quarantined = fs.readdirSync(path.dirname(abs))
        .filter((name) => name.startsWith('victim.md.nuvyn-quarantine-reuse-'))
      expect(quarantined).toHaveLength(1)
      expect(fs.readFileSync(path.join(path.dirname(abs), quarantined[0]!), 'utf8')).toBe('# Old\n')
    } finally {
      unlink.mockRestore()
    }
  })

  it('refreshes the link index against the new generation when a failed-delete path is re-used', async () => {
    // Round 5: the failed delete never ran applyDelete — without an
    // applyWrite against the re-used file the process-level index would
    // keep the old generation's outbound links until a restart.
    __resetLinkIndexForTesting()
    const abs = writeFile('reuse/victim.md', '# Old\nsee [[ta]]\n')
    writeFile('ta.md', '# ta\n')
    writeFile('tb.md', '# tb\n')
    saveDocumentMetadata(db, { id: 'victim-old-id', path: 'reuse/victim', title: 'Old' })
    const before = (await getLinkIndex()).snapshot()
    expect(before.outgoing['reuse/victim']?.map((l) => l.target)).toEqual(['ta'])
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      fs.writeFileSync(abs, '# new\nsee [[tb]]\n', 'utf8')
      throw Object.assign(new Error('injected unlink failure'), { code: 'EIO' })
    })
    try {
      const result = await executeToolCall('delete_file', { path: 'reuse/victim' }, ctx)
      expect(result.isError).toBe(true)
      const after = (await getLinkIndex()).snapshot()
      expect(after.outgoing['reuse/victim']?.map((l) => l.target)).toEqual(['tb'])
    } finally {
      unlink.mockRestore()
      __resetLinkIndexForTesting()
    }
  })
})

// --- rename_file ------------------------------------------------------------

describe('rename_file', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir); __resetLinkIndexForTesting() })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); __resetLinkIndexForTesting(); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('renames a file and reports a rename change with newRaw', async () => {
    writeFile('a/old.md', 'hello')
    const r = await executeToolCall('rename_file', { path: 'a/old', new_path: 'a/new' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.changed?.kind).toBe('rename')
    expect(r.changed?.path).toBe('a/new')
    expect(r.changed?.oldPath).toBe('a/old')
    expect(r.changed?.newRaw).toBe('hello')
    expect(fs.existsSync(path.join(contentDir, 'a/old.md'))).toBe(false)
    expect(fs.readFileSync(path.join(contentDir, 'a/new.md'), 'utf8')).toBe('hello')
    expect(getDocumentMetadata(db, 'a/old')).toBeNull()
    expect(getDocumentMetadata(db, 'a/new')?.title).toBe('old')
  })

  it('rejects when source equals target', async () => {
    writeFile('a/x.md', 'x')
    const r = await executeToolCall('rename_file', { path: 'a/x', new_path: 'a/x' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/equals/)
  })

  it('rejects when the source does not exist', async () => {
    const r = await executeToolCall('rename_file', { path: 'a/nope', new_path: 'a/x' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/does not exist/)
  })

  it('rejects when the target already exists', async () => {
    writeFile('a/old.md', 'o')
    writeFile('a/new.md', 'n')
    const r = await executeToolCall('rename_file', { path: 'a/old', new_path: 'a/new' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/already exists/)
  })

  it('updates inbound references by default and reports changed files', async () => {
    writeFile('a/old.md', 'target')
    writeFile('a/source.md', 'see [[old]]')
    const r = await executeToolCall('rename_file', { path: 'a/old', new_path: 'a/new' }, ctx)
    expect(r.isError).toBe(false)
    expect(fs.readFileSync(path.join(contentDir, 'a/source.md'), 'utf8')).toBe('see [[a/new]]')
    expect(r.changes).toEqual([expect.objectContaining({ path: 'a/source', kind: 'write', newRaw: 'see [[a/new]]' })])
  })

  it('can rename without updating inbound references', async () => {
    writeFile('a/old.md', 'target')
    writeFile('a/source.md', 'see [[old]]')
    const r = await executeToolCall('rename_file', {
      path: 'a/old', new_path: 'a/new', update_references: false,
    }, ctx)
    expect(r.isError).toBe(false)
    expect(fs.readFileSync(path.join(contentDir, 'a/source.md'), 'utf8')).toBe('see [[old]]')
    expect(r.changes).toEqual([])
  })

  it('reports the final on-disk body in the rename event when the document self-references via the old path', async () => {
    // The source document links to itself via its old path. The reference
    // rewrite updates that link to the new path and writes the new body to
    // dstAbs. The rename event must report the FINAL on-disk body (which
    // now points to the new path), not the pre-rewrite `raw` captured
    // before the rename — otherwise the client would trust the wrong
    // body and disk polling would never repair it (mtime would match).
    writeFile('a/old.md', 'see [[a/old]]')
    const r = await executeToolCall('rename_file', { path: 'a/old', new_path: 'a/new' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.changed?.kind).toBe('rename')
    expect(r.changed?.path).toBe('a/new')
    expect(r.changed?.oldPath).toBe('a/old')
    // Disk final body — the self-reference has been rewritten to the new path.
    const finalBody = fs.readFileSync(path.join(contentDir, 'a/new.md'), 'utf8')
    expect(finalBody).toBe('see [[a/new]]')
    // The event's newRaw must match the disk final body byte-for-byte.
    expect(r.changed?.newRaw).toBe(finalBody)
    // newMtime must correspond to the destination's final write, not the
    // pre-rename stat. The destination was last touched by the self-ref
    // rewrite (since the self-ref is the only backlink), so its mtime is
    // the latest fs.writeFileSync timestamp.
    const finalStat = fs.statSync(path.join(contentDir, 'a/new.md'))
    expect(r.changed?.newMtime).toBe(finalStat.mtimeMs)
  })

  it('reports the final on-disk body in the rename event when an external backlink is rewritten to a different file', async () => {
    // Sanity check that even when no self-reference is involved, the
    // rename event reports the actual destination body. The destination
    // was renamed from the source (no rewrite of its own body), so the
    // pre-rewrite `raw` happens to equal the final disk body — the test
    // guarantees the event uses the re-read disk body, not a stale
    // pre-rename snapshot.
    writeFile('a/old.md', 'hello world')
    writeFile('a/source.md', 'see [[a/old]]')
    const r = await executeToolCall('rename_file', { path: 'a/old', new_path: 'a/new' }, ctx)
    expect(r.isError).toBe(false)
    const finalBody = fs.readFileSync(path.join(contentDir, 'a/new.md'), 'utf8')
    expect(finalBody).toBe('hello world')
    expect(r.changed?.newRaw).toBe(finalBody)
  })

  it('removes metadata minted for a metadata-less source and backlink when reference writing fails', async () => {
    const oldAbs = writeFile('a/old.md', 'target')
    const backlinkAbs = writeFile('a/source.md', 'see [[a/old]]')
    await getLinkIndex()
    const before = snapshotDocumentMetadataDatabase(db)
    // Reference writes are ownership-verified: the first step is the
    // takeover rename of the current generation to a private staged
    // path. Failing THAT rename injects the failure into the backlink
    // write without touching the document move (whose rename target is
    // the destination, not a staged path).
    const originalRename = fs.promises.rename.bind(fs.promises)
    const write = vi.spyOn(fs.promises, 'rename').mockImplementation(((from: unknown, to: unknown) => {
      if (String(to).includes('.nuvyn-staged-')) {
        return Promise.reject(new Error('injected backlink write failure'))
      }
      return originalRename(from as any, to as any)
    }) as typeof fs.promises.rename)
    try {
      const result = await executeToolCall('rename_file', { path: 'a/old', new_path: 'a/new' }, ctx)
      expect(result.isError).toBe(true)
      expect(fs.readFileSync(oldAbs, 'utf8')).toBe('target')
      expect(fs.readFileSync(backlinkAbs, 'utf8')).toBe('see [[a/old]]')
      expect(fs.existsSync(path.join(contentDir, 'a/new.md'))).toBe(false)
      expect(snapshotDocumentMetadataDatabase(db)).toEqual(before)
    } finally {
      write.mockRestore()
    }
  })

  it('never replaces an external file that claims the target mid-move (create-only link)', async () => {
    // Round 5: POSIX rename(2) atomically REPLACES the target, so the
    // existsSync(dstAbs) pre-check cannot protect an external editor
    // that claims the destination before the move runs. The move must
    // be create-only: link(2) fails EEXIST, the source is restored
    // untouched, and the external file wins.
    const oldAbs = writeFile('a/old.md', 'hello')
    const newAbs = path.join(contentDir, 'a/new.md')
    const link = vi.spyOn(fs.promises, 'link').mockImplementationOnce(async () => {
      fs.writeFileSync(newAbs, '# external\n', 'utf8')
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    })
    try {
      const r = await executeToolCall('rename_file', {
        path: 'a/old', new_path: 'a/new', update_references: false,
      }, ctx)
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/claimed by an external writer/)
      expect(fs.readFileSync(oldAbs, 'utf8')).toBe('hello')
      expect(fs.readFileSync(newAbs, 'utf8')).toBe('# external\n')
      expect(fs.readdirSync(path.dirname(oldAbs)).some((n) => n.includes('.nuvyn-rename-'))).toBe(false)
      // Identity never moved: metadata still bound to the source path.
      expect(getDocumentMetadata(db, 'a/new')).toBeNull()
    } finally {
      link.mockRestore()
    }
  })
})

// --- dispatcher / shape -----------------------------------------------------

describe('executeToolCall dispatcher', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir) })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('returns is_error for an unknown tool name', async () => {
    const r = await executeToolCall('nope_tool', {}, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/unknown tool/)
  })

  it('returns is_error when the signal is pre-aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await executeToolCall('read_file', { path: 'a' }, { signal: ac.signal })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/aborted/)
  })
})

describe('AI mutations with the reserved structure-lock spelling as a path', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir); __resetLinkIndexForTesting() })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); __resetLinkIndexForTesting(); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('rejects every mutation tool with an invalid-path error instead of self-deadlocking', async () => {
    // Regression: an unnormalizable tool path falls back to its raw
    // spelling as the document lock key. When that raw spelling WAS the
    // structure lock key, structural tools self-deadlocked — the outer
    // structure lock waited for an inner document lock on the same key,
    // which waited for the outer lock to release — and every later
    // membership operation queued behind the stuck structure lock. Lock
    // keys now live in separate namespaces (structure vs `document:*`),
    // so each call must return an immediate invalid-path error, never
    // hang, and leave no queued locks behind. The 2s timeout IS the
    // assertion against the deadlock.
    const calls: Array<[string, Record<string, unknown>]> = [
      ['create_file', { path: VAULT_STRUCTURE_LOCK, content: 'x' }],
      ['write_file', { path: VAULT_STRUCTURE_LOCK, content: 'x' }],
      ['delete_file', { path: VAULT_STRUCTURE_LOCK }],
      ['rename_file', { path: VAULT_STRUCTURE_LOCK, new_path: 'a/renamed' }],
      ['rename_file', { path: 'a/source', new_path: VAULT_STRUCTURE_LOCK }],
    ]
    for (const [name, input] of calls) {
      const result = await executeToolCall(name, input, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/invalid path/)
      expect(result.changed).toBeUndefined()
    }
    expect(fs.existsSync(path.join(CONTENT_DIR, `${VAULT_STRUCTURE_LOCK}.md`))).toBe(false)
    expect(documentWriteLockWaitersForTesting(VAULT_STRUCTURE_LOCK)).toBe(0)
    expect(pendingDocumentWriteLocksForTesting()).toBe(0)
  }, 2000)
})

describe('AI Diary mutation contract', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir); __resetLinkIndexForTesting() })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); __resetLinkIndexForTesting(); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  it('blocks generic Diary creation, identity changes, and delete', async () => {
    fs.mkdirSync(path.join(contentDir, 'diary'), { recursive: true })
    writeFile('diary/2000-05-01.md', '# 2000-05-01\n')
    writeFile('diary/legacy.md', '# legacy external\n')
    saveDocumentMetadata(db, { path: 'diary/2000-05-01', title: '2000-05-01' })
    writeFile('inbox/source.md', '# source\n')
    saveDocumentMetadata(db, { path: 'inbox/source', title: 'source' })

    const create = await executeToolCall('create_file', {
      path: 'diary/generic', content: '# generic\n',
    }, ctx)
    const writeMissing = await executeToolCall('write_file', {
      path: 'diary/missing', content: '# missing\n',
    }, ctx)
    const renameOut = await executeToolCall('rename_file', {
      path: 'diary/2000-05-01', new_path: 'inbox/diary-note', update_references: false,
    }, ctx)
    const renameIn = await executeToolCall('rename_file', {
      path: 'inbox/source', new_path: 'diary/2000-05-02', update_references: false,
    }, ctx)
    const renameInUnmanaged = await executeToolCall('rename_file', {
      path: 'inbox/source', new_path: 'diary/unmanaged', update_references: false,
    }, ctx)
    const cleanupOut = await executeToolCall('rename_file', {
      path: 'diary/legacy', new_path: 'inbox/legacy', update_references: false,
    }, ctx)
    const write = await executeToolCall('write_file', {
      path: 'diary/2000-05-01', content: '# edited\n',
    }, ctx)
    const deleted = await executeToolCall('delete_file', { path: 'diary/2000-05-01' }, ctx)

    expect(create.isError).toBe(true)
    expect(create.content).toMatch(/date command/)
    expect(writeMissing.isError).toBe(true)
    expect(renameOut.isError).toBe(true)
    expect(renameOut.content).toMatch(/cannot change identity/)
    expect(renameIn.isError).toBe(true)
    expect(renameIn.content).toMatch(/cannot change identity/)
    expect(renameInUnmanaged.isError).toBe(true)
    expect(renameInUnmanaged.content).toMatch(/Diary namespace/)
    expect(cleanupOut.isError).toBe(false)
    expect(write.isError).toBe(true)
    expect(deleted.isError).toBe(true)
    expect(deleted.content).toMatch(/diary-encrypted-delete-unsupported/)
    expect(fs.existsSync(path.join(contentDir, 'diary', 'generic.md'))).toBe(false)
    expect(fs.existsSync(path.join(contentDir, 'diary', 'missing.md'))).toBe(false)
    expect(fs.existsSync(path.join(contentDir, 'diary', '2000-05-01.md'))).toBe(true)
    expect(fs.existsSync(path.join(contentDir, 'inbox', 'source.md'))).toBe(true)
    expect(fs.existsSync(path.join(contentDir, 'diary', 'unmanaged.md'))).toBe(false)
    expect(fs.existsSync(path.join(contentDir, 'diary', 'legacy.md'))).toBe(false)
    expect(fs.existsSync(path.join(contentDir, 'inbox', 'legacy.md'))).toBe(true)
  })

  it('allows a Note-only rename when an unrelated managed Diary exists without reading its body', async () => {
    writeFile('notes/source.md', '# source\n')
    const diaryAbs = writeFile('diary/2000-05-04.md', 'private Diary bytes')
    saveDocumentMetadata(db, { path: 'notes/source', title: 'source' })
    saveDocumentMetadata(db, { path: 'diary/2000-05-04', title: '2000-05-04' })
    await getLinkIndex()
    const originalReader = fs.readFileSync
    const bodyReads: string[] = []
    const reader = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file).endsWith(path.join('diary', '2000-05-04.md'))) bodyReads.push(String(file))
      return originalReader(file, ...(args as [any]))
    }) as typeof fs.readFileSync)
    try {
      const result = await executeToolCall('rename_file', {
        path: 'notes/source', new_path: 'notes/renamed',
      }, {
        ...ctx,
        diaryBodyAccess: (logicalPath) => logicalPath !== 'diary/2000-05-04',
      })
      expect(result.isError).toBe(false)
      expect(result.changed).toMatchObject({ kind: 'rename', path: 'notes/renamed', oldPath: 'notes/source' })
      expect(bodyReads).toEqual([])
      expect(fs.readFileSync(diaryAbs, 'utf8')).toBe('private Diary bytes')
    } finally {
      reader.mockRestore()
    }
  })

  it('fails closed before body reads when structural discovery reports a managed Diary footprint', async () => {
    const sourceAbs = writeFile('notes/source.md', 'source')
    const diaryAbs = writeFile('diary/2000-05-05.md', 'private [[notes/source]] body')
    saveDocumentMetadata(db, { path: 'notes/source', title: 'source' })
    saveDocumentMetadata(db, { path: 'diary/2000-05-05', title: '2000-05-05' })
    __resetLinkIndexForTesting()

    const backlinks = vi.spyOn(LinkIndex.prototype, 'getBacklinks').mockImplementation((target) => (
      target === 'notes/source'
        ? [{ source: 'diary/2000-05-05', kind: 'wiki' }]
        : []
    ))

    const originalReader = fs.promises.readFile
    const diaryBodyReads: string[] = []
    const reader = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (
      file: fs.PathLike | fs.FileHandle,
      ...args: unknown[]
    ) => {
      if (String(file).endsWith(path.join('diary', '2000-05-05.md'))) {
        diaryBodyReads.push(String(file))
      }
      return originalReader(file as any, ...(args as [any]))
    }) as typeof fs.promises.readFile)
    try {
      const blocked = await executeToolCall('rename_file', {
        path: 'notes/source', new_path: 'notes/renamed',
      }, {
        ...ctx,
        diaryBodyAccess: (logicalPath) => logicalPath !== 'diary/2000-05-05',
      })

      expect(blocked.isError).toBe(true)
      expect(blocked.content).toContain('Diary body access is locked')
      expect(diaryBodyReads).toEqual([])
      expect(fs.readFileSync(sourceAbs, 'utf8')).toBe('source')
      expect(fs.readFileSync(diaryAbs, 'utf8')).toBe('private [[notes/source]] body')
      diaryBodyReads.length = 0

      const allowed = await executeToolCall('rename_file', {
        path: 'notes/source', new_path: 'notes/renamed',
      }, {
        ...ctx,
        diaryBodyAccess: () => true,
      })
      expect(allowed.isError).toBe(true)
      expect(allowed.content).toContain('encrypted managed Diary body')
      expect(diaryBodyReads).toEqual([])
      expect(fs.readFileSync(path.join(contentDir, 'diary/2000-05-05.md'), 'utf8'))
        .toBe('private [[notes/source]] body')
    } finally {
      reader.mockRestore()
      backlinks.mockRestore()
    }
  })
})

describe('TOOL_DEFINITIONS', () => {
  it('has tools with names matching the dispatch table', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(8)
    const names = TOOL_DEFINITIONS.map((t) => t.name).sort()
    expect(names).toEqual(['create_file', 'delete_file', 'list_files', 'patch_file', 'read_file', 'rename_file', 'update_metadata', 'write_file'])
    for (const t of TOOL_DEFINITIONS) {
      expect(t.parameters.type).toBe('object')
      expect(typeof t.description).toBe('string')
    }
  })
})

describe('T2-0 update_metadata writer safety', () => {
  it('keeps tags untouched for a summary-only call', async () => {
    saveDocumentMetadata(db, { path: 'ai/note', title: 'Note', tags: ['Java'], updatedAt: 100 })
    const result = await executeToolCall('update_metadata', {
      path: 'ai/note', summary: 'Summary only',
    }, ctx)
    expect(result.isError).toBe(false)
    expect(getDocumentMetadata(db, 'ai/note')).toMatchObject({ summary: 'Summary only', tags: ['Java'] })
  })

  it('uses the same set-diff provenance contract for AI tag updates', async () => {
    const saved = saveDocumentMetadata(db, { path: 'ai/note', title: 'Note', tags: ['Backend'], updatedAt: 100 })
    const backendBefore = db.prepare(`
      SELECT dt.association_id
      FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
      WHERE dt.document_id = ? AND t.normalized_name = 'backend'
    `).get(saved.id) as { association_id: number }
    const added = await executeToolCall('update_metadata', {
      path: 'ai/note', tags: ['Backend', 'Python'], expected_updated_at: saved.updatedAt,
    }, ctx)
    expect(added.isError).toBe(false)
    expect(db.prepare(`
      SELECT dt.association_id
      FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
      WHERE dt.document_id = ? AND t.normalized_name = 'backend'
    `).get(saved.id)).toEqual(backendBefore)

    const current = getDocumentMetadata(db, 'ai/note')!
    const pythonBefore = db.prepare(`
      SELECT dt.association_id
      FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
      WHERE dt.document_id = ? AND t.normalized_name = 'python'
    `).get(saved.id) as { association_id: number }
    const removed = await executeToolCall('update_metadata', {
      path: 'ai/note', tags: ['Backend', 'Vue'], expected_updated_at: current.updatedAt,
    }, ctx)
    expect(removed.isError).toBe(false)
    expect(db.prepare('SELECT 1 FROM document_tags WHERE association_id = ?').get(pythonBefore.association_id)).toBeUndefined()
    expect(db.prepare(`
      SELECT dt.association_id
      FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
      WHERE dt.document_id = ? AND t.normalized_name = 'backend'
    `).get(saved.id)).toEqual(backendBefore)
  })

  it('preserves a Merge-owned association across an AI tag addition so Undo retains the later tag', async () => {
    const source = saveDocumentMetadata(db, {
      id: 'ai-undo-source', path: 'ai/note', title: 'Note', tags: ['Java'], updatedAt: 100,
    })
    saveDocumentMetadata(db, {
      id: 'ai-undo-destination', path: 'ai/destination', title: 'Destination', tags: ['Backend'], updatedAt: 101,
    })
    const sourceTagId = (db.prepare('SELECT id FROM tags WHERE normalized_name = ?').get('java') as { id: number }).id
    const destinationTagId = (db.prepare('SELECT id FROM tags WHERE normalized_name = ?').get('backend') as { id: number }).id
    const operation: TagOperationRequest = { kind: 'merge', sourceTagId, destinationTagId }
    const ordinaryPreview = previewTagOperation(db, operation)
    await applyTagOperation(db, operation, ordinaryPreview.planFingerprint)

    const recordId = getTagUndoAvailability(db).recordId
    expect(recordId).not.toBeNull()
    const ownedBackend = db.prepare(`
      SELECT association_id
      FROM tag_undo_association_deltas
      WHERE record_id = ? AND effect = 'created-destination' AND document_id = ?
    `).get(recordId, source.id) as { association_id: number }
    const afterMerge = getDocumentMetadata(db, source.path)!
    const added = await executeToolCall('update_metadata', {
      path: source.path, tags: ['Backend', 'Python'], expected_updated_at: afterMerge.updatedAt,
    }, ctx)
    expect(added.isError).toBe(false)
    expect(db.prepare(`
      SELECT dt.association_id
      FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
      WHERE dt.document_id = ? AND t.normalized_name = 'backend'
    `).get(source.id)).toEqual(ownedBackend)

    const undoPreview = previewTagUndo(db, { recordId })
    expect(undoPreview).toMatchObject({ state: 'available', validation: 'safe', allowedToApply: true })
    await applyTagUndo(db, { recordId: recordId!, undoFingerprint: undoPreview.undoFingerprint! })
    expect(new Set(getDocumentMetadata(db, source.path)?.tags)).toEqual(new Set(['Java', 'Python']))
  })

  it('requires the read version for an explicit tag call', async () => {
    saveDocumentMetadata(db, { path: 'ai/note', title: 'Note', tags: ['Java'], updatedAt: 100 })
    const before = getDocumentMetadata(db, 'ai/note')
    const result = await executeToolCall('update_metadata', {
      path: 'ai/note', tags: ['TypeScript'],
    }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('expected_updated_at')
    expect(getDocumentMetadata(db, 'ai/note')).toEqual(before)
  })

  it('rejects stale mixed metadata without applying the title', async () => {
    saveDocumentMetadata(db, { path: 'ai/note', title: 'Original', tags: ['Java'], updatedAt: 100 })
    const staleToken = getDocumentMetadata(db, 'ai/note')!.updatedAt
    const first = await executeToolCall('update_metadata', {
      path: 'ai/note', tags: ['Live'], expected_updated_at: staleToken,
    }, ctx)
    expect(first.isError).toBe(false)
    const beforeRejected = getDocumentMetadata(db, 'ai/note')

    const stale = await executeToolCall('update_metadata', {
      path: 'ai/note', title: 'Must not land', tags: ['Stale'], expected_updated_at: staleToken,
    }, ctx)
    expect(stale.isError).toBe(true)
    expect(stale.content).toContain('METADATA_VERSION_CONFLICT')
    expect(getDocumentMetadata(db, 'ai/note')).toEqual(beforeRejected)
  })

  it.each(['rename', 'display-rename', 'merge', 'remove'] as const)(
    'keeps committed %s tag state authoritative for AI stale writers',
    async (kind) => {
      const initialTags = kind === 'merge' ? ['Java', 'Backend'] : ['Java']
      const expectedTags = kind === 'rename' ? ['Backend']
        : kind === 'display-rename' ? ['JAVA']
          : kind === 'merge' ? ['Backend']
            : []
      const saved = saveDocumentMetadata(db, {
        path: 'ai/writer-matrix',
        title: 'Original',
        tags: initialTags,
        updatedAt: 100,
      })
      const sourceTagId = (db.prepare(
        'SELECT id FROM tags WHERE normalized_name = ?',
      ).get('java') as { id: number }).id
      const destinationTagId = kind === 'merge'
        ? (db.prepare('SELECT id FROM tags WHERE normalized_name = ?').get('backend') as { id: number }).id
        : null
      const operation: TagOperationRequest = kind === 'rename'
        ? { kind: 'rename', sourceTagId, destinationName: 'Backend' }
        : kind === 'display-rename'
          ? { kind: 'rename', sourceTagId, destinationName: 'JAVA' }
          : kind === 'merge'
            ? { kind: 'merge', sourceTagId, destinationTagId: destinationTagId! }
            : { kind: 'remove', sourceTagId }
      const preview = previewTagOperation(db, operation)
      await applyTagOperation(db, operation, preview.planFingerprint)

      const summaryOnly = await executeToolCall('update_metadata', {
        path: saved.path,
        summary: 'Summary written after Tag Apply',
      }, ctx)
      expect(summaryOnly.isError).toBe(false)
      expect(getDocumentMetadata(db, saved.path)?.tags).toEqual(expectedTags)

      const staleExplicit = await executeToolCall('update_metadata', {
        path: saved.path,
        tags: initialTags,
        expected_updated_at: saved.updatedAt,
      }, ctx)
      expect(staleExplicit.isError).toBe(true)
      expect(staleExplicit.content).toContain('METADATA_VERSION_CONFLICT')
      expect(getDocumentMetadata(db, saved.path)?.tags).toEqual(expectedTags)

      const current = getDocumentMetadata(db, saved.path)!
      const currentExplicit = await executeToolCall('update_metadata', {
        path: saved.path,
        tags: [...current.tags, 'Current'],
        expected_updated_at: current.updatedAt,
      }, ctx)
      expect(currentExplicit.isError).toBe(false)
      expect(new Set(getDocumentMetadata(db, saved.path)?.tags)).toEqual(new Set([...expectedTags, 'Current']))
    },
  )
})

// --- Edit-10.4 tool safety --------------------------------------------------
// Integration layer: real temp vault + real DB + real executeToolCall with a
// ToolSafetyPolicy in the tool context. Pure decision logic (policy
// derivation, guard table, canonicalization) is unit-tested in
// tool-safety.test.ts; the runChat loop layer lives in chat.test.ts.

function diffSnapshot(path = 'notes/a'): AiLiveContextSnapshot {
  return {
    v: 1,
    kind: 'diff',
    capturedAt: 1,
    vaultId: 'vault-a',
    workspaceTabId: `diff:${path}`,
    readOnly: true,
    identity: { path, revisionId: 'rev-1', revisionTime: 1, currentDocumentId: 'doc-a' },
    title: 'A',
    before: { raw: 'OLD', source: 'history' },
    after: { raw: 'NEW', source: 'live-editor', dirty: false },
  } as never
}

function recoverySnapshot(view: 'content' | 'diff' = 'content', path = 'notes/a'): AiLiveContextSnapshot {
  return {
    v: 1,
    kind: 'recovery',
    capturedAt: 1,
    vaultId: 'vault-a',
    workspaceTabId: 'recovery:vault-a:doc-a',
    readOnly: true,
    identity: { recoveryId: 'r-1', documentId: 'doc-a', path, source: 'primary' },
    title: 'A',
    decisionKind: 'divergent',
    view,
    draft: { raw: 'DRAFT' },
    ...(view === 'diff' ? { disk: { documentId: 'doc-a', raw: 'DISK' } } : {}),
  } as never
}

describe('Edit-10.4 tool safety: executeToolCall with safety policy', () => {
  let contentDir: string
  beforeEach(() => { contentDir = makeTempContentDir(); setContentDir(contentDir); __resetLinkIndexForTesting() })
  afterEach(() => { setContentDir(ORIGINAL_CONTENT_DIR); __resetLinkIndexForTesting(); fs.rmSync(path.dirname(contentDir), { recursive: true, force: true }) })

  const DISK_RAW = 'ON_DISK_ORIGINAL_BODY_123'

  function ctxWith(policy: ToolSafetyPolicy): ToolContext {
    return { signal: new AbortController().signal, db, safety: policy }
  }

  function seed(relPath: string, raw: string, id: string, title: string): void {
    writeFile(`${relPath}.md`, raw)
    saveDocumentMetadata(db, { id, path: relPath, title })
  }

  function readDisk(relPath: string): string {
    return fs.readFileSync(path.join(contentDir, `${relPath}.md`), 'utf8')
  }

  const dirtyPolicy: ToolSafetyPolicy = { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'unsaved-context' }

  describe('dirty Document: same-path mutations are blocked', () => {
    beforeEach(() => seed('notes/a', DISK_RAW, 'doc-a', 'Original Title'))

    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['create_file', 'create_file', { path: 'notes/a', content: 'ATTACKER' }],
      ['write_file', 'write_file', { path: 'notes/a', content: 'ATTACKER' }],
      ['patch_file', 'patch_file', { path: 'notes/a', old_string: 'ON_DISK', new_string: 'ATTACKER' }],
      ['delete_file', 'delete_file', { path: 'notes/a' }],
      ['update_metadata', 'update_metadata', { path: 'notes/a', title: 'ATTACKER' }],
      ['rename_file (protected source)', 'rename_file', { path: 'notes/a', new_path: 'notes/b' }],
      ['rename_file (protected destination)', 'rename_file', { path: 'notes/z', new_path: 'notes/a' }],
    ]

    it.each(cases)('blocks %s with active-context-unsaved, byte-exact disk, no change descriptors', async (_label, tool, input) => {
      writeFile('notes/z.md', 'Z_BODY')
      const r = await executeToolCall(tool, input, ctxWith(dirtyPolicy))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-unsaved')
      expect(r.content).toContain('notes/a')
      // No file_changed material reaches the chat loop.
      expect(r.changed).toBeUndefined()
      expect(r.changes).toBeUndefined()
      // Disk and metadata untouched, byte for byte.
      expect(readDisk('notes/a')).toBe(DISK_RAW)
      expect(readDisk('notes/z')).toBe('Z_BODY')
      expect(fs.existsSync(path.join(contentDir, 'notes/b.md'))).toBe(false)
      expect(getDocumentMetadata(db, 'notes/a')?.title).toBe('Original Title')
      // No raw body in the error text.
      expect(r.content).not.toContain(DISK_RAW)
      expect(r.content).not.toContain('Z_BODY')
    })
  })

  describe('read-only contexts: Diff / Recovery content / Recovery diff', () => {
    beforeEach(() => seed('notes/a', DISK_RAW, 'doc-a', 'Original Title'))

    const contexts: Array<[string, AiLiveContextSnapshot]> = [
      ['Diff', diffSnapshot()],
      ['Recovery content', recoverySnapshot('content')],
      ['Recovery diff', recoverySnapshot('diff')],
    ]

    it.each(contexts)('%s: write_file on the protected path is blocked read-only', async (_label, snapshot) => {
      const policy = deriveToolSafetyPolicy({ kind: 'live', liveContext: snapshot })
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'ATTACKER' }, ctxWith(policy))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-read-only')
      expect(r.changed).toBeUndefined()
      expect(readDisk('notes/a')).toBe(DISK_RAW)
    })

    it.each(contexts)('%s: read_file and list_files stay allowed', async (_label, snapshot) => {
      const policy = deriveToolSafetyPolicy({ kind: 'live', liveContext: snapshot })
      const read = await executeToolCall('read_file', { path: 'notes/a' }, ctxWith(policy))
      expect(read.isError).toBe(false)
      const list = await executeToolCall('list_files', {}, ctxWith(policy))
      expect(list.isError).toBe(false)
    })

    it.each(contexts)('%s: unrelated write_file keeps original behavior', async (_label, snapshot) => {
      const policy = deriveToolSafetyPolicy({ kind: 'live', liveContext: snapshot })
      const r = await executeToolCall('write_file', { path: 'notes/other', content: 'fresh' }, ctxWith(policy))
      expect(r.isError).toBe(false)
      expect(r.changed?.kind).toBe('write')
      expect(readDisk('notes/other')).toBe('fresh')
    })
  })

  describe('external conflict: blocked with no raw leakage', () => {
    const EXTERNAL_RAW = 'EXTERNAL_RAW_SECRET_999'
    const policy: ToolSafetyPolicy = { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'external-conflict' }

    it('blocks write_file and leaks neither the local nor the external raw', async () => {
      seed('notes/a', DISK_RAW, 'doc-a', 'Original Title')
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'ATTACKER' }, ctxWith(policy))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-external-conflict')
      expect(r.content).not.toContain(DISK_RAW)
      expect(r.content).not.toContain(EXTERNAL_RAW)
      expect(r.changed).toBeUndefined()
      expect(readDisk('notes/a')).toBe(DISK_RAW)
    })
  })

  describe('unstable transient save state', () => {
    const policy: ToolSafetyPolicy = { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'unstable-context' }

    it('blocks patch_file with active-context-unstable', async () => {
      seed('notes/a', DISK_RAW, 'doc-a', 'Original Title')
      const r = await executeToolCall('patch_file', { path: 'notes/a', old_string: 'ON_DISK', new_string: 'X' }, ctxWith(policy))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-unstable')
      expect(readDisk('notes/a')).toBe(DISK_RAW)
    })
  })

  describe('verify-clean-document: server identity and raw are re-verified at call time', () => {
    const CLEAN_RAW = 'CLEAN_DISK_RAW_555'
    const cleanPolicy = (overrides: Partial<Extract<ToolSafetyPolicy, { kind: 'verify-clean-document' }>> = {}): ToolSafetyPolicy => ({
      kind: 'verify-clean-document',
      protectedPath: 'notes/a',
      expectedDocumentId: 'doc-clean',
      expectedRaw: CLEAN_RAW,
      ...overrides,
    })

    it('allows write_file when identity and raw match', async () => {
      seed('notes/a', CLEAN_RAW, 'doc-clean', 'A')
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'updated body' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(false)
      expect(r.changed?.kind).toBe('write')
      expect(r.changed?.path).toBe('notes/a')
      expect(readDisk('notes/a')).toBe('updated body')
    })

    it('allows patch_file when identity and raw match', async () => {
      seed('notes/a', CLEAN_RAW, 'doc-clean', 'A')
      const r = await executeToolCall('patch_file', { path: 'notes/a', old_string: 'CLEAN_DISK_RAW', new_string: 'PATCHED_RAW' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(false)
      expect(r.changed?.kind).toBe('write')
      expect(readDisk('notes/a')).toBe('PATCHED_RAW_555')
    })

    it('allows update_metadata when identity and raw match', async () => {
      seed('notes/a', CLEAN_RAW, 'doc-clean', 'A')
      const r = await executeToolCall('update_metadata', { path: 'notes/a', title: 'New Title' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(false)
      expect(getDocumentMetadata(db, 'notes/a')?.title).toBe('New Title')
      expect(readDisk('notes/a')).toBe(CLEAN_RAW)
    })

    it('allows rename_file when identity and raw match', async () => {
      seed('notes/a', CLEAN_RAW, 'doc-clean', 'A')
      const r = await executeToolCall('rename_file', { path: 'notes/a', new_path: 'notes/c' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(false)
      expect(r.changed?.kind).toBe('rename')
      expect(fs.existsSync(path.join(contentDir, 'notes/a.md'))).toBe(false)
      expect(readDisk('notes/c')).toBe(CLEAN_RAW)
    })

    it('allows delete_file when identity and raw match', async () => {
      seed('notes/a', CLEAN_RAW, 'doc-clean', 'A')
      const r = await executeToolCall('delete_file', { path: 'notes/a' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(false)
      expect(r.changed?.kind).toBe('delete')
      expect(fs.existsSync(path.join(contentDir, 'notes/a.md'))).toBe(false)
    })

    it('blocks with identity-mismatch when the path belongs to a different document, even with identical raw', async () => {
      // Path reuse: same body on disk, DIFFERENT document identity than
      // the snapshot. Identical raw must NOT rescue the mutation.
      seed('notes/a', CLEAN_RAW, 'doc-SOMEONE-ELSE', 'A')
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'ATTACKER' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-identity-mismatch')
      expect(readDisk('notes/a')).toBe(CLEAN_RAW)
      // Neither the expected nor the current document id leaks.
      expect(r.content).not.toContain('doc-clean')
      expect(r.content).not.toContain('doc-SOMEONE-ELSE')
    })

    it('blocks with stale when the on-disk raw changed after the snapshot', async () => {
      seed('notes/a', 'CHANGED_ON_DISK_777', 'doc-clean', 'A')
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'ATTACKER' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-stale')
      expect(readDisk('notes/a')).toBe('CHANGED_ON_DISK_777')
      expect(r.content).not.toContain('CHANGED_ON_DISK_777')
      expect(r.content).not.toContain(CLEAN_RAW)
    })

    it('a blocked stale mutation leaves the metadata row, tags, and updatedAt untouched', async () => {
      // Verification is a PURE READ: a mutation blocked as stale must
      // not advance updatedAt, re-touch tags, or otherwise modify the
      // documents row while deciding. Snapshot the full hydrated row
      // (id, path, title, summary, tags, createdAt, updatedAt) before
      // the blocked call and require byte-identical equality after.
      saveDocumentMetadata(db, { id: 'doc-clean', path: 'notes/a', title: 'A', summary: 'S', tags: ['alpha', 'beta'] })
      writeFile('notes/a.md', CLEAN_RAW)
      const before = getDocumentMetadata(db, 'notes/a')
      writeFile('notes/a.md', 'CHANGED_ON_DISK_777')
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'ATTACKER' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-stale')
      expect(getDocumentMetadata(db, 'notes/a')).toEqual(before)
    })

    it('blocks with unverifiable when the file is missing — write_file must NOT recreate it', async () => {
      // No file on disk; the snapshot still claims notes/a.
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'ATTACKER' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-unverifiable')
      expect(fs.existsSync(path.join(contentDir, 'notes/a.md'))).toBe(false)
    })

    it('blocks with unverifiable when the document row has no identity', async () => {
      seed('notes/a', CLEAN_RAW, 'doc-clean', 'A')
      db.prepare("UPDATE documents SET id = '' WHERE path = 'notes/a'").run()
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'ATTACKER' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-unverifiable')
      expect(readDisk('notes/a')).toBe(CLEAN_RAW)
    })

    it('blocks with unverifiable when the file exists but has NO documents row — and creates none', async () => {
      // File on disk, metadata row completely missing. Verification
      // must fail closed as unverifiable and must NOT repair server
      // state: a blocked call may not create a documents row (that
      // would mint a fresh identity inside a mutation it refused).
      writeFile('notes/a.md', CLEAN_RAW)
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'ATTACKER' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-unverifiable')
      expect(readDisk('notes/a')).toBe(CLEAN_RAW)
      const rows = db.prepare("SELECT COUNT(*) AS c FROM documents WHERE path = 'notes/a'").get() as { c: number }
      expect(rows.c).toBe(0)
    })

    it('blocks with unverifiable when the file is unreadable (path is a directory)', async () => {
      fs.mkdirSync(path.join(contentDir, 'notes/a.md'), { recursive: true })
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'ATTACKER' }, ctxWith(cleanPolicy()))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-unverifiable')
    })
  })

  describe('unrelated paths keep original behavior under every deny reason', () => {
    const reasons: Array<[string, ToolSafetyPolicy]> = [
      ['unsaved-context', { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'unsaved-context' }],
      ['read-only-context', { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'read-only-context' }],
      ['external-conflict', { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'external-conflict' }],
      ['unstable-context', { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'unstable-context' }],
    ]

    it.each(reasons)('%s: write/create/update_metadata/rename on notes/b all succeed', async (_reason, policy) => {
      seed('notes/a', DISK_RAW, 'doc-a', 'Protected')
      seed('notes/b', 'B_BODY', 'doc-b', 'B Title')
      const c = ctxWith(policy)

      const write = await executeToolCall('write_file', { path: 'notes/b', content: 'B_NEW' }, c)
      expect(write.isError).toBe(false)
      expect(write.changed?.kind).toBe('write')

      const create = await executeToolCall('create_file', { path: 'notes/b2', content: 'B2' }, c)
      expect(create.isError).toBe(false)

      const meta = await executeToolCall('update_metadata', { path: 'notes/b', title: 'B Renamed' }, c)
      expect(meta.isError).toBe(false)
      expect(getDocumentMetadata(db, 'notes/b')?.title).toBe('B Renamed')

      const rename = await executeToolCall('rename_file', { path: 'notes/b', new_path: 'notes/c' }, c)
      expect(rename.isError).toBe(false)
      expect(rename.changed?.kind).toBe('rename')
      expect(readDisk('notes/c')).toBe('B_NEW')

      // The protected path is untouched throughout.
      expect(readDisk('notes/a')).toBe(DISK_RAW)
    })
  })

  describe('rename_file guards both source and destination', () => {
    beforeEach(() => {
      seed('notes/a', DISK_RAW, 'doc-a', 'Protected')
      seed('notes/z', 'Z_BODY', 'doc-z', 'Z Title')
    })

    it('blocks protected source → unrelated destination', async () => {
      const r = await executeToolCall('rename_file', { path: 'notes/a', new_path: 'notes/b' }, ctxWith(dirtyPolicy))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-unsaved')
      expect(readDisk('notes/a')).toBe(DISK_RAW)
      expect(fs.existsSync(path.join(contentDir, 'notes/b.md'))).toBe(false)
    })

    it('blocks unrelated source → protected destination', async () => {
      const r = await executeToolCall('rename_file', { path: 'notes/z', new_path: 'notes/a' }, ctxWith(dirtyPolicy))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-unsaved')
      expect(readDisk('notes/z')).toBe('Z_BODY')
      expect(readDisk('notes/a')).toBe(DISK_RAW)
    })

    it('blocks when the protected path is spelled with a trailing .md', async () => {
      const asDest = await executeToolCall('rename_file', { path: 'notes/z', new_path: 'notes/a.md' }, ctxWith(dirtyPolicy))
      expect(asDest.isError).toBe(true)
      expect(asDest.content).toContain('active-context-unsaved')
      const asSource = await executeToolCall('rename_file', { path: 'notes/a.md', new_path: 'notes/b' }, ctxWith(dirtyPolicy))
      expect(asSource.isError).toBe(true)
      expect(asSource.content).toContain('active-context-unsaved')
      expect(readDisk('notes/a')).toBe(DISK_RAW)
      expect(readDisk('notes/z')).toBe('Z_BODY')
    })

    it('allows unrelated source → unrelated destination', async () => {
      seed('notes/q', 'Q_BODY', 'doc-q', 'Q Title')
      const r = await executeToolCall('rename_file', { path: 'notes/q', new_path: 'notes/y' }, ctxWith(dirtyPolicy))
      expect(r.isError).toBe(false)
      expect(r.changed?.kind).toBe('rename')
      expect(readDisk('notes/y')).toBe('Q_BODY')
    })
  })

  describe('rename_file backlink footprint: indirect writes to the protected document are guarded', () => {
    // rename_file does not only move source → destination: with
    // update_references (default true) it also rewrites EVERY file
    // that links to the source. The safety footprint must cover those
    // backlink files too — an "unrelated" rename whose reference
    // rewrite would modify the protected document is NOT unrelated.

    it('blocks an unrelated rename whose reference rewrite would modify the dirty protected document', async () => {
      // notes/a is protected (dirty) and contains [[notes/b]]. Renaming
      // notes/b → notes/c looks unrelated by source/destination alone,
      // but the backlink rewrite would overwrite notes/a.md on disk.
      seed('notes/a', 'see [[notes/b]]', 'doc-a', 'Protected')
      seed('notes/b', 'B_BODY', 'doc-b', 'B')
      const r = await executeToolCall('rename_file', { path: 'notes/b', new_path: 'notes/c' }, ctxWith(dirtyPolicy))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-unsaved')
      // No file_changed material reaches the chat loop.
      expect(r.changed).toBeUndefined()
      expect(r.changes).toBeUndefined()
      // Both the protected backlink file AND the rename source are
      // byte-exact; the destination was never created.
      expect(readDisk('notes/a')).toBe('see [[notes/b]]')
      expect(readDisk('notes/b')).toBe('B_BODY')
      expect(fs.existsSync(path.join(contentDir, 'notes/c.md'))).toBe(false)
      expect(getDocumentMetadata(db, 'notes/a')?.title).toBe('Protected')
    })

    it('allows the same rename with update_references=false and leaves the protected document untouched', async () => {
      // No reference rewrite → the footprint is only source and
      // destination, both unrelated → the rename executes and notes/a
      // keeps its (now dangling) link.
      seed('notes/a', 'see [[notes/b]]', 'doc-a', 'Protected')
      seed('notes/b', 'B_BODY', 'doc-b', 'B')
      const r = await executeToolCall(
        'rename_file',
        { path: 'notes/b', new_path: 'notes/c', update_references: false },
        ctxWith(dirtyPolicy),
      )
      expect(r.isError).toBe(false)
      expect(r.changed?.kind).toBe('rename')
      expect(readDisk('notes/a')).toBe('see [[notes/b]]')
      expect(readDisk('notes/c')).toBe('B_BODY')
      expect(r.changes).toEqual([])
    })

    it('verify-clean: re-verifies the protected document when it would be rewritten as a backlink (allowed on match)', async () => {
      // Clean protected document whose server identity and raw still
      // match the snapshot: the backlink rewrite may proceed, but ONLY
      // after documentId + raw re-verification on notes/a itself.
      seed('notes/a', 'see [[notes/b]]', 'doc-a', 'Protected')
      seed('notes/b', 'B_BODY', 'doc-b', 'B')
      const policy: ToolSafetyPolicy = {
        kind: 'verify-clean-document',
        protectedPath: 'notes/a',
        expectedDocumentId: 'doc-a',
        expectedRaw: 'see [[notes/b]]',
      }
      const r = await executeToolCall('rename_file', { path: 'notes/b', new_path: 'notes/c' }, ctxWith(policy))
      expect(r.isError).toBe(false)
      expect(r.changed?.kind).toBe('rename')
      expect(readDisk('notes/a')).toBe('see [[notes/c]]')
      expect(r.changes).toEqual([expect.objectContaining({ path: 'notes/a', kind: 'write' })])
    })

    it('verify-clean: blocks with stale when the protected backlink document changed after the snapshot', async () => {
      seed('notes/a', 'see [[notes/b]]', 'doc-a', 'Protected')
      seed('notes/b', 'B_BODY', 'doc-b', 'B')
      // External edit lands on the protected document after the
      // snapshot: the backlink rewrite must be refused as stale and
      // leave all three files byte-exact.
      writeFile('notes/a.md', 'see [[notes/b]] + appended later')
      const policy: ToolSafetyPolicy = {
        kind: 'verify-clean-document',
        protectedPath: 'notes/a',
        expectedDocumentId: 'doc-a',
        expectedRaw: 'see [[notes/b]]',
      }
      const r = await executeToolCall('rename_file', { path: 'notes/b', new_path: 'notes/c' }, ctxWith(policy))
      expect(r.isError).toBe(true)
      expect(r.content).toContain('active-context-stale')
      expect(readDisk('notes/a')).toBe('see [[notes/b]] + appended later')
      expect(readDisk('notes/b')).toBe('B_BODY')
      expect(fs.existsSync(path.join(contentDir, 'notes/c.md'))).toBe(false)
    })
  })

  describe('rename plan atomicity: the locked plan is the guarded plan is the executed plan', () => {
    // The rename runs ONE authoritative plan: computed, locked over its
    // full footprint, re-computed inside the lock (candidate), guarded,
    // and then executed VERBATIM — the executor performs no independent
    // backlink discovery of its own. These tests simulate a concurrent
    // editor save of the protected notes/a (adds [[notes/b]] to body
    // AND link index, like a real PUT /api/posts/notes/a) landing in
    // each race window.

    async function concurrentSaveAddsLink(): Promise<void> {
      writeFile('notes/a.md', 'see [[notes/b]]')
      const idx = await getLinkIndex()
      idx.applyWrite('notes/a', 'see [[notes/b]]')
    }

    afterEach(() => __setRenameRaceHooksForTesting(null))

    const policies: Array<[string, ToolSafetyPolicy]> = [
      ['unsaved', { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'unsaved-context' }],
      ['read-only', { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'read-only-context' }],
      ['external', { kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'external-conflict' }],
      ['verify-clean', { kind: 'verify-clean-document', protectedPath: 'notes/a', expectedDocumentId: 'doc-a', expectedRaw: 'A_BODY_NO_LINK' }],
    ]

    it.each(policies)('%s: a backlink added AFTER the guarded plan is not rewritten by the executor', async (_label, policy) => {
      // notes/a has no link to notes/b while the plan is computed and
      // guarded; the concurrent save lands between the guard and the
      // executor. The stable (unrelated) plan may execute, but the
      // executor must consume that plan — never re-discover backlinks
      // and rewrite the just-added link.
      seed('notes/a', 'A_BODY_NO_LINK', 'doc-a', 'Protected')
      seed('notes/b', 'B_BODY', 'doc-b', 'B')
      __setRenameRaceHooksForTesting({ beforeExecute: concurrentSaveAddsLink })
      const r = await executeToolCall('rename_file', { path: 'notes/b', new_path: 'notes/c' }, ctxWith(policy))
      expect(r.isError).toBe(false)
      expect(r.changed).toMatchObject({ kind: 'rename', path: 'notes/c', oldPath: 'notes/b' })
      expect(readDisk('notes/c')).toBe('B_BODY')
      // notes/a holds EXACTLY the body the concurrent save wrote — the
      // tool never touched it (no [[notes/c]] rewrite, no file_changed).
      expect(readDisk('notes/a')).toBe('see [[notes/b]]')
      expect(r.changes).toEqual([])
    })

    const driftPolicies: Array<[string, ToolSafetyPolicy]> = [
      ...policies,
      ['unrestricted', { kind: 'unrestricted' }],
    ]

    it.each(driftPolicies)('%s: footprint drift inside the lock fails closed with a retryable error', async (_label, policy) => {
      // The concurrent save lands between the pre-lock plan and the
      // in-lock candidate plan: the candidate footprint now contains a
      // path the current lock set does NOT cover. The rename must fail
      // closed (never execute under an incomplete lock set) with a
      // retryable error — a retry replans from scratch and sees the new
      // reference, which then goes through the normal guard.
      seed('notes/a', 'A_BODY_NO_LINK', 'doc-a', 'Protected')
      seed('notes/b', 'B_BODY', 'doc-b', 'B')
      __setRenameRaceHooksForTesting({ beforeReplan: concurrentSaveAddsLink })
      const r = await executeToolCall('rename_file', { path: 'notes/b', new_path: 'notes/c' }, ctxWith(policy))
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/retry/i)
      // A drift failure is a concurrency hazard, not a safety block:
      // no active-context- code under ANY policy (incl. unrestricted).
      expect(r.content).not.toContain('active-context-')
      expect(readDisk('notes/b')).toBe('B_BODY')
      expect(fs.existsSync(path.join(contentDir, 'notes/c.md'))).toBe(false)
      // notes/a holds only the concurrent save's body — never a tool write.
      expect(readDisk('notes/a')).toBe('see [[notes/b]]')
      expect(r.changed).toBeUndefined()
      expect(r.changes).toBeUndefined()
    })
  })

  describe('change descriptors: blocked mutations report nothing, allowed mutations report exactly one', () => {
    it('blocked write reports no change descriptor (0 file_changed events)', async () => {
      seed('notes/a', DISK_RAW, 'doc-a', 'Protected')
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'X' }, ctxWith(dirtyPolicy))
      expect(r.isError).toBe(true)
      expect(r.changed).toBeUndefined()
      expect(r.changes).toBeUndefined()
    })

    it('allowed unrelated write reports exactly one write descriptor', async () => {
      seed('notes/a', DISK_RAW, 'doc-a', 'Protected')
      const r = await executeToolCall('write_file', { path: 'notes/b', content: 'B' }, ctxWith(dirtyPolicy))
      expect(r.isError).toBe(false)
      expect(r.changed).toMatchObject({ kind: 'write', path: 'notes/b' })
      expect(r.changes).toBeUndefined()
    })

    it('allowed verified-clean same-path write reports exactly one write descriptor', async () => {
      seed('notes/a', 'CLEAN_RAW_1', 'doc-clean', 'A')
      const policy: ToolSafetyPolicy = { kind: 'verify-clean-document', protectedPath: 'notes/a', expectedDocumentId: 'doc-clean', expectedRaw: 'CLEAN_RAW_1' }
      const r = await executeToolCall('write_file', { path: 'notes/a', content: 'next' }, ctxWith(policy))
      expect(r.isError).toBe(false)
      expect(r.changed).toMatchObject({ kind: 'write', path: 'notes/a' })
      expect(r.changes).toBeUndefined()
    })
  })

  describe('malformed and unknown calls under a deny policy', () => {
    it('malformed input fails with the tool\'s own error, not a safety code', async () => {
      seed('notes/a', DISK_RAW, 'doc-a', 'Protected')
      const r = await executeToolCall('write_file', {}, ctxWith(dirtyPolicy))
      expect(r.isError).toBe(true)
      expect(r.content).not.toContain('active-context-')
    })

    it('unknown tool fails closed with the dispatcher error', async () => {
      const r = await executeToolCall('nope_tool', { path: 'notes/a' }, ctxWith(dirtyPolicy))
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/unknown tool/)
    })
  })
})
