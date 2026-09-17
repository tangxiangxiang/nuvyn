// Edit-10.3 server-side strict validation of the client's
// AiLiveContextSnapshot wire contract. parseAiLiveContext is the ONLY
// gate between the raw request body and the system prompt: it must
// accept exactly the three sealed snapshot kinds (v: 1) and reject
// everything else — no `as` trust, no kind-only checks, no silent
// normalization, no silent truncation, and no fallback to a legacy
// path when the live context is malformed.
import { describe, it, expect } from 'vitest'
import {
  MAX_AI_LIVE_CONTEXT_BYTES,
  parseAiLiveContext,
} from '../ai/live-context'

// A NUL byte expressed without invisible characters in the source.
const NUL = String.fromCharCode(0)

// ─── Valid fixtures (plain data — shaped exactly like the client's
// captureAiLiveContext output) ────────────────────────────────────────

function documentContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'document',
    capturedAt: 1_750_000_000_000,
    vaultId: 'vault-a',
    workspaceTabId: 'notes/a',
    identity: { documentId: 'doc-a', path: 'notes/a' },
    title: 'A',
    raw: '# live body',
    revision: 3,
    savedRevision: 2,
    dirty: true,
    saveStatus: 'dirty',
    ...overrides,
  }
}

function diffContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'diff',
    capturedAt: 1_750_000_000_000,
    vaultId: 'vault-a',
    workspaceTabId: 'diff:notes/a',
    readOnly: true,
    identity: { path: 'notes/a', revisionId: 'rev-3', revisionTime: 222, currentDocumentId: 'doc-a' },
    title: 'A',
    before: { raw: 'old body', source: 'history' },
    after: { raw: 'new body', source: 'live-editor', dirty: true },
    ...overrides,
  }
}

function recoveryContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'recovery',
    capturedAt: 1_750_000_000_000,
    vaultId: 'vault-a',
    workspaceTabId: 'recovery:vault-a:doc-draft-a',
    readOnly: true,
    identity: { recoveryId: 'recovery-a', documentId: 'doc-draft-a', path: 'notes/a', source: 'primary' },
    title: 'A',
    decisionKind: 'divergent',
    view: 'content',
    draft: { raw: 'unsaved draft' },
    ...overrides,
  }
}

function ok(value: unknown) {
  const r = parseAiLiveContext(value)
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r.value
}

function fail(value: unknown): 'invalid-live-context' | 'context-too-large' {
  const r = parseAiLiveContext(value)
  if (r.ok) throw new Error(`expected failure, got ok for ${JSON.stringify(value).slice(0, 120)}`)
  return r.reason
}

describe('parseAiLiveContext — valid snapshots', () => {
  it('accepts a dirty Document snapshot verbatim', () => {
    const value = documentContext()
    expect(ok(value)).toEqual(value)
  })

  it('accepts a clean Document with the external-modified block', () => {
    const value = documentContext({
      revision: 4,
      savedRevision: 4,
      dirty: false,
      saveStatus: 'external',
      external: { kind: 'modified', raw: 'externally changed body' },
    })
    expect(ok(value)).toEqual(value)
  })

  it('accepts external deleted with a null raw', () => {
    const value = documentContext({
      revision: 1,
      savedRevision: 1,
      dirty: false,
      saveStatus: 'external',
      external: { kind: 'deleted', raw: null },
    })
    expect(ok(value)).toEqual(value)
  })

  it('accepts external unreadable with a null raw', () => {
    const value = documentContext({
      revision: 1,
      savedRevision: 1,
      dirty: false,
      saveStatus: 'external',
      external: { kind: 'unreadable', raw: null },
    })
    expect(ok(value)).toEqual(value)
  })

  it('accepts an empty Markdown body (empty string is legal)', () => {
    expect(ok(documentContext({ raw: '' })).raw).toBe('')
    const value = diffContext({ before: { raw: '', source: 'history' } })
    expect(ok(value)).toEqual(value)
  })

  it('accepts a path WITH a single trailing .md', () => {
    const value = diffContext({
      identity: {
        path: 'notes/a.md',
        revisionId: 'rev-7',
        revisionTime: 111,
        currentDocumentId: 'doc-a',
      },
    })
    expect(ok(value)).toEqual(value)
  })

  it('accepts a Diff with a live-editor after side', () => {
    const value = diffContext()
    expect(ok(value)).toEqual(value)
  })

  it('accepts a Diff with a comparison-snapshot after side and null currentDocumentId', () => {
    const value = diffContext({
      identity: { path: 'notes/a', revisionId: 'rev-3', revisionTime: 222, currentDocumentId: null },
      after: { raw: 'snapshot body', source: 'comparison-snapshot', dirty: false },
    })
    expect(ok(value)).toEqual(value)
  })

  it('accepts a Recovery content view (draft only)', () => {
    const value = recoveryContext()
    expect(ok(value)).toEqual(value)
  })

  it('accepts a Recovery diff view with the disk side, even on identity mismatch', () => {
    const value = recoveryContext({
      decisionKind: 'identity-mismatch',
      view: 'diff',
      disk: { documentId: 'doc-other', raw: 'disk body' },
    })
    expect(ok(value)).toEqual(value)
  })

  it('accepts a Recovery diff whose disk side has a null documentId', () => {
    const value = recoveryContext({
      view: 'diff',
      disk: { documentId: null, raw: 'disk body' },
    })
    expect(ok(value)).toEqual(value)
  })

  it('accepts every real SaveStatus and DraftRecoveryDecisionKind', () => {
    for (const saveStatus of ['idle', 'dirty', 'saving', 'saved', 'error', 'offline', 'external']) {
      expect(parseAiLiveContext(documentContext({ saveStatus })).ok).toBe(true)
    }
    for (const decisionKind of ['baseline-match', 'divergent', 'unknown', 'missing-source', 'identity-mismatch']) {
      expect(parseAiLiveContext(recoveryContext({ decisionKind })).ok).toBe(true)
    }
  })
})

