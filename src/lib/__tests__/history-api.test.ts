// Wire-level tests for the typed fetch wrappers in src/lib/history-api.ts.
//
// Stub global.fetch so no real network is hit. The assertions pin down:
//   1. Request shape (URL, query, method, body) — caught regressions
//      where the client URL drifted from the server route.
//   2. Response mapping on 2xx (the success shape comes through).
//   3. The non-2xx contract for endpoints that throw (server's
//      `{ error }` body surfaces verbatim) vs. the one endpoint that
//      doesn't (/status uses 503 + `{ available: false }` as a
//      graceful-unavailable signal, not an error — getStatus must
//      resolve that body, not throw).
//
// The mock-passthrough pattern mirrors src/lib/__tests__/ai-api.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as api from '../history-api'

type FetchCall = { url: string; init: RequestInit }

let calls: FetchCall[] = []
let responses: { status: number; body: unknown }[] = []

beforeEach(() => {
  calls = []
  responses = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})

describe('getStatus', () => {
  it('resolves with the body on a 2xx', async () => {
    responses.push({ status: 200, body: { dirty: [{ path: 'a.md', index: '?', worktree: '?' }], available: true } })
    const out = await api.getStatus()
    expect(out).toEqual({ dirty: [{ path: 'a.md', index: '?', worktree: '?' }], available: true })
  })

  it('resolves with { available: false } on a 503 (graceful unavailable, not an error)', async () => {
    /* /status uses 503 + `{ dirty: [], available: false }` to mean
       "git is not on this machine". The History panel reads
       `available` off the body and renders an EmptyState — throwing
       here would surface a useless "getStatus failed: 503" instead
       and hide the actual reason. This test pins that contract so
       a future "normalize all error handling" refactor doesn't
       silently regress the panel into an error state. */
    responses.push({ status: 503, body: { dirty: [], available: false } })
    const out = await api.getStatus()
    expect(out).toEqual({ dirty: [], available: false })
  })

  it('throws on a real 500 instead of accepting an invalid status body', async () => {
    responses.push({ status: 500, body: { error: 'status failed' } })
    await expect(api.getStatus()).rejects.toMatchObject({
      message: 'status failed',
      status: 500,
    })
  })

  it('rejects a malformed 503 unavailable body', async () => {
    responses.push({ status: 503, body: { error: 'status failed' } })
    await expect(api.getStatus()).rejects.toMatchObject({ status: 503 })
  })
})

describe('getDiff', () => {
  it('throws the server error message on a 4xx', async () => {
    responses.push({
      status: 404,
      body: { error: 'file does not exist at ref HEAD~1', code: 'HISTORY_NOT_FOUND', details: { ref: 'HEAD~1' } },
    })
    const error = await api.getDiff('inbox/a.md', 'HEAD~1', 'HEAD').catch((cause) => cause)
    expect(error).toMatchObject({
      message: 'file does not exist at ref HEAD~1',
      code: 'HISTORY_NOT_FOUND',
      details: { ref: 'HEAD~1' },
    })
  })

  it('preserves structured repair failure code and details', async () => {
    responses.push({
      status: 409,
      body: {
        error: 'Git Index changed, but the repair record could not be saved',
        code: 'HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED',
        details: { replacementApplied: true, finalHead: 'b'.repeat(40) },
      },
    })
    const error = await api.getDiff('inbox/a.md', 'HEAD~1', 'HEAD').catch((cause) => cause)
    expect(error).toBeInstanceOf(api.HistoryApiError)
    expect(error).toMatchObject({
      status: 409,
      code: 'HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED',
      details: { replacementApplied: true, finalHead: 'b'.repeat(40) },
    })
  })

  it('falls back to "<endpoint> failed: <status>" when the body has no error field', async () => {
    responses.push({ status: 500, body: {} })
    await expect(api.getDiff('inbox/a.md', 'HEAD~1', 'HEAD'))
      .rejects.toThrow('getDiff inbox/a.md failed: 500')
  })
})

