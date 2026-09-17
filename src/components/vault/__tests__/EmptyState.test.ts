// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EmptyState from '../EmptyState.vue'

describe('EmptyState', () => {
  it('renders the title', () => {
    const w = mount(EmptyState, { props: { title: 'No file open' } })
    expect(w.find('.empty-state-title').text()).toBe('No file open')
    expect(w.find('.empty-state').exists()).toBe(true)
  })

  it('applies the compact modifier class', () => {
    const w = mount(EmptyState, { props: { title: 'Empty', size: 'compact' } })
    expect(w.find('.empty-state').classes()).toContain('empty-state--compact')
  })

  it('does not apply the compact modifier when size is normal (default)', () => {
    const w = mount(EmptyState, { props: { title: 'Empty' } })
    expect(w.find('.empty-state').classes()).not.toContain('empty-state--compact')
  })

  it('hides the hint container when no slot content is given', () => {
    const w = mount(EmptyState, { props: { title: 'Empty' } })
    expect(w.find('.empty-state-hint').exists()).toBe(false)
  })

  it('renders slot content inside the hint container', () => {
    /* Hint rows are VS Code Welcome style: label first, kbd second.
       Both end up in the parent grid via `display: contents` on
       .hint-row, so the DOM still shows the row wrapper around
       them. */
    const w = mount(EmptyState, {
      props: { title: 'Empty' },
      slots: {
        default: `
          <span class="hint-row">
            <span class="hint-label">Command palette</span>
            <kbd class="hint-kbd">⌘P</kbd>
          </span>
          <span class="hint-row">
            <span class="hint-label">Toggle sidebar</span>
            <kbd class="hint-kbd">⌘B</kbd>
          </span>
        `,
      },
    })
    const hint = w.find('.empty-state-hint')
    expect(hint.exists()).toBe(true)
    const rows = hint.findAll('.hint-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.hint-label').text()).toBe('Command palette')
    expect(rows[0].find('.hint-kbd').text()).toBe('⌘P')
    expect(rows[1].find('.hint-label').text()).toBe('Toggle sidebar')
    expect(rows[1].find('.hint-kbd').text()).toBe('⌘B')
  })
})