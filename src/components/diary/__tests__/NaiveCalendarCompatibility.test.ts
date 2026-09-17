// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import NaiveCalendarCompatibilityProbe from './NaiveCalendarCompatibilityProbe.vue'

describe('Naive UI 2.45.3 Calendar compatibility probe', () => {
  let consoleError: ReturnType<typeof vi.spyOn>
  let consoleWarn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    const output = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
      .flat()
      .map(String)
      .join('\n')
    expect(output).not.toMatch(/Unhandled|TypeError|undefined.*render/i)
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })

  function probe(wrapper: VueWrapper) {
    return {
      root: () => wrapper.get('[data-testid="naive-calendar-probe"]'),
      page: () => wrapper.get('[data-testid="naive-calendar-probe"]').attributes('data-page'),
      targetDay: () => wrapper.get('[data-date="2026-08-24"]'),
    }
  }

  it('mounts a monthly view with a custom default-slot day and reactive marker', async () => {
    const wrapper = mount(NaiveCalendarCompatibilityProbe)
    await flushPromises()

    expect(wrapper.find('.n-calendar').exists()).toBe(true)
    expect(wrapper.findAll('[data-date^="2026-08-"]').length).toBeGreaterThanOrEqual(28)
    expect(wrapper.get('[data-testid="custom-marker"]').text()).toContain('mood-probe')

    await wrapper.get('[data-testid="toggle-indicator"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="custom-marker"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('navigates previous and next month through onPanelChange', async () => {
    const wrapper = mount(NaiveCalendarCompatibilityProbe)
    await flushPromises()

    await wrapper.findAll('.n-calendar-header__extra button')[2].trigger('click')
    await flushPromises()
    expect(probe(wrapper).page()).toBe('2026-09')

    await wrapper.findAll('.n-calendar-header__extra button')[0].trigger('click')
    await flushPromises()
    expect(probe(wrapper).page()).toBe('2026-08')
    wrapper.unmount()
  })

  it('emits a local DiaryDate through update:value and the slot fields', async () => {
    const wrapper = mount(NaiveCalendarCompatibilityProbe)
    await flushPromises()

    await probe(wrapper).targetDay().trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="selected-date"]').text()).toBe('2026-08-24')
    expect(wrapper.get('[data-testid="clicked-date"]').text()).toBe('2026-08-24')
    wrapper.unmount()
  })

  it('bridges locale/theme changes through ConfigProvider and remounts cleanly', async () => {
    const wrapper = mount(NaiveCalendarCompatibilityProbe)
    await flushPromises()
    expect(probe(wrapper).root().attributes('data-locale')).toBe('en')
    expect(probe(wrapper).root().attributes('data-theme')).toBe('light')

    await wrapper.get('[data-testid="toggle-locale"]').trigger('click')
    await wrapper.get('[data-testid="toggle-theme"]').trigger('click')
    await flushPromises()
    expect(probe(wrapper).root().attributes('data-locale')).toBe('zh')
    expect(probe(wrapper).root().attributes('data-theme')).toBe('dark')

    await wrapper.get('[data-testid="toggle-calendar"]').trigger('click')
    expect(wrapper.find('.n-calendar').exists()).toBe(false)
    await wrapper.get('[data-testid="toggle-calendar"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.n-calendar').exists()).toBe(true)
    wrapper.unmount()
  })
})
