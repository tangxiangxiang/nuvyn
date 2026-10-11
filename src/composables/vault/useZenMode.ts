import { readonly, ref } from 'vue'

// A single in-memory owner shared by App chrome and VaultView. Deliberately
// not persisted: a fresh page load must always return to the normal layout.
const active = ref(false)

export function useZenMode() {
  function enter(): void {
    active.value = true
  }

  function exit(): void {
    active.value = false
  }

  function toggle(): void {
    active.value = !active.value
  }

  return {
    active: readonly(active),
    enter,
    exit,
    toggle,
  }
}

export function __resetZenModeForTesting(): void {
  active.value = false
}
