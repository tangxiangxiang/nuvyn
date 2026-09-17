export interface DiaryHomeKeyboardState {
  activeWorkspaceTabId: string | null
  workspaceTabCount: number
}

/**
 * Apply only the keyboard ownership that Diary Home is allowed to claim.
 * Hidden workspace tabs remain mounted for lifecycle continuity, but they
 * must not receive keyboard close/cycle/save/edit actions.
 */
export function handleDiaryHomeKeydown(
  event: KeyboardEvent,
  state: DiaryHomeKeyboardState,
  onEditorKeydown: (event: KeyboardEvent) => void,
): void {
  const meta = event.metaKey || event.ctrlKey
  if (!meta) return

  const key = event.key.toLowerCase()
  if (key === 'w' && state.activeWorkspaceTabId) {
    event.preventDefault()
    return
  }

  if (event.key === 'Tab' && state.workspaceTabCount > 0) {
    event.preventDefault()
    return
  }

  if (key === 's' || key === 'e') {
    event.preventDefault()
    return
  }

  if (key === 'b') onEditorKeydown(event)
}
