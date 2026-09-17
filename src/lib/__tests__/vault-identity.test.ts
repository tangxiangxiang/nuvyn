// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureVaultIdentity,
  getVaultIdentityState,
  requireVaultId,
  resetVaultIdentityForTesting,
} from '../vault-identity'

const authFetch = vi.hoisted(() => vi.fn())
vi.mock('../auth-session', () => ({ authFetch }))

describe('protected vault identity coordinator', () => {
  beforeEach(() => {
    resetVaultIdentityForTesting()
    authFetch.mockReset()
  })

  afterEach(() => resetVaultIdentityForTesting())

  it('deduplicates the in-flight request and caches the validated id', async () => {
    let resolve!: (response: Response) => void
    authFetch.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r }))
    const first = ensureVaultIdentity()
    const second = ensureVaultIdentity()
    expect(authFetch).toHaveBeenCalledTimes(1)
    resolve(new Response(JSON.stringify({ vaultId: 'abc123def456' }), { status: 200 }))
    await expect(first).resolves.toBe('abc123def456')
    await expect(second).resolves.toBe('abc123def456')
    expect(getVaultIdentityState().state.value).toBe('ready')
    expect(requireVaultId()).toBe('abc123def456')
    await expect(ensureVaultIdentity()).resolves.toBe('abc123def456')
    expect(authFetch).toHaveBeenCalledTimes(1)
  })

  it('fails closed on an invalid response and can retry', async () => {
    authFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ vaultId: 'abc123def456' }), { status: 200 }))
    await expect(ensureVaultIdentity()).rejects.toThrow('invalid response')
    expect(getVaultIdentityState().state.value).toBe('error')
    await expect(ensureVaultIdentity()).resolves.toBe('abc123def456')
    expect(getVaultIdentityState().state.value).toBe('ready')
  })

  it('does not let a response from before reset repopulate identity state', async () => {
    let resolve!: (response: Response) => void
    authFetch.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r }))
    const pending = ensureVaultIdentity()

    resetVaultIdentityForTesting()
    resolve(new Response(JSON.stringify({ vaultId: 'stale-vault-id' }), { status: 200 }))
    await expect(pending).resolves.toBe('stale-vault-id')

    expect(getVaultIdentityState().state.value).toBe('unknown')
    expect(getVaultIdentityState().vaultId.value).toBeNull()
    expect(() => requireVaultId()).toThrow('Vault identity must be resolved')
  })
})
