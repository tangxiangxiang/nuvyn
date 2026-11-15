// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import DiaryBulletReader from '../DiaryBulletReader.vue'

describe('DiaryBulletReader', () => {
  it('renders text entries as native list items and keeps each gallery with its entry', () => {
    const wrapper = mount(DiaryBulletReader, {
      props: {
        entries: ['早餐\n南瓜饼', '晚上背单词'],
        entryIds: ['entry-one', 'entry-two'],
      },
      slots: {
        'after-entry': ({ entryId }: { entryId: string | null }) => h('div', { class: 'gallery', 'data-entry': entryId }, '照片'),
      },
    })

    const list = wrapper.get('ul')
    const items = list.findAll('li')
    expect(list.attributes('data-testid')).toBe('diary-bullet-reader')
    expect(items).toHaveLength(2)
    expect(items[0]?.attributes('data-entry-id')).toBe('entry-one')
    expect(items[0]?.get('.diary-bullet-reader-text').text()).toBe('早餐\n南瓜饼')
    expect(items[0]?.get('.gallery').attributes('data-entry')).toBe('entry-one')
    expect(items[1]?.get('.gallery').attributes('data-entry')).toBe('entry-two')
    expect(list.findAll('li li')).toHaveLength(0)
    wrapper.unmount()
  })

  it('renders no list item for a photo-only day', () => {
    const wrapper = mount(DiaryBulletReader, { props: { entries: [] } })

    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.findAll('li')).toHaveLength(0)
    expect(wrapper.get('[data-testid="diary-empty-reading"]').text()).toBe('今天还没有文字记录。')
    wrapper.unmount()
  })
})
