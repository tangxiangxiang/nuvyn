// AES-256-GCM encryption for provider API keys at rest.
//
// Storage format on disk:
//   iv:authTag:ciphertext   — three base64 segments joined by ':'
//
// AES-256-GCM gives both confidentiality (ciphertext) and integrity
// (auth tag) — if the stored blob is tampered with, `decrypt` throws.
// The 12-byte IV is generated fresh for every write (never reused),
// and the auth tag is verified on read.
//
// The 32-byte encryption key is supplied out-of-band by settings.ts through
// NUVYN_MASTER_KEY / NUVYN_MASTER_KEY_FILE, or the separate local
// data/.nuvyn-master-key file. It is never persisted in
// SQLite. This
// deliberately keeps the design small and cross-platform; an OS keychain
// abstraction can be added later.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM standard — never reuse, generated per-write
const KEY_LENGTH = 32 // 256 bits
const SEP = ':'

function encryptApiKey(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`encryption key must be ${KEY_LENGTH} bytes, got ${key.length}`)
  }
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(SEP)
}

function decryptApiKey(blob: string, key: Buffer): string {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`encryption key must be ${KEY_LENGTH} bytes, got ${key.length}`)
  }
  const parts = blob.split(SEP)
  if (parts.length !== 3) {
    throw new Error('malformed encrypted blob: expected 3 colon-separated segments')
  }
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ctB64, 'base64')
  if (iv.length !== IV_LENGTH) {
    throw new Error(`malformed encrypted blob: iv must be ${IV_LENGTH} bytes`)
  }
  if (authTag.length !== 16) {
    throw new Error('malformed encrypted blob: auth tag must be 16 bytes')
  }
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function generateApiKeyEncryptionKey(): Buffer {
  return randomBytes(KEY_LENGTH)
}

/* Detect whether a stored value is an encrypted blob (3 colon-separated
   base64 segments) or legacy plaintext. Used by readStoredAiSettings()
   to migrate legacy rows on first read. We treat anything that isn't
   strictly 3 valid base64 segments as plaintext — the worst case is
   we attempt to decrypt a plaintext that happens to have 2 colons,
   which throws and falls back to plaintext anyway. */
function isEncryptedFormat(blob: string): boolean {
  const parts = blob.split(SEP)
  if (parts.length !== 3) return false
  try {
    for (const part of parts) {
      const buf = Buffer.from(part, 'base64')
      // Buffer.from with invalid base64 silently strips invalid chars;
      // we additionally require the round-trip to match (length parity)
      // so a string with stray '=' doesn't pass.
      if (buf.toString('base64').replace(/=+$/, '') !== part.replace(/=+$/, '')) return false
    }
    return true
  } catch {
    return false
  }
}

export { encryptApiKey, decryptApiKey, generateApiKeyEncryptionKey, isEncryptedFormat }
