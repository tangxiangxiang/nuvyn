import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __testing__, runMermaidExclusive } from '../mermaidRuntime'

const calls: Array<Record<string, unknown>> = []

vi.mock('mermaid', () => ({
  default: {
    initialize(config: Record<string, unknown>) {
      calls.push({ ...config })
    },
    async render(id: string, code: string) {
      return { svg: `<svg data-id="${id}"><text>${code}</text></svg>` }
    },
  },
}))

beforeEach(() => {
  __testing__.reset()
  calls.length = 0
})

describe('Mermaid runtime isolation', () => {
  it('serializes initialize plus async render across widgets', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = runMermaidExclusive(async (_mermaid, runtime) => {
      runtime.initialize('default')
      events.push('first-start')
      await firstGate
      events.push('first-end')
      return runtime.nextId(0)
    })
    const second = runMermaidExclusive(async (_mermaid, runtime) => {
      events.push('second-start')
      runtime.initialize('dark')
      events.push('second-end')
      return runtime.nextId(0)
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['first-start'])
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.stringMatching(/^mermaid-1-/),
      expect.stringMatching(/^mermaid-2-/),
    ])
    expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
    expect(calls.map((call) => call.theme)).toEqual(['default', 'dark'])
    expect(calls.every((call) => call.securityLevel === 'strict')).toBe(true)
  })
})
