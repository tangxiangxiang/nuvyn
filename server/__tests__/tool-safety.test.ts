// Edit-10.4 pure unit tests: logical-path canonicalization, tool
// mutation classification, ChatContext → ToolSafetyPolicy derivation,
// and the guard decision table (deny reasons, rename double-path,
// clean-document server re-verification, leakage-free messages).
//
// Integration coverage (real temp vault, real executeToolCall,
// runChat loop) lives in tools.test.ts and chat.test.ts.
import { describe, expect, it } from 'vitest'
import { normalizeLogicalContentPath } from '../paths'
import { TOOL_DEFINITIONS } from '../ai/tools'
import {
  deriveToolSafetyPolicy,
  getToolMutationTarget,
  guardToolMutation,
  type ToolMutationTarget,
  type ToolSafetyPolicy,
} from '../ai/tool-safety'
import type { ChatContext } from '../ai/chat'
import type { AiLiveContextSnapshot } from '../../src/composables/vault/aiLiveContext'

const NUL = String.fromCharCode(0)

// ─── Fixtures (plain data shaped like the sealed snapshot union) ─────

function docSnapshot(overrides: Record<string, unknown> = {}): AiLiveContextSnapshot {
  return {
    v: 1,
    kind: 'document',
    capturedAt: 1,
    vaultId: 'vault-a',
    workspaceTabId: 'notes/a',
    identity: { documentId: 'doc-a', path: 'notes/a' },
    title: 'A',
    raw: 'DOC_RAW_SENTINEL_42',
    revision: 1,
    savedRevision: 1,
    dirty: false,
    saveStatus: 'idle',
    ...overrides,
  } as never
}

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

function live(liveContext: AiLiveContextSnapshot): ChatContext {
  return { kind: 'live', liveContext }
}

// ─── §6: logical path canonicalization ───────────────────────────────

describe('normalizeLogicalContentPath', () => {
  it('keeps the canonical extensionless spelling', () => {
    expect(normalizeLogicalContentPath('notes/a')).toBe('notes/a')
    expect(normalizeLogicalContentPath('a')).toBe('a')
    expect(normalizeLogicalContentPath('inbox/deep/note-1')).toBe('inbox/deep/note-1')
  })

  it('strips exactly one trailing .md (history spelling)', () => {
    expect(normalizeLogicalContentPath('notes/a.md')).toBe('notes/a')
    expect(normalizeLogicalContentPath('a.md')).toBe('a')
  })

  it('treats notes/a and notes/a.md as the same path', () => {
    expect(normalizeLogicalContentPath('notes/a'))
      .toBe(normalizeLogicalContentPath('notes/a.md'))
  })

  it.each([
    ['mid-path .md segment', 'notes/a.md/b'],
    ['double .md leaves an invalid segment', 'a.md.md'],
    ['bare .md', '.md'],
    ['absolute path', '/notes/a'],
    ['parent traversal', '../a'],
    ['embedded traversal', 'notes/../a'],
    ['backslash', 'notes\\a'],
    ['empty string', ''],
    ['NUL byte', `notes${NUL}a`],
    ['uppercase', 'Notes/A'],
    ['trailing slash', 'notes/a/'],
    ['leading dash segment', '-notes/a'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeLogicalContentPath(input)).toBeNull()
  })
})

// ─── §5.1: tool mutation classification ──────────────────────────────

