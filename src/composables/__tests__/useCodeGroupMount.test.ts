// @vitest-environment jsdom

import { createApp, defineComponent, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { activateCodeGroupTab, enhanceCodeGroups, useCodeGroupMount } from '../useCodeGroupMount'

async function settleMutationObserver(): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function makeRoot(): HTMLElement {
  const root = document.createElement('article')
  root.innerHTML = `
    <div class="nuvyn-code-group">
      <div class="nuvyn-code-group-tabs" role="tablist">
        <button role="tab" id="tab-a" aria-controls="panel-a" aria-selected="true" tabindex="0">A</button>
        <button role="tab" id="tab-b" aria-controls="panel-b" aria-selected="false" tabindex="-1">B</button>
        <button role="tab" id="tab-c" aria-controls="panel-c" aria-selected="false" tabindex="-1">C</button>
      </div>
      <div class="nuvyn-code-group-panels">
        <div role="tabpanel" id="panel-a" class="nuvyn-code-group-panel is-active" aria-hidden="false">A body</div>
        <div role="tabpanel" id="panel-b" class="nuvyn-code-group-panel" aria-hidden="true">B body</div>
        <div role="tabpanel" id="panel-c" class="nuvyn-code-group-panel" aria-hidden="true">C body</div>
      </div>
    </div>`
  return root
}

describe('code-group reader state helpers', () => {
  it('keeps one selected tab and one visible panel', () => {
    const root = makeRoot()
    const group = root.querySelector<HTMLElement>('.nuvyn-code-group')!
    const tabs = root.querySelectorAll<HTMLElement>('[role="tab"]')
    const panels = root.querySelectorAll<HTMLElement>('[role="tabpanel"]')

    expect(enhanceCodeGroups(root)).toBe(1)
    activateCodeGroupTab(group, tabs[2]!)

    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]?.getAttribute('tabindex')).toBe('-1')
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[2]?.getAttribute('tabindex')).toBe('0')
    expect(tabs[2]?.classList.contains('is-active')).toBe(true)
    expect(panels[0]?.getAttribute('aria-hidden')).toBe('true')
    expect(panels[2]?.getAttribute('aria-hidden')).toBe('false')
    expect(panels[2]?.classList.contains('is-active')).toBe(true)
  })

  it('repairs an invalid initial selection without trusting arbitrary panel IDs', () => {
    const root = makeRoot()
    const group = root.querySelector<HTMLElement>('.nuvyn-code-group')!
    const tabs = root.querySelectorAll<HTMLElement>('[role="tab"]')
    tabs[0]?.setAttribute('aria-selected', 'true')
    tabs[0]?.setAttribute('aria-controls', 'missing-panel')
    tabs[1]?.setAttribute('aria-selected', 'true')

    enhanceCodeGroups(root)

    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
    expect(root.querySelector<HTMLElement>('#panel-b')?.getAttribute('aria-hidden')).toBe('false')
    expect(() => activateCodeGroupTab(group, tabs[0]!)).not.toThrow()
  })

  it('delegates keyboard/click interaction and cleans up on rerender and unmount', async () => {
    const articleRef = ref<HTMLElement | null>(null)
    const host = document.createElement('div')
    const root = makeRoot()
    document.body.append(host, root)
    const app = createApp(defineComponent({
      setup() {
        useCodeGroupMount(articleRef)
        return () => null
      },
    }))
    app.mount(host)
    articleRef.value = root
    await nextTick()

    const tabs = root.querySelectorAll<HTMLElement>('[role="tab"]')
    const selected = () => Array.from(tabs).map((tab) => tab.getAttribute('aria-selected'))
    const keydown = (tab: HTMLElement, key: string) => {
      tab.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }

    tabs[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(selected()).toEqual(['false', 'true', 'false'])

    tabs[1]?.focus()
    keydown(tabs[1]!, 'ArrowRight')
    expect(selected()).toEqual(['false', 'false', 'true'])
    expect(document.activeElement).toBe(tabs[2])
    keydown(tabs[2]!, 'ArrowRight')
    expect(selected()).toEqual(['true', 'false', 'false'])
    expect(document.activeElement).toBe(tabs[0])
    keydown(tabs[0]!, 'ArrowLeft')
    expect(selected()).toEqual(['false', 'false', 'true'])
    expect(document.activeElement).toBe(tabs[2])
    keydown(tabs[2]!, 'Home')
    expect(selected()).toEqual(['true', 'false', 'false'])
    keydown(tabs[0]!, 'End')
    expect(selected()).toEqual(['false', 'false', 'true'])
    tabs[1]?.focus()
    keydown(tabs[1]!, 'Enter')
    expect(selected()).toEqual(['false', 'true', 'false'])
    tabs[2]?.focus()
    keydown(tabs[2]!, ' ')
    expect(selected()).toEqual(['false', 'false', 'true'])

    const secondRoot = makeRoot()
    root.append(secondRoot.querySelector<HTMLElement>('.nuvyn-code-group')!)
    await settleMutationObserver()
    const groups = root.querySelectorAll<HTMLElement>('.nuvyn-code-group')
    const secondTabs = groups[1]?.querySelectorAll<HTMLElement>('[role="tab"]')
    secondTabs?.[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(secondTabs?.[1]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true')

    root.innerHTML = makeRoot().innerHTML
    await settleMutationObserver()
    const rerenderedTabs = root.querySelectorAll<HTMLElement>('[role="tab"]')
    expect(rerenderedTabs[0]?.getAttribute('aria-selected')).toBe('true')
    rerenderedTabs[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(rerenderedTabs[1]?.getAttribute('aria-selected')).toBe('true')

    app.unmount()
    root.innerHTML = makeRoot().innerHTML
    root.querySelectorAll<HTMLElement>('[role="tab"]')[1]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    expect(root.querySelectorAll<HTMLElement>('[role="tab"]')[0]?.getAttribute('aria-selected')).toBe('true')
    host.remove()
    root.remove()
  })
})
