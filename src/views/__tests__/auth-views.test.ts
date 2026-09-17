// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { AuthApiError } from '../../lib/auth-api'
import LoginView from '../LoginView.vue'
import SetupView from '../SetupView.vue'
import { useI18n } from '../../composables/useI18n'

const mocks = vi.hoisted(() => ({
  route: { query: {} as Record<string, unknown> },
  router: {
    replace: vi.fn(),
    resolve: vi.fn((target: unknown) => target),
  },
  auth: {
    submitting: { value: false },
    login: vi.fn(),
    setup: vi.fn(),
    refreshStatus: vi.fn(),
  },
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => mocks.router,
}))

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => mocks.auth,
}))

const wrappers: VueWrapper[] = []

function mountLogin() {
  const wrapper = mount(LoginView, { attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}

function mountSetup() {
  const wrapper = mount(SetupView, { attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}

function fill(wrapper: VueWrapper, selector: string, value: string) {
  const input = wrapper.get(selector)
  input.setValue(value)
  return input
}

function error(code: string, status = 401, retryAfterSeconds?: number): AuthApiError {
  return new AuthApiError('request failed', status, { code }, retryAfterSeconds)
}

beforeEach(() => {
  useI18n().setLocale('zh')
  mocks.route.query = {}
  mocks.router.replace.mockReset()
  mocks.router.resolve.mockClear()
  mocks.auth.submitting = ref(false)
  mocks.auth.login.mockReset()
  mocks.auth.setup.mockReset()
  mocks.auth.refreshStatus.mockReset()
})

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
  useI18n().setLocale('zh')
})

describe('LoginView', () => {
  it('does not ask the browser to remember the username', () => {
    const wrapper = mountLogin()

    expect(wrapper.get('form').attributes('autocomplete')).toBe('off')
    expect(wrapper.get('#login-username').attributes('autocomplete')).toBe('off')
    expect(wrapper.get('#login-password').attributes('autocomplete')).toBe('new-password')
  })

  it('submits username and password, including Enter/form submission', async () => {
    mocks.auth.login.mockResolvedValue({ authenticated: true, user: { id: 1, username: 'owner' } })
    mocks.route.query = { redirect: '/vault/a?view=read#section' }
    const wrapper = mountLogin()
    await fill(wrapper, '#login-username', 'owner').trigger('input')
    await fill(wrapper, '#login-password', 'secret').trigger('input')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(mocks.auth.login).toHaveBeenCalledWith({ username: 'owner', password: 'secret' })
    expect(mocks.router.replace).toHaveBeenCalledWith('/vault/a?view=read#section')
    expect((wrapper.get('#login-password').element as HTMLInputElement).value).toBe('')
  })

  it('keeps native required, name, and validity semantics inside Naive inputs', () => {
    const wrapper = mountLogin()
    const username = wrapper.get('#login-username').element as HTMLInputElement
    const password = wrapper.get('#login-password').element as HTMLInputElement
    const form = wrapper.get('form').element as HTMLFormElement

    expect(username.required).toBe(true)
    expect(username.name).toBe('username')
    expect(password.required).toBe(true)
    expect(password.name).toBe('password')
    expect(form.checkValidity()).toBe(false)
    expect(mocks.auth.login).not.toHaveBeenCalled()
  })

  it('focuses the username field and prevents duplicate pending submissions', async () => {
    let resolveLogin: (() => void) | undefined
    mocks.auth.login.mockImplementation(() => {
      mocks.auth.submitting.value = true
      return new Promise<void>((resolve) => { resolveLogin = resolve })
    })
    const wrapper = mountLogin()
    await fill(wrapper, '#login-username', 'owner').trigger('input')
    await fill(wrapper, '#login-password', 'secret').trigger('input')
    await flushPromises()
    const logo = wrapper.get('[data-testid="auth-logo"]')
    expect(logo.attributes('src')).toBe('/logo-48.png')
    expect(logo.attributes('alt')).toBe('')
    expect(logo.attributes('aria-hidden')).toBe('true')
    expect(logo.attributes('tabindex')).toBeUndefined()
    const authPage = wrapper.get('.auth-page')
    const authBrand = wrapper.get('.auth-page-brand')
    expect(authBrand.attributes('aria-label')).toBe('Nuvyn')
    expect(wrapper.get('.auth-page-brand-wordmark').text()).toBe('Nuvyn')
    expect(authBrand.element.parentElement).toBe(authPage.element)
    expect(wrapper.get('.auth-card').find('.auth-page-brand').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('#login-username').element)

    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')
    await nextTick()
    expect(mocks.auth.login).toHaveBeenCalledOnce()
    expect(wrapper.get('form').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.auth-submit').attributes('disabled')).toBeDefined()
    resolveLogin?.()
  })

  it('shows generic invalid-credentials and rate-limit errors without user enumeration', async () => {
    mocks.auth.login.mockRejectedValueOnce(error('invalid-credentials'))
    const wrapper = mountLogin()
    await fill(wrapper, '#login-username', 'owner').trigger('input')
    await fill(wrapper, '#login-password', 'wrong').trigger('input')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('用户名或密码错误')
    expect(wrapper.get('#login-username').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('#login-username').attributes('aria-describedby')).toBe('login-error')

    mocks.auth.login.mockRejectedValueOnce(error('auth-rate-limited', 429, 12))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('12')
    expect(wrapper.get('#login-username').attributes('aria-invalid')).toBeUndefined()
    expect(wrapper.get('#login-password').attributes('aria-invalid')).toBeUndefined()

    mocks.auth.login.mockRejectedValueOnce(error('auth-rate-limited'))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('稍后重试')
  })

  it('keeps expiry informational and presents unavailable errors safely', async () => {
    mocks.route.query = { reason: 'expired' }
    mocks.auth.login.mockRejectedValue(new AuthApiError('database detail', 503, { code: 'auth-unavailable' }))
    const wrapper = mountLogin()
    expect(wrapper.get('[role="status"]').text()).toContain('会话已过期')

    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('认证服务暂时不可用')
    expect(wrapper.get('[role="alert"]').text()).not.toContain('database detail')
    expect(wrapper.get('#login-username').attributes('aria-describedby')).toBeUndefined()
  })

  it('uses a safe fallback for malicious redirects and generic failures', async () => {
    mocks.route.query = { redirect: 'https://evil.example' }
    mocks.auth.login.mockRejectedValue(new Error('network down'))
    const wrapper = mountLogin()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('认证服务暂时不可用')
    expect(wrapper.get('label[for="login-username"]')).toBeTruthy()

    mocks.auth.login.mockResolvedValue({ authenticated: true, user: { id: 1, username: 'owner' } })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.router.replace).toHaveBeenCalledWith('/vault')
  })
})

describe('SetupView', () => {
  it('focuses the bootstrap token and explains its operator/fallback source', () => {
    const wrapper = mountSetup()
    const logo = wrapper.get('[data-testid="auth-logo"]')
    expect(logo.attributes('src')).toBe('/logo-48.png')
    expect(logo.attributes('alt')).toBe('')
    expect(logo.attributes('aria-hidden')).toBe('true')
    expect(logo.attributes('tabindex')).toBeUndefined()
    const authPage = wrapper.get('.auth-page')
    const authBrand = wrapper.get('.auth-page-brand')
    expect(authBrand.attributes('aria-label')).toBe('Nuvyn')
    expect(wrapper.get('.auth-page-brand-wordmark').text()).toBe('Nuvyn')
    expect(authBrand.element.parentElement).toBe(authPage.element)
    expect(wrapper.get('.auth-card').find('.auth-page-brand').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('#setup-token').element)
    expect(wrapper.get('#setup-token-help').text()).toContain('NUVYN_SETUP_TOKEN')
    expect(wrapper.get('#setup-token-help').text()).not.toContain('bootstrap-secret')
    expect(wrapper.text()).not.toMatch(/logout|sign out/i)
  })

  it('validates password confirmation without a network request', async () => {
    const wrapper = mountSetup()
    await fill(wrapper, '#setup-password', 'secret').trigger('input')
    await fill(wrapper, '#setup-confirm-password', 'different').trigger('input')
    await wrapper.get('form').trigger('submit')

    expect(mocks.auth.setup).not.toHaveBeenCalled()
    expect(wrapper.get('#setup-confirm-error').text()).toContain('两次输入的密码不一致')
    expect(wrapper.get('#setup-confirm-password').attributes('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(wrapper.get('#setup-confirm-password').element)
  })

  it('keeps every setup secret field required with its transport name', () => {
    const wrapper = mountSetup()
    const expected = [
      ['#setup-token', 'bootstrapToken'],
      ['#setup-username', 'username'],
      ['#setup-password', 'password'],
      ['#setup-confirm-password', 'confirmPassword'],
    ] as const

    for (const [selector, name] of expected) {
      const input = wrapper.get(selector).element as HTMLInputElement
      expect(input.required).toBe(true)
      expect(input.name).toBe(name)
    }
    expect((wrapper.get('form').element as HTMLFormElement).checkValidity()).toBe(false)
  })

  it('sends only bootstrapToken, username, and password, then restores a deep link', async () => {
    mocks.route.query = { redirect: '/vault/inbox/note?view=read#section' }
    mocks.auth.setup.mockResolvedValue({ authenticated: true, user: { id: 1, username: 'owner' } })
    const wrapper = mountSetup()
    await fill(wrapper, '#setup-token', 'bootstrap-secret').trigger('input')
    await fill(wrapper, '#setup-username', 'owner').trigger('input')
    await fill(wrapper, '#setup-password', 'secret').trigger('input')
    await fill(wrapper, '#setup-confirm-password', 'secret').trigger('input')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(mocks.auth.setup).toHaveBeenCalledWith({
      bootstrapToken: 'bootstrap-secret',
      username: 'owner',
      password: 'secret',
    })
    expect(JSON.stringify(mocks.auth.setup.mock.calls[0]?.[0])).not.toContain('confirmPassword')
    expect(mocks.router.replace).toHaveBeenCalledWith('/vault/inbox/note?view=read#section')
    expect((wrapper.get('#setup-token').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('#setup-password').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('#setup-confirm-password').element as HTMLInputElement).value).toBe('')
  })

  it('shows bootstrap-invalid and rate-limit errors', async () => {
    mocks.auth.setup.mockRejectedValueOnce(error('bootstrap-invalid'))
    const wrapper = mountSetup()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Bootstrap Token 无效')
    expect(document.activeElement).toBe(wrapper.get('#setup-token').element)
    expect(wrapper.get('#setup-token').attributes('aria-invalid')).toBe('true')

    mocks.auth.setup.mockRejectedValueOnce(error('auth-rate-limited', 429, 10))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('10')
    expect(wrapper.get('#setup-token').attributes('aria-invalid')).toBeUndefined()

    mocks.auth.setup.mockRejectedValueOnce(error('auth-unavailable', 503))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('认证服务暂时不可用')
  })

  it('keeps owner creation controls busy while the request is pending', async () => {
    let resolveSetup: (() => void) | undefined
    mocks.auth.setup.mockImplementation(() => {
      mocks.auth.submitting.value = true
      return new Promise<void>((resolve) => { resolveSetup = resolve })
    })
    const wrapper = mountSetup()
    await wrapper.get('form').trigger('submit')
    await nextTick()
    expect(wrapper.get('form').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.auth-submit').attributes('disabled')).toBeDefined()
    resolveSetup?.()
  })

  it('re-resolves already-initialized setup instead of getting stuck', async () => {
    mocks.route.query = { redirect: '/vault/inbox/note' }
    mocks.auth.setup.mockRejectedValue(error('already-initialized', 409))
    mocks.auth.refreshStatus.mockResolvedValue('unauthenticated')
    const wrapper = mountSetup()
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(mocks.auth.refreshStatus).toHaveBeenCalledOnce()
    expect(mocks.router.replace).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/vault/inbox/note' },
    })
  })

  it('restores the requested route when already-initialized refresh is authenticated', async () => {
    mocks.route.query = { redirect: '/vault/inbox/recovered' }
    mocks.auth.setup.mockRejectedValue(error('already-initialized', 409))
    mocks.auth.refreshStatus.mockResolvedValue('authenticated')
    const wrapper = mountSetup()
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(mocks.router.replace).toHaveBeenCalledWith('/vault/inbox/recovered')
  })

  it('rejects malicious redirects after successful setup', async () => {
    mocks.route.query = { redirect: 'https://evil.example' }
    mocks.auth.setup.mockResolvedValue({ authenticated: true, user: { id: 1, username: 'owner' } })
    const wrapper = mountSetup()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.router.replace).toHaveBeenCalledWith('/vault')
  })
})
