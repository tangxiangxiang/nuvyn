import type { AuthState } from '../composables/useAuth'

/**
 * Normal workspace chrome is only available to an authenticated owner.
 * Public development previews are the one intentional exception because
 * they do not mount the authenticated workspace shell.
 */
export function shouldShowNormalChrome(
  authState: AuthState,
  isAuthPage: boolean,
  isPublicPreview: boolean,
  identityReady = true,
): boolean {
  return isPublicPreview || (!isAuthPage && authState === 'authenticated' && identityReady)
}
