// Shared test helpers for vault/editor dialog mocks.
//
// The vault tests all need to stub the same three composables:
//   - useConfirm() — returns a confirm() that resolves to true (the user
//     clicks OK), with an answer() helper to drive a different answer
//     mid-test if needed
//   - usePrompt()  — returns a prompt() that resolves to null (the user
//     cancels) so test setup never blocks
//   - useToast()   — captures info/success/error/dismiss calls so a test
//     can assert "the failing save pushed a toast" without rendering
//
// Before this helper existed, the same three vi.mock blocks were
// copy-pasted into FileTree.test.ts, drag-bubbling.test.ts,
// drag-move.test.ts, rename-input.test.ts, same-name-rename.test.ts,
// and context-menu.test.ts — six identical bodies. Each test file now
// does:
//
//   import { installDialogMocks } from '../../../__test-helpers__/dialogs'
//   installDialogMocks()
//
// which expands to the three vi.mock calls. The stubs themselves
// (dialogStubs) are also exported so a test that needs to change a
// return value mid-test (e.g. "user clicks Cancel instead of OK") can
// reach in: `dialogStubs.confirm.mockResolvedValueOnce(false)`. The
// spy identity is stable across the test file because the factory
// closure captures the same object on every module import.
//
// The other half of this file is shared small-test utilities:
//   - makeDT()      — minimal DataTransfer shim for drag events
//   - rowByLabel()  — pick the leafmost tree row whose row-name matches
//   - stubFetch()   — minimal fetch shim for /api/tree and /api/posts
//
// These were also copy-pasted; consolidating them here means a future
// change to the row-name selector (we just moved from <a> to <button>)
// only needs to be made in one place.

import { vi, type Mock } from 'vitest'
import type { PostSummary, TreeNode } from '../lib/api'
import { useI18n } from '../composables/useI18n'

// Vault interaction fixtures assert the app's primary Chinese copy.
// Keep them independent from jsdom's navigator.language.
useI18n().setLocale('zh')

/* ---------- dialog stubs ---------- */

const confirmMock: Mock = vi.fn().mockResolvedValue(true)
const promptMock: Mock = vi.fn().mockResolvedValue(null)
const toastMock = {
  toasts: { value: [] as { id: number; type: string; message: string; ttl: number }[] },
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}

/** The mock objects that back useConfirm / usePrompt / useToast. Tests
 *  can reach in and change `.mockResolvedValueOnce(...)` to drive a
 *  different code path, or `.mock.calls` to assert a call happened. */
export const dialogStubs = {
  confirm: confirmMock,
  prompt: promptMock,
  toast: toastMock,
}

// vi.mock is hoisted to the top of *this* file. The factory functions
// close over the module-level mocks above, so the spies are stable
// across every test file that imports this helper. The first import of
// the composable from any test triggers the factory, which returns the
// shared mock object — so two tests in the same file share the same
// confirm() spy identity. That's what lets `dialogStubs.confirm
// .mockResolvedValueOnce(false)` from one test bleed into the next if
// not cleared; tests that change the answer should call
// `resetDialogMocks()` in beforeEach.
//
// We mock using the *relative* path from this file: the composables
// live at src/composables/, and we're at src/__test-helpers__/, so the
// path is one level up. The trailing slash on the path doesn't matter.
vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    confirm: confirmMock,
    answer: vi.fn(),
    queue: { value: [] },
  }),
}))
vi.mock('../composables/usePrompt', () => ({
  usePrompt: () => ({
    prompt: promptMock,
    answer: vi.fn(),
    queue: { value: [] },
  }),
}))
vi.mock('../composables/useToast', () => ({
  useToast: () => toastMock,
}))

/** Call this once at the top of a test file (after imports, before
 *  any code that touches the composables) to install the three dialog
 *  mocks. The vi.mock calls above are hoisted, so this function is
 *  effectively a marker — it exists so the import is "used" and the
 *  side effect of importing the helper is obvious at the call site. */
export function installDialogMocks() {}

/** Reset the dialog spies' call history. Useful in beforeEach when a
 *  test asserts on toast calls and the previous test left some behind. */
export function resetDialogMocks() {
  confirmMock.mockClear()
  promptMock.mockClear()
  toastMock.info.mockClear()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
  toastMock.dismiss.mockClear()
}

/* ---------- DOM / vue-test-utils helpers ---------- */

/** Minimal DataTransfer shim. Vue Test Utils' trigger() doesn't
 *  provide a real one, so a dragstart that reads e.dataTransfer will
 *  crash without this. The `getData` round-trips strings, matching
 *  the parts of the DataTransfer API the tree uses. */
export function makeDT() {
  const store = new Map<string, string>()
  return {
    setData: (k: string, v: string) => { store.set(k, v); return true },
    getData: (k: string) => store.get(k) ?? '',
    clearData: () => store.clear(),
    effectAllowed: 'move' as const,
    dropEffect: 'move' as const,
    files: [] as File[],
    items: [] as DataTransferItem[],
    types: Array.from(store.keys()),
  }
}

/** Pick the leafmost tree row whose .row-name text matches `name`.
 *  If `kind` is given, also filter to the matching kind ('folder' /
 *  'file') so same-named file + folder pairs (e.g. `notes.md` and
 *  `notes/`) can be disambiguated. File rows are matched by
 *  *absence* of the `folder` class — TreeRow only tags folders
 *  explicitly. */
export function rowByLabel(rows: any[], name: string, kind?: 'folder' | 'file'): any {
  return rows.filter((r: any) => {
    if (r.find('.row-name-text')?.text() !== name) return false
    if (kind === undefined) return true
    if (kind === 'folder') return r.classes('folder') === true
    return r.classes('folder') === false
  }).pop()!
}

/* ---------- fetch shims ---------- */

/** Build a fetch shim that returns the given /api/posts payload and an
 *  empty /api/tree. The composables (useTagFilter, useEditorTabs) all
 *  hit /api/posts on mount, so this is the minimum fetch shape the
 *  tests need. */
export function stubFetch(opts: {
  posts?: PostSummary[]
  tree?: TreeNode[]
  fetchImpl?: Mock
} = {}) {
  const posts = opts.posts ?? []
  const tree = opts.tree ?? []
  const handler: Mock = opts.fetchImpl ?? vi.fn(async (url: string) => {
    if (url === '/api/posts') return { ok: true, json: async () => posts }
    if (url === '/api/tree') return { ok: true, json: async () => tree }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'not found' }) }
  })
  return handler
}
