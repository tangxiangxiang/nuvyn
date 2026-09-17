import { describe, expect, it } from 'vitest'
import { sanitizeDiagnosticText } from '../../shared/sanitize-diagnostic'

const PASSWORD_LITERAL = 'e2e-diary-access-password-strong-123'

function sanitize(value: string): string {
  return sanitizeDiagnosticText(value, PASSWORD_LITERAL)
}

describe('sanitizeDiagnosticText', () => {
  describe('password literal', () => {
    it('redacts the known plaintext password', () => {
      expect(sanitize(`password=${PASSWORD_LITERAL}`))
        .toBe('password=[REDACTED]')
    })

    it('redacts every occurrence of the password literal', () => {
      const input = `${PASSWORD_LITERAL} then ${PASSWORD_LITERAL} again`
      expect(sanitize(input)).toBe('[REDACTED] then [REDACTED] again')
    })
  })

  describe('bare HTTP-style headers', () => {
    it('redacts the value of a single-segment Cookie header', () => {
      expect(sanitize('Cookie: session=AAA'))
        .toBe('Cookie: [REDACTED]')
    })

    it('redacts the value of a multi-segment Cookie header', () => {
      // Regression: the previous regex used [^\s,;}]+ which left
      // every segment after the first `;` exposed.
      expect(sanitize('Cookie: session=AAA; refresh=BBB; csrf=CCC'))
        .toBe('Cookie: [REDACTED]')
    })

    it('redacts the value of an X-Nuvyn-Diary-Capability header', () => {
      expect(sanitize('X-Nuvyn-Diary-Capability: SEC'))
        .toBe('X-Nuvyn-Diary-Capability: [REDACTED]')
    })

    it('redacts the value of an Authorization header (Bearer included)', () => {
      expect(sanitize('Authorization: Bearer foo'))
        .toBe('Authorization: [REDACTED]')
    })

    it('accepts the `=` separator form', () => {
      expect(sanitize('Cookie=foo')).toBe('Cookie=[REDACTED]')
    })

    it('redacts the value when it extends to end-of-line', () => {
      expect(sanitize('X-Nuvyn-Diary-Capability: SEC trailing'))
        .toBe('X-Nuvyn-Diary-Capability: [REDACTED]')
    })
  })

  describe('JSON-serialized headers', () => {
    // Regression: the previous regex's `[^\s,;}]+` character class
    // stopped at the opening JSON quote and left the value exposed.
    it('redacts a quoted X-Nuvyn-Diary-Capability value', () => {
      expect(sanitize('{"X-Nuvyn-Diary-Capability":"SECRET"}'))
        .toBe('{"X-Nuvyn-Diary-Capability":"[REDACTED]"}')
    })

    it('redacts a quoted Authorization Bearer value', () => {
      expect(sanitize('{"Authorization":"Bearer foo"}'))
        .toBe('{"Authorization":"[REDACTED]"}')
    })

    it('redacts a quoted Cookie multi-segment value', () => {
      expect(sanitize('{"Cookie":"session=AAA; refresh=BBB"}'))
        .toBe('{"Cookie":"[REDACTED]"}')
    })

    it('tolerates whitespace between the colon and the opening value quote', () => {
      expect(sanitize('{"Authorization": "Bearer foo"}'))
        .toBe('{"Authorization": "[REDACTED]"}')
    })

    it('does not mistake unrelated keys for sensitive headers', () => {
      expect(sanitize('{"name":"Alice","city":"Paris"}'))
        .toBe('{"name":"Alice","city":"Paris"}')
    })
  })

  describe('URL query tokens', () => {
    it('redacts a Vite/HMR-style token query parameter', () => {
      expect(sanitize('ws://127.0.0.1:4174/?token=QPLo-foo-bar'))
        .toBe('ws://127.0.0.1:4174/?token=[REDACTED]')
    })

    it('redacts a session query parameter', () => {
      expect(sanitize('https://example.test/login?session=ABC123'))
        .toBe('https://example.test/login?session=[REDACTED]')
    })

    it('redacts only the sensitive parameter and preserves siblings', () => {
      expect(sanitize('https://example.test/api?a=1&token=foo&b=2'))
        .toBe('https://example.test/api?a=1&token=[REDACTED]&b=2')
    })

    it('redacts case-insensitive parameter names', () => {
      expect(sanitize('https://example.test/?Token=foo&API_KEY=bar'))
        .toBe('https://example.test/?Token=[REDACTED]&API_KEY=[REDACTED]')
    })

    it('does not touch non-credential query parameters', () => {
      expect(sanitize('https://example.test/?id=42&page=3'))
        .toBe('https://example.test/?id=42&page=3')
    })
  })

  describe('non-sensitive input', () => {
    it('passes plain text through unchanged', () => {
      expect(sanitize('Hello, world!')).toBe('Hello, world!')
    })

    it('passes unrelated file paths through unchanged', () => {
      expect(sanitize('/Users/alice/projects/example/file.ts'))
        .toBe('/Users/alice/projects/example/file.ts')
    })

    it('does not mistake the substring `token` outside a URL for a token', () => {
      expect(sanitize('tokenizer crashed at line 12'))
        .toBe('tokenizer crashed at line 12')
    })
  })

  describe('size bound', () => {
    it('truncates the output to the documented maximum length', () => {
      const huge = 'A'.repeat(20_000)
      const out = sanitize(huge)
      expect(out.length).toBe(8_000)
      expect(out).toBe('A'.repeat(8_000))
    })

    it('still redacts secrets that appear before the size cap', () => {
      const padding = 'x'.repeat(2_000)
      const input = `${padding} Bearer secret ${padding}`
      const out = sanitize(input)
      expect(out).toContain('Bearer [REDACTED]')
      expect(out).not.toContain('Bearer secret')
    })
  })
})
