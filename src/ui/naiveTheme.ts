import type { GlobalThemeOverrides } from 'naive-ui'

export type NuvynTheme = 'light' | 'dark'

/**
 * Naive UI derives alpha variants from common.primaryColor with seemly. That
 * parser cannot consume a CSS custom property in Naive UI 2.45.3, so this is
 * the only concrete TS mirror kept at the boundary. CSS tokens remain the
 * semantic authority; all fields Naive can safely consume stay CSS-backed.
 */
export const nuvynNaivePrimaryColors: Readonly<Record<NuvynTheme, string>> = {
  light: '#6366f1',
  dark: '#818cf8',
}

/**
 * A small component-local mirror for Naive components that blend surfaces
 * with seemly. Keeping this out of `common` preserves CSS-backed global
 * tokens while preventing `composite(var(--token), ...)` at render time.
 */
const nuvynNaiveCompositeColors: Readonly<Record<NuvynTheme, {
  cardColor: string
  modalColor: string
  borderColor: string
  dividerColor: string
}>> = {
  light: {
    cardColor: '#f9fafb',
    modalColor: '#f9fafb',
    borderColor: '#e5e7eb',
    dividerColor: '#e5e7eb',
  },
  dark: {
    cardColor: '#252526',
    modalColor: '#252526',
    borderColor: '#374151',
    dividerColor: '#374151',
  },
}

export function createNuvynNaiveThemeOverrides(theme: NuvynTheme): GlobalThemeOverrides {
  const compositeColors = nuvynNaiveCompositeColors[theme]
  return {
    common: {
      bodyColor: 'var(--nuvyn-bg)',
      cardColor: 'var(--nuvyn-surface-1)',
      modalColor: 'var(--nuvyn-surface-1)',
      borderColor: 'var(--nuvyn-border)',
      dividerColor: 'var(--nuvyn-divider)',

      // See nuvynNaivePrimaryColors: this one field must be parseable by seemly.
      primaryColor: nuvynNaivePrimaryColors[theme],
      primaryColorHover: 'var(--nuvyn-accent-hover)',
      primaryColorPressed: 'var(--nuvyn-accent-pressed)',

      textColorBase: 'var(--nuvyn-text-1)',
      textColor1: 'var(--nuvyn-text-1)',
      textColor2: 'var(--nuvyn-text-2)',
      textColor3: 'var(--nuvyn-text-3)',
      borderRadius: 'var(--nuvyn-radius-md)',
      fontFamily: 'var(--sans)',
      fontFamilyMono: 'var(--mono)',
      fontSize: 'var(--nuvyn-font-size-md)',
    },
    Calendar: { common: compositeColors },
    DataTable: { common: compositeColors },
    DatePicker: { common: compositeColors },
    Descriptions: { common: compositeColors },
    List: { common: compositeColors },
    TimePicker: { common: compositeColors },
  }
}

/** A stable light export is useful to callers that only need the mapping. */
export const nuvynNaiveThemeOverrides = createNuvynNaiveThemeOverrides('light')
