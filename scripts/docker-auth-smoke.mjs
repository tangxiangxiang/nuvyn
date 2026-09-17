import { chmod, mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const image = process.env.DOCKER_IMAGE ?? 'nuvyn-ci-smoke'
const port = Number(process.env.DOCKER_PORT ?? '18080')
const origin = `http://127.0.0.1:${port}`
const setupToken = process.env.NUVYN_SMOKE_SETUP_TOKEN
  ?? process.env.NUVYN_SMOKE_SETUP_TOKEN
  ?? 'phase8-docker-smoke-token-0123456789abcdef'
const username = 'phase8-owner'
const password = 'phase8-docker-password-0123456789'

if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error('Docker auth smoke requires a valid unprivileged host port')
}
if (Buffer.byteLength(setupToken, 'utf8') < 32) {
  throw new Error('Docker auth smoke test token is too short')
}

let sequence = 0
let currentContainer = null
let dataDir

async function docker(args, label) {
  try {
    return await execFileAsync('docker', args, { maxBuffer: 4 * 1024 * 1024 })
  } catch {
    // Do not surface execFile's command line: it contains the setup token in
    // `docker run` arguments and must never reach CI logs.
    throw new Error(`Docker auth smoke ${label} failed`)
  }
}

async function stopContainer() {
  if (!currentContainer) return
  const name = currentContainer
  currentContainer = null
  try {
    await docker(['stop', '--time', '10', name], 'container stop')
  } catch {
    // A failed stop is followed by forceful removal below.
  }
  try {
    await docker(['rm', '-f', name], 'container cleanup')
  } catch {
    // Cleanup is best effort; the primary assertion has already failed.
  }
}

async function startContainer(revokeSessionsOnStart) {
  const name = `nuvyn-auth-smoke-${process.pid}-${Date.now()}-${sequence++}`
  const { stdout } = await docker([
    'run', '-d', '--name', name,
    '--tmpfs', '/tmp:rw,mode=1777',
    '-e', 'NODE_ENV=production',
    '-e', 'HOST=0.0.0.0',
    '-e', 'PORT=3000',
    '-e', `NUVYN_PUBLIC_ORIGIN=${origin}`,
    '-e', `NUVYN_SETUP_TOKEN=${setupToken}`,
    '-e', `NUVYN_AUTH_REVOKE_SESSIONS_ON_START=${revokeSessionsOnStart ? '1' : '0'}`,
    '--tmpfs', '/app/src/content:rw,mode=1777',
    '-v', `${dataDir}:/app/data`,
    '-p', `127.0.0.1:${port}:3000`,
    image,
  ], 'container start')
  currentContainer = name
  if (!stdout.trim()) throw new Error('Docker auth smoke container did not start')
  await waitForHealth()
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) {
        const body = await response.json()
        if (JSON.stringify(body) === JSON.stringify({ ok: true })) return
      }
    } catch {
      // The production process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error('Docker auth smoke health endpoint did not become ready')
}

function cookieHeaders(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie()
  }
  const value = response.headers.get('set-cookie')
  return value ? [value] : []
}

function cookieValueFrom(headers, name) {
  const header = headers.find((value) => value.startsWith(`${name}=`))
  if (!header) throw new Error('Docker auth smoke did not receive the expected session cookie')
  return header.split(';', 1)[0]
}

function assertCookieProfile(headers, name) {
  const header = headers.find((value) => value.startsWith(`${name}=`))
  if (!header
    || !header.includes('HttpOnly')
    || !header.includes('SameSite=Lax')
    || !header.includes('Path=/')
    || header.includes('Secure')) {
    throw new Error('Docker auth smoke received an unexpected loopback cookie profile')
  }
  if (headers.some((value) => value.startsWith('__Host-nuvyn_session='))) {
    throw new Error('Docker auth smoke received an unexpected HTTPS cookie')
  }
}

async function request(pathname, init = {}) {
  return fetch(`${origin}${pathname}`, init)
}