describe('parseAiLiveContext — structural rejection', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'document'],
    ['an array', []],
    ['an array of contexts', [documentContext()]],
  ])('rejects %s', (_label, value) => {
    expect(fail(value)).toBe('invalid-live-context')
  })

  it('rejects a wrong protocol version', () => {
    expect(fail(documentContext({ v: 2 }))).toBe('invalid-live-context')
    expect(fail(documentContext({ v: '1' }))).toBe('invalid-live-context')
  })

  it('rejects an unknown kind', () => {
    expect(fail(documentContext({ kind: 'attachment' }))).toBe('invalid-live-context')
  })

  it('rejects the retired History snapshot kind', () => {
    expect(fail({
      v: 1,
      kind: 'history',
      capturedAt: 1_750_000_000_000,
      vaultId: 'vault-a',
      workspaceTabId: 'history:notes/a',
      readOnly: true,
      identity: { path: 'notes/a', revisionId: 'rev-7', revisionTime: 111 },
      title: 'A',
      raw: 'historical body',
    })).toBe('invalid-live-context')
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['negative', -1],
    ['a string', 'now'],
  ])('rejects capturedAt = %s', (_label, capturedAt) => {
    expect(fail(documentContext({ capturedAt }))).toBe('invalid-live-context')
  })

  it('rejects a missing capturedAt', () => {
    const value = documentContext()
    delete (value as { capturedAt?: unknown }).capturedAt
    expect(fail(value)).toBe('invalid-live-context')
  })

  it.each([
    ['empty vaultId', { vaultId: '' }],
    ['non-string vaultId', { vaultId: 7 }],
    ['empty workspaceTabId', { workspaceTabId: '' }],
  ])('rejects %s', (_label, overrides) => {
    expect(fail(documentContext(overrides))).toBe('invalid-live-context')
  })

  it('rejects a missing identity', () => {
    const value = documentContext()
    delete (value as { identity?: unknown }).identity
    expect(fail(value)).toBe('invalid-live-context')
  })

  it('rejects an over-long id string', () => {
    expect(fail(documentContext({ vaultId: 'v'.repeat(4096) }))).toBe('invalid-live-context')
  })
})

describe('parseAiLiveContext — path safety', () => {
  it.each([
    ['absolute path', '/notes/a'],
    ['windows drive path', 'c:/notes/a'],
    ['parent segment', '../notes/a'],
    ['embedded parent segment', 'notes/../../a'],
    ['backslash path', 'notes\\a'],
    ['backslash parent', '..\\notes\\a'],
    ['NUL in path', `notes/${NUL}a`],
    ['newline in path', 'notes/\na'],
    ['uppercase segment', 'Notes/A'],
    ['empty path', ''],
    ['dot segment', './notes/a'],
    ['double slash', 'notes//a'],
  ])('rejects %s', (_label, path) => {
    const value = documentContext({
      workspaceTabId: path,
      identity: { documentId: 'doc-a', path },
    })
    expect(fail(value)).toBe('invalid-live-context')
  })

  it('rejects a mid-path .md segment (only one trailing .md may be stripped)', () => {
    const value = diffContext({
      identity: {
        path: 'a.md/b',
        revisionId: 'rev-1',
        revisionTime: 1,
        currentDocumentId: 'doc-a',
      },
    })
    expect(fail(value)).toBe('invalid-live-context')
  })

  it('never converts the client path to a filesystem path', () => {
    // The parser is pure validation: it returns the logical path
    // unchanged and produces no absolute path anywhere in its result.
    const value = ok(documentContext())
    expect(JSON.stringify(value)).not.toContain('/Users')
    expect(JSON.stringify(value)).not.toContain(':\\')
    expect(value.identity.path).toBe('notes/a')
  })
})

