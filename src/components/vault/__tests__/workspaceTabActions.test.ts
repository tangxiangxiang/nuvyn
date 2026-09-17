// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard, revealWorkspacePath } from '../workspaceTabActions'

describe('Workspace tab path actions', () => {
  it('uses the Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    expect(await copyTextToClipboard('inbox/a', { writeText })).toBe(true)
    expect(writeText).toHaveBeenCalledWith('inbox/a')
  })

  it('falls back when Clipboard API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    const execCommand = vi.fn().mockReturnValue(true)
    const source = document.createElement('button')
    document.body.appendChild(source)
    source.focus()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    expect(await copyTextToClipboard('inbox/a', { writeText }, document)).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(source)
    source.remove()
  })

  it('reports failure when neither clipboard path succeeds', async () => {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    })
    expect(await copyTextToClipboard('inbox/a', undefined, document)).toBe(false)
  })
})

describe('Workspace tab file-tree reveal', () => {
  it('catches refresh failures and reports one error without retrying reveal', async () => {
    const revealPath = vi.fn().mockResolvedValue(false)
    const refresh = vi.fn().mockRejectedValue(new Error('tree unavailable'))
    const onNotFound = vi.fn()
    const onError = vi.fn()

    await expect(revealWorkspacePath('inbox/a', {
      revealPath,
      refresh,
      afterRefresh: vi.fn(),
      onNotFound,
      onError,
    })).resolves.toBeUndefined()

    expect(revealPath).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(onNotFound).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('inbox/a')
  })
})
