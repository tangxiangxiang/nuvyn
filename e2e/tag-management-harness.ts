import { createApp, h, ref } from 'vue'
import TagManagementPanel from '../src/components/vault/TagManagementPanel.vue'
import {
  listManagedTags,
  type TagOperationApplyResult,
  type TagOperationRequest,
} from '../src/lib/tag-management-api'
import {
  reconcileCommittedTagSelectionFromOperation,
  reconcileTagSelection,
  type TagSelectionSnapshot,
} from '../src/lib/tag-selection-reconciliation'

type TagManagementHarness = {
  app: ReturnType<typeof createApp>
  host: HTMLElement
  setSelectedTag: (tag: string | null) => void
  holdSync: () => void
  releaseSync: () => void
}

declare global {
  interface Window {
    __t2TagManagementHarness?: TagManagementHarness
  }
}

/** Test-only mount for focused management-flow coverage. */
export function mountTagManagementHarness(): void {
  const selectedTag = ref<string | null>('Java')
  const selectionEpoch = ref(0)
  let syncHeld = false
  let releaseHeldSync: (() => void) | null = null
  const syncAfterCommit = async (
    result: TagOperationApplyResult,
    snapshot: TagSelectionSnapshot,
  ) => {
    const [, managedTags] = await Promise.all([
      fetch('/api/posts'),
      listManagedTags(),
    ])
    if (syncHeld) {
      await new Promise<void>((resolve) => { releaseHeldSync = resolve })
    }
    const finalSelectedTag = reconcileTagSelection({
      snapshot,
      currentSelectedTag: selectedTag.value,
      currentSelectionEpoch: selectionEpoch.value,
      operation: result.operation,
      result,
      managedTags,
    })
    selectedTag.value = finalSelectedTag
    return { managedTags, selectedTag: finalSelectedTag }
  }
  const recoverCommittedOperation = async (
    operation: TagOperationRequest,
    snapshot: TagSelectionSnapshot,
  ) => {
    const [, managedTags] = await Promise.all([
      fetch('/api/posts'),
      listManagedTags(),
    ])
    const finalSelectedTag = reconcileCommittedTagSelectionFromOperation({
      snapshot,
      currentSelectedTag: selectedTag.value,
      currentSelectionEpoch: selectionEpoch.value,
      operation,
      managedTags,
    })
    selectedTag.value = finalSelectedTag
    return { managedTags, selectedTag: finalSelectedTag }
  }
  const host = document.createElement('div')
  host.id = 't2-4-tag-management-harness'
  document.body.append(host)
  const app = createApp({
    setup() {
      return { selectedTag, selectionEpoch, syncAfterCommit, recoverCommittedOperation }
    },
    render() {
      return h(TagManagementPanel, {
        selectedTag: this.selectedTag,
        selectionEpoch: this.selectionEpoch,
        syncAfterCommit: this.syncAfterCommit,
        recoverCommittedOperation: this.recoverCommittedOperation,
      })
    },
  })
  app.mount(host)
  window.__t2TagManagementHarness = {
    app,
    host,
    setSelectedTag(tag) {
      selectedTag.value = tag
      selectionEpoch.value += 1
    },
    holdSync() {
      syncHeld = true
    },
    releaseSync() {
      syncHeld = false
      releaseHeldSync?.()
      releaseHeldSync = null
    },
  }
}

export function unmountTagManagementHarness(): void {
  window.__t2TagManagementHarness?.app.unmount()
  window.__t2TagManagementHarness?.host.remove()
  delete window.__t2TagManagementHarness
}