describe('getToolMutationTarget', () => {
  it('classifies read_file and list_files as non-mutating', () => {
    expect(getToolMutationTarget('read_file', { path: 'notes/a' })).toEqual({ kind: 'none' })
    expect(getToolMutationTarget('list_files', { scope: 'inbox' })).toEqual({ kind: 'none' })
    expect(getToolMutationTarget('list_files', {})).toEqual({ kind: 'none' })
  })

  it.each(['create_file', 'write_file', 'patch_file', 'delete_file', 'update_metadata'])(
    'classifies %s as single-path',
    (name) => {
      expect(getToolMutationTarget(name, { path: 'notes/a' }))
        .toEqual({ kind: 'single-path', path: 'notes/a' })
    },
  )

  it('classifies rename_file with both paths', () => {
    // Static classification: the backlink reference footprint is
    // resolved later by the dispatcher (it needs the link index), so
    // the classifier emits an empty referencePaths to be filled in.
    expect(getToolMutationTarget('rename_file', { path: 'notes/a', new_path: 'notes/b' }))
      .toEqual({ kind: 'rename', sourcePath: 'notes/a', destinationPath: 'notes/b', referencePaths: [] })
  })

  it('fails closed on unknown tools — never defaults to read-only', () => {
    const target = getToolMutationTarget('hack_the_vault', { path: 'notes/a' })
    expect(target).toEqual({ kind: 'unknown' })
    expect(target.kind).not.toBe('none')
  })

  it('fails closed on malformed mutating input', () => {
    expect(getToolMutationTarget('write_file', {})).toEqual({ kind: 'unknown' })
    expect(getToolMutationTarget('write_file', { path: 42 })).toEqual({ kind: 'unknown' })
    expect(getToolMutationTarget('write_file', { path: '' })).toEqual({ kind: 'unknown' })
    expect(getToolMutationTarget('delete_file', {})).toEqual({ kind: 'unknown' })
    expect(getToolMutationTarget('update_metadata', {})).toEqual({ kind: 'unknown' })
    // rename without new_path cannot be classified as a safe rename.
    expect(getToolMutationTarget('rename_file', { path: 'notes/a' })).toEqual({ kind: 'unknown' })
    expect(getToolMutationTarget('rename_file', { new_path: 'notes/b' })).toEqual({ kind: 'unknown' })
    expect(getToolMutationTarget('rename_file', {})).toEqual({ kind: 'unknown' })
  })

  it('knows exactly the defined tools — a new tool fails here until classified', () => {
    const defined = new Set(TOOL_DEFINITIONS.map((tool) => tool.name))
    const classified = new Set([
      'read_file', 'list_files', 'create_file', 'write_file',
      'patch_file', 'delete_file', 'update_metadata', 'rename_file',
    ])
    expect(defined).toEqual(classified)
  })
})

// ─── §5.2: ChatContext → ToolSafetyPolicy ────────────────────────────

describe('deriveToolSafetyPolicy', () => {
  it('none and legacy-path stay unrestricted (old clients keep current behavior)', () => {
    expect(deriveToolSafetyPolicy({ kind: 'none' })).toEqual({ kind: 'unrestricted' })
    expect(deriveToolSafetyPolicy({ kind: 'legacy-path', currentNotePath: 'notes/a' }))
      .toEqual({ kind: 'unrestricted' })
  })

  it.each([
    ['Diff', () => live(diffSnapshot())],
    ['Recovery content', () => live(recoverySnapshot('content'))],
    ['Recovery diff', () => live(recoverySnapshot('diff'))],
  ])('%s is deny / read-only-context on its identity path', (_label, makeCtx) => {
    expect(deriveToolSafetyPolicy(makeCtx())).toEqual({
      kind: 'deny-protected-path',
      protectedPath: 'notes/a',
      reason: 'read-only-context',
    })
  })

  it('dirty Document is deny / unsaved-context', () => {
    const policy = deriveToolSafetyPolicy(live(docSnapshot({
      revision: 3, savedRevision: 2, dirty: true, saveStatus: 'dirty',
    })))
    expect(policy).toEqual({
      kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'unsaved-context',
    })
  })

  it('external block takes precedence over dirty and unstable', () => {
    const policy = deriveToolSafetyPolicy(live(docSnapshot({
      dirty: true, saveStatus: 'saving',
      external: { kind: 'modified', raw: 'EXTERNAL_RAW' },
    })))
    expect(policy).toMatchObject({ kind: 'deny-protected-path', reason: 'external-conflict' })
  })

  it('saveStatus external without an external block is still external-conflict', () => {
    const policy = deriveToolSafetyPolicy(live(docSnapshot({ dirty: false, saveStatus: 'external' })))
    expect(policy).toMatchObject({ kind: 'deny-protected-path', reason: 'external-conflict' })
  })

  it('dirty takes precedence over a transient saveStatus', () => {
    const policy = deriveToolSafetyPolicy(live(docSnapshot({
      dirty: true, saveStatus: 'saving',
    })))
    expect(policy).toMatchObject({ kind: 'deny-protected-path', reason: 'unsaved-context' })
  })

  it.each(['saving', 'error', 'offline', 'dirty'] as const)(
    'clean but saveStatus=%s is deny / unstable-context',
    (saveStatus) => {
      const policy = deriveToolSafetyPolicy(live(docSnapshot({ dirty: false, saveStatus })))
      expect(policy).toEqual({
        kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'unstable-context',
      })
    },
  )

  it.each(['idle', 'saved'] as const)(
    'clean stable Document (saveStatus=%s) becomes verify-clean-document',
    (saveStatus) => {
      const policy = deriveToolSafetyPolicy(live(docSnapshot({
        raw: 'CLEAN_RAW', dirty: false, saveStatus,
        identity: { documentId: 'doc-77', path: 'notes/a' },
      })))
      expect(policy).toEqual({
        kind: 'verify-clean-document',
        protectedPath: 'notes/a',
        expectedDocumentId: 'doc-77',
        expectedRaw: 'CLEAN_RAW',
      })
    },
  )

  it('preserves an empty expectedRaw (empty Markdown is a legal body)', () => {
    const policy = deriveToolSafetyPolicy(live(docSnapshot({ raw: '' })))
    expect(policy).toMatchObject({ kind: 'verify-clean-document', expectedRaw: '' })
  })

  it('returns a by-value policy — later snapshot mutation does not leak in', () => {
    const snapshot = docSnapshot({ raw: 'BEFORE' })
    const policy = deriveToolSafetyPolicy(live(snapshot))
    ;(snapshot as { raw: string }).raw = 'AFTER'
    ;(snapshot as { identity: { documentId: string; path: string } }).identity.path = 'notes/evil'
    expect(policy).toMatchObject({ kind: 'verify-clean-document', protectedPath: 'notes/a', expectedRaw: 'BEFORE' })
  })
})

