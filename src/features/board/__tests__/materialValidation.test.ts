import { describe, expect, it } from 'vitest'
import {
  boardMaterialPreviewUrl,
  defaultBoardMaterialName,
  isBoardMaterialSvg,
} from '../materialValidation'

const VALID_SVG = '\uFEFF <!-- pasted from a library -->\n<svg viewBox="0 0 16 16"><path d="M0 8h16" /></svg>'

describe('Board material validation', () => {
  it('derives a usable name from an SVG filename', () => {
    expect(defaultBoardMaterialName('  Arrow.SVG  ')).toBe('Arrow')
    expect(defaultBoardMaterialName('')).toBe('未命名素材')
    expect(defaultBoardMaterialName('  .svg ')).toBe('未命名素材')
  })

  it('accepts SVG markup and rejects non-SVG payloads', () => {
    expect(isBoardMaterialSvg(VALID_SVG)).toBe(true)
    expect(isBoardMaterialSvg('<html><body>not an svg</body></html>')).toBe(false)
    expect(isBoardMaterialSvg('{"type":"svg"}')).toBe(false)
    expect(isBoardMaterialSvg('')).toBe(false)
  })

  it('does not embed raw SVG markup in the preview URL', () => {
    const previewUrl = boardMaterialPreviewUrl(VALID_SVG)
    expect(previewUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(previewUrl).not.toContain('<svg')
    expect(previewUrl).toContain('%3Csvg')
  })
})