describe('parseAiLiveContext — Document invariants', () => {
  it.each([
    ['empty documentId', { identity: { documentId: '', path: 'notes/a' } }],
    ['missing documentId', { identity: { path: 'notes/a' } }],
    ['invalid identity path', { identity: { documentId: 'doc-a', path: '/abs' } }],
  ])('rejects %s', (_label, overrides) => {
    expect(fail(documentContext(overrides))).toBe('invalid-live-context')
  })

  it('rejects workspaceTabId diverging from identity.path (no split identity)', () => {
    expect(fail(documentContext({ workspaceTabId: 'notes/b' }))).toBe('invalid-live-context')
  })

  it.each([
    ['negative revision', { revision: -1, savedRevision: 0, dirty: true }],
    ['non-integer revision', { revision: 1.5, savedRevision: 1, dirty: true }],
    ['negative savedRevision', { revision: 0, savedRevision: -1, dirty: true }],
    ['NaN revision', { revision: NaN, savedRevision: 0, dirty: true }],
    ['string revision', { revision: '3', savedRevision: 2, dirty: true }],
  ])('rejects %s', (_label, overrides) => {
    expect(fail(documentContext(overrides))).toBe('invalid-live-context')
  })

  it.each([
    ['dirty=true while revision === savedRevision', { revision: 2, savedRevision: 2, dirty: true }],
    ['dirty=false while revision !== savedRevision', { revision: 3, savedRevision: 2, dirty: false }],
  ])('rejects the dirty invariant violation: %s', (_label, overrides) => {
    expect(fail(documentContext(overrides))).toBe('invalid-live-context')
  })

  it('rejects an invalid saveStatus', () => {
    expect(fail(documentContext({ saveStatus: 'synced' }))).toBe('invalid-live-context')
  })

  it('rejects a non-string raw', () => {
    expect(fail(documentContext({ raw: 42 }))).toBe('invalid-live-context')
    expect(fail(documentContext({ raw: null }))).toBe('invalid-live-context')
  })

  it('rejects NUL inside a Markdown body', () => {
    expect(fail(documentContext({ raw: `a${NUL}b` }))).toBe('invalid-live-context')
  })

  it.each([
    ['modified with null raw', { external: { kind: 'modified', raw: null } }],
    ['deleted with a string raw', { external: { kind: 'deleted', raw: 'body' } }],
    ['unknown external kind', { external: { kind: 'renamed', raw: null } }],
    ['external missing raw', { external: { kind: 'modified' } }],
    ['external extra key', { external: { kind: 'modified', raw: 'x', mtime: 1 } }],
  ])('rejects external %s', (_label, overrides) => {
    expect(fail(documentContext(overrides))).toBe('invalid-live-context')
  })
})

describe('parseAiLiveContext — Diff invariants', () => {
  it('rejects readOnly !== true', () => {
    expect(fail(diffContext({ readOnly: false }))).toBe('invalid-live-context')
  })

  it('rejects a before side that is not history', () => {
    expect(fail(diffContext({ before: { raw: 'old', source: 'live-editor' } }))).toBe('invalid-live-context')
  })

  it('rejects a missing side', () => {
    const noAfter = diffContext()
    delete (noAfter as { after?: unknown }).after
    expect(fail(noAfter)).toBe('invalid-live-context')
    const noBefore = diffContext()
    delete (noBefore as { before?: unknown }).before
    expect(fail(noBefore)).toBe('invalid-live-context')
  })

  it('rejects a live-editor after side without a non-empty currentDocumentId', () => {
    const value = diffContext({
      identity: { path: 'notes/a', revisionId: 'rev-3', revisionTime: 222, currentDocumentId: null },
    })
    expect(fail(value)).toBe('invalid-live-context')
    const emptyId = diffContext({
      identity: { path: 'notes/a', revisionId: 'rev-3', revisionTime: 222, currentDocumentId: '' },
    })
    expect(fail(emptyId)).toBe('invalid-live-context')
  })

  it('rejects a comparison-snapshot after side with a non-null currentDocumentId', () => {
    const value = diffContext({
      after: { raw: 'snapshot body', source: 'comparison-snapshot', dirty: false },
      // identity keeps currentDocumentId: 'doc-a'
    })
    expect(fail(value)).toBe('invalid-live-context')
  })

  it('rejects an unknown after source', () => {
    expect(fail(diffContext({ after: { raw: 'x', source: 'disk', dirty: false } }))).toBe('invalid-live-context')
  })

  it('rejects a non-boolean after.dirty', () => {
    expect(fail(diffContext({ after: { raw: 'x', source: 'live-editor', dirty: 'yes' } }))).toBe('invalid-live-context')
  })
})

