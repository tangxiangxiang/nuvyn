// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AccountMenu from '../AccountMenu.vue'
import { useI18n } from '../../../composables/useI18n'

const wrappers: VueWrapper[] = []

function mountAccount(props: {
  username?: string
  logoutBusy?: boolean
  diaryUnlocked?: boolean
  diaryLockBusy?: boolean
} = {}) {
  const wrapper = mount(AccountMenu, {
    props: { username: 'xiangxiang', ...props },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return wrapper
}

beforeEach(() => useI18n().setLocale('en'))

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
  useI18n().setLocale('zh')
})

describe('AccountMenu', () => {
  it('opens a compact account menu with the current username and toggles closed', async () => {
    const wrapper = mountAccount()
    const button = wrapper.get('[data-testid="account-button"]')

    expect(button.element.tagName).toBe('BUTTON')
    expect(button.attributes('aria-label')).toBe('Account')
    expect(button.attributes('aria-haspopup')).toBe('menu')
    expect(button.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(false)

    await button.trigger('click')
    await wrapper.vm.$nextTick()
    expect(button.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-testid="account-menu"]').text()).toContain('xiangxiang')
    const settings = wrapper.get('[data-testid="account-settings"]')
    expect(settings.text()).toContain('Settings')
    expect(settings.attributes('role')).toBe('menuitem')
    expect(settings.attributes('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(settings.element)
    const logout = wrapper.get('[data-testid="account-logout"]')
    expect(logout.text()).toContain('Log out')
    expect(logout.attributes('role')).toBe('menuitem')
    expect(logout.attributes('tabindex')).toBe('-1')
    expect(document.activeElement).not.toBe(logout.element)

    await button.trigger('click')
    expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(false)
  })

  it('closes on outside pointer without restoring trigger focus', async () => {
    const wrapper = mountAccount()
    const button = wrapper.get('[data-testid="account-button"]')

    await button.trigger('click')
    await wrapper.vm.$nextTick()
    document.dispatchEvent(new Event('pointerdown'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(false)
    expect(document.activeElement).not.toBe(button.element)
  })

  it('closes on Escape and returns focus to the account button', async () => {
    const wrapper = mountAccount()
    const button = wrapper.get('[data-testid="account-button"]')

    await button.trigger('click')
    await wrapper.vm.$nextTick()
    const settings = wrapper.get('[data-testid="account-settings"]')
    expect(document.activeElement).toBe(settings.element)

    settings.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(button.element)
  })

  it.each(['ArrowDown', 'ArrowUp', 'Home', 'End'])(
    'handles %s within the menu without losing focus',
    async (key) => {
      const wrapper = mountAccount()
      const button = wrapper.get('[data-testid="account-button"]')

      await button.trigger('click')
      await wrapper.vm.$nextTick()
      const settings = wrapper.get('[data-testid="account-settings"]')
      const logout = wrapper.get('[data-testid="account-logout"]')
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      })

      settings.element.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(
        key === 'Home' ? settings.element : logout.element,
      )
      expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(true)
    },
  )

  it('closes on Tab without trapping or restoring focus', async () => {
    const wrapper = mountAccount()
    const button = wrapper.get('[data-testid="account-button"]')

    await button.trigger('click')
    await wrapper.vm.$nextTick()
    const logout = wrapper.get('[data-testid="account-logout"]')
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    })

    logout.element.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(false)
    expect(document.activeElement).not.toBe(button.element)
  })

  it('emits a logout intent without making an authentication request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const wrapper = mountAccount()

    await wrapper.get('[data-testid="account-button"]').trigger('click')
    await wrapper.get('[data-testid="account-logout"]').trigger('click')

    expect(wrapper.emitted('logout')).toHaveLength(1)
    expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('emits an open-settings intent from the account menu', async () => {
    const wrapper = mountAccount()
    const trigger = wrapper.get('[data-testid="account-button"]')

    await trigger.trigger('click')
    await wrapper.get('[data-testid="account-settings"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('open-settings')).toHaveLength(1)
    expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
  })

  it('keeps Diary lock conditional, busy-safe, and single-shot', async () => {
    const wrapper = mountAccount({ diaryUnlocked: true, diaryLockBusy: false })
    await wrapper.get('[data-testid="account-button"]').trigger('click')
    const lock = wrapper.get('[data-testid="account-lock-diary"]')

    expect((lock.element as HTMLButtonElement).disabled).toBe(false)
    await lock.trigger('click')
    expect(wrapper.emitted('lock-diary')).toHaveLength(1)
    expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(false)

    await wrapper.get('[data-testid="account-button"]').trigger('click')
    await wrapper.setProps({ diaryLockBusy: true })
    const busyLock = wrapper.get('[data-testid="account-lock-diary"]')
    expect((busyLock.element as HTMLButtonElement).disabled).toBe(true)
    expect(busyLock.attributes('aria-busy')).toBe('true')
    await busyLock.trigger('click')
    expect(wrapper.emitted('lock-diary')).toHaveLength(1)
  })

  it('disables the account entry and prevents duplicate logout intents while busy', async () => {
    const wrapper = mountAccount()
    const button = wrapper.get('[data-testid="account-button"]')

    await button.trigger('click')
    await wrapper.setProps({ logoutBusy: true })

    expect((button.element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.find('[data-testid="account-menu"]').exists()).toBe(false)
    expect(wrapper.emitted('logout')).toBeUndefined()
  })
})
