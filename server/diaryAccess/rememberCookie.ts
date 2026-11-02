import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { DIARY_REMEMBER_DEVICE_LIFETIME_MS } from './service.js'

// Different origin profiles deliberately have different names, mirroring the
// existing auth cookie rule. The credential is restricted to Diary access
// routes and is never readable by application JavaScript.
const SECURE_REMEMBER_COOKIE = '__Secure-nuvyn_diary_device_v1'
const LOCAL_REMEMBER_COOKIE = 'nuvyn_diary_device_local_v1'
const COOKIE_PATH = '/api/diary/access'

function name(secure: boolean): string {
  return secure ? SECURE_REMEMBER_COOKIE : LOCAL_REMEMBER_COOKIE
}

export function readDiaryRememberCookie(c: any, secure: boolean): string | undefined {
  return getCookie(c, name(secure))
}

export function setDiaryRememberCookie(
  c: any,
  secure: boolean,
  remembered: { token: string; expiresAt: number },
): void {
  // The absolute expiry belongs to the server's capability and is bounded
  // by both the 7-day opt-in and the active owner login session.
  const remaining = Math.min(
    DIARY_REMEMBER_DEVICE_LIFETIME_MS,
    remembered.expiresAt - Date.now(),
  )
  if (remaining <= 0) {
    clearDiaryRememberCookie(c, secure)
    return
  }
  setCookie(c, name(secure), remembered.token, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: COOKIE_PATH,
    maxAge: Math.max(1, Math.floor(remaining / 1000)),
    expires: new Date(remembered.expiresAt),
  })
}

export function clearDiaryRememberCookie(c: any, secure: boolean): void {
  deleteCookie(c, name(secure), {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: COOKIE_PATH,
  })
}
