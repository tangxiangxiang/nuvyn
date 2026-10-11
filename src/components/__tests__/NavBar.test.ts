// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import NavBar from '../NavBar.vue'
import { VaultViewModeKey, type VaultViewMode } from '../../composables/vault/viewMode'
import { useI18n } from '../../composables/useI18n'
import { useTheme } from '../../composables/useTheme'
import { useScopeFilter } from '../../composables/vault/useScopeFilter'
import { __resetVaultLayoutState } from '../../composables/vault/useVaultLayout'
import { AppShellContextKey } from '../../composables/appShellContext'
import { Calendar, Lock } from '@vicons/tabler'

function installWorkspaceMobileMediaQuery(initialMatches: boolean) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const query = {
    matches: initialMatches,
    media: '(max-width: 600px)',
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    }),
  } as unknown as MediaQueryList
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => query),
  })

  return {
    resize(matches: boolean) {
      Object.defineProperty(query, 'matches', { configurable: true, value: matches })
      for (const listener of listeners) listener({ matches } as MediaQueryListEvent)
    },
    restore() {
      if (originalDescriptor) Object.defineProperty(window, 'matchMedia', originalDescriptor)
      else Reflect.deleteProperty(window, 'matchMedia')
    },
  }
}

function makeViewModeApi(initial: VaultViewMode = 'edit') {
  const mode = ref<VaultViewMode>(initial)
  return {
    mode,
    set: (m: VaultViewMode) => { mode.value = m },
    toggle: vi.fn(() => { mode.value = mode.value === 'edit' ? 'read' : 'edit' }),
  }
}

function dispatchPointerEvent(
  target: Element,
  type: string,
  values: Record<string, string | number>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value })
  }
  target.dispatchEvent(event)
}

function installSvgAnimationMock(options: { supportsBeginElement?: boolean } = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion')
  const prototype = Object.getPrototypeOf(element) as object
  const originalBegin = Object.getOwnPropertyDescriptor(prototype, 'beginElement')
  const originalEnd = Object.getOwnPropertyDescriptor(prototype, 'endElement')
  const beginElement = vi.fn()
  Object.defineProperty(prototype, 'beginElement', {
    configurable: true,
    value: options.supportsBeginElement === false ? undefined : beginElement,
  })
  Object.defineProperty(prototype, 'endElement', { configurable: true, value: vi.fn() })

  return {
    beginElement,
    restore() {
      if (originalBegin) Object.defineProperty(prototype, 'beginElement', originalBegin)
      else Reflect.deleteProperty(prototype, 'beginElement')
      if (originalEnd) Object.defineProperty(prototype, 'endElement', originalEnd)
      else Reflect.deleteProperty(prototype, 'endElement')
    },
  }
}

function mountNavBar(
  initial: VaultViewMode = 'edit',
  zenModeBrandEntry?: { canEnter: () => boolean; enter: () => boolean },
  attachTo?: HTMLElement,
) {
  const api = makeViewModeApi(initial)
  const provided: Record<symbol, unknown> = { [VaultViewModeKey as symbol]: api }
  if (zenModeBrandEntry) {
    provided[AppShellContextKey as symbol] = {
      settingsRequestTick: ref(0),
      diaryCalendarVisible: ref(false),
      zenModeBrandEntry: ref(zenModeBrandEntry),
    }
  }
  const wrapper = mount(NavBar, {
    attachTo,
    props: { isVault: true },
    global: { provide: provided, stubs: { transition: false } },
  })
  return { wrapper, api }
}