async function json(response, label) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Docker auth smoke ${label} returned invalid JSON`)
  }
}

function expectStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`Docker auth smoke ${label} returned ${response.status}`)
}

async function assertNoSecretsInLogs(cookieValues) {
  const { stdout, stderr } = await docker(['logs', currentContainer], 'log capture')
  const logs = `${stdout}\n${stderr}`
  const secrets = [setupToken, password, ...cookieValues]
  if (secrets.some((secret) => secret && logs.includes(secret))) {
    throw new Error('Docker auth smoke detected a credential in container logs')
  }
}

async function assertFreshContainer() {
  const health = await request('/api/health')
  expectStatus(health, 200, 'health before setup')
  if (JSON.stringify(await json(health, 'health')) !== JSON.stringify({ ok: true })) {
    throw new Error('Docker auth smoke health response is not minimal liveness')
  }

  const status = await request('/api/auth/status')
  expectStatus(status, 200, 'status before setup')
  if (JSON.stringify(await json(status, 'status')) !== JSON.stringify({ authenticated: false, setupRequired: true })) {
    throw new Error('Docker auth smoke did not report setup-required state')
  }
  if (status.headers.get('cache-control') !== 'no-store') {
    throw new Error('Docker auth smoke status response is missing no-store')
  }

  const anonymousIdentity = await request('/api/vault/identity')
  expectStatus(anonymousIdentity, 401, 'anonymous identity')
  const anonymousIdentityBody = await json(anonymousIdentity, 'anonymous identity')
  if (anonymousIdentityBody.code !== 'auth-session-required') {
    throw new Error('Docker auth smoke anonymous identity did not fail closed')
  }
  if (anonymousIdentity.headers.get('cache-control') !== 'no-store') {
    throw new Error('Docker auth smoke anonymous identity is missing no-store')
  }

  const setup = await request('/api/auth/setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify({
      bootstrapToken: setupToken,
      username,
      password,
    }),
  })
  expectStatus(setup, 201, 'setup')
  const setupBody = await json(setup, 'setup')
  if (!setupBody.authenticated || JSON.stringify(setupBody).includes(setupToken) || JSON.stringify(setupBody).includes(password)) {
    throw new Error('Docker auth smoke setup response exposed a secret')
  }
  const setCookies = cookieHeaders(setup)
  assertCookieProfile(setCookies, 'nuvyn_session')
  const cookie = cookieValueFrom(setCookies, 'nuvyn_session')
  return { cookie }
}

async function assertAuthenticated(cookie, label = 'authenticated') {
  const headers = { Cookie: cookie }
  const status = await request('/api/auth/status', { headers })
  expectStatus(status, 200, `${label} status`)
  const statusBody = await json(status, `${label} status`)
  if (!statusBody.authenticated || statusBody.setupRequired !== false) {
    throw new Error(`Docker auth smoke ${label} status was not authenticated`)
  }
  if (status.headers.get('cache-control') !== 'no-store') {
    throw new Error(`Docker auth smoke ${label} status is missing no-store`)
  }

  const identity = await request('/api/vault/identity', { headers })
  expectStatus(identity, 200, `${label} identity`)
  const identityBody = await json(identity, `${label} identity`)
  if (!/^[0-9a-f]{12}$/.test(identityBody.vaultId ?? '')) {
    throw new Error(`Docker auth smoke ${label} identity is invalid`)
  }
  if (identity.headers.get('cache-control') !== 'no-store') {
    throw new Error(`Docker auth smoke ${label} identity is missing no-store`)
  }

  const tree = await request('/api/tree', { headers })
  expectStatus(tree, 200, `${label} tree`)
  if (tree.headers.get('cache-control') !== 'no-store') {
    throw new Error(`Docker auth smoke ${label} tree is missing no-store`)
  }
  return identityBody.vaultId
}

async function assertRouteBoundary(cookie) {
  const anonymousUnknown = await request('/api/__phase8_unknown')
  expectStatus(anonymousUnknown, 401, 'anonymous unknown API')
  if ((await json(anonymousUnknown, 'anonymous unknown API')).code !== 'auth-session-required') {
    throw new Error('Docker auth smoke unknown anonymous API did not fail closed')
  }
  const authenticatedUnknown = await request('/api/__phase8_unknown', { headers: { Cookie: cookie } })
  expectStatus(authenticatedUnknown, 404, 'authenticated unknown API')

  const wrongOrigin = await request('/api/auth/logout', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'http://evil.example',
    },
  })
  expectStatus(wrongOrigin, 403, 'wrong-origin logout')
  if ((await json(wrongOrigin, 'wrong-origin logout')).code !== 'csrf-origin-mismatch') {
    throw new Error('Docker auth smoke wrong-origin mutation was not rejected')
  }
}

async function loginAgain() {
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify({ username, password }),
  })
  expectStatus(login, 200, 'login after revocation')
  const body = await json(login, 'login after revocation')
  if (!body.authenticated || JSON.stringify(body).includes(password)) {
    throw new Error('Docker auth smoke login response was invalid')
  }
  const cookies = cookieHeaders(login)
  assertCookieProfile(cookies, 'nuvyn_session')
  return cookieValueFrom(cookies, 'nuvyn_session')
}

async function run() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nuvyn-docker-auth-smoke-'))
  dataDir = path.join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  // The production image runs as uid 1000; the CI-owned temporary directories
  // must be writable without changing the image's non-root runtime contract.
  await chmod(dataDir, 0o777)
  const cookies = []
  try {
    await startContainer(false)
    const fresh = await assertFreshContainer()
    cookies.push(fresh.cookie)
    await assertAuthenticated(fresh.cookie, 'fresh')
    await assertRouteBoundary(fresh.cookie)
    await assertNoSecretsInLogs(cookies)

    await stopContainer()
    await startContainer(false)
    await assertAuthenticated(fresh.cookie, 'restart without revocation')
    await assertNoSecretsInLogs(cookies)

    await stopContainer()
    await startContainer(true)
    const revokedStatus = await request('/api/auth/status', { headers: { Cookie: fresh.cookie } })
    expectStatus(revokedStatus, 200, 'status after startup revocation')
    const revokedBody = await json(revokedStatus, 'status after startup revocation')
    if (revokedBody.authenticated !== false || revokedBody.setupRequired !== false) {
      throw new Error('Docker auth smoke startup revocation did not invalidate the old session')
    }
    const newCookie = await loginAgain()
    cookies.push(newCookie)
    await assertAuthenticated(newCookie, 'login after startup revocation')
    const healthAfter = await request('/api/health')
    expectStatus(healthAfter, 200, 'health after setup/restart')
    if (JSON.stringify(await json(healthAfter, 'health after setup/restart')) !== JSON.stringify({ ok: true })) {
      throw new Error('Docker auth smoke health changed after authentication')
    }
    await assertNoSecretsInLogs(cookies)
  } finally {
    await stopContainer()
    await rm(root, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('[nuvyn] Docker authentication smoke passed')
}).catch((error) => {
  console.error(error instanceof Error ? error.message : 'Docker auth smoke failed')
  process.exitCode = 1
})
