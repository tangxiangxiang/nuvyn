import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('H9 PDF export capture contract', () => {
  test('delegates snapshot waiting to the enclosing Playwright test timeout', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'e2e/helpers/pdf-export.ts'),
      'utf8',
    )
    const start = source.indexOf('const snapshotPromise = page')
    const end = source.indexOf('const clickPromise =', start)
    const waitBlock = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(waitBlock).toContain('waitForFunction')
    expect(waitBlock).toContain('__pdfExportSnapshot')
    expect(waitBlock).toContain('timeout: 0')
    expect(waitBlock).not.toContain('timeout: 60_000')
  })
})
