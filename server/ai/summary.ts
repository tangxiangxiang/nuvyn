import { generateText, resolveAiRuntimeConfig } from './llm.js'
import { ChatError } from './errors.js'
import { getDb } from '../db.js'

const MAX_TOKENS = 256
const MAX_CONTEXT_CHARS = 20_000
const MAX_SUMMARY_CHARS = 2_000

export class SummaryPromptLimitError extends Error {
  constructor() {
    super(`AI summary prompt exceeds the ${MAX_CONTEXT_CHARS}-character limit`)
    this.name = 'SummaryPromptLimitError'
  }
}

function cleanSummary(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
    .replace(/^Summary:\s*/i, '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_SUMMARY_CHARS)
    .trim()
}

export async function generateSummary(opts: {
  path: string
  content: string
  language?: 'zh' | 'en'
  signal?: AbortSignal
}): Promise<string> {
  const content = opts.content.trim()
  if (!content) throw new ChatError('parse-failed', 'empty document')
  if (content.length > MAX_CONTEXT_CHARS) throw new SummaryPromptLimitError()

  const cfg = resolveAiRuntimeConfig(getDb())
  if (!cfg.apiKey) throw new ChatError('no-api-key')

  let result
  try {
    result = await generateText({
      model: cfg.model,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      signal: opts.signal,
      system: [
        'Summarize the Markdown document in one to three concise sentences.',
        opts.language === 'zh'
          ? 'Write the summary in natural Simplified Chinese.'
          : 'Write the summary in natural English.',
        'Return only the summary, with no heading, quotes, markdown, or explanation.',
        'Focus on the document\'s main topic, purpose, and useful conclusions.',
        'Do not invent details that are not present in the document.',
      ].join('\n'),
      user: `Document path: ${opts.path}\n\nDocument content:\n${content}`,
    })
  } catch (err) {
    if (err instanceof ChatError) throw err
    if (opts.signal?.aborted) throw new ChatError('aborted')
    throw new ChatError('llm-error', (err as Error).message)
  }

  const summary = cleanSummary(result.text)
  if (!summary) throw new ChatError('parse-failed', 'empty summary from model')
  return summary
}
