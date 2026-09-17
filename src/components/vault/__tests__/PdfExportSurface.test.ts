// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PdfExportSurface from '../PdfExportSurface.vue'

describe('PdfExportSurface theme contract', () => {
  it('passes the light render theme to RenderedMarkdown', () => {
    const wrapper = mount(PdfExportSurface, {
      props: { raw: '# PDF' },
      global: {
        stubs: {
          RenderedMarkdown: {
            props: ['raw', 'resolver', 'tag', 'renderTheme'],
            template: '<div data-rendered-markdown :data-render-theme="renderTheme" />',
          },
        },
      },
    })

    expect(wrapper.find('[data-rendered-markdown]').attributes('data-render-theme')).toBe('light')
    wrapper.unmount()
  })
})
