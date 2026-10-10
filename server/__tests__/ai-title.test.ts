import { beforeEach, describe, expect, it, vi } from 'vitest'
const { textMock, configMock } = vi.hoisted(() => ({ textMock: vi.fn(), configMock: vi.fn() }))
vi.mock('../ai/llm.js', () => ({ generateText: textMock, resolveAiRuntimeConfig: configMock }))
vi.mock('../db.js', () => ({ getDb: () => ({}) }))
import { generateTitle } from '../ai/title.js'

beforeEach(() => {
  configMock.mockReset().mockReturnValue({ apiKey: 'test', model: 'model' })
  textMock.mockReset().mockResolvedValue({ text: '# Vue components' })
})
describe('generateTitle', () => {
  it('cleans title formatting and forwards the request signal', async () => {
    const signal = new AbortController().signal
    expect(await generateTitle({ path: 'note', content: '# Vue', language: 'zh', signal })).toBe('Vue components')
    expect(textMock).toHaveBeenCalledWith(expect.objectContaining({ signal, temperature: 0, maxTokens: 128 }))
  })
  it.each(['', 'One\nTwo', 'a'.repeat(201)])('rejects unusable titles', async text => {
    textMock.mockResolvedValue({ text })
    await expect(generateTitle({ path: 'note', content: 'body' })).rejects.toMatchObject({ reason: 'parse-failed' })
  })
  it('requires content and configured AI', async () => {
    await expect(generateTitle({ path: 'note', content: ' ' })).rejects.toMatchObject({ reason: 'parse-failed' })
    configMock.mockReturnValue({ apiKey: '' })
    await expect(generateTitle({ path: 'note', content: 'body' })).rejects.toMatchObject({ reason: 'no-api-key' })
    expect(textMock).not.toHaveBeenCalled()
  })
})
