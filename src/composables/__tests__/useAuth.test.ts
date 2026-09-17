import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/auth-api', () => ({
  getAuthStatus: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setupOwner: vi.fn(),
}))

import { getAuthStatus, login as loginApi, logout as logoutApi, setupOwner as setupApi } from '../../lib/auth-api'
import { captureAuthSessionGeneration, observeAuthSessionResponse } from '../../lib/auth-session'
import { useAuth } from '../useAuth'

const auth = useAuth()

beforeEach(() => {
  auth.resetAuthForTesting()
  vi.mocked(getAuthStatus).mockReset()
  vi.mocked(loginApi).mockReset()
  vi.mocked(logoutApi).mockReset()
  vi.mocked(setupApi).mockReset()
})

afterEach(() => vi.restoreAllMocks())

describe('useAuth singleton coordinator', () => {
  it('deduplicates concurrent hydration and maps setup state', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: false, setupRequired: true })
    const [first, second] = await Promise.all([auth.ensureHydrated(), auth.ensureHydrated()])
    expect(first).toBe('setup-required')
    expect(second).toBe('setup-required')
    expect(getAuthStatus).toHaveBeenCalledOnce()
  })

  it('maps a valid status to authenticated safe user data', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      authenticated: true,
      setupRequired: false,
      user: { id: 3, username: 'owner' },
    })
    await auth.ensureHydrated()
    expect(auth.state.value).toBe('authenticated')
    expect(auth.user.value).toEqual({ id: 3, username: 'owner' })
  })

  it('keeps a generic hydration failure unknown and allows an explicit retry', async () => {
    vi.mocked(getAuthStatus).mockRejectedValueOnce(new Error('network down'))
    await expect(auth.ensureHydrated()).resolves.toBe('unknown')
    expect(auth.state.value).toBe('unknown')
    expect(auth.hydrationError.value).toBeInstanceOf(Error)

    vi.mocked(getAuthStatus).mockResolvedValueOnce({ authenticated: false, setupRequired: true })
    await expect(auth.refreshStatus()).resolves.toBe('setup-required')
    expect(auth.state.value).toBe('setup-required')
  })

  it('does not let late hydration overwrite a successful login', async () => {
    let resolveStatus: ((value: { authenticated: false; setupRequired: false }) => void) | undefined
    vi.mocked(getAuthStatus).mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve }))
    const hydration = auth.ensureHydrated()
    vi.mocked(loginApi).mockResolvedValue({ authenticated: true, user: { id: 1, username: 'owner' } })
    await auth.login({ username: 'owner', password: 'secret' })
    resolveStatus?.({ authenticated: false, setupRequired: false })
    await hydration
    expect(auth.state.value).toBe('authenticated')
    expect(auth.user.value).toEqual({ id: 1, username: 'owner' })
  })

  it('does not let a failed login overwrite the existing authenticated state', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      authenticated: true,
      setupRequired: false,
      user: { id: 1, username: 'owner' },
    })
    await auth.ensureHydrated()
    vi.mocked(loginApi).mockRejectedValue(new Error('invalid credentials'))

    await expect(auth.login({ username: 'owner', password: 'wrong' })).rejects.toThrow('invalid credentials')
    expect(auth.state.value).toBe('authenticated')
    expect(auth.user.value).toEqual({ id: 1, username: 'owner' })
  })

  it('does not leave the form busy after a newer auth transition supersedes a login', async () => {
    let resolveLogin: ((value: { authenticated: true; user: { id: number; username: string } }) => void) | undefined
    vi.mocked(loginApi).mockImplementation(() => new Promise((resolve) => { resolveLogin = resolve }))

    const pendingLogin = auth.login({ username: 'owner', password: 'secret' })
    expect(auth.submitting.value).toBe(true)

    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: false, setupRequired: true })
    await expect(auth.refreshStatus()).resolves.toBe('setup-required')
    expect(auth.submitting.value).toBe(false)

    resolveLogin?.({ authenticated: true, user: { id: 1, username: 'owner' } })
    await pendingLogin
    expect(auth.submitting.value).toBe(false)
    expect(auth.state.value).toBe('setup-required')
  })

  it('moves to authenticated after setup and clears an earlier expiry marker', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: false, setupRequired: true })
    await auth.ensureHydrated()
    vi.mocked(setupApi).mockResolvedValue({ authenticated: true, user: { id: 1, username: 'owner' } })

    await auth.setup({ bootstrapToken: 'bootstrap', username: 'owner', password: 'secret' })

    expect(auth.state.value).toBe('authenticated')
    expect(auth.user.value).toEqual({ id: 1, username: 'owner' })
    expect(auth.sessionExpired.value).toBe(false)
  })

  it('does not let an old-generation expiry event invalidate a newer login', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: false, setupRequired: false })
    await auth.ensureHydrated()
    const oldGeneration = captureAuthSessionGeneration()
    vi.mocked(loginApi).mockResolvedValue({ authenticated: true, user: { id: 1, username: 'owner' } })
    await auth.login({ username: 'owner', password: 'secret' })

    await observeAuthSessionResponse(
      new Response(JSON.stringify({ code: 'auth-session-required' }), { status: 401 }),
      oldGeneration,
    )

    expect(auth.state.value).toBe('authenticated')
    expect(auth.sessionExpired.value).toBe(false)
  })

  it('transitions once for the Nuvyn-owned expiry response', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: true, setupRequired: false, user: { id: 1, username: 'owner' } })
    await auth.ensureHydrated()
    const expired = vi.fn()
    const stop = auth.onSessionExpired(expired)
    await observeAuthSessionResponse(new Response(JSON.stringify({ code: 'auth-session-required' }), { status: 401 }))
    await observeAuthSessionResponse(new Response(JSON.stringify({ code: 'auth-session-required' }), { status: 401 }))
    expect(auth.state.value).toBe('unauthenticated')
    expect(auth.sessionExpired.value).toBe(true)
    expect(expired).toHaveBeenCalledOnce()
    stop()
  })

  it('prepares the workspace before revoking a clean active session', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      authenticated: true,
      setupRequired: false,
      user: { id: 1, username: 'owner' },
    })
    await auth.ensureHydrated()
    vi.mocked(logoutApi).mockResolvedValue(undefined)
    const order: string[] = []
    const unregister = auth.registerWorkspaceTransition({
      prepareActiveLogout: async () => {
        order.push('workspace')
        return { status: 'ready' }
      },
      prepareSessionExpiry: async () => ({ status: 'ready' }),
    })

    const result = await auth.logout()
    order.push('after')
    expect(result).toEqual({ status: 'logged-out', revokeConfirmed: true })
    expect(order).toEqual(['workspace', 'after'])
    expect(logoutApi).toHaveBeenCalledOnce()
    expect(auth.state.value).toBe('unauthenticated')
    unregister()
  })

  it('cancels active logout without revoking or changing auth state', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      authenticated: true,
      setupRequired: false,
      user: { id: 1, username: 'owner' },
    })
    await auth.ensureHydrated()
    vi.mocked(logoutApi).mockResolvedValue(undefined)
    const unregister = auth.registerWorkspaceTransition({
      prepareActiveLogout: async () => ({ status: 'cancelled' }),
      prepareSessionExpiry: async () => ({ status: 'ready' }),
    })

    await expect(auth.logout()).resolves.toEqual({ status: 'cancelled' })
    expect(logoutApi).not.toHaveBeenCalled()
    expect(auth.state.value).toBe('authenticated')
    expect(auth.transitionKind.value).toBeNull()
    unregister()
  })

  it('keeps an authenticated workspace recoverable when revoke fails', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      authenticated: true,
      setupRequired: false,
      user: { id: 1, username: 'owner' },
    })
    await auth.ensureHydrated()
    const revokeError = new Error('auth unavailable')
    vi.mocked(logoutApi).mockRejectedValue(revokeError)
    const resume = vi.fn()
    const unregister = auth.registerWorkspaceTransition({
      prepareActiveLogout: async () => ({ status: 'ready' as const, resume }),
      prepareSessionExpiry: async () => ({ status: 'ready' as const }),
    })

    await expect(auth.logout()).rejects.toBe(revokeError)
    expect(resume).toHaveBeenCalledOnce()
    expect(auth.state.value).toBe('authenticated')
    expect(auth.transitionKind.value).toBeNull()
    unregister()
  })

  it('delays expiry notification until the workspace has flushed', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      authenticated: true,
      setupRequired: false,
      user: { id: 1, username: 'owner' },
    })
    await auth.ensureHydrated()
    let releaseExpiry!: () => void
    const expiryReady = new Promise<void>((resolve) => { releaseExpiry = resolve })
    const prepareSessionExpiry = vi.fn(async () => {
      await expiryReady
      return { status: 'ready' as const }
    })
    const unregister = auth.registerWorkspaceTransition({
      prepareActiveLogout: async () => ({ status: 'ready' }),
      prepareSessionExpiry,
    })
    const expired = vi.fn()
    const stop = auth.onSessionExpired(expired)

    await observeAuthSessionResponse(
      new Response(JSON.stringify({ code: 'auth-session-required' }), { status: 401 }),
    )
    expect(auth.state.value).toBe('unauthenticated')
    expect(auth.transitionKind.value).toBe('expired')
    expect(prepareSessionExpiry).toHaveBeenCalledOnce()
    expect(expired).not.toHaveBeenCalled()

    releaseExpiry()
    await Promise.resolve()
    await Promise.resolve()
    expect(expired).toHaveBeenCalledOnce()
    expect(auth.transitionKind.value).toBeNull()
    stop()
    unregister()
  })

  it('lets session expiry take ownership of an in-flight active logout', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      authenticated: true,
      setupRequired: false,
      user: { id: 1, username: 'owner' },
    })
    await auth.ensureHydrated()
    let finishLogoutPreparation!: () => void
    const preparation = new Promise<void>((resolve) => { finishLogoutPreparation = resolve })
    const prepareSessionExpiry = vi.fn(async () => ({ status: 'ready' as const }))
    const cancelActiveLogout = vi.fn()
    const unregister = auth.registerWorkspaceTransition({
      prepareActiveLogout: async () => {
        await preparation
        return { status: 'ready' as const }
      },
      prepareSessionExpiry,
      cancelActiveLogout,
    })
    const logoutPending = auth.logout()
    await Promise.resolve()

    await observeAuthSessionResponse(
      new Response(JSON.stringify({ code: 'auth-session-required' }), { status: 401 }),
    )
    expect(cancelActiveLogout).toHaveBeenCalledOnce()
    finishLogoutPreparation()

    await expect(logoutPending).resolves.toEqual({ status: 'expired' })
    await Promise.resolve()
    expect(logoutApi).not.toHaveBeenCalled()
    expect(prepareSessionExpiry).toHaveBeenCalledOnce()
    unregister()
  })
})
