import { describe, expect, it } from 'vitest'
import { shouldShowNormalChrome } from '../auth-chrome'

describe('normal application chrome visibility', () => {
  it.each([
    ['unknown', false],
    ['setup-required', false],
    ['unauthenticated', false],
  ] as const)('hides the Vault chrome while auth state is %s', (state, expected) => {
    expect(shouldShowNormalChrome(state, false, false)).toBe(expected)
  })

  it('shows the chrome for an authenticated workspace', () => {
    expect(shouldShowNormalChrome('authenticated', false, false)).toBe(true)
  })

  it('hides the chrome on auth pages even after authentication', () => {
    expect(shouldShowNormalChrome('authenticated', true, false)).toBe(false)
  })

  it('preserves public development preview behavior', () => {
    expect(shouldShowNormalChrome('unknown', false, true)).toBe(true)
    expect(shouldShowNormalChrome('unauthenticated', true, true)).toBe(true)
  })
})
