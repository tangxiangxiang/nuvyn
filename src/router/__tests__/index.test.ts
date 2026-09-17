// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthStatus } from '../../lib/auth-api'
import { useAuth } from '../../composables/useAuth'
import router from '../index'

vi.mock('../../lib/auth-api', () => ({
  getAuthStatus: vi.fn(),
  login: vi.fn(),
  setupOwner: vi.fn(),
}))
// Router guard tests assert navigation policy, not VaultView rendering. Keep
// the authenticated redirects independent of the workspace's large lazy
// module graph so the suite does not time out while transforming the view.
vi.mock('../../views/VaultView.vue', () => ({
  default: { template: '<div />' },
}))

const auth = useAuth()

beforeEach(() => {
  auth.resetAuthForTesting()
  vi.mocked(getAuthStatus).mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ vaultId: 'test-vault' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))
})

afterEach(() => {
  auth.resetAuthForTesting()
  vi.unstubAllGlobals()
})

describe('authentication router guard', () => {
  it('preserves the complete setup deep link for a first-run workspace visit', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: false, setupRequired: true })

    await router.push('/vault/inbox/note?view=read#section')

    expect(router.currentRoute.value.name).toBe('setup')
    expect(router.currentRoute.value.query.redirect).toBe('/vault/inbox/note?view=read#section')
  })

  it('waits for unknown auth state instead of mounting a workspace early', async () => {
    let resolveStatus: ((value: { authenticated: false; setupRequired: true }) => void) | undefined
    vi.mocked(getAuthStatus).mockImplementation(() => new Promise((resolve) => {
      resolveStatus = resolve
    }))

    const navigation = router.push('/vault')
    await vi.waitFor(() => expect(getAuthStatus).toHaveBeenCalledOnce())
    expect(router.currentRoute.value.path).not.toBe('/vault')

    resolveStatus?.({ authenticated: false, setupRequired: true })
    await navigation
    expect(router.currentRoute.value.name).toBe('setup')
  })

  it('preserves a login deep link for an unauthenticated owner', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: false, setupRequired: false })

    await router.push('/vault/a/b?x=1#test')

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/vault/a/b?x=1#test')
  })

  it('preserves a legacy Ledger deep link for an unauthenticated owner', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: false, setupRequired: false })

    await router.push('/bills/transactions?period=month')

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/ledger/transactions?period=month')
  })

  it('rejects an external redirect when an authenticated owner visits an auth page', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      authenticated: true,
      setupRequired: false,
      user: { id: 1, username: 'owner' },
    })

    await router.push('/login?redirect=https%3A%2F%2Fevil.example')

    expect(router.currentRoute.value.name).toBe('vault')
    expect(router.currentRoute.value.fullPath).toBe('/vault')
  })

  it('normalizes auth-page query values without dropping the expiry notice', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: false, setupRequired: false })

    await router.push('/login?reason=expired&redirect=https%3A%2F%2Fevil.example&extra=ignored')

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query).toEqual({ reason: 'expired' })
  })

  it('redirects authenticated setup visits to a safe deep route and consumes the query', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      authenticated: true,
      setupRequired: false,
      user: { id: 1, username: 'owner' },
    })

    await router.push('/setup?redirect=%2Fvault%2Finbox%2Fnote%3Fview%3Dread%23section')

    expect(router.currentRoute.value.name).toBe('vault-doc')
    expect(router.currentRoute.value.fullPath).toBe('/vault/inbox/note?view=read#section')
    expect(router.currentRoute.value.query.redirect).toBeUndefined()
  })

  it('keeps setup-required users on the setup page with only a validated redirect', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authenticated: false, setupRequired: true })

    await router.push('/login?redirect=https%3A%2F%2Fevil.example&extra=ignored')

    expect(router.currentRoute.value.name).toBe('setup')
    expect(router.currentRoute.value.query).toEqual({})
  })
})
