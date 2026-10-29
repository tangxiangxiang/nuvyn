import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const readPublic = (file: string) => readFileSync(`public/${file}`, 'utf8')

describe('PWA install foundation', () => {
  it('provides same-origin standalone metadata and existing icons', () => {
    const manifest = JSON.parse(readPublic('manifest.webmanifest'))
    expect(manifest.id).toBe('/')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons).toContainEqual({
      src: '/logo.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    })
    const html = readFileSync('index.html', 'utf8')
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('rel="apple-touch-icon"')
  })

  it('intercepts hashed assets but never user data or navigation', () => {
    const listeners = new Map<string, (event: any) => void>()
    const cache = {
      match: async () => null,
      put: async () => {},
    }
    runInNewContext(readPublic('sw.js'), {
      self: {
        location: { origin: 'https://nuvyn.example' },
        addEventListener: (type: string, callback: (event: any) => void) => {
          listeners.set(type, callback)
        },
        clients: { claim: async () => {} },
      },
      caches: {
        keys: async () => [],
        open: async () => cache,
      },
      URL,
      fetch: async () => ({ ok: true, type: 'basic', clone() { return this } }),
    })
    const fetchListener = listeners.get('fetch')
    expect(fetchListener).toBeDefined()
    const intercepts = (url: string, method = 'GET', mode = 'cors') => {
      let intercepted = false
      fetchListener!({
        request: { url, method, mode },
        respondWith(promise: Promise<unknown>) {
          intercepted = true
          void promise.catch(() => {})
        },
      })
      return intercepted
    }
    expect(intercepts('https://nuvyn.example/assets/index-AbCDe123.js')).toBe(true)
    expect(intercepts('https://nuvyn.example/assets/app-AbCDe123.css')).toBe(true)
    expect(intercepts('https://nuvyn.example/api/ledger/transactions')).toBe(false)
    expect(intercepts('https://nuvyn.example/api/vault/files/image.png')).toBe(false)
    expect(intercepts('https://nuvyn.example/diary/2026-10-29')).toBe(false)
    expect(intercepts('https://nuvyn.example/index.html')).toBe(false)
    expect(intercepts('https://nuvyn.example/manifest.webmanifest')).toBe(false)
    expect(intercepts('https://nuvyn.example/assets/index-AbCDe123.js', 'POST')).toBe(false)
    expect(intercepts('https://nuvyn.example/assets/index-AbCDe123.js', 'GET', 'navigate')).toBe(false)
    expect(intercepts('https://other.example/assets/index-AbCDe123.js')).toBe(false)
  })
})
