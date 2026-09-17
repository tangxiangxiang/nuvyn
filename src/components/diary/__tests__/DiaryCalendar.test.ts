// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import DiaryCalendar from '../DiaryCalendar.vue'
import {
  diaryDateFromCalendarFields,
  diaryCalendarMonthFromNaiveCalendarValue,
  diaryDateFromNaiveCalendarValue,
  diaryDateFromLocalDate,
  naiveCalendarValueForDiaryDate,
  normalizeDiaryDays,
  localCalendarDateForDiaryDate,
  type DiaryCalendarDay,
} from '../diaryCalendarAdapter'
import { parseDiaryDate, type DiaryDate } from '../../../../shared/diaryProtocol'
import { useI18n } from '../../../composables/useI18n'
import { useTheme } from '../../../composables/useTheme'

function installBrowserApiShims(): void {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe(): void { /* jsdom has no layout engine */ }
      unobserve(): void { /* jsdom has no layout engine */ }
      disconnect(): void { /* jsdom has no layout engine */ }
    }
  }

  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0)
    window.cancelAnimationFrame = (handle: number) => window.clearTimeout(handle)
  }
}

function date(value: string): DiaryDate {
  return parseDiaryDate(value)!
}

function day(value: string, hasDiary = true): DiaryCalendarDay {
  return { date: date(value), hasDiary }
}

function mountCalendar(
  days: readonly DiaryCalendarDay[] = [day('2026-08-24')],
  extraProps: Record<string, unknown> = {},
): VueWrapper {
  return mount(DiaryCalendar, {
    props: {
      days,
      initialMonth: { year: 2026, month: 8 },
      ...extraProps,
    },
  })
}

function dayCell(wrapper: VueWrapper, value: string): DOMWrapper<Element> {
  const target = wrapper.get(`[data-diary-day-content][data-date="${value}"]`).element
  return new DOMWrapper(target.closest('.n-calendar-cell')!)
}