describe('parseAiLiveContext — Recovery invariants', () => {
  it('rejects readOnly !== true', () => {
    expect(fail(recoveryContext({ readOnly: false }))).toBe('invalid-live-context')
  })

  it.each([
    ['unknown source', { identity: { recoveryId: 'r', documentId: 'd', path: 'notes/a', source: 'backup' } }],
    ['missing recoveryId', { identity: { documentId: 'd', path: 'notes/a', source: 'primary' } }],
    ['invalid path', { identity: { recoveryId: 'r', documentId: 'd', path: '/abs', source: 'primary' } }],
  ])('rejects %s', (_label, overrides) => {
    expect(fail(recoveryContext(overrides))).toBe('invalid-live-context')
  })

  it('rejects an unknown decisionKind', () => {
    expect(fail(recoveryContext({ decisionKind: 'whatever' }))).toBe('invalid-live-context')
  })

  it('rejects an unknown view', () => {
    expect(fail(recoveryContext({ view: 'full' }))).toBe('invalid-live-context')
  })

  it('rejects a content view carrying a disk block', () => {
    const value = recoveryContext({ disk: { documentId: 'doc-other', raw: 'disk' } })
    expect(fail(value)).toBe('invalid-live-context')
  })

  it('rejects a diff view without the disk block', () => {
    expect(fail(recoveryContext({ view: 'diff' }))).toBe('invalid-live-context')
  })

  it('rejects a diff view whose disk block is malformed', () => {
    expect(fail(recoveryContext({ view: 'diff', disk: { raw: 'disk' } }))).toBe('invalid-live-context')
    expect(fail(recoveryContext({ view: 'diff', disk: { documentId: 'd', raw: 42 } }))).toBe('invalid-live-context')
  })

  it('rejects a non-string draft raw', () => {
    expect(fail(recoveryContext({ draft: { raw: null } }))).toBe('invalid-live-context')
  })
})

describe('parseAiLiveContext — strict shape (no hidden authorities)', () => {
  it.each([
    ['currentNotePath', { currentNotePath: 'notes/a' }],
    ['currentNoteContent', { currentNoteContent: 'hidden body' }],
    ['filesystemPath', { filesystemPath: '/Users/x/notes/a.md' }],
    ['absolutePath', { absolutePath: '/abs' }],
    ['extra Markdown body field', { extraRaw: 'injected body' }],
    ['attachment list', { attachments: [{ path: 'b', raw: 'x' }] }],
  ])('rejects an unknown top-level field: %s', (_label, extra) => {
    expect(fail({ ...documentContext(), ...extra })).toBe('invalid-live-context')
  })

  it('rejects unknown fields nested in identity / draft / after blocks', () => {
    expect(fail(documentContext({ identity: { documentId: 'd', path: 'notes/a', root: '/' } }))).toBe('invalid-live-context')
    expect(fail(recoveryContext({ draft: { raw: 'x', html: '<b>x</b>' } }))).toBe('invalid-live-context')
    expect(fail(diffContext({ after: { raw: 'x', source: 'live-editor', dirty: true, baseSha: 'abc' } }))).toBe('invalid-live-context')
  })
})

describe('parseAiLiveContext — size limit', () => {
  it('exposes a single byte-budget constant', () => {
    expect(MAX_AI_LIVE_CONTEXT_BYTES).toBe(512 * 1024)
  })

  it('rejects an oversized context with context-too-large (never truncates)', () => {
    const value = documentContext({ raw: 'x'.repeat(MAX_AI_LIVE_CONTEXT_BYTES + 1) })
    expect(fail(value)).toBe('context-too-large')
  })

  it('reports context-too-large even when the oversized value is also malformed', () => {
    // Size is checked before structure: an attacker's 1 MiB garbage
    // blob gets the size verdict, and the parser never walks it.
    const value = { kind: 'nope', raw: 'x'.repeat(MAX_AI_LIVE_CONTEXT_BYTES + 1) }
    expect(fail(value)).toBe('context-too-large')
  })

  it('accepts a large-but-under-budget context without touching its bytes', () => {
    const raw = 'y'.repeat(MAX_AI_LIVE_CONTEXT_BYTES - 2048)
    const value = documentContext({ raw })
    expect(ok(value).raw).toBe(raw)
    expect(ok(value).raw.length).toBe(raw.length)
  })
})
