// @vitest-environment jsdom
// Tests for useArchiveNote.
//
// The composable owns the patch + toast + collision-suffix handling
// shared by FileTree's right-click "归档" and AiPanel's
// Drafts archive button. Tests cover:
//   - happy path: returns the server's moved path
//   - collision: server returns archive/foo-2, composable toasts the
//     suffixed path
//   - error: composable toasts the error message, returns null
//   - early-out: target equals source (e.g. archive/foo when called
//     on archive/foo), returns null without a round-trip

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import * as api from '../../../lib/api'
import { useArchiveNote } from '../useArchiveNote'
import { useI18n } from '../../useI18n'

// Per-test toast spy. The shared __test-helpers__/dialogs vi.mock
// doesn't intercept the live useToast() reliably here (see comment in
// archive-note.test.ts), so we set up a local one.
const toastSpy = {
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}
vi.mock('../../useToast', () => ({
  useToast: () => toastSpy,
}))

beforeEach(() => {
  useI18n().setLocale('zh')
  vi.restoreAllMocks()
  toastSpy.info.mockClear()
  toastSpy.success.mockClear()
  toastSpy.error.mockClear()
  toastSpy.dismiss.mockClear()
})

interface Harness {
  archive: (path: string, targetPath?: string) => Promise<string | null>
}

function setup(): Harness {
  let captured: Harness | null = null
  const Comp = defineComponent({
    setup() {
      const { archive } = useArchiveNote()
      captured = { archive }
      return () => h('div')
    },
  })
  mount(Comp)
  return captured!
}

describe('useArchiveNote', () => {
  it('patches the file to archive/<filename>.md and returns the moved path', async () => {
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/foo', title: 'foo', created: '', updated: '', tags: [], size: 0, mtime: 0,
    } as any)
    const h = setup()
    const result = await h.archive('inbox/draft/foo')
    expect(patchSpy).toHaveBeenCalledWith('inbox/draft/foo', { targetPath: 'archive/foo' })
    expect(result).toBe('archive/foo')
    expect(toastSpy.success).toHaveBeenCalledWith('已归档')
  })

  it('toasts the suffixed path when the server auto-collides', async () => {
    vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/foo-2', title: 'foo-2', created: '', updated: '', tags: [], size: 0, mtime: 0,
    } as any)
    const h = setup()
    const result = await h.archive('literature/draft/foo')
    expect(result).toBe('archive/foo-2')
    expect(toastSpy.success).toHaveBeenCalledWith('已归档到 archive/foo-2')
  })

  it('returns null and toasts the error when patchPost rejects', async () => {
    vi.spyOn(api, 'patchPost').mockRejectedValue(new Error('disk full'))
    const h = setup()
    const result = await h.archive('inbox/draft/foo')
    expect(result).toBeNull()
    expect(toastSpy.error).toHaveBeenCalledWith('归档失败：disk full')
  })

  it('returns null without a network call when target equals source', async () => {
    // Path already in archive/. The composable should skip — re-issuing
    // the patch would 409 on the server.
    const patchSpy = vi.spyOn(api, 'patchPost')
    const h = setup()
    const result = await h.archive('archive/foo')
    expect(result).toBeNull()
    expect(patchSpy).not.toHaveBeenCalled()
    expect(toastSpy.success).not.toHaveBeenCalled()
    expect(toastSpy.error).not.toHaveBeenCalled()
  })

  it('accepts an explicit targetPath so the caller can pre-compute unique names', async () => {
    // Batch archive pre-computes archive/foo-2 to avoid the server-side
    // -2 suffix scattering (-2, -3, -4, -5). The caller passes the
    // pre-computed target; the composable just sends it through.
    const patchSpy = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/foo-2', title: 'foo-2', created: '', updated: '', tags: [], size: 0, mtime: 0,
    } as any)
    const h = setup()
    const result = await h.archive('inbox/draft/foo', 'archive/foo-2')
    expect(patchSpy).toHaveBeenCalledWith('inbox/draft/foo', { targetPath: 'archive/foo-2' })
    expect(result).toBe('archive/foo-2')
  })
})
