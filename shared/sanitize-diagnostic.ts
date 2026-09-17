/**
 * Diagnostic text sanitizer used by E2E fixtures before persisting browser
 * console output or page errors as Playwright attachments. Kept dependency-
 * free so it can be used from both production-safe source boundaries and
 * unit-tested without standing up the Playwright fixture.
 *
 * Three classes of leakage the sanitizer must cover, motivated by what
 * the fixture has actually observed in browser console output:
 *   1. HTTP-style `Header: value` headers, including multi-segment
 *      `Cookie: a=1; b=2` whose second segment is otherwise left in
 *      the clear by character-class matchers.
 *   2. JSON-serialized `"Header":"value"` headers. The opening quote
 *      breaks the bare-header regex and would leave the value exposed.
 *   3. URL query parameters that commonly carry credentials — the
 *      most recent example being Vite/HMR's `ws://...?token=...`.
 */

const REDACTED = '[REDACTED]'
const MAX_DIAGNOSTIC_LENGTH = 8_000

const SENSITIVE_HEADER_NAMES = 'X-Nuvyn-Diary-Capability|Authorization|Cookie'

// Vite/HMR uses `?token=`; lockout/refresh flows use `?session=` or
// `?refresh_token=`; capability headers can also leak through `?capability=`.
const SENSITIVE_QUERY_PARAM_NAMES = [
  'token',
  'session',
  'access_token',
  'access-token',
  'refresh',
  'refresh_token',
  'refresh-token',
  'apikey',
  'api[_-]key',
  'secret',
  'password',
  'bearer',
  'capability',
  'cookie',
].join('|')

export function sanitizeDiagnosticText(value: string, passwordLiteral: string): string {
  return value
    // 1. Known plaintext password literal (the setup-time secret).
    .replaceAll(passwordLiteral, REDACTED)
    // 2. URL query parameters that commonly carry credentials. The
    //    `?` / `&` anchor prevents accidental matches inside paths or
    //    free-form text; the `gi` flag accepts case-insensitive names.
    .replace(
      new RegExp(`([?&](?:${SENSITIVE_QUERY_PARAM_NAMES})=)([^&\\s"')}\\]+]*)`, 'gi'),
      `$1${REDACTED}`,
    )
    // 3. JSON-serialized headers. The bare-header regex below would
    //    stop at the opening quote and leave the value unredacted.
    .replace(
      new RegExp(`("(?:${SENSITIVE_HEADER_NAMES})"\\s*:\\s*")([^"\\n]+)(")`, 'gi'),
      `$1${REDACTED}$3`,
    )
    // 4. Bearer tokens, including in JSON-stripped form after step 3.
    .replace(
      /(Bearer\s+)[^\s"',;}\]\n]+/gi,
      `Bearer ${REDACTED}`,
    )
    // 5. Bare `Header: value` / `Header=value` headers. The value
    //    extends to EOL so multi-segment Cookie values are fully
    //    redacted; quoted JSON forms were already handled above.
    //    Preserves the header name and separator so the diagnostic
    //    still shows which header carried the credential.
    .replace(
      new RegExp(`(${SENSITIVE_HEADER_NAMES})(\\s*[:=]\\s*)[^\\n\\r]*`, 'gi'),
      `$1$2${REDACTED}`,
    )
    // Bound the size so a single huge diagnostic doesn't blow up the
    // attachment payload.
    .slice(0, MAX_DIAGNOSTIC_LENGTH)
}
