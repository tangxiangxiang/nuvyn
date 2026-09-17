import { AuthConfigError } from './auth/config.js'
import { readCanonicalEnv } from './env.js'

export const DEFAULT_HOST = '127.0.0.1'

const LOOPBACK_LISTENER_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Resolve the listener address without widening a bare-metal install. */
export function resolveServerHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HOST?.trim()
  return configured || DEFAULT_HOST
}

/**
 * Resolve the browser-facing origin for bare-metal production startup.
 *
 * A local listener may safely use the historical loopback default. Once an
 * operator widens the listener, however, silently pretending that browsers
 * still use a loopback origin creates an ambiguous cookie/CSRF profile. The
 * public origin remains an explicit authority; the listener address is only
 * used to reject that ambiguous configuration.
 */
export function resolveAuthOrigin(
  env: NodeJS.ProcessEnv = process.env,
  port = 3000,
  host = resolveServerHost(env),
): string {
  const configured = readCanonicalEnv(env, 'NUVYN_PUBLIC_ORIGIN')
  if (configured) return configured
  if (!LOOPBACK_LISTENER_HOSTS.has(host.trim().toLowerCase())) {
    throw new AuthConfigError('NUVYN_PUBLIC_ORIGIN is required when HOST is not loopback')
  }
  return `http://127.0.0.1:${port}`
}
