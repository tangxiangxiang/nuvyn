import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import app from '../index.js'
import { CONTENT_DIR, setContentDir } from '../paths.js'
import {
  authenticatedRequest,
  closeAuthTestContext,
  createAuthenticatedTestContext,
  type AuthenticatedTestContext,
} from '../__tests__/helpers/auth.js'

let tempRoot: string
let originalContentDir: string
let auth: AuthenticatedTestContext

describe('authenticated Markdown resource boundary', () => {
  beforeEach(async () => {
    originalContentDir = CONTENT_DIR
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-markdown-resources-'))
    setContentDir(tempRoot)
    auth = createAuthenticatedTestContext()
  })

  afterEach(async () => {
    closeAuthTestContext(auth)
    setContentDir(originalContentDir)
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('requires authentication before reading a resource', async () => {
    const response = await app.fetch(new Request(
      'http://localhost/api/markdown-resources?kind=include&path=notes.md',
    ))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'auth-session-required' })
  })

  it('reads allowlisted UTF-8 text through the existing safe path helper', async () => {
    await fs.mkdir(path.join(tempRoot, 'docs'))
    await fs.writeFile(path.join(tempRoot, 'docs', 'part.md'), '# Included\n', 'utf8')
    const response = await app.fetch(authenticatedRequest(
      auth,
      '/api/markdown-resources?kind=include&path=docs%2Fpart.md',
    ))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      kind: 'include',
      path: 'docs/part.md',
      content: '# Included\n',
    })
  })

  it('rejects traversal, unsupported types, invalid UTF-8, and directories generically', async () => {
    await fs.mkdir(path.join(tempRoot, 'docs'))
    await fs.writeFile(path.join(tempRoot, 'docs', 'bad.md'), Buffer.from([0, 1, 2]))
    await fs.mkdir(path.join(tempRoot, 'docs', 'directory.md'))
    const requests = [
      '/api/markdown-resources?kind=include&path=..%2Fsecret.md',
      '/api/markdown-resources?kind=snippet&path=docs%2Fpart.md',
      '/api/markdown-resources?kind=include&path=docs%2Fbad.md',
      '/api/markdown-resources?kind=include&path=docs%2Fdirectory.md',
    ]
    const responses = await Promise.all(requests.map((request) => app.fetch(authenticatedRequest(auth, request))))
    expect(responses.map((response) => response.status)).toEqual([400, 415, 415, 404])
    for (const response of responses) {
      const body = await response.json() as { error?: string }
      expect(body.error).toBe('Unable to load Markdown resource.')
      expect(JSON.stringify(body)).not.toContain(tempRoot)
    }
  })

  it('returns image bytes with the exact allowlisted MIME type', async () => {
    await fs.writeFile(path.join(tempRoot, 'logo.png'), Buffer.from([137, 80, 78, 71]))
    const response = await app.fetch(authenticatedRequest(
      auth,
      '/api/markdown-resources?kind=image&path=logo.png',
    ))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
  })

  it('sanitizes manually placed SVGs on every read and applies a restrictive direct-navigation policy', async () => {
    const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#6270ac"/></svg>'
    const hostileSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svgExecuted=true</script><rect width="10" height="10"/></svg>'
    await fs.writeFile(path.join(tempRoot, 'manual.svg'), safeSvg)
    await fs.writeFile(path.join(tempRoot, 'hostile.svg'), hostileSvg)

    const safeResponse = await app.fetch(authenticatedRequest(
      auth,
      '/api/markdown-resources?kind=image&path=manual.svg',
    ))
    expect(safeResponse.status).toBe(200)
    expect(safeResponse.headers.get('content-type')).toBe('image/svg+xml')
    expect(safeResponse.headers.get('cache-control')).toBe('no-store')
    expect(safeResponse.headers.get('x-content-type-options')).toBe('nosniff')
    expect(safeResponse.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(safeResponse.headers.get('content-security-policy')).toContain("script-src 'none'")
    expect(safeResponse.headers.get('content-security-policy')).toContain('sandbox')
    expect((await safeResponse.text()).match(/<rect\b/gu)).toHaveLength(1)

    const hostileResponse = await app.fetch(authenticatedRequest(
      auth,
      '/api/markdown-resources?kind=image&path=hostile.svg',
    ))
    expect(hostileResponse.status).toBe(415)
    expect(await hostileResponse.json()).toMatchObject({ code: 'resource-invalid-svg' })
  })

  it('rejects symlinked resources without disclosing the target', async () => {
    await fs.writeFile(path.join(tempRoot, 'real.md'), 'secret', 'utf8')
    await fs.symlink(path.join(tempRoot, 'real.md'), path.join(tempRoot, 'link.md'))
    const response = await app.fetch(authenticatedRequest(
      auth,
      '/api/markdown-resources?kind=include&path=link.md',
    ))
    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).not.toContain('real.md')
  })
})
