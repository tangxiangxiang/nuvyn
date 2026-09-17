import type { Ref } from 'vue'
import type { Tab } from '../../../components/vault/tabs'

function isInsideMonaco(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest('.monaco-editor'))
}

export function useEditorShortcuts(options: {
  tabs: Ref<Tab[]>
  activePath: Ref<string | null>
  doSaveNow: () => Promise<void>
  closeTab: (path: string) => Promise<boolean | void>
  selectTab: (path: string) => void
  selectFilesPanel: () => void
  toggleViewMode?: () => void
  workspaceShortcuts?: boolean
}) {
  function onKeydown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey
    if (meta && e.key === 's') {
      e.preventDefault()
      void options.doSaveNow()
    }
    if (options.workspaceShortcuts !== false && meta && e.key === 'w' && options.activePath.value) {
      e.preventDefault()
      void options.closeTab(options.activePath.value)
    }
    if (meta && e.key === 'b') {
      e.preventDefault()
      options.selectFilesPanel()
    }
    if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
      if (isInsideMonaco(e.target)) return
      e.preventDefault()
      if (options.toggleViewMode) {
        options.toggleViewMode()
      } else if (import.meta.env.DEV) {
        console.warn('[useEditorShortcuts] Cmd/Ctrl+E pressed but toggleViewMode is not wired')
      }
    }
    if (options.workspaceShortcuts !== false && meta && e.key === 'Tab' && options.tabs.value.length > 0) {
      e.preventDefault()
      const cur = options.tabs.value.findIndex((t) => t.path === options.activePath.value)
      const dir = e.shiftKey ? -1 : 1
      const nextIdx = cur === -1
        ? (dir > 0 ? 0 : options.tabs.value.length - 1)
        : (cur + dir + options.tabs.value.length) % options.tabs.value.length
      options.selectTab(options.tabs.value[nextIdx].path)
    }
  }

  return { onKeydown }
}