describe('DiaryCalendar presentation adapter', () => {
  let consoleError: ReturnType<typeof vi.spyOn>
  let consoleWarn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    installBrowserApiShims()
    useI18n().setLocale('en')
    useTheme().set('light')
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    const output = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
      .flat()
      .map(String)
      .join('\n')
    expect(output).not.toMatch(/dayIndex|Unhandled|TypeError|undefined.*render/i)
    consoleError.mockRestore()
    consoleWarn.mockRestore()
    useI18n().setLocale('zh')
    useTheme().set('light')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('converts local Calendar fields to validated DiaryDate without UTC conversion', () => {
    expect(diaryDateFromCalendarFields({ year: 2026, month: 8, date: 24 })).toBe('2026-08-24')
    expect(diaryDateFromCalendarFields({ year: 2026, month: 2, date: 31 })).toBeNull()
    expect(diaryDateFromCalendarFields({ year: 2026, month: 0, date: 24 })).toBeNull()

    const localDate = new Date(2026, 7, 24, 23, 59, 59)
    expect(diaryDateFromLocalDate(localDate)).toBe('2026-08-24')
    const calendarValue = naiveCalendarValueForDiaryDate(date('2026-08-24'))
    expect(diaryDateFromNaiveCalendarValue(calendarValue)).toBe('2026-08-24')
    expect(diaryCalendarMonthFromNaiveCalendarValue(calendarValue)).toEqual({ year: 2026, month: 8 })
    expect(diaryCalendarMonthFromNaiveCalendarValue(Number.NaN)).toBeNull()
  })

  it('preserves every supported Diary year through the local Date bridge', () => {
    const values = [
      '0000-02-29',
      '0001-01-01',
      '0099-12-31',
      '0100-01-01',
      '2026-08-24',
      '0099-02-28',
      '0099-03-01',
      '0100-02-28',
      '0400-02-29',
    ] as const

    for (const value of values) {
      const diaryDate = parseDiaryDate(value)!
      const localDate = localCalendarDateForDiaryDate(diaryDate)

      expect(localDate.getHours()).toBe(12)
      expect(diaryDateFromLocalDate(localDate)).toBe(diaryDate)
    }
  })

  it('normalizes duplicate projection dates into one Diary map entry', () => {
    const normalized = normalizeDiaryDays([
      day('2026-08-24', false),
      day('2026-08-24', true),
      day('2026-08-24', true),
      day('2026-08-25', false),
    ])

    expect(normalized).toHaveLength(2)
    expect(normalized[0]).toEqual(day('2026-08-24', true))
    expect(normalized[1]).toEqual(day('2026-08-25', false))
  })

  it('renders a fixed monthly Calendar and emits the initial library-independent month', async () => {
    const wrapper = mountCalendar()
    await flushPromises()

    expect(wrapper.find('.n-calendar').exists()).toBe(true)
    expect(wrapper.get('[data-testid="diary-calendar-month"]').text()).toContain('2026-08')
    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('data-month')).toBe('2026-08')
    expect(wrapper.emitted('month-change')).toEqual([[{ year: 2026, month: 8 }]])
  })

  it('renders only the month’s actual week rows so five-week months do not reserve a blank row', async () => {
    const fiveWeekMonth = mountCalendar([], { initialMonth: { year: 2026, month: 9 } })
    await flushPromises()
    expect(fiveWeekMonth.findAll('.n-calendar-cell')).toHaveLength(35)

    const sixWeekMonth = mountCalendar([], { initialMonth: { year: 2026, month: 8 } })
    await flushPromises()
    expect(sixWeekMonth.findAll('.n-calendar-cell')).toHaveLength(42)

    fiveWeekMonth.unmount()
    sixWeekMonth.unmount()
  })

  it('maps hasDiary to a Diary-owned mood action and leaves empty dates ordinary', async () => {
    const wrapper = mountCalendar([
      day('2026-08-24', true),
      day('2026-08-25', false),
    ])
    await flushPromises()

    expect(dayCell(wrapper, '2026-08-24').findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(1)
    expect(dayCell(wrapper, '2026-08-25').findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(0)
    expect(dayCell(wrapper, '2026-08-25').get('[data-diary-day-content]').attributes('aria-disabled')).toBe('false')
  })

  it('keeps Today and selected presentation independent from month navigation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0))
    const wrapper = mountCalendar([
      { ...day('2026-08-24', true), metadataUpdatedAt: 1 },
      { ...day('2026-08-27', true), metadataUpdatedAt: 2 },
    ])
    await flushPromises()

    const today = wrapper.get('[data-date="2026-08-27"]')
    expect(today.classes()).toContain('is-today')
    expect(today.attributes('aria-current')).toBe('date')
    expect(today.attributes('aria-pressed')).toBe('false')

    const selected = wrapper.get('[data-date="2026-08-24"]')
    await selected.trigger('click')
    await flushPromises()
    expect(selected.classes()).toContain('is-selected')
    expect(selected.attributes('aria-pressed')).toBe('true')
    expect(today.classes()).toContain('is-today')
    expect(today.attributes('aria-current')).toBe('date')
    wrapper.unmount()
  })

  it('clears only selection while preserving the visible month, Today, and mood', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0))
    const wrapper = mountCalendar([
      { ...day('2026-08-24', true), mood: 'happy', metadataUpdatedAt: 1 },
      { ...day('2026-08-27', true), mood: 'sad', metadataUpdatedAt: 2 },
    ])
    await flushPromises()

    await wrapper.get('[data-date="2026-08-24"]').trigger('click')
    await wrapper.get('[data-diary-calendar-nav="next"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('data-month')).toBe('2026-09')

    const calendarApi = wrapper.vm as unknown as { clearSelection: () => void }
    calendarApi.clearSelection()
    await flushPromises()

    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('data-month')).toBe('2026-09')
    await wrapper.get('[data-diary-calendar-nav="previous"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-date="2026-08-24"]').classes()).not.toContain('is-selected')
    expect(wrapper.get('[data-date="2026-08-24"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.get('[data-date="2026-08-27"]').classes()).toContain('is-today')
    expect(dayCell(wrapper, '2026-08-24').get('[data-testid="diary-calendar-mood"] img').attributes('src')).toBe('/emoji/开心.svg')
    wrapper.unmount()
  })

  it('keeps Mood actions disabled without a safe CAS version or while busy', async () => {
    const wrapper = mountCalendar([
      { ...day('2026-08-24', true), mood: 'happy' },
      { ...day('2026-08-25', true), mood: 'sad', metadataUpdatedAt: 4 },
    ])
    await flushPromises()

    expect((dayCell(wrapper, '2026-08-24').get('[data-testid="diary-calendar-mood"]').element as HTMLButtonElement).disabled).toBe(true)
    expect((dayCell(wrapper, '2026-08-25').get('[data-testid="diary-calendar-mood"]').element as HTMLButtonElement).disabled).toBe(false)

    await wrapper.setProps({ moodBusy: true })
    await flushPromises()
    expect((dayCell(wrapper, '2026-08-25').get('[data-testid="diary-calendar-mood"]').element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('uses the Mood emoji itself as the sibling picker control without plus/edit affordances', async () => {
    const wrapper = mountCalendar([
      {
        ...day('2026-08-24', true),
        mood: 'happy',
        metadataUpdatedAt: 3,
        documentId: 'doc-24',
      },
      {
        ...day('2026-08-25', true),
        mood: 'unknown-mood-v3',
        metadataUpdatedAt: 4,
      },
      { ...day('2026-08-26', true), mood: null, metadataUpdatedAt: 5 },
    ])
    await flushPromises()

    const knownCell = dayCell(wrapper, '2026-08-24')
    const unknownCell = dayCell(wrapper, '2026-08-25')
    const emptyCell = dayCell(wrapper, '2026-08-26')
    expect(knownCell.get('[data-testid="diary-calendar-mood"] img').attributes('src')).toBe('/emoji/开心.svg')
    expect(unknownCell.get('[data-testid="diary-calendar-mood"]').text()).toBe('?')
    expect(emptyCell.find('[data-testid="diary-calendar-mood"]').exists()).toBe(true)
    expect(emptyCell.find('.diary-calendar-mood-empty-mark').text()).toBe('?')
    expect(knownCell.get('[data-testid="diary-calendar-mood"]').element.parentElement)
      .toBe(knownCell.get('[data-diary-day-content]').element.parentElement)
    expect(knownCell.text()).not.toContain('+')
    expect(knownCell.text()).not.toContain('✎')
    expect(wrapper.findAll('button button')).toHaveLength(0)
    expect(knownCell.get('[data-testid="diary-calendar-mood"]').element.classList).toContain('n-button')
    expect(knownCell.get('[data-testid="diary-calendar-mood"]').attributes('type')).toBe('button')
    expect(knownCell.get('[data-testid="diary-calendar-mood"]').attributes('aria-label')).toContain('Happy')

    await knownCell.get('[data-testid="diary-calendar-mood"]').trigger('click')
    await flushPromises()
    const pickerElement = document.body.querySelector('[data-testid="diary-mood-picker"]')
    expect(pickerElement).not.toBeNull()
    const picker = new DOMWrapper(pickerElement!)
    expect(picker.findAll('[role="radio"]')).toHaveLength(24)
    await picker.get('[data-mood-id="sad"]').trigger('click')
    expect(wrapper.emitted('date-selected')).toBeUndefined()
    expect(wrapper.emitted('mood-change')).toEqual([['2026-08-24', 'sad']])

    await picker.get('[data-testid="diary-mood-clear"]').trigger('click')
    expect(wrapper.emitted('mood-change')).toEqual([
      ['2026-08-24', 'sad'],
      ['2026-08-24', null],
    ])
    wrapper.unmount()
  })

  it('keeps an unknown Mood opaque until an explicit replacement or clear', async () => {
    const wrapper = mountCalendar([{
      ...day('2026-08-25', true),
      mood: 'future-mood-v3',
      metadataUpdatedAt: 4,
    }])
    await flushPromises()

    const moodButton = dayCell(wrapper, '2026-08-25').get('[data-testid="diary-calendar-mood"]')
    expect(moodButton.text()).toBe('?')
    await moodButton.trigger('click')
    await flushPromises()

    let pickerElement = document.body.querySelector('[data-testid="diary-mood-picker"]')
    expect(pickerElement).not.toBeNull()
    const picker = new DOMWrapper(pickerElement!)
    expect(picker.get('[data-testid="diary-mood-unknown"]')).toBeTruthy()
    await picker.get('[data-testid="diary-mood-picker-close"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).toBeNull()
    expect(wrapper.emitted('mood-change')).toBeUndefined()
    expect(moodButton.text()).toBe('?')

    await moodButton.trigger('click')
    await flushPromises()
    pickerElement = document.body.querySelector('[data-testid="diary-mood-picker"]')
    expect(pickerElement).not.toBeNull()
    const reopenedPicker = new DOMWrapper(pickerElement!)
    await reopenedPicker.get('[data-mood-id="happy"]').trigger('click')
    await reopenedPicker.get('[data-testid="diary-mood-clear"]').trigger('click')
    expect(wrapper.emitted('date-selected')).toBeUndefined()
    expect(wrapper.emitted('mood-change')).toEqual([
      ['2026-08-25', 'happy'],
      ['2026-08-25', null],
    ])
    wrapper.unmount()
  })

  it('updates mood presentation reactively without remounting the Calendar', async () => {
    const wrapper = mountCalendar([{
      ...day('2026-08-24', true),
      mood: 'happy',
      metadataUpdatedAt: 1,
    }])
    await flushPromises()
    const container = wrapper.get('.n-calendar').element

    expect(dayCell(wrapper, '2026-08-24').get('[data-testid="diary-calendar-mood"] img').attributes('src')).toBe('/emoji/开心.svg')
    await wrapper.setProps({ days: [{
      ...day('2026-08-24', true),
      mood: 'sad',
      metadataUpdatedAt: 2,
    }] })
    await flushPromises()
    expect(dayCell(wrapper, '2026-08-24').get('[data-testid="diary-calendar-mood"] img').attributes('src')).toBe('/emoji/伤心.svg')
    expect(wrapper.get('.n-calendar').element).toBe(container)
  })

  it('renders a complete calendar with zero markers for an empty projection', async () => {
    const wrapper = mountCalendar([])
    await flushPromises()

    expect(wrapper.find('.n-calendar').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-date^="2026-08-"]').length).toBeGreaterThanOrEqual(28)
  })

  it('updates Diary day actions reactively without remounting the Calendar', async () => {
    const wrapper = mountCalendar([day('2026-08-24', false)])
    await flushPromises()
    const container = wrapper.get('.n-calendar').element

    expect(dayCell(wrapper, '2026-08-24').findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(0)
    await wrapper.setProps({ days: [day('2026-08-24', true)] })
    await flushPromises()
    expect(dayCell(wrapper, '2026-08-24').findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(1)
    expect(wrapper.get('.n-calendar').element).toBe(container)

    await wrapper.setProps({ days: [day('2026-08-24', false)] })
    await flushPromises()
    expect(dayCell(wrapper, '2026-08-24').findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(0)
  })

  it('emits only a validated DiaryDate for day clicks', async () => {
    const wrapper = mountCalendar()
    await flushPromises()

    await wrapper.get('[data-date="2026-08-24"]').trigger('click')
    await flushPromises()

    const payload = wrapper.emitted('date-selected')?.[0]?.[0]
    expect(payload).toBe('2026-08-24')
    expect(payload).not.toBeInstanceOf(Date)
    expect(String(payload)).not.toMatch(/[T/\\]|\.md/)
  })

  it('opens Mood first for a missing today/past date and cancellation creates no intent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0))
    const wrapper = mountCalendar([])
    await flushPromises()

    await wrapper.get('[data-date="2026-08-24"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).not.toBeNull()
    expect(wrapper.emitted('date-selected')).toBeUndefined()
    expect(wrapper.emitted('mood-change')).toBeUndefined()

    await new DOMWrapper(document.body.querySelector('[data-testid="diary-mood-picker"]')!)
      .get('[data-testid="diary-mood-picker-close"]')
      .trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).toBeNull()
    expect(wrapper.emitted('date-selected')).toBeUndefined()
    expect(wrapper.emitted('mood-change')).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps a missing future date on the existing date-command guard path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0))
    const wrapper = mountCalendar([])
    await flushPromises()

    await wrapper.get('[data-date="2026-08-28"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).toBeNull()
    expect(wrapper.emitted('date-selected')).toEqual([['2026-08-28']])
    wrapper.unmount()
  })

  it('keeps the custom day-content seam, click behavior, and non-visual marker meaning', async () => {
    const wrapper = mountCalendar()
    await flushPromises()

    const target = wrapper.get('[data-date="2026-08-24"]')
    expect(target.element.tagName).toBe('BUTTON')
    expect(target.attributes('type')).toBe('button')
    expect(target.attributes('role')).toBe('button')
    expect(target.attributes('data-diary-day-content')).toBe('')
    expect(target.attributes('aria-label')).toContain('Diary exists')
    expect(target.text()).toContain('Diary exists')

    await target.trigger('click')
    expect(wrapper.emitted('date-selected')).toHaveLength(1)
  })

  it('navigates previous and next month without selecting a date', async () => {
    const wrapper = mountCalendar()
    await flushPromises()
    wrapper.emitted('month-change')!.length = 0

    await wrapper.get('[data-diary-calendar-nav="next"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('data-month')).toBe('2026-09')
    expect(wrapper.emitted('month-change')?.at(-1)?.[0]).toEqual({ year: 2026, month: 9 })
    expect(wrapper.emitted('date-selected')).toBeUndefined()

    await wrapper.get('[data-diary-calendar-nav="previous"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('data-month')).toBe('2026-08')
    expect(wrapper.emitted('month-change')?.at(-1)?.[0]).toEqual({ year: 2026, month: 8 })
  })

  it('does not emit month-change again when selecting within the visible month', async () => {
    const wrapper = mountCalendar()
    await flushPromises()
    wrapper.emitted('month-change')!.length = 0

    await wrapper.get('[data-date="2026-08-24"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('month-change')).toEqual([])
    expect(wrapper.emitted('date-selected')).toEqual([['2026-08-24']])
    wrapper.unmount()
  })

  it('closes the Teleport picker before date or month navigation changes Calendar context', async () => {
    const wrapper = mountCalendar([
      { ...day('2026-08-24'), mood: 'happy', metadataUpdatedAt: 1 },
      { ...day('2026-08-25'), mood: null, metadataUpdatedAt: 2 },
    ])
    await flushPromises()

    await dayCell(wrapper, '2026-08-24').get('[data-testid="diary-calendar-mood"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).not.toBeNull()

    await wrapper.get('[data-date="2026-08-25"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).toBeNull()
    expect(wrapper.emitted('date-selected')).toEqual([['2026-08-25']])

    await dayCell(wrapper, '2026-08-24').get('[data-testid="diary-calendar-mood"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).not.toBeNull()

    await wrapper.get('[data-diary-calendar-nav="next"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).toBeNull()
    wrapper.unmount()
  })

  it('exposes semantic date focus for presentation close restoration', async () => {
    const wrapper = mount(DiaryCalendar, {
      attachTo: document.body,
      props: {
        days: [day('2026-08-24')],
        initialMonth: { year: 2026, month: 8 },
      },
    })
    await flushPromises()

    const target = wrapper.get('[data-diary-day-content][data-date="2026-08-24"]').element
    const focusDate = (wrapper.vm as unknown as { focusDate: (value: DiaryDate) => boolean }).focusDate

    expect(focusDate(date('2026-08-24'))).toBe(true)
    expect(document.activeElement).toBe(target)
  })

  it('provides accessible navigation labels, loading/error presentation, and locale/theme integration', async () => {
    const wrapper = mountCalendar([day('2026-08-24')], { loading: true, error: 'Projection unavailable' })
    await flushPromises()

    expect(wrapper.get('[data-diary-calendar-nav="previous"]').attributes('type')).toBe('button')
    expect(wrapper.get('[data-diary-calendar-nav="previous"]').attributes('aria-label')).toBe('Previous month')
    expect(wrapper.get('[data-diary-calendar-nav="next"]').attributes('type')).toBe('button')
    expect(wrapper.get('[data-diary-calendar-nav="next"]').attributes('aria-label')).toBe('Next month')
    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[data-testid="diary-calendar-loading"]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-testid="diary-calendar-error"]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('data-locale')).toBe('en-US')
    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('data-theme')).toBe('light')

    useI18n().setLocale('zh')
    useTheme().set('dark')
    await flushPromises()
    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('data-locale')).toBe('zh-CN')
    expect(wrapper.get('[data-testid="diary-calendar"]').attributes('data-theme')).toBe('dark')
  })

  it('does not import or invoke API, router, editor, persistence, or UTC seams', () => {
    const componentSource = readFileSync(
      resolve(process.cwd(), 'src/components/diary/DiaryCalendar.vue'),
      'utf8',
    )
    const adapterSource = readFileSync(
      resolve(process.cwd(), 'src/components/diary/diaryCalendarAdapter.ts'),
      'utf8',
    )

    expect(componentSource).toContain("from 'naive-ui'")
    expect(componentSource).toContain('<NCalendar')
    expect(componentSource).toContain('daysByDate')
    expect(componentSource).not.toContain('#day-content')
    expect(componentSource).not.toMatch(/fetch\(|authFetch|createPost|savePost|recoverPost|deletePost|useRouter|router\.|Editor|\/api\//)
    expect(componentSource).not.toContain('toISOString')
    expect(adapterSource).not.toContain('toISOString')
  })

  it('does not call fetch for Calendar presentation interactions', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mountCalendar()
    await flushPromises()

    await wrapper.get('[data-date="2026-08-24"]').trigger('click')
    await wrapper.get('[data-diary-calendar-nav="next"]').trigger('click')
    await wrapper.get('[data-diary-calendar-nav="previous"]').trigger('click')
    await flushPromises()

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('unmounts and remounts without stale Calendar state', async () => {
    const first = mountCalendar()
    await flushPromises()
    first.unmount()

    const second = mountCalendar([day('2026-08-25')])
    await flushPromises()
    expect(second.find('[data-date="2026-08-25"]').exists()).toBe(true)
    expect(second.findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(1)
    second.unmount()
  })
})
