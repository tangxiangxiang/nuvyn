import { AUTH_SESSION_REQUIRED_CODE } from './auth-session'

export type AuthErrorCode =
  | 'validation-error'
  | 'bootstrap-invalid'
  | 'already-initialized'
  | 'invalid-credentials'
  | 'auth-rate-limited'
  | 'auth-unavailable'
  | typeof AUTH_SESSION_REQUIRED_CODE

export interface AuthUser {
  id: number
  username: string
}

export interface AuthStatusResponse {
  authenticated: boolean
  setupRequired: boolean
  user?: AuthUser
}

export interface AuthenticatedResponse {
  authenticated: true
  user: AuthUser
}

export interface SetupRequest {
  bootstrapToken: string
  username: string
  password: string
}

export interface LoginRequest {
  username: string
  password: string
}

export interface AuthApiErrorBody {
  error?: string
  code?: string
}

export class AuthApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly body: AuthApiErrorBody
  readonly retryAfterSeconds?: number

  constructor(
    message: string,
    status: number,
    body: AuthApiErrorBody = {},
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'AuthApiError'
    this.status = status
    this.code = body.code
    this.body = body
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined
  const seconds = Number(value.trim())
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) return undefined
  return seconds
}

async function parseErrorBody(response: Response): Promise<AuthApiErrorBody> {
  try {
    const body = await response.json() as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
    const record = body as Record<string, unknown>
    return {
      ...(typeof record.error === 'string' ? { error: record.error } : {}),
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
    }
  } catch {
    return {}
  }
}

async function jsonRequest<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  if (!response.ok) {
    const errorBody = await parseErrorBody(response)
    const message = errorBody.error ?? `Authentication request failed (${response.status}).`
    throw new AuthApiError(
      message,
      response.status,
      errorBody,
      parseRetryAfter(response.headers.get('Retry-After')),
    )
  }
  try {
    return await response.json() as T
  } catch {
    throw new AuthApiError('Authentication returned an invalid response.', response.status)
  }
}

function isUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const user = value as Record<string, unknown>
  return typeof user.id === 'number'
    && Number.isInteger(user.id)
    && user.id > 0
    && typeof user.username === 'string'
}

function validateStatus(value: unknown): AuthStatusResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthApiError('Authentication returned an invalid status response.', 200, {})
  }
  const status = value as Record<string, unknown>
  if (typeof status.authenticated !== 'boolean' || typeof status.setupRequired !== 'boolean') {
    throw new AuthApiError('Authentication returned an invalid status response.', 200, {})
  }
  if (status.authenticated && status.setupRequired) {
    throw new AuthApiError('Authentication returned an invalid status response.', 200, {})
  }
  if (status.authenticated && !isUser(status.user)) {
    throw new AuthApiError('Authentication returned an invalid status response.', 200, {})
  }
  if (!status.authenticated && status.user !== undefined) {
    throw new AuthApiError('Authentication returned an invalid status response.', 200, {})
  }
  return {
    authenticated: status.authenticated,
    setupRequired: status.setupRequired,
    ...(status.authenticated ? { user: status.user as AuthUser } : {}),
  }
}

function validateAuthenticated(value: unknown): AuthenticatedResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthApiError('Authentication returned an invalid response.', 200, {})
  }
  const response = value as Record<string, unknown>
  if (response.authenticated !== true || !isUser(response.user)) {
    throw new AuthApiError('Authentication returned an invalid response.', 200, {})
  }
  return { authenticated: true, user: response.user }
}

export async function getAuthStatus(): Promise<AuthStatusResponse> {
  return validateStatus(await jsonRequest<unknown>('/api/auth/status', 'GET'))
}

export async function setupOwner(input: SetupRequest): Promise<AuthenticatedResponse> {
  return validateAuthenticated(await jsonRequest<unknown>('/api/auth/setup', 'POST', {
    bootstrapToken: input.bootstrapToken,
    username: input.username,
    password: input.password,
  }))
}

export async function login(input: LoginRequest): Promise<AuthenticatedResponse> {
  return validateAuthenticated(await jsonRequest<unknown>('/api/auth/login', 'POST', {
    username: input.username,
    password: input.password,
  }))
}

/** Low-level session revoke wrapper; workspace coordination belongs to useAuth. */
export async function logout(): Promise<void> {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  })
  if (response.status === 204) return
  if (!response.ok) {
    const errorBody = await parseErrorBody(response)
    throw new AuthApiError(
      errorBody.error ?? `Authentication request failed (${response.status}).`,
      response.status,
      errorBody,
      parseRetryAfter(response.headers.get('Retry-After')),
    )
  }
}
