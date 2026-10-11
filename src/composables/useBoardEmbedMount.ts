import { createApp, onBeforeUnmount, unref, watch, type App, type MaybeRef, type Ref } from 'vue'
import BoardEmbed from '../components/board/BoardEmbed.vue'
import { parseBoardReference } from '../lib/boardReferences'
import type { Theme } from './useTheme'

/** Upgrade only valid Board image placeholders, and dispose on v-html replacement. */
export function useBoardEmbedMount(articleEl: Ref<HTMLElement | null>, renderTheme?: MaybeRef<Theme | undefined>): void {
  const widgets = new Map<HTMLElement, App>()
  let observer: MutationObserver | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function scan(): void {
    const root = articleEl.value
    for (const [host, app] of widgets) {
      if (root?.contains(host)) continue
      app.unmount()
      widgets.delete(host)
    }
    if (!root) return
    for (const placeholder of root.querySelectorAll<HTMLElement>('.board-embed-mount')) {
      const boardId = parseBoardReference(`board:${placeholder.dataset.target ?? ''}`)
      if (!boardId) {
        placeholder.classList.remove('board-embed-mount')
        continue
      }
      const host = document.createElement('span')
      host.className = 'board-embed-host'
      const app = createApp(BoardEmbed, { boardId, label: placeholder.title, renderTheme: unref(renderTheme) })
      placeholder.replaceWith(host)
      app.mount(host)
      widgets.set(host, app)
    }
  }

  function stopObserver(): void {
    observer?.disconnect()
    observer = null
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  watch(articleEl, (root) => {
    stopObserver()
    scan()
    if (!root) return
    observer = new MutationObserver(() => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        scan()
      }, 60)
    })
    observer.observe(root, { childList: true, subtree: true })
  }, { flush: 'post', immediate: true })

  onBeforeUnmount(() => {
    stopObserver()
    for (const app of widgets.values()) app.unmount()
    widgets.clear()
  })
}