describe('NavBar — view-toggle button', () => {
  beforeEach(() => {
    useScopeFilter().activeScope.value = 'note'
    vi.clearAllMocks()
    useI18n().setLocale('en')
    useTheme().set('light')
    __resetVaultLayoutState()
  })
  afterEach(() => useI18n().setLocale('zh'))

  it('renders a view-toggle button', () => {
    const { wrapper } = mountNavBar()
    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(true)
  })

  it('places the theme toggle before the view toggle', () => {
    const { wrapper } = mountNavBar()
    expect(wrapper.findAll('.nav-actions > button').map((button) => (
      ['nav-search', 'theme-toggle', 'view-toggle', 'left-panel-toggle', 'right-rail-toggle']
        .find((className) => button.classes().includes(className))
    ))).toEqual([
      'nav-search',
      'theme-toggle',
      'view-toggle',
      'left-panel-toggle',
      'right-rail-toggle',
    ])
  })

  it('does not render a logout action in the top-right chrome', () => {
    const { wrapper } = mountNavBar()
    expect(wrapper.find('[data-testid="logout-button"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/log out/i)
  })

  it('keeps the top chrome busy without rendering a logout button', () => {
    const api = makeViewModeApi()
    const wrapper = mount(NavBar, {
      props: { isVault: true, logoutBusy: true },
      global: { provide: { [VaultViewModeKey as symbol]: api } },
    })
    expect(wrapper.find('.navbar').attributes('inert')).toBeDefined()
    expect(wrapper.find('.navbar').attributes('aria-busy')).toBe('true')
    expect(wrapper.find('[data-testid="logout-button"]').exists()).toBe(false)
  })

  it('clicking the button calls viewModeApi.toggle()', async () => {
    const { wrapper, api } = mountNavBar()
    await wrapper.find('[data-testid="view-toggle"]').trigger('click')
    expect(api.toggle).toHaveBeenCalledOnce()
  })

  it('shows the read icon in edit mode (offering "switch to read")', () => {
    const { wrapper } = mountNavBar('edit')
    expect(wrapper.find('[data-testid="view-toggle"]').attributes('aria-label')).toBe('Switch to read')
  })

  it('shows the edit icon in read mode (offering "switch to edit")', () => {
    const { wrapper } = mountNavBar('read')
    expect(wrapper.find('[data-testid="view-toggle"]').attributes('aria-label')).toBe('Switch to edit')
  })

  it('hides the view toggle on Vault Home until a document is open', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/vault', name: 'vault', component: { template: '<div />' } },
        { path: '/vault/:pathMatch(.*)*', name: 'vault-doc', component: { template: '<div />' } },
      ],
    })
    await router.push('/vault')
    await router.isReady()

    const api = makeViewModeApi()
    const wrapper = mount(NavBar, {
      props: { isVault: true },
      global: {
        plugins: [router],
        provide: { [VaultViewModeKey as symbol]: api },
      },
    })

    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="left-panel-toggle"]').exists()).toBe(true)

    await router.push('/vault/inbox/kept-note')
    await nextTick()
    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('hides document and side-panel controls on Diary Calendar Home', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/vault', name: 'vault', component: { template: '<div />' } }],
    })
    await router.push('/vault')
    await router.isReady()

    const scope = useScopeFilter()
    scope.activeScope.value = 'diary'
    const api = makeViewModeApi()
    const wrapper = mount(NavBar, {
      props: { isVault: true },
      global: {
        plugins: [router],
        provide: { [VaultViewModeKey as symbol]: api },
      },
    })

    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="left-panel-toggle"]').exists()).toBe(false)
    expect(wrapper.find('.right-rail-toggle').exists()).toBe(false)

    scope.activeScope.value = 'note'
    await nextTick()
    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="left-panel-toggle"]').exists()).toBe(true)
    expect(wrapper.find('.right-rail-toggle').exists()).toBe(true)
    wrapper.unmount()
  })

  it('follows the resolved Calendar visibility when a document URL is retained', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/vault/:pathMatch(.*)*', name: 'vault-doc', component: { template: '<div />' } }],
    })
    await router.push('/vault/inbox/kept-note')
    await router.isReady()

    const calendarVisible = ref(true)
    const api = makeViewModeApi()
    const wrapper = mount(NavBar, {
      props: { isVault: true },
      global: {
        plugins: [router],
        provide: {
          [VaultViewModeKey as symbol]: api,
          [AppShellContextKey as symbol]: {
            settingsRequestTick: ref(0),
            diaryCalendarVisible: calendarVisible,
          },
        },
      },
    })

    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="left-panel-toggle"]').exists()).toBe(false)
    expect(wrapper.find('.right-rail-toggle').exists()).toBe(false)

    calendarVisible.value = false
    await nextTick()
    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="left-panel-toggle"]').exists()).toBe(true)
    expect(wrapper.find('.right-rail-toggle').exists()).toBe(true)
    wrapper.unmount()
  })

  it('omits the contextual toggle in Diary documents and restores it in Note', async () => {
    const { wrapper } = mountNavBar()
    useScopeFilter().activeScope.value = 'diary'
    await nextTick()
    expect(wrapper.find('.right-rail-toggle').exists()).toBe(false)
    expect(wrapper.find('[data-testid="left-panel-toggle"]').exists()).toBe(true)
    useScopeFilter().activeScope.value = 'note'
    await nextTick()
    expect(wrapper.find('.right-rail-toggle').exists()).toBe(true)
    wrapper.unmount()
  })

  it('places the account entry in the navbar actions and forwards settings', async () => {
    const { wrapper } = mountNavBar()

    expect(wrapper.find('.nav-actions [data-testid="account-button"]').exists()).toBe(true)
    expect(wrapper.find('.nav-actions [data-testid="account-button"]').element.closest('.activity-bar')).toBeNull()

    await wrapper.find('[data-testid="account-button"]').trigger('click')
    await wrapper.find('[data-testid="account-settings"]').trigger('click')

    expect(wrapper.emitted('open-settings')).toHaveLength(1)
  })

  it('preserves search, theme, and panel action semantics and ARIA state', async () => {
    const { wrapper } = mountNavBar()
    const search = wrapper.get('.nav-search')
    const theme = wrapper.get('.theme-toggle')
    const left = wrapper.get('[data-testid="left-panel-toggle"]')
    const right = wrapper.get('.right-rail-toggle')

    expect(search.attributes('aria-label')).toBe('Search')
    await search.trigger('click')
    expect(wrapper.emitted('open-search')).toHaveLength(1)

    expect(theme.attributes('aria-label')).toContain('Dark')
    await theme.trigger('click')
    expect(useTheme().theme.value).toBe('dark')
    expect(theme.attributes('aria-label')).toContain('Light')

    expect(left.attributes('aria-pressed')).toBe('true')
    expect(right.attributes('aria-pressed')).toBe('true')
    await left.trigger('click')
    await right.trigger('click')
    expect(left.attributes('aria-pressed')).toBe('false')
    expect(right.attributes('aria-pressed')).toBe('false')
  })
})

