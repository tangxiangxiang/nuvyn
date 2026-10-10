import { describe, it, expect, beforeEach, vi } from 'vitest'
const { generateTextMock, configMock } = vi.hoisted(() => ({ generateTextMock: vi.fn(), configMock: vi.fn() }))
vi.mock('../ai/llm.js', () => ({ generateText: generateTextMock, resolveAiRuntimeConfig: configMock }))
vi.mock('../db.js', () => ({ getDb: () => ({}) }))
import { generateTags } from '../ai/tags.js'

beforeEach(() => {
  configMock.mockReset().mockReturnValue({ apiKey: 'test-key', model: 'test-model' })
  generateTextMock.mockReset().mockResolvedValue({ text: '["Vue", "#vue", "TypeScript"]' })
})
describe('generateTags', () => {
  it('normalizes and deduplicates model JSON', async () => {
    expect(await generateTags({ path: 'note', content: '# Vue', language: 'zh' })).toEqual(['Vue', 'TypeScript'])
    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0, maxTokens: 256 }))
  })
  it('accepts fenced JSON', async () => {
    generateTextMock.mockResolvedValue({ text: '```json\n["Vue"]\n```' })
    expect(await generateTags({ path: 'note', content: 'body' })).toEqual(['Vue'])
  })
  it.each(['not JSON', '[]', '[42]', '["a,b"]', '["a","b","c","d","e","f"]', '["\\u202Eevil"]'])('rejects invalid model output %s', async text => {
    generateTextMock.mockResolvedValue({ text })
    await expect(generateTags({ path: 'note', content: 'body' })).rejects.toMatchObject({ reason: 'parse-failed' })
  })
  it('requires configured AI and rejects empty documents', async () => {
    await expect(generateTags({ path: 'note', content: ' ' })).rejects.toMatchObject({ reason: 'parse-failed' })
    configMock.mockReturnValue({ apiKey: '' })
    await expect(generateTags({ path: 'note', content: 'body' })).rejects.toMatchObject({ reason: 'no-api-key' })
    expect(generateTextMock).not.toHaveBeenCalled()
  })
})
