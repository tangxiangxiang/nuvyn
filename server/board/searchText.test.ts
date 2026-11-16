import { describe, expect, it } from 'vitest'
import { extractBoardSearchText } from './searchText.js'

describe('Board search text extraction', () => {
  it('extracts active text elements, including multiline and bound shape labels', () => {
    const extracted = extractBoardSearchText({
      elements: [
        { id: 'plain', type: 'text', text: 'Hello 世界', originalText: 'Hello 世界' },
        { id: 'multiline', type: 'text', text: '第一行\nSecond line' },
        { id: 'bound-label', type: 'text', text: '菱形标签', containerId: 'diamond-1' },
      ],
      fileMap: { 'asset-id': 'not searchable' },
    })

    expect(extracted).toEqual([
      { elementId: 'plain', text: 'Hello 世界' },
      { elementId: 'multiline', text: '第一行\nSecond line' },
      { elementId: 'bound-label', text: '菱形标签' },
    ])
  })

  it('supports valid legacy originalText and indexes an element only once', () => {
    expect(extractBoardSearchText({
      elements: [
        { id: 'legacy', type: 'text', originalText: '旧版文字' },
        { id: 'current', type: 'text', text: '新版文字', originalText: '新版文字' },
        { id: 'current', type: 'text', text: '重复 id 不重复索引' },
      ],
    })).toEqual([
      { elementId: 'legacy', text: '旧版文字' },
      { elementId: 'current', text: '新版文字' },
    ])
  })

  it('ignores deleted, empty, non-text, image, and malformed elements', () => {
    expect(extractBoardSearchText({
      elements: [
        { id: 'deleted', type: 'text', text: '已删除', isDeleted: true },
        { id: 'empty', type: 'text', text: '  ', originalText: '' },
        { id: 'rectangle', type: 'rectangle', text: '不得搜索图形属性' },
        { id: 'image', type: 'image', text: '不得搜索图片' },
        { type: 'text', text: '缺少 id' },
        { id: 'invalid-text', type: 'text', text: 42 },
        null,
        'not an element',
      ],
    })).toEqual([])
  })

  it.each([null, undefined, [], 'elements', { elements: {} }])('returns an empty list for invalid engine data %j', (engineData) => {
    expect(extractBoardSearchText(engineData)).toEqual([])
  })
})
