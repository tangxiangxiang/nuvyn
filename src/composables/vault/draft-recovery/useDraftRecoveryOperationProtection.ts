import { computed, ref, type ComputedRef } from 'vue'

export interface DraftRecoveryOperationProtection {
  protectedIds: ComputedRef<ReadonlySet<string>>
  run<T>(recoveryIds: readonly string[], operation: () => Promise<T>): Promise<T>
}

export function createDraftRecoveryOperationProtection(): DraftRecoveryOperationProtection {
  const counts = ref(new Map<string, number>())
  const protectedIds = computed<ReadonlySet<string>>(() => new Set(counts.value.keys()))

  async function run<T>(
    recoveryIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const next = new Map(counts.value)
    for (const id of recoveryIds) next.set(id, (next.get(id) ?? 0) + 1)
    counts.value = next
    try {
      return await operation()
    } finally {
      const remaining = new Map(counts.value)
      for (const id of recoveryIds) {
        const count = (remaining.get(id) ?? 1) - 1
        if (count <= 0) remaining.delete(id)
        else remaining.set(id, count)
      }
      counts.value = remaining
    }
  }

  return { protectedIds, run }
}
