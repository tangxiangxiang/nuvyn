// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  boardExportFilename,
  downloadBoardBlob,
  sanitizeBoardExportFilename,
} from '../boardExport'

describe('board export helpers', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('sanitizes path and control characters without allowing an empty filename', () => {
    expect(sanitizeBoardExportFilename('  My / Board:*?  ')).toBe('My Board')
    expect(sanitizeBoardExportFilename('/\\:*?"<>|\u0000...')).toBe('Untitled Board')
    expect(boardExportFilename('A\\B: C.', 'png')).toBe('A B C.png')
    expect(boardExportFilename('', 'svg')).toBe('Untitled Board.svg')
  })

  it('clicks a browser download and always revokes its object URL', () => {
    const objectUrlApi = {
      createObjectURL: vi.fn(() => 'blob:board-export'),
      revokeObjectURL: vi.fn(),
    }
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    downloadBoardBlob(new Blob(['png'], { type: 'image/png' }), 'Board.png', objectUrlApi)

    expect(objectUrlApi.createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(objectUrlApi.revokeObjectURL).toHaveBeenCalledWith('blob:board-export')
    expect(document.querySelector('a[download="Board.png"]')).toBeNull()
    click.mockRestore()
  })

  it('revokes an object URL even when the anchor click throws', () => {
    const objectUrlApi = {
      createObjectURL: vi.fn(() => 'blob:failed-export'),
      revokeObjectURL: vi.fn(),
    }
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('browser refused download')
    })

    expect(() => downloadBoardBlob(new Blob(['svg']), 'Board.svg', objectUrlApi)).toThrow('browser refused download')
    expect(objectUrlApi.revokeObjectURL).toHaveBeenCalledWith('blob:failed-export')
    expect(document.querySelector('a')).toBeNull()
    click.mockRestore()
  })
})
