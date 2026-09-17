import { onBeforeUnmount, ref } from 'vue'

const HOLD_DURATION = 550

export function useSettingsIconManagement<T extends string>() {
  const managing = ref(false)
  const editingId = ref<T | null>(null)
  const editingName = ref('')
  let holdTimer: ReturnType<typeof setTimeout> | null = null

  function cancelHold(): void {
    if (holdTimer !== null) clearTimeout(holdTimer)
    holdTimer = null
  }

  function startHold(): void {
    cancelHold()
    holdTimer = setTimeout(() => {
      managing.value = true
      holdTimer = null
    }, HOLD_DURATION)
  }

  function enterManaging(): void {
    cancelHold()
    managing.value = true
  }

  function startRename(id: T, currentName: string, canRename = true): void {
    if (!managing.value || !canRename) return
    editingId.value = id
    editingName.value = currentName
  }

  function cancelRename(): void {
    editingId.value = null
    editingName.value = ''
  }

  function stopManaging(): void {
    cancelHold()
    cancelRename()
    managing.value = false
  }

  onBeforeUnmount(cancelHold)

  return {
    managing,
    editingId,
    editingName,
    startHold,
    cancelHold,
    enterManaging,
    startRename,
    cancelRename,
    stopManaging,
  }
}
