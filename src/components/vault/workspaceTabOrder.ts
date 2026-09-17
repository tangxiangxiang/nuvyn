export type WorkspaceTabDropPosition = 'before' | 'after'

function uniqueAvailableIds(availableIds: readonly string[]): string[] {
  return [...new Set(availableIds)]
}

export function reconcileWorkspaceTabOrder(
  currentOrder: readonly string[],
  availableIds: readonly string[],
): string[] {
  const available = uniqueAvailableIds(availableIds)
  const availableSet = new Set(available)
  const seen = new Set<string>()
  const result: string[] = []

  for (const id of currentOrder) {
    if (!availableSet.has(id) || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  for (const id of available) {
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

export function applyWorkspaceTabOrder(
  currentOrder: readonly string[],
  requestedOrder: readonly string[],
  availableIds: readonly string[],
): string[] | null {
  const available = uniqueAvailableIds(availableIds)
  if (
    requestedOrder.length !== available.length
    || new Set(requestedOrder).size !== requestedOrder.length
  ) return null
  const availableSet = new Set(available)
  if (requestedOrder.some((id) => !availableSet.has(id))) return null

  const reconciled = reconcileWorkspaceTabOrder(currentOrder, available)
  return reconciled.every((id, index) => id === requestedOrder[index])
    ? reconciled
    : [...requestedOrder]
}

export function moveWorkspaceTab(
  currentOrder: readonly string[],
  movedId: string,
  targetId: string,
  position: WorkspaceTabDropPosition,
): string[] {
  if (movedId === targetId) return [...currentOrder]
  const sourceIndex = currentOrder.indexOf(movedId)
  const targetIndex = currentOrder.indexOf(targetId)
  if (sourceIndex < 0 || targetIndex < 0) return [...currentOrder]

  const result = [...currentOrder]
  result.splice(sourceIndex, 1)
  const adjustedTarget = result.indexOf(targetId)
  result.splice(adjustedTarget + (position === 'after' ? 1 : 0), 0, movedId)
  return result
}

export function migrateWorkspaceTabIds(
  currentOrder: readonly string[],
  mappings: ReadonlyArray<{ from: string; to: string }>,
): string[] {
  let result = [...new Set(currentOrder)]
  for (const { from, to } of mappings) {
    if (!from || !to || from === to) continue
    const sourceIndex = result.indexOf(from)
    if (sourceIndex < 0) continue
    result.splice(sourceIndex, 1)
    const duplicateIndex = result.indexOf(to)
    if (duplicateIndex >= 0) result.splice(duplicateIndex, 1)
    const insertionIndex = duplicateIndex >= 0 && duplicateIndex < sourceIndex
      ? sourceIndex - 1
      : sourceIndex
    result.splice(Math.min(insertionIndex, result.length), 0, to)
  }
  return result
}