describe('createCommit', () => {
  it('captures and sends expected working-tree content hashes', async () => {
    const hash = 'a'.repeat(64)
    responses.push({ status: 200, body: { hashes: { 'a.md': hash } } })
    await expect(api.getContentHashes(['a.md'])).resolves.toEqual({ 'a.md': hash })
    expect(calls[0]).toEqual(expect.objectContaining({
      url: '/api/history/content-hashes',
      init: expect.objectContaining({ body: JSON.stringify({ paths: ['a.md'] }) }),
    }))

    responses.push({ status: 201, body: { sha: 'abc', filesCommitted: ['a.md'] } })
    await api.createCommit(['a.md'], 'msg', { 'a.md': hash })
    expect(calls[1]?.init.body).toBe(JSON.stringify({
      paths: ['a.md'],
      message: 'msg',
      expected: { 'a.md': hash },
    }))
  })

  it('loads persisted repair transactions and posts the opaque token', async () => {
    const transaction = {
      token: 'a'.repeat(32),
      status: 'pending',
      head: 'b'.repeat(40),
      paths: ['a.md'],
      expectedIndex: { 'a.md': [{ mode: '100644', oid: 'c'.repeat(40), stage: 0 }] },
    }
    responses.push({ status: 200, body: { transactions: [transaction] } })
    await expect(api.getIndexRepairStatus()).resolves.toEqual([transaction])

    responses.push({
      status: 200,
      body: { repaired: true, repairStatePersistenceFailed: true },
    })
    await expect(api.repairIndex(transaction.token)).resolves.toEqual({
      repaired: true,
      repairStatePersistenceFailed: true,
    })
    expect(calls[1]).toEqual(expect.objectContaining({
      url: '/api/history/repair-index',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: transaction.token }),
      }),
    }))

    responses.push({ status: 200, body: { discarded: true } })
    await api.discardIndexRepair(transaction.token)
    expect(calls[2]).toEqual(expect.objectContaining({
      url: '/api/history/repair-index/discard',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: transaction.token }),
      }),
    }))
  })

  it('throws the server error message on a non-2xx', async () => {
    responses.push({ status: 409, body: { error: 'nothing to commit' } })
    await expect(api.createCommit(['a.md'], 'msg', { 'a.md': 'a'.repeat(64) }))
      .rejects.toThrow('nothing to commit')
  })

  it('withdraws the requested latest version and parses the complete result', async () => {
    const result: api.DropCommitResult = {
      sha: 'a'.repeat(40),
      droppedSha: 'b'.repeat(40),
      filesChanged: ['a.md'],
      indexRefreshFailed: false,
      repairStatePersistenceFailed: false,
    }
    responses.push({ status: 200, body: result })

    await expect(api.dropCommit(result.droppedSha)).resolves.toEqual(result)
    expect(calls.at(-1)).toEqual(expect.objectContaining({
      url: '/api/history/drop',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sha: result.droppedSha }),
      }),
    }))
  })

  it('preserves the HTTP status for stale-selection handling', async () => {
    responses.push({ status: 409, body: { error: 'selection is stale' } })
    const error = await api.createCommit(['a.md'], 'msg', { 'a.md': 'a'.repeat(64) }).catch((cause) => cause)
    expect(error).toBeInstanceOf(api.HistoryApiError)
    expect(error.status).toBe(409)
  })
})

describe('repairIndex', () => {
  it('preserves the structured persistence-failure response on the repair endpoint', async () => {
    const token = 'a'.repeat(32)
    responses.push({
      status: 409,
      body: {
        error: 'Git Index changed, but the repair record could not be saved',
        code: 'HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED',
        details: { replacementApplied: true, finalHead: 'b'.repeat(40) },
      },
    })

    const error = await api.repairIndex(token).catch((cause) => cause)
    expect(error).toBeInstanceOf(api.HistoryApiError)
    expect(error).toMatchObject({
      status: 409,
      code: 'HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED',
      details: { replacementApplied: true, finalHead: 'b'.repeat(40) },
    })
    expect(calls[0]).toEqual(expect.objectContaining({
      url: '/api/history/repair-index',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    }))
  })
})

describe('restoreFile', () => {
  it('posts one document path and revision and returns restored bytes', async () => {
    responses.push({
      status: 200,
      body: { path: 'a.md', ref: 'abc1234', resolvedRef: 'a'.repeat(40), raw: '# Historical', mtime: 100 },
    })

    await expect(api.restoreFile('a.md', 'abc1234')).resolves.toEqual({
      path: 'a.md',
      ref: 'abc1234',
      resolvedRef: 'a'.repeat(40),
      raw: '# Historical',
      mtime: 100,
    })
    expect(calls).toEqual([expect.objectContaining({
      url: '/api/history/restore',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'a.md', ref: 'abc1234' }),
      }),
    })])
  })

  it('throws the server error message on a non-2xx', async () => {
    responses.push({ status: 404, body: { error: 'file does not exist at ref HEAD' } })
    await expect(api.restoreFile('a.md', 'HEAD'))
      .rejects.toThrow('file does not exist at ref HEAD')
  })
})

describe('getFileAt', () => {
  it('throws the server error message on a non-2xx', async () => {
    responses.push({ status: 400, body: { error: 'invalid ref' } })
    await expect(api.getFileAt('a.md', 'main'))
      .rejects.toThrow('invalid ref')
  })

  it('falls back to "<endpoint> failed: <status>" when the body has no error field', async () => {
    responses.push({ status: 503, body: {} })
    await expect(api.getFileAt('a.md', 'WORKTREE'))
      .rejects.toThrow('getFileAt a.md@WORKTREE failed: 503')
  })
})

describe('getLog', () => {
  it('throws the server error message on a non-2xx', async () => {
    responses.push({ status: 503, body: { error: 'git not available' } })
    await expect(api.getLog()).rejects.toThrow('git not available')
  })
})
