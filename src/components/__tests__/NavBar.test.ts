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

function makeViewModeApi(initial: VaultViewMode = 'edit') {
  const mode = ref<VaultViewMode>(initial)
  return {
    mode,
    set: (m: VaultViewMode) => { mode.value = m },
    toggle: vi.fn(() => { mode.value = mode.value === 'edit' ? 'read' : 'edit' }),
  }
}

function mountNavBar(initial: VaultViewMode = 'edit') {
  const api = makeViewModeApi(initial)
  const wrapper = mount(NavBar, {
    props: { isVault: true },
    global: {
      provide: { [VaultViewModeKey as symbol]: api },
    },
  })
  return { wrapper, api }
}

describe('NavBar — view-toggle button', () => {
  beforeEach(() => {
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
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens after hovering the brand for three seconds', async () => {
    const { wrapper } = mountNavBar()
    const brand = wrapper.find('.brand')

    await brand.trigger('mouseenter')
    vi.advanceTimersByTime(2999)
    await nextTick()
    expect(wrapper.find('.brand-constellation').exists()).toBe(false)

    vi.advanceTimersByTime(1)
    await nextTick()
    expect(wrapper.find('.brand-constellation').exists()).toBe(true)
    expect(wrapper.findAll('.brand-network-node')).toHaveLength(9)
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

    await brand.trigger('mouseenter')
    vi.advanceTimersByTime(3000)
    await nextTick()
    await brand.trigger('mouseleave')

    expect(wrapper.find('.brand-constellation').exists()).toBe(false)
  })

  it.each(['Escape', 'blur'])('cleans the body cursor class on %s', async (event) => {
    const { wrapper } = mountNavBar()
    await wrapper.find('.brand').trigger('mouseenter')
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
    await wrapper.find('.brand').trigger('mouseenter')
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
    await wrapper.find('.brand').trigger('mouseenter')
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
    await wrapper.find('.brand').trigger('mouseenter')
    wrapper.unmount()
    vi.advanceTimersByTime(3000)
    expect(document.body.classList.contains('brand-constellation-active')).toBe(false)
  })
})