// ─── §11: guard decisions ────────────────────────────────────────────

const single = (path: string): ToolMutationTarget => ({ kind: 'single-path', path })
const rename = (
  sourcePath: string,
  destinationPath: string,
  referencePaths: string[] = [],
): ToolMutationTarget => ({ kind: 'rename', sourcePath, destinationPath, referencePaths })
const unknownTarget: ToolMutationTarget = { kind: 'unknown' }

const denyUnsaved: ToolSafetyPolicy = {
  kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'unsaved-context',
}
const denyReadOnly: ToolSafetyPolicy = {
  kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'read-only-context',
}
const denyExternal: ToolSafetyPolicy = {
  kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'external-conflict',
}
const denyUnstable: ToolSafetyPolicy = {
  kind: 'deny-protected-path', protectedPath: 'notes/a', reason: 'unstable-context',
}
const RAW_SENTINEL = 'EXPECTED_RAW_SENTINEL_789'
const verifyClean: ToolSafetyPolicy = {
  kind: 'verify-clean-document',
  protectedPath: 'notes/a',
  expectedDocumentId: 'doc-a',
  expectedRaw: RAW_SENTINEL,
}

describe('guardToolMutation', () => {
  it('unrestricted allows everything', async () => {
    const decision = await guardToolMutation({
      policy: { kind: 'unrestricted' },
      target: single('notes/a'),
      readCurrentDocument: () => null,
    })
    expect(decision).toEqual({ allowed: true })
  })

  it.each([
    ['unsaved', denyUnsaved, 'active-context-unsaved'],
    ['read-only', denyReadOnly, 'active-context-read-only'],
    ['external', denyExternal, 'active-context-external-conflict'],
    ['unstable', denyUnstable, 'active-context-unstable'],
  ] as const)('deny %s: blocks the exact protected path', async (_label, policy, code) => {
    const decision = await guardToolMutation({
      policy, target: single('notes/a'), readCurrentDocument: () => null,
    })
    expect(decision).toMatchObject({ allowed: false, code })
  })

  it('deny: the .md spelling of the protected path is the same path', async () => {
    const decision = await guardToolMutation({
      policy: denyUnsaved, target: single('notes/a.md'), readCurrentDocument: () => null,
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-unsaved' })
  })

  it('deny: unrelated paths are NOT blocked', async () => {
    const decision = await guardToolMutation({
      policy: denyReadOnly, target: single('notes/b'), readCurrentDocument: () => null,
    })
    expect(decision).toEqual({ allowed: true })
  })

  it('deny: rename is blocked when the SOURCE is protected', async () => {
    const decision = await guardToolMutation({
      policy: denyReadOnly, target: rename('notes/a', 'notes/b'), readCurrentDocument: () => null,
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-read-only' })
  })

  it('deny: rename is blocked when the DESTINATION is protected (no clobbering the active path)', async () => {
    const decision = await guardToolMutation({
      policy: denyUnsaved, target: rename('notes/b', 'notes/a'), readCurrentDocument: () => null,
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-unsaved' })
  })

  it('deny: rename with .md-spelled protected destination is blocked', async () => {
    const decision = await guardToolMutation({
      policy: denyUnsaved, target: rename('notes/b', 'notes/a.md'), readCurrentDocument: () => null,
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-unsaved' })
  })

  it('deny: fully unrelated rename is allowed', async () => {
    const decision = await guardToolMutation({
      policy: denyReadOnly, target: rename('notes/b', 'notes/c'), readCurrentDocument: () => null,
    })
    expect(decision).toEqual({ allowed: true })
  })

  // The rename footprint includes every file the backlink rewrite
  // will touch — an "unrelated" rename of notes/b can still WRITE the
  // protected document when it references notes/b ([[notes/b]] →
  // [[notes/c]]), so reference paths are guarded like source/dest.
  it('deny: rename is blocked when a BACKLINK reference path is protected', async () => {
    const decision = await guardToolMutation({
      policy: denyUnsaved,
      target: rename('notes/b', 'notes/c', ['notes/a']),
      readCurrentDocument: () => null,
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-unsaved' })
  })

  it('deny: rename is blocked when a .md-spelled reference path is protected', async () => {
    const decision = await guardToolMutation({
      policy: denyReadOnly,
      target: rename('notes/b', 'notes/c', ['notes/x', 'notes/a.md']),
      readCurrentDocument: () => null,
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-read-only' })
  })

  it('deny: rename with only unrelated reference paths is allowed', async () => {
    const decision = await guardToolMutation({
      policy: denyReadOnly,
      target: rename('notes/b', 'notes/c', ['notes/x', 'notes/y']),
      readCurrentDocument: () => null,
    })
    expect(decision).toEqual({ allowed: true })
  })

  it('unknown targets pass to the dispatcher (which rejects them without side effects)', async () => {
    const decision = await guardToolMutation({
      policy: denyUnsaved, target: unknownTarget, readCurrentDocument: () => null,
    })
    expect(decision).toEqual({ allowed: true })
  })

  it('create_file on the protected path is NOT exempted', async () => {
    const decision = await guardToolMutation({
      policy: denyReadOnly, target: single('notes/a'), readCurrentDocument: () => null,
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-read-only' })
  })

  // ---- verify-clean-document: server re-verification ----

  it('verify-clean: allows when identity AND raw AND path all match', async () => {
    const decision = await guardToolMutation({
      policy: verifyClean,
      target: single('notes/a'),
      readCurrentDocument: (p) => ({ documentId: 'doc-a', path: p, raw: RAW_SENTINEL }),
    })
    expect(decision).toEqual({ allowed: true })
  })

  it('verify-clean: blocks as unverifiable when the file is missing/unreadable', async () => {
    const decision = await guardToolMutation({
      policy: verifyClean, target: single('notes/a'), readCurrentDocument: () => null,
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-unverifiable' })
  })

  it('verify-clean: blocks identity mismatch EVEN WHEN the raw is byte-identical (path reuse)', async () => {
    const decision = await guardToolMutation({
      policy: verifyClean,
      target: single('notes/a'),
      readCurrentDocument: (p) => ({ documentId: 'doc-B-different', path: p, raw: RAW_SENTINEL }),
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-identity-mismatch' })
  })

  it('verify-clean: blocks stale disk when the id matches but the raw differs', async () => {
    const decision = await guardToolMutation({
      policy: verifyClean,
      target: single('notes/a'),
      readCurrentDocument: (p) => ({ documentId: 'doc-a', path: p, raw: 'SOMETHING_NEW_ON_DISK' }),
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-stale' })
  })

  it('verify-clean: re-verifies for the .md spelling and reads the CANONICAL path', async () => {
    const readPaths: string[] = []
    const decision = await guardToolMutation({
      policy: verifyClean,
      target: single('notes/a.md'),
      readCurrentDocument: (p) => {
        readPaths.push(p)
        return { documentId: 'doc-a', path: p, raw: RAW_SENTINEL }
      },
    })
    expect(decision).toEqual({ allowed: true })
    expect(readPaths).toEqual(['notes/a'])
  })

  it('verify-clean: unrelated target skips the server read entirely', async () => {
    let reads = 0
    const decision = await guardToolMutation({
      policy: verifyClean,
      target: single('notes/b'),
      readCurrentDocument: () => { reads++; return null },
    })
    expect(decision).toEqual({ allowed: true })
    expect(reads).toBe(0)
  })

  it('verify-clean: rename touching the protected path re-verifies; both-unrelated skips it', async () => {
    const blocked = await guardToolMutation({
      policy: verifyClean,
      target: rename('notes/b', 'notes/a'),
      readCurrentDocument: () => null,
    })
    expect(blocked).toMatchObject({ allowed: false, code: 'active-context-unverifiable' })

    let reads = 0
    const allowed = await guardToolMutation({
      policy: verifyClean,
      target: rename('notes/b', 'notes/c'),
      readCurrentDocument: () => { reads++; return null },
    })
    expect(allowed).toEqual({ allowed: true })
    expect(reads).toBe(0)
  })

  it('verify-clean: a protected BACKLINK reference path is re-verified before the rewrite', async () => {
    const readPaths: string[] = []
    const allowed = await guardToolMutation({
      policy: verifyClean,
      target: rename('notes/b', 'notes/c', ['notes/a']),
      readCurrentDocument: (p) => {
        readPaths.push(p)
        return { documentId: 'doc-a', path: p, raw: RAW_SENTINEL }
      },
    })
    expect(allowed).toEqual({ allowed: true })
    expect(readPaths).toEqual(['notes/a'])
  })

  it('verify-clean: stale protected backlink blocks the whole rename', async () => {
    const decision = await guardToolMutation({
      policy: verifyClean,
      target: rename('notes/b', 'notes/c', ['notes/a.md']),
      readCurrentDocument: (p) => ({ documentId: 'doc-a', path: p, raw: 'DISK_CHANGED_AFTER_SNAPSHOT' }),
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-stale' })
  })

  it('verify-clean: protected backlink now owned by another identity blocks the whole rename', async () => {
    const decision = await guardToolMutation({
      policy: verifyClean,
      target: rename('notes/b', 'notes/c', ['notes/a']),
      readCurrentDocument: (p) => ({ documentId: 'doc-SOMEONE-ELSE', path: p, raw: RAW_SENTINEL }),
    })
    expect(decision).toMatchObject({ allowed: false, code: 'active-context-identity-mismatch' })
  })

  it('verify-clean: works with an async resolver', async () => {
    const decision = await guardToolMutation({
      policy: verifyClean,
      target: single('notes/a'),
      readCurrentDocument: async (p) => ({ documentId: 'doc-a', path: p, raw: RAW_SENTINEL }),
    })
    expect(decision).toEqual({ allowed: true })
  })

  // ---- error message hygiene ----

  it('blocked messages carry the code and the logical path, never the snapshot raw or guard internals', async () => {
    const decisions = [
      await guardToolMutation({ policy: denyUnsaved, target: single('notes/a'), readCurrentDocument: () => null }),
      await guardToolMutation({ policy: denyReadOnly, target: single('notes/a'), readCurrentDocument: () => null }),
      await guardToolMutation({ policy: denyExternal, target: single('notes/a'), readCurrentDocument: () => null }),
      await guardToolMutation({ policy: denyUnstable, target: single('notes/a'), readCurrentDocument: () => null }),
      await guardToolMutation({ policy: verifyClean, target: single('notes/a'), readCurrentDocument: () => null }),
      await guardToolMutation({
        policy: verifyClean, target: single('notes/a'),
        readCurrentDocument: (p) => ({ documentId: 'doc-CURRENT-id', path: p, raw: 'CURRENT_RAW_ON_DISK_XYZ' }),
      }),
      await guardToolMutation({
        policy: verifyClean, target: single('notes/a'),
        readCurrentDocument: (p) => ({ documentId: 'doc-a', path: p, raw: 'STALE_MISMATCH_RAW_XYZ' }),
      }),
    ]
    for (const decision of decisions) {
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) {
        expect(decision.message).toContain(decision.code)
        expect(decision.message).toContain('notes/a')
        // No snapshot bodies, no disk bodies, no identity internals.
        expect(decision.message).not.toContain(RAW_SENTINEL)
        expect(decision.message).not.toContain('DOC_RAW_SENTINEL_42')
        expect(decision.message).not.toContain('CURRENT_RAW_ON_DISK_XYZ')
        expect(decision.message).not.toContain('doc-a')
        expect(decision.message).not.toContain('doc-CURRENT-id')
        // Logical paths only — no filesystem paths.
        expect(decision.message).not.toContain('/content/')
        expect(decision.message).not.toContain('.md')
      }
    }
  })
})
