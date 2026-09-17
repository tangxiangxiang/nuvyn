import { describe, expect, it } from 'vitest'
import { DEFAULT_HOST, resolveAuthOrigin, resolveServerHost } from '../prodConfig'

describe('resolveServerHost', () => {
  it('defaults bare-metal servers to localhost', () => {
    expect(resolveServerHost({})).toBe(DEFAULT_HOST)
  })

  it('honors an explicit LAN or public binding', () => {
    expect(resolveServerHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0')
    expect(resolveServerHost({ HOST: '192.168.1.20' })).toBe('192.168.1.20')
  })

  it('treats a blank HOST as unset', () => {
    expect(resolveServerHost({ HOST: '  ' })).toBe(DEFAULT_HOST)
  })

  it('uses the local fallback only for loopback listeners', () => {
    expect(resolveAuthOrigin({}, 3000, '127.0.0.1')).toBe('http://127.0.0.1:3000')
    expect(resolveAuthOrigin({ HOST: 'localhost' }, 5173, 'localhost')).toBe('http://127.0.0.1:5173')
  })

  it('requires an explicit browser origin when the listener is widened', () => {
    expect(() => resolveAuthOrigin({ HOST: '0.0.0.0' }, 3000, '0.0.0.0'))
      .toThrow('NUVYN_PUBLIC_ORIGIN is required when HOST is not loopback')
    expect(resolveAuthOrigin({ HOST: '0.0.0.0', NUVYN_PUBLIC_ORIGIN: 'https://nuvyn.example.com' }, 3000, '0.0.0.0'))
      .toBe('https://nuvyn.example.com')
  })

  it('uses the canonical Nuvyn origin', () => {
    expect(resolveAuthOrigin({
      HOST: '0.0.0.0',
      NUVYN_PUBLIC_ORIGIN: 'https://nuvyn.example.com',
    }, 3000, '0.0.0.0')).toBe('https://nuvyn.example.com')
  })
})
