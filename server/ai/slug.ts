import { SLUG_RE } from '../paths.js'
import { generateText, resolveAiRuntimeConfig } from './llm.js'
import { ChatError } from './errors.js'
import { getDb } from '../db.js'

const INITIAL_MAX_TOKENS = 256
const RETRY_MAX_TOKENS = 512
const MAX_INPUT_CHARS = 160
const MIN_SLUG_LENGTH = 3
const MAX_SLUG_LENGTH = 60

function cleanModelSlug(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
    .replace(/^(?:here(?:'s| is) (?:the )?slug|(?:the )?(?:filename )?slug(?: is)?)\s*:\s*/i, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

function isUsableSlug(slug: string): boolean {
  return slug.length >= MIN_SLUG_LENGTH
    && slug.length <= MAX_SLUG_LENGTH
    && SLUG_RE.test(slug)
}

function slugSystemPrompt(isRetry: boolean): string {
  return [
    'Convert the user input into one concise English lowercase-kebab-case filename slug.',
    'Allowed characters: a-z, 0-9, hyphen.',
    'Length: 3-60 characters. Do not end with .md.',
    isRetry
      ? [
          'The previous response did not contain a usable slug. Return the final slug only.',
          'Do not explain your reasoning. Do not return analysis, quotes, or markdown.',
          'Return a non-empty ASCII lowercase kebab-case slug.',
        ].join('\n')
      : 'Return only the slug, no prose, no quotes, no markdown.',
  ].join('\n')
}

function unusableSlugReason(
  result: Awaited<ReturnType<typeof generateText>>,
  slug: string,
): string {
  if (result.finishReason === 'length') return 'output limit reached'
  if (!result.text.trim()) return 'empty response'
  if (!slug) return 'unusable output'
  if (slug.length < MIN_SLUG_LENGTH) return `slug too short (${slug.length} characters)`
  if (slug.length > MAX_SLUG_LENGTH) return `slug too long (${slug.length} characters)`
  return 'unusable output'
}

export async function generateSlug(opts: {
  input: string
  kind: 'file' | 'folder'
  signal?: AbortSignal
}): Promise<string> {
  const text = opts.input.trim().slice(0, MAX_INPUT_CHARS)
  if (!text) throw new ChatError('parse-failed', 'empty input')
  const cfg = resolveAiRuntimeConfig(getDb())
  if (!cfg.apiKey) throw new ChatError('no-api-key')

  let lastFailure = 'unusable output'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (opts.signal?.aborted) throw new ChatError('aborted')

    let result
    try {
      result = await generateText({
        model: cfg.model,
        maxTokens: attempt === 0 ? INITIAL_MAX_TOKENS : RETRY_MAX_TOKENS,
        temperature: 0,
        signal: opts.signal,
        system: slugSystemPrompt(attempt === 1),
        user: `Kind: ${opts.kind}\nInput: ${text}`,
      })
    } catch (err) {
      if (err instanceof ChatError) throw err
      if (opts.signal?.aborted) throw new ChatError('aborted')
      throw new ChatError('llm-error', (err as Error).message)
    }

    if (opts.signal?.aborted) throw new ChatError('aborted')
    const slug = cleanModelSlug(result.text)
    if (isUsableSlug(slug)) return slug
    lastFailure = unusableSlugReason(result, slug)
  }

  throw new ChatError('parse-failed', `bad slug from model after retry: ${lastFailure}`)
}