describe('NavBar — scope chips', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
    useScopeFilter().activeScope.value = 'note'
  })
  afterEach(() => useI18n().setLocale('zh'))

  it('shows the content-oriented scope names', () => {
    const { wrapper } = mountNavBar()

    expect(wrapper.findAll('.scope-chip')[0].attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('.scope-chip-label').map((chip) => chip.text())).toEqual([
      'note',
      'diary',
      'ledger',
    ])
  })

  it('shows a lock for a locked Diary and a calendar after unlocking', async () => {
    const wrapper = mount(NavBar, {
      props: { isVault: true, diaryUnlocked: false },
    })

    expect(wrapper.findComponent(Lock).exists()).toBe(true)
    expect(wrapper.findComponent(Calendar).exists()).toBe(false)

    await wrapper.setProps({ diaryUnlocked: true })

    expect(wrapper.findComponent(Lock).exists()).toBe(false)
    expect(wrapper.findComponent(Calendar).exists()).toBe(true)
    wrapper.unmount()
  })

  it('uses content scopes instead of exposing individual vault roots', async () => {
    const { wrapper } = mountNavBar()
    const chips = wrapper.findAll('.scope-chip')

    await chips[1].trigger('click')

    expect(chips[1].attributes('aria-pressed')).toBe('true')
    expect(chips[1].attributes('aria-label')).toBe('Current scope: diary')
  })

  it('routes an active unlocked Diary re-selection through the shared Diary Back command', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/vault', name: 'vault', component: { template: '<div />' } },
        { path: '/vault/:pathMatch(.*)*', name: 'vault-doc', component: { template: '<div />' } },
      ],
    })
    await router.push('/vault/diary/2026-09-30')
    await router.isReady()
    const scope = useScopeFilter()
    scope.activeScope.value = 'diary'
    const diaryBackCommand = vi.fn()
    const wrapper = mount(NavBar, {
      props: { isVault: true, diaryUnlocked: true },
      global: {
        plugins: [router],
        provide: {
          [VaultViewModeKey as symbol]: makeViewModeApi(),
          [AppShellContextKey as symbol]: {
            settingsRequestTick: ref(0),
            diaryCalendarVisible: ref(false),
            diaryBackCommand: ref(diaryBackCommand),
          },
        },
      },
    })

    const diaryChip = wrapper.findAll('.scope-chip')[1]
    expect(diaryChip.element.tagName).toBe('BUTTON')
    expect(diaryChip.attributes('aria-pressed')).toBe('true')
    await diaryChip.trigger('click')

    expect(diaryBackCommand).toHaveBeenCalledOnce()
    expect(scope.activeScope.value).toBe('diary')
    expect(router.currentRoute.value.path).toBe('/vault/diary/2026-09-30')
    wrapper.unmount()
  })

  it('keeps Note to Diary as a normal workspace switch', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/vault', name: 'vault', component: { template: '<div />' } },
        { path: '/vault/:pathMatch(.*)*', name: 'vault-doc', component: { template: '<div />' } },
      ],
    })
    await router.push('/vault/inbox/example')
    await router.isReady()
    const scope = useScopeFilter()
    scope.activeScope.value = 'note'
    const diaryBackCommand = vi.fn()
    const wrapper = mount(NavBar, {
      props: { isVault: true, diaryUnlocked: true },
      global: {
        plugins: [router],
        provide: {
          [VaultViewModeKey as symbol]: makeViewModeApi(),
          [AppShellContextKey as symbol]: {
            settingsRequestTick: ref(0),
            diaryCalendarVisible: ref(false),
            diaryBackCommand: ref(diaryBackCommand),
          },
        },
      },
    })

    await wrapper.findAll('.scope-chip')[1].trigger('click')

    expect(diaryBackCommand).not.toHaveBeenCalled()
    expect(scope.activeScope.value).toBe('diary')
    expect(router.currentRoute.value.path).toBe('/vault/inbox/example')
    wrapper.unmount()
  })

  it('waits for the Vault to restore Note scope before selecting the Note chip', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/vault', name: 'vault', component: { template: '<div />' } },
        { path: '/vault/:pathMatch(.*)*', name: 'vault-doc', component: { template: '<div />' } },
      ],
    })
    await router.push('/vault/diary/2026-09-30')
    await router.isReady()
    const scope = useScopeFilter()
    scope.activeScope.value = 'diary'
    let resolveExit: (completed: boolean) => void = () => {}
    const vaultScopeChangeCommand = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveExit = resolve
    }))
    const wrapper = mount(NavBar, {
      props: { isVault: true, diaryUnlocked: true },
      global: {
        plugins: [router],
        provide: {
          [VaultViewModeKey as symbol]: makeViewModeApi(),
          [AppShellContextKey as symbol]: {
            settingsRequestTick: ref(0),
            diaryCalendarVisible: ref(false),
            diaryBackCommand: ref(null),
            vaultScopeChangeCommand: ref(vaultScopeChangeCommand),
          },
        },
      },
    })

    await wrapper.findAll('.scope-chip')[0].trigger('click')

    expect(vaultScopeChangeCommand).toHaveBeenCalledWith('note')
    expect(vaultScopeChangeCommand).toHaveBeenCalledOnce()
    expect(scope.activeScope.value).toBe('diary')
    resolveExit(false)
    await flushPromises()
    expect(scope.activeScope.value).toBe('diary')

    wrapper.unmount()
  })

  it('uses the ledger scope chip as the canonical Ledger entry', async () => {
    const api = makeViewModeApi()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/vault', name: 'vault', component: { template: '<div />' } },
        { path: '/ledger', name: 'ledger', component: { template: '<div />' } },
      ],
    })
    await router.push('/vault')
    await router.isReady()

    const wrapper = mount(NavBar, {
      props: { isVault: true },
      global: {
        plugins: [router],
        provide: { [VaultViewModeKey as symbol]: api },
      },
    })

    expect(wrapper.findAll('.scope-chip')[2].text()).toContain('ledger')
    await wrapper.findAll('.scope-chip')[2].trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(router.currentRoute.value.name).toBe('ledger')
  })

  it('keeps the shared workspace chrome on the Ledger route', async () => {
    const api = makeViewModeApi()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/vault', name: 'vault', component: { template: '<div />' } },
        { path: '/ledger', name: 'ledger', component: { template: '<div />' } },
      ],
    })
    await router.push('/ledger')
    await router.isReady()

    const wrapper = mount(NavBar, {
      props: { isVault: true },
      global: {
        plugins: [router],
        provide: { [VaultViewModeKey as symbol]: api },
      },
    })

    expect(wrapper.find('.navbar').classes()).toContain('is-vault')
    expect(wrapper.findAll('.scope-chip')[2].attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.nav-search').exists()).toBe(false)
    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(false)
    expect(wrapper.find('.right-rail-toggle').exists()).toBe(false)
    expect(wrapper.find('[data-testid="account-button"]').exists()).toBe(true)

    await wrapper.findAll('.scope-chip')[0].trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(router.currentRoute.value.name).toBe('vault')
    expect(useScopeFilter().activeScope.value).toBe('note')
    wrapper.unmount()
  })

  it('hides global search when Ledger passes its explicit workspace kind', () => {
    const wrapper = mount(NavBar, {
      props: { workspaceKind: 'ledger' },
    })

    expect(wrapper.find('.nav-search').exists()).toBe(false)
    wrapper.unmount()
  })

  it('only renders scope chips in the Vault chrome', () => {
    const api = makeViewModeApi()
    const wrapper = mount(NavBar, {
      props: { isVault: false },
      global: {
        provide: { [VaultViewModeKey as symbol]: api },
      },
    })

    expect(wrapper.find('.scope-chips').exists()).toBe(false)
  })

  it('renders Board as the active workspace entry with shared workspace navigation', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/board', name: 'board', component: { template: '<div />' } },
        { path: '/vault', name: 'vault', component: { template: '<div />' } },
      ],
    })
    await router.push('/board')
    await router.isReady()

    const wrapper = mount(NavBar, {
      props: { workspaceKind: 'board' },
      global: { plugins: [router] },
    })

    expect(wrapper.find('.navbar').classes()).toContain('is-workspace')
    expect(wrapper.find('.workspace-board-link').classes()).toContain('active')
    expect(wrapper.find('.workspace-board-link').attributes('aria-current')).toBe('page')
    expect(wrapper.find('.workspace-board-link-label').text()).toBe('board')
    expect(wrapper.find('.scope-chips').exists()).toBe(true)
    expect(wrapper.findAll('.scope-chip')).toHaveLength(3)
    expect(wrapper.findAll('.scope-chip.active')).toHaveLength(0)
    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(false)
    expect(wrapper.find('.left-panel-toggle').exists()).toBe(false)
    await wrapper.find('.nav-search').trigger('click')
    expect(wrapper.emitted('open-search')).toHaveLength(1)
    await wrapper.findAll('.scope-chip')[0].trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(router.currentRoute.value.name).toBe('vault')
    expect(useScopeFilter().activeScope.value).toBe('note')
    wrapper.unmount()
  })
})

