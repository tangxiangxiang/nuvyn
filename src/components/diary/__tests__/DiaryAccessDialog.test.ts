// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useI18n } from '../../../composables/useI18n'
import DiaryAccessDialog from '../DiaryAccessDialog.vue'

enableAutoUnmount(afterEach)

describe('DiaryAccessDialog', () => {
  beforeEach(() => useI18n().setLocale('zh'))
  afterEach(() => {
    document.body.innerHTML = ''
    useI18n().setLocale('zh')
  })

  it('renders setup fields, submits both passwords, and clears them after close', async () => {
    const wrapper = mount(DiaryAccessDialog, {
      props: { open: true, mode: 'setup' },
      attachTo: document.body,
    })
    const password = () => document.getElementById('diary-access-password') as HTMLInputElement
    const confirmPassword = () => document.getElementById('diary-access-confirm') as HTMLInputElement
    const form = () => document.querySelector('form.diary-access-dialog') as HTMLFormElement
    const cancel = () => document.querySelector('[data-testid="diary-access-cancel"]') as HTMLButtonElement
    await wrapper.vm.$nextTick()
    expect(password()).toBeTruthy()
    expect(confirmPassword()).toBeTruthy()
    expect(document.activeElement).toBe(password())
    expect(form().getAttribute('aria-busy')).toBeNull()
    expect(password().type).toBe('password')
    expect(confirmPassword().type).toBe('password')
    expect(password().autocomplete).toBe('new-password')
    expect(confirmPassword().autocomplete).toBe('new-password')
    expect(password().required).toBe(true)
    expect(confirmPassword().required).toBe(true)
    expect(password().minLength).toBe(12)
    expect(confirmPassword().minLength).toBe(12)
    expect(password().maxLength).toBe(256)
    expect(confirmPassword().maxLength).toBe(256)
    expect(document.querySelectorAll('.diary-access-actions .n-button')).toHaveLength(2)

    password().value = 'diary-password'
    password().dispatchEvent(new Event('input', { bubbles: true }))
    confirmPassword().value = 'diary-password'
    confirmPassword().dispatchEvent(new Event('input', { bubbles: true }))
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('submit')).toEqual([[
      { password: 'diary-password', confirmPassword: 'diary-password' },
    ]])

    cancel().click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    expect(password().value).toBe('')
  })

  it('cancels on Escape and only shows one password field in unlock mode', async () => {
    const wrapper = mount(DiaryAccessDialog, {
      props: { open: true, mode: 'unlock' },
      attachTo: document.body,
    })
    expect(document.getElementById('diary-access-confirm')).toBeNull()
    expect((document.getElementById('diary-access-password') as HTMLInputElement).autocomplete)
      .toBe('new-password')
    expect(document.querySelector('.diary-access-actions button[type="submit"]')).toBeTruthy()
    const form = document.querySelector('form.diary-access-dialog') as HTMLFormElement
    form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('keeps the access dialog open and inert while busy', async () => {
    const wrapper = mount(DiaryAccessDialog, {
      props: { open: true, mode: 'setup', busy: true },
      attachTo: document.body,
    })
    await wrapper.vm.$nextTick()
    const backdrop = document.querySelector('.diary-access-backdrop') as HTMLElement
    const form = document.querySelector('form.diary-access-dialog') as HTMLFormElement

    expect(form.getAttribute('aria-busy')).toBe('true')
    expect((document.getElementById('diary-access-password') as HTMLInputElement).disabled).toBe(true)
    expect((document.querySelector('[data-testid="diary-access-cancel"]') as HTMLButtonElement).disabled).toBe(true)
    backdrop.click()
    form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('cancel')).toBeUndefined()
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(document.querySelector('.diary-access-backdrop')).not.toBeNull()
  })
})
