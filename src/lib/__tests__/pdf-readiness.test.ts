// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  markmapWidgetsReady,
  mathWidgetsReady,
  mermaidWidgetsReady,
  pdfEnhancementsReady,
} from '../pdf-readiness'

function articleWith(markup: string): HTMLElement {
  const article = document.createElement('article')
  article.innerHTML = markup
  return article
}

describe('PDF enhancement readiness', () => {
  describe('Math', () => {
    it.each([
      ['pending', false],
      ['missing', false],
      ['unknown', false],
      ['ready', true],
      ['error', true],
    ])('%s is %s', (state, expected) => {
      const stateAttribute = state === 'missing' ? '' : ` data-math-state="${state}"`
      expect(mathWidgetsReady(articleWith(`<span class="math-mount"${stateAttribute}></span>`)))
        .toBe(expected)
    })

    it('checks every Math placeholder', () => {
      expect(mathWidgetsReady(articleWith(
        '<span class="math-mount" data-math-state="ready"></span>'
        + '<span class="math-mount" data-math-state="pending"></span>',
      ))).toBe(false)
    })
  })

  describe('Mermaid', () => {
    it('blocks an unmounted placeholder even when another widget is ready', () => {
      expect(mermaidWidgetsReady(articleWith(
        '<div class="mermaid-widget-host"><div class="mermaid-widget" data-mermaid-state="ready"></div></div>'
        + '<div class="mermaid-mount"></div>',
      ))).toBe(false)
    })

    it.each([
      ['pending', false],
      ['missing', false],
      ['unknown', false],
      ['ready', true],
      ['error', true],
    ])('%s is %s', (state, expected) => {
      const stateAttribute = state === 'missing' ? '' : ` data-mermaid-state="${state}"`
      const article = articleWith(
        `<div class="mermaid-widget-host"><div class="mermaid-widget"${stateAttribute}></div></div>`,
      )
      expect(mermaidWidgetsReady(article)).toBe(expected)
    })

    it('does not treat an SVG without explicit state as settled', () => {
      expect(mermaidWidgetsReady(articleWith(
        '<div class="mermaid-widget-host">'
        + '<div class="mermaid-widget"><div class="mermaid-svg"><svg></svg></div></div>'
        + '</div>',
      ))).toBe(false)
    })

    it('blocks a host that has no Mermaid widget yet', () => {
      expect(mermaidWidgetsReady(articleWith('<div class="mermaid-widget-host"></div>'))).toBe(false)
    })

    it('requires every Mermaid widget to be settled', () => {
      expect(mermaidWidgetsReady(articleWith(
        '<div class="mermaid-widget-host"><div class="mermaid-widget" data-mermaid-state="ready"></div></div>'
        + '<div class="mermaid-widget-host"><div class="mermaid-widget" data-mermaid-state="pending"></div></div>',
      ))).toBe(false)
    })
  })

  describe('MarkMap', () => {
    it('blocks an unmounted placeholder even when another widget is ready', () => {
      expect(markmapWidgetsReady(articleWith(
        '<div class="markmap-widget-host"><div class="markmap-widget" data-markmap-state="ready"></div></div>'
        + '<div class="markmap-mount"></div>',
      ))).toBe(false)
    })

    it.each([
      ['pending', false],
      ['missing', false],
      ['unknown', false],
      ['ready', true],
      ['error', true],
    ])('%s is %s', (state, expected) => {
      const stateAttribute = state === 'missing' ? '' : ` data-markmap-state="${state}"`
      const article = articleWith(
        `<div class="markmap-widget-host"><div class="markmap-widget"${stateAttribute}></div></div>`,
      )
      expect(markmapWidgetsReady(article)).toBe(expected)
    })

    it('does not treat an SVG without explicit state as settled', () => {
      expect(markmapWidgetsReady(articleWith(
        '<div class="markmap-widget-host">'
        + '<div class="markmap-widget"><svg class="markmap-svg"><g></g></svg></div>'
        + '</div>',
      ))).toBe(false)
    })

    it('does not treat a pending SVG as settled', () => {
      expect(markmapWidgetsReady(articleWith(
        '<div class="markmap-widget-host">'
        + '<div class="markmap-widget" data-markmap-state="pending">'
        + '<svg class="markmap-svg"><g></g></svg>'
        + '</div></div>',
      ))).toBe(false)
    })

    it('blocks a host that has no MarkMap widget yet', () => {
      expect(markmapWidgetsReady(articleWith('<div class="markmap-widget-host"></div>'))).toBe(false)
    })

    it('requires every MarkMap widget to be settled', () => {
      expect(markmapWidgetsReady(articleWith(
        '<div class="markmap-widget-host"><div class="markmap-widget" data-markmap-state="ready"></div></div>'
        + '<div class="markmap-widget-host"><div class="markmap-widget" data-markmap-state="pending"></div></div>',
      ))).toBe(false)
    })
  })

  describe('combined contract', () => {
    it('allows an empty article', () => {
      expect(pdfEnhancementsReady(articleWith('<p>Hello</p>'))).toBe(true)
    })

    it('requires all enhancement types to be settled', () => {
      expect(pdfEnhancementsReady(articleWith(
        '<span class="math-mount" data-math-state="ready"></span>'
        + '<div class="mermaid-widget-host"><div class="mermaid-widget" data-mermaid-state="ready"></div></div>'
        + '<div class="markmap-widget-host"><div class="markmap-widget" data-markmap-state="error"></div></div>',
      ))).toBe(true)

      expect(pdfEnhancementsReady(articleWith(
        '<span class="math-mount" data-math-state="error"></span>'
        + '<div class="mermaid-widget-host"><div class="mermaid-widget" data-mermaid-state="pending"></div></div>'
        + '<div class="markmap-widget-host"><div class="markmap-widget" data-markmap-state="ready"></div></div>',
      ))).toBe(false)

      expect(pdfEnhancementsReady(articleWith(
        '<span class="math-mount" data-math-state="ready"></span>'
        + '<div class="mermaid-widget-host"><div class="mermaid-widget" data-mermaid-state="ready"></div></div>'
        + '<div class="markmap-widget-host"><div class="markmap-widget"></div></div>',
      ))).toBe(false)
    })
  })
})