describe('NavBar — brand constellation', () => {
  async function advanceAnimation(ms: number) {
    await vi.advanceTimersByTimeAsync(ms)
    await nextTick()
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    useTheme().set('light')
  })

  it('opens after hovering the brand for three seconds', async () => {
    const { wrapper } = mountNavBar()
    const brand = wrapper.find('.brand')

    await brand.trigger('pointerenter', { pointerType: 'mouse' })
    vi.advanceTimersByTime(2999)
    await nextTick()
    expect(wrapper.find('.brand-constellation').exists()).toBe(false)

    vi.advanceTimersByTime(1)
    await nextTick()
    expect(wrapper.find('.brand-constellation').exists()).toBe(true)
    expect(wrapper.find('.brand-decoration').attributes('data-phase')).toBe('black')
    expect(wrapper.find('.brand-decoration-mark').exists()).toBe(false)
    expect(wrapper.findAll('.brand-network-node')).toHaveLength(0)
    expect(wrapper.find('.brand').element.tagName).toBe('BUTTON')
  })

  it('keeps the product-specific brand button as the home route action', async () => {
    const api = makeViewModeApi()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: { template: '<div />' } },
        { path: '/vault', name: 'vault', component: { template: '<div />' } },
      ],
    })
    await router.push('/vault')
    await router.isReady()
    const wrapper = mount(NavBar, {
      props: { isVault: true },
      global: {
        plugins: [router],
        provide: { [VaultViewModeKey as symbol]: api },
      },
    })

    await wrapper.get('.brand').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('home')
    wrapper.unmount()
  })

  it('closes when the pointer leaves the brand', async () => {
    const { wrapper } = mountNavBar()
    const brand = wrapper.find('.brand')

    await brand.trigger('pointerenter', { pointerType: 'mouse' })
    vi.advanceTimersByTime(3000)
    await nextTick()
    await brand.trigger('pointerleave', { pointerType: 'mouse' })

    expect(wrapper.find('.brand-constellation').exists()).toBe(false)
  })

  it.each(['Escape', 'blur'])('cleans the body cursor class on %s', async (event) => {
    const { wrapper } = mountNavBar()
    await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(document.body.classList.contains('brand-constellation-active')).toBe(true)
    if (event === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    else window.dispatchEvent(new Event('blur'))
    expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
    wrapper.unmount()
  })

  it('cleans the body cursor class when the document becomes hidden', async () => {
    const { wrapper } = mountNavBar()
    await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(document.body.classList.contains('brand-constellation-active')).toBe(true)

    const originalHidden = document.hidden
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
    Object.defineProperty(document, 'hidden', { configurable: true, value: originalHidden })
    wrapper.unmount()
  })

  it('cleans the body cursor class when the route changes', async () => {
    const api = makeViewModeApi()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/vault', component: { template: '<div />' } },
      ],
    })
    const wrapper = mount(NavBar, {
      props: { isVault: true },
      global: {
        plugins: [router],
        provide: { [VaultViewModeKey as symbol]: api },
      },
    })
    await router.push('/')
    await router.isReady()
    await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(document.body.classList.contains('brand-constellation-active')).toBe(true)

    await router.push('/vault')
    await nextTick()
    expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
    wrapper.unmount()
  })

  it('cleans the body cursor class on unmount and before the delay fires', async () => {
    const { wrapper } = mountNavBar()
    await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
    wrapper.unmount()
    vi.advanceTimersByTime(3000)
    expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
  })

  it('forms Courage from the first point, then delivers each virtue on arrival before entering Zen Mode', async () => {
    useI18n().setLocale('zh')
    const smil = installSvgAnimationMock()
    const enter = vi.fn(() => true)
    const canEnter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter, enter })
    try {
      await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3000)
      const journey = wrapper.get('.brand-journey')
      const core = wrapper.get('.brand-journey-core').element
      expect(journey.attributes('data-phase')).toBe('black')
      expect(wrapper.find('.brand-journey-round').exists()).toBe(false)
      expect(wrapper.find('.brand-network-virtue').exists()).toBe(false)
      expect(wrapper.get('.brand-journey-core').classes()).toContain('is-hidden')
      expect(wrapper.find('.brand-network').exists()).toBe(false)
      await advanceAnimation(299)
      expect(wrapper.find('.brand-journey-round').exists()).toBe(false)
      await advanceAnimation(1)
      expect(journey.attributes('data-phase')).toBe('appearing')
      expect(wrapper.get('.brand-journey-round').attributes('data-virtue')).toBe('courage')
      expect(wrapper.get('.brand-journey-round').attributes('data-virtue-color')).toBe('#6270AC')
      expect(smil.beginElement).not.toHaveBeenCalled()
      await advanceAnimation(400)
      expect(journey.attributes('data-phase')).toBe('moving')
      expect(smil.beginElement).toHaveBeenCalledOnce()
      expect(wrapper.get('.brand-journey-flight').classes()).toContain('is-moving')
      expect(wrapper.findAll('.brand-journey-glow circle')).toHaveLength(2)
      expect(wrapper.get('.brand-journey-glow-inner').attributes('filter')).toBe('url(#brand-point-glow-inner)')
      expect(wrapper.get('.brand-journey-glow-outer').attributes('filter')).toBe('url(#brand-point-glow-outer)')
      expect(wrapper.find('.brand-network-virtue').exists()).toBe(false)
      const firstMotion = wrapper.get('animateMotion')
      expect(firstMotion.attributes('dur')).toBe('900ms')
      expect(firstMotion.attributes('calcMode')).toBe('spline')
      expect(firstMotion.attributes('keySplines')).toBe('0.45 0 0.35 1')
      expect(firstMotion.attributes('path')).toBe('M 0 0 L 0 355')
      await advanceAnimation(599)
      expect(wrapper.find('.brand-network-virtue').exists()).toBe(false)
      await advanceAnimation(1)
      expect(wrapper.find('.brand-network-virtue').exists()).toBe(false)
      expect(wrapper.get('.brand-journey-core').classes()).toContain('is-forming')
      await advanceAnimation(300)
      firstMotion.element.dispatchEvent(new Event('endEvent'))
      await nextTick()
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('勇气')
      expect(wrapper.get('.brand-network-virtue-subtitle').text()).toBe('Courage')
      expect(journey.attributes('data-phase')).toBe('forming')
      expect(wrapper.get('.brand-journey-flight').classes()).toContain('is-forming')
      firstMotion.element.dispatchEvent(new Event('endEvent'))
      await advanceAnimation(600)
      expect(wrapper.find('.brand-journey-round').exists()).toBe(false)
      expect(wrapper.get('.brand-journey-core').classes()).toContain('is-steady')
      await advanceAnimation(699)
      expect(smil.beginElement).toHaveBeenCalledOnce()
      await advanceAnimation(1)

      const virtues = [
        'courage', 'honesty', 'reflection', 'humility', 'kindness',
        'patience', 'restraint', 'focus', 'clarity',
      ]
      const colors = [
        '#6270AC', '#6977B7', '#7280C2', '#7D89CD', '#8992D6',
        '#969CE0', '#A5A8E9', '#B3B3F1', '#C4C1FA',
      ]
      const chineseWords = ['勇气', '诚实', '自省', '谦逊', '善意', '耐心', '克制', '专注', '清明']
      const englishWords = ['Courage', 'Honesty', 'Reflection', 'Humility', 'Kindness', 'Patience', 'Restraint', 'Focus', 'Clarity']
      for (let index = 1; index < chineseWords.length; index += 1) {
        const round = wrapper.get('.brand-journey-round')
        expect(wrapper.findAll('.brand-journey-point')).toHaveLength(1)
        expect(round.attributes('data-virtue')).toBe(virtues[index])
        expect(round.attributes('data-virtue-color')).toBe(colors[index])
        expect(wrapper.get('.brand-network-virtue-primary').text()).toBe(chineseWords[index - 1])
        await advanceAnimation(250)
        const motion = wrapper.get('animateMotion')
        expect(motion.attributes('dur')).toBe('850ms')
        expect(smil.beginElement).toHaveBeenCalledTimes(index + 1)
        // Travel does not advance the word; only this round's arrival does.
        await advanceAnimation(850)
        expect(wrapper.get('.brand-network-virtue-primary').text()).toBe(chineseWords[index - 1])
        motion.element.dispatchEvent(new Event('endEvent'))
        await nextTick()
        expect(wrapper.findAll('.brand-network-virtue')).toHaveLength(1)
        motion.element.dispatchEvent(new Event('endEvent'))
        firstMotion.element.dispatchEvent(new Event('endEvent'))
        await advanceAnimation(300)
        expect(wrapper.findAll('.brand-network-virtue')).toHaveLength(1)
        expect(wrapper.get('.brand-network-virtue-primary').text()).toBe(chineseWords[index])
        expect(wrapper.get('.brand-network-virtue-subtitle').text()).toBe(englishWords[index])
        expect(wrapper.get('.brand-journey-core').element).toBe(core)
        expect(enter).not.toHaveBeenCalled()
        if (index < chineseWords.length - 1) await advanceAnimation(500)
      }

      expect(smil.beginElement).toHaveBeenCalledTimes(9)
      const finalWord = wrapper.find('.brand-network-virtue.is-final')
      expect(finalWord.get('.brand-network-virtue-primary').text()).toBe('清明')
      expect(wrapper.get('.brand-journey-core').classes()).toContain('is-final')
      expect(wrapper.findAll('.brand-journey-rim circle').map((arc) => arc.attributes('stroke'))).toEqual(colors)
      await advanceAnimation(1099)
      expect(enter).not.toHaveBeenCalled()
      await advanceAnimation(1)
      expect(journey.attributes('data-phase')).toBe('merging')
      expect(wrapper.get('.brand-journey-rim').classes()).toContain('is-unified')
      expect(wrapper.find('.brand-journey-point').exists()).toBe(false)
      await advanceAnimation(900)
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('归一')
      expect(wrapper.get('.brand-network-virtue-subtitle').text()).toBe('Oneness')
      expect(smil.beginElement).toHaveBeenCalledTimes(9)
      await advanceAnimation(1499)
      expect(enter).not.toHaveBeenCalled()
      expect(wrapper.find('.brand-constellation').exists()).toBe(true)
      await advanceAnimation(1)
      expect(enter).not.toHaveBeenCalled()
      await advanceAnimation(600)
      await flushPromises()
      expect(canEnter).toHaveBeenCalled()
      expect(wrapper.find('.brand-constellation').exists()).toBe(false)
      expect(enter).toHaveBeenCalledOnce()
    } finally {
      wrapper.unmount()
      smil.restore()
      useI18n().setLocale('zh')
    }
  })

  it('keeps both languages together regardless of the application locale', async () => {
    useI18n().setLocale('en')
    const smil = installSvgAnimationMock()
    const { wrapper } = mountNavBar('edit', { canEnter: () => true, enter: vi.fn(() => true) })
    try {
      await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3700)
      expect(wrapper.find('.brand-network-virtue').exists()).toBe(false)
      await advanceAnimation(600)
      expect(wrapper.find('.brand-network-virtue').exists()).toBe(false)
      await advanceAnimation(300)
      wrapper.get('animateMotion').element.dispatchEvent(new Event('endEvent'))
      await advanceAnimation(1550)
      expect(wrapper.get('.brand-journey-round').attributes('data-virtue')).toBe('honesty')
      expect(wrapper.find('.brand-network-virtue-primary').text()).toBe('勇气')
      expect(wrapper.find('.brand-network-virtue-subtitle').text()).toBe('Courage')
      useI18n().setLocale('zh')
      await advanceAnimation(850)
      wrapper.get('animateMotion').element.dispatchEvent(new Event('endEvent'))
      await advanceAnimation(300)
      expect(wrapper.findAll('.brand-network-virtue')).toHaveLength(1)
      expect(wrapper.find('.brand-network-virtue-primary').text()).toBe('诚实')
      expect(wrapper.find('.brand-network-virtue-subtitle').text()).toBe('Honesty')
      expect(wrapper.text()).not.toContain('Nine Virtues')
    } finally {
      wrapper.unmount()
      smil.restore()
      useI18n().setLocale('zh')
    }
  })

  it('cancels the Oneness hold without a delayed or inherited entry', async () => {
    const smil = installSvgAnimationMock({ supportsBeginElement: false })
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter: () => true, enter })
    try {
      await wrapper.get('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(5850)
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('归一')
      expect(wrapper.find('.brand-journey-point').exists()).toBe(false)
      window.dispatchEvent(new Event('blur'))
      await advanceAnimation(30000)
      expect(enter).not.toHaveBeenCalled()
      expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
      await wrapper.get('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3700)
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('勇气')
      expect(wrapper.get('.brand-network-virtue-subtitle').text()).toBe('Courage')
    } finally {
      wrapper.unmount()
      smil.restore()
    }
  })

  it('cancels a prepared entry if the window blurs during the fade', async () => {
    const smil = installSvgAnimationMock({ supportsBeginElement: false })
    const enter = vi.fn(() => true)
    const canEnter = vi.fn(() => true)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { wrapper } = mountNavBar('edit', { canEnter, enter }, container)
    try {
      await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(7350)
      expect(container.querySelector('.brand-network-virtue-primary')?.textContent).toBe('归一')
      expect(container.querySelector('.brand-constellation')?.classList.contains('brand-constellation-leave-active')).toBe(true)
      expect(enter).not.toHaveBeenCalled()

      window.dispatchEvent(new Event('blur'))
      await nextTick()
      await advanceAnimation(600)
      await flushPromises()
      expect(enter).not.toHaveBeenCalled()
      expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
    } finally {
      wrapper.unmount()
      container.remove()
      smil.restore()
    }
  })

  it.each([0, 300, 700, 3000])('cancels the journey %i ms after opening without delayed progression', async (elapsed) => {
    const smil = installSvgAnimationMock()
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter: () => true, enter })
    try {
      await wrapper.get('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3000 + elapsed)
      window.dispatchEvent(new Event('blur'))
      await nextTick()
      const launches = smil.beginElement.mock.calls.length
      await advanceAnimation(30000)
      expect(smil.beginElement).toHaveBeenCalledTimes(launches)
      expect(enter).not.toHaveBeenCalled()
      expect(wrapper.find('.brand-constellation').exists()).toBe(false)
      expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
    } finally {
      wrapper.unmount()
      smil.restore()
    }
  })

  it.each(['eligibility loss', 'unmount'])('cleans a running journey after %s', async (reason) => {
    const smil = installSvgAnimationMock()
    const eligible = ref(true)
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter: () => eligible.value, enter })
    try {
      await wrapper.get('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3700)
      expect(smil.beginElement).toHaveBeenCalledOnce()
      if (reason === 'eligibility loss') eligible.value = false
      else wrapper.unmount()
      await nextTick()
      await advanceAnimation(30000)
      expect(smil.beginElement).toHaveBeenCalledOnce()
      expect(enter).not.toHaveBeenCalled()
      expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
    } finally {
      if (reason !== 'unmount') wrapper.unmount()
      smil.restore()
    }
  })

  it('ignores a late particle endEvent from a cancelled animation after a new run starts', async () => {
    const smil = installSvgAnimationMock()
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter: () => true, enter })
    try {
      const brand = wrapper.get('.brand')
      await brand.trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3700)
      const oldMotion = wrapper.get('animateMotion').element

      window.dispatchEvent(new Event('blur'))
      await nextTick()
      expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
      oldMotion.dispatchEvent(new Event('endEvent'))
      expect(enter).not.toHaveBeenCalled()
      await advanceAnimation(600)

      await brand.trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3700)
      expect(smil.beginElement).toHaveBeenCalledTimes(2)
      oldMotion.dispatchEvent(new Event('endEvent'))
      expect(wrapper.find('.brand-network-virtue').exists()).toBe(false)
      expect(wrapper.get('.brand-journey').attributes('data-phase')).toBe('moving')

      wrapper.get('animateMotion').element.dispatchEvent(new Event('endEvent'))
      await nextTick()
      expect(wrapper.find('.brand-network-virtue-primary').text()).toBe('勇气')
    } finally {
      wrapper.unmount()
      smil.restore()
    }
  })

  it.each(['light', 'dark'] as const)('keeps the desktop constellation geometric decoration in %s theme', async (theme) => {
    useTheme().set(theme)
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter: () => false, enter })
    await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(wrapper.get('.brand-decoration').attributes('data-phase')).toBe('black')
    await advanceAnimation(300)
    expect(wrapper.find('.brand-decoration-core').exists()).toBe(true)
    expect(wrapper.find('.brand-decoration-point').exists()).toBe(true)
    expect(wrapper.findAll('.brand-network-node')).toHaveLength(0)
    expect(wrapper.find('image[href="/brain.svg"]').exists()).toBe(false)
    expect(wrapper.find('.brand-network-virtue').exists()).toBe(false)
    await advanceAnimation(2200)
    expect(wrapper.find('.brand-constellation').exists()).toBe(false)
    expect(enter).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('never enters Zen if decoration gains eligibility during its finite playback', async () => {
    const eligible = ref(false)
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter: () => eligible.value, enter })
    try {
      await wrapper.get('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3000)
      eligible.value = true
      await advanceAnimation(2500)
      expect(wrapper.find('.brand-constellation').exists()).toBe(false)
      expect(enter).not.toHaveBeenCalled()
      expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('cancels an unfinished touch long press when the finger moves or is cancelled', async () => {
    const { wrapper } = mountNavBar()
    const brand = wrapper.find('.brand')

    dispatchPointerEvent(brand.element, 'pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 20, clientY: 30 })
    dispatchPointerEvent(brand.element, 'pointermove', { pointerType: 'touch', pointerId: 7, clientX: 33, clientY: 30 })
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(wrapper.find('.brand-constellation').exists()).toBe(false)

    dispatchPointerEvent(brand.element, 'pointerdown', { pointerType: 'touch', pointerId: 8, clientX: 20, clientY: 30 })
    dispatchPointerEvent(brand.element, 'pointercancel', { pointerType: 'touch', pointerId: 8 })
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(wrapper.find('.brand-constellation').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lets a short touch continue to click and consumes the click after a recognized long press', async () => {
    const { wrapper } = mountNavBar()
    const brand = wrapper.find('.brand')

    dispatchPointerEvent(brand.element, 'pointerdown', { pointerType: 'touch', pointerId: 9, clientX: 20, clientY: 30 })
    vi.advanceTimersByTime(2999)
    dispatchPointerEvent(brand.element, 'pointerup', { pointerType: 'touch', pointerId: 9 })
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(wrapper.find('.brand-constellation').exists()).toBe(false)

    dispatchPointerEvent(brand.element, 'pointerdown', { pointerType: 'touch', pointerId: 10, clientX: 20, clientY: 30 })
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(wrapper.find('.brand-constellation').exists()).toBe(true)
    dispatchPointerEvent(brand.element, 'pointerup', { pointerType: 'touch', pointerId: 10 })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    brand.element.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(wrapper.find('.brand-constellation').exists()).toBe(true)
    wrapper.unmount()
  })

  it.each([
    { name: 'Ledger', path: '/ledger', scope: 'ledger' as const, diaryCalendarVisible: false },
    { name: 'Diary Calendar', path: '/vault', scope: 'diary' as const, diaryCalendarVisible: true },
    { name: 'Vault blank page', path: '/vault', scope: 'note' as const, diaryCalendarVisible: false },
  ])('closes a released touch constellation after its decorative animation on $name', async ({ path, scope, diaryCalendarVisible }) => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/ledger', component: { template: '<div />' } },
        { path: '/vault', component: { template: '<div />' } },
      ],
    })
    await router.push(path)
    await router.isReady()
    useScopeFilter().activeScope.value = scope
    const wrapper = mount(NavBar, {
      // The legacy Vault prop lets the real /ledger route select its Ledger
      // presentation while keeping this test's mount prop type uniform.
      props: { isVault: true, diaryUnlocked: diaryCalendarVisible },
      global: {
        plugins: [router],
        stubs: { transition: false },
        provide: {
          [VaultViewModeKey as symbol]: makeViewModeApi(),
          [AppShellContextKey as symbol]: {
            settingsRequestTick: ref(0),
            diaryCalendarVisible: ref(diaryCalendarVisible),
            zenModeBrandEntry: ref({ canEnter: () => false, enter: vi.fn(() => true) }),
          },
        },
      },
    })
    const brand = wrapper.get('.brand')
    const originalPath = router.currentRoute.value.fullPath
    try {
      dispatchPointerEvent(brand.element, 'pointerdown', { pointerType: 'touch', pointerId: 31, clientX: 20, clientY: 30 })
      await vi.advanceTimersByTimeAsync(3000)
      await nextTick()
      expect(wrapper.find('.brand-constellation').exists()).toBe(true)
      expect(document.body.classList.contains('brand-constellation-active')).toBe(true)

      // The touch contact ends as soon as recognition succeeds; the visible
      // constellation's source remains touch until its own completion.
      dispatchPointerEvent(brand.element, 'pointerup', { pointerType: 'touch', pointerId: 31 })
      expect(wrapper.find('.brand-constellation').exists()).toBe(true)
      await advanceAnimation(2500)
      await flushPromises()

      expect(wrapper.find('.brand-constellation').exists()).toBe(false)
      expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
      expect(router.currentRoute.value.fullPath).toBe(originalPath)

      dispatchPointerEvent(brand.element, 'pointerdown', { pointerType: 'touch', pointerId: 32, clientX: 20, clientY: 30 })
      await vi.advanceTimersByTimeAsync(3000)
      await nextTick()
      expect(wrapper.find('.brand-constellation').exists()).toBe(true)
    } finally {
      wrapper.unmount()
      expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
      useScopeFilter().activeScope.value = 'note'
    }
  })

  it('keeps click suppression separate from the touch animation and clears stale suppression on the next pointer sequence', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/vault', component: { template: '<div />' } },
      ],
    })
    await router.push('/vault')
    await router.isReady()
    const wrapper = mount(NavBar, {
      props: { isVault: true },
      global: {
        plugins: [router],
        stubs: { transition: false },
        provide: {
          [VaultViewModeKey as symbol]: makeViewModeApi(),
          [AppShellContextKey as symbol]: {
            settingsRequestTick: ref(0),
            diaryCalendarVisible: ref(false),
            zenModeBrandEntry: ref({ canEnter: () => false, enter: vi.fn(() => true) }),
          },
        },
      },
    })
    const brand = wrapper.get('.brand')
    try {
      dispatchPointerEvent(brand.element, 'pointerdown', { pointerType: 'touch', pointerId: 41, clientX: 20, clientY: 30 })
      await vi.advanceTimersByTimeAsync(3000)
      dispatchPointerEvent(brand.element, 'pointerup', { pointerType: 'touch', pointerId: 41 })
      const compatibilityClick = new MouseEvent('click', { bubbles: true, cancelable: true })
      brand.element.dispatchEvent(compatibilityClick)
      expect(compatibilityClick.defaultPrevented).toBe(true)
      expect(router.currentRoute.value.fullPath).toBe('/vault')
      expect(wrapper.find('.brand-constellation').exists()).toBe(true)

      // A new normal pointer interaction cannot inherit suppression if the
      // browser did not emit a compatibility click for the prior long press.
      dispatchPointerEvent(brand.element, 'pointerdown', { pointerType: 'mouse', pointerId: 42 })
      brand.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/')
    } finally {
      wrapper.unmount()
    }
  })

  it('recovers when SMIL beginElement exists but the particle endEvent is missing', async () => {
    const smil = installSvgAnimationMock()
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter: () => true, enter })
    try {
      await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3700)
      expect(smil.beginElement).toHaveBeenCalledTimes(1)
      await advanceAnimation(1079)
      expect(wrapper.get('.brand-journey').attributes('data-phase')).toBe('moving')
      expect(smil.beginElement).toHaveBeenCalledOnce()
      await advanceAnimation(1)
      expect(wrapper.get('.brand-journey').attributes('data-phase')).toBe('forming')
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('勇气')
      await advanceAnimation(1300)
      expect(wrapper.get('.brand-journey-round').attributes('data-virtue')).toBe('honesty')
      await advanceAnimation(250)
      expect(smil.beginElement).toHaveBeenCalledTimes(2)
      await advanceAnimation(1029)
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('勇气')
      await advanceAnimation(1)
      await advanceAnimation(300)
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('诚实')
      // The remaining rounds recover separately, rather than launching in
      // parallel or letting a missing endEvent stall the whole entrance.
      await advanceAnimation(18700)
      await flushPromises()
      expect(smil.beginElement).toHaveBeenCalledTimes(9)
      expect(enter).toHaveBeenCalledOnce()
    } finally {
      wrapper.unmount()
      smil.restore()
    }
  })

  it('falls back from Courage to Clarity when SMIL beginElement is unavailable', async () => {
    const smil = installSvgAnimationMock({ supportsBeginElement: false })
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter: () => true, enter })
    try {
      await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3700)
      expect(wrapper.find('.brand-network-virtue-primary').text()).toBe('勇气')
      expect(wrapper.find('.brand-journey-round').exists()).toBe(false)
      await advanceAnimation(750)
      expect(wrapper.find('.brand-network-virtue.is-final .brand-network-virtue-primary').text()).toBe('清明')
      await advanceAnimation(3500)
      await flushPromises()
      expect(enter).toHaveBeenCalledOnce()
    } finally {
      wrapper.unmount()
      smil.restore()
    }
  })

  it('uses the simplified journey if beginning the SVG motion throws', async () => {
    const smil = installSvgAnimationMock()
    smil.beginElement.mockImplementation(() => { throw new Error('SVG animation unavailable') })
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter: () => true, enter })
    try {
      await wrapper.get('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      await advanceAnimation(3700)
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('勇气')
      expect(wrapper.find('animateMotion').exists()).toBe(false)
      await advanceAnimation(750)
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('清明')
      await advanceAnimation(3500)
      expect(enter).toHaveBeenCalledOnce()
      await advanceAnimation(30000)
      expect(enter).toHaveBeenCalledOnce()
    } finally {
      wrapper.unmount()
      smil.restore()
    }
  })

  it('starts constellation completion without animation events under reduced motion', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const query = {
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => query),
    })
    const canEnter = vi.fn(() => true)
    const enter = vi.fn(() => true)
    const { wrapper } = mountNavBar('edit', { canEnter, enter })

    try {
      await wrapper.find('.brand').trigger('pointerenter', { pointerType: 'mouse' })
      vi.advanceTimersByTime(3000)
      await nextTick()
      await nextTick()
      expect(wrapper.get('.brand-journey').attributes('data-phase')).toBe('black')
      expect(wrapper.find('.brand-network-virtue').exists()).toBe(false)
      await advanceAnimation(300)
      expect(wrapper.find('.brand-network-virtue-primary').text()).toBe('勇气')
      expect(wrapper.find('animateMotion').exists()).toBe(false)
      vi.advanceTimersByTime(449)
      await nextTick()
      expect(wrapper.find('.brand-network-virtue-primary').text()).toBe('勇气')
      vi.advanceTimersByTime(1)
      await nextTick()
      await nextTick()
      expect(wrapper.find('.brand-network-virtue-primary').text()).toBe('清明')
      vi.advanceTimersByTime(799)
      await nextTick()
      expect(wrapper.find('.brand-constellation').exists()).toBe(true)
      vi.advanceTimersByTime(1)
      await nextTick()
      await advanceAnimation(0)
      expect(wrapper.get('.brand-network-virtue-primary').text()).toBe('归一')
      expect(wrapper.get('.brand-network-virtue-subtitle').text()).toBe('Oneness')
      await advanceAnimation(1499)
      expect(enter).not.toHaveBeenCalled()
      await advanceAnimation(1)
      expect(canEnter).toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      if (originalDescriptor) Object.defineProperty(window, 'matchMedia', originalDescriptor)
      else Reflect.deleteProperty(window, 'matchMedia')
    }
  })
})

describe('NavBar — workspace mobile availability', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
    useScopeFilter().activeScope.value = 'note'
  })
  afterEach(() => useI18n().setLocale('zh'))

  it('removes Note and Board from mobile navigation and restores them on resize', async () => {
    const media = installWorkspaceMobileMediaQuery(true)
    const { wrapper } = mountNavBar()

    expect(wrapper.findAll('.scope-chip-label').map((label) => label.text())).toEqual(['diary', 'ledger'])
    expect(wrapper.find('.workspace-board-link').exists()).toBe(false)
    expect(wrapper.findAll('.scope-chip[aria-pressed="true"]')).toHaveLength(0)

    media.resize(false)
    await nextTick()
    expect(wrapper.findAll('.scope-chip-label').map((label) => label.text())).toEqual([
      'note',
      'diary',
      'ledger',
    ])
    expect(wrapper.find('.workspace-board-link').exists()).toBe(true)
    expect(wrapper.find('.scope-chip[aria-pressed="true"] .scope-chip-label').text()).toBe('note')

    media.resize(true)
    await nextTick()
    expect(wrapper.findAll('.scope-chip-label').map((label) => label.text())).toEqual(['diary', 'ledger'])
    expect(wrapper.find('.workspace-board-link').exists()).toBe(false)

    wrapper.unmount()
    media.restore()
  })
})
