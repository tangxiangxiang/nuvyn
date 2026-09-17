import { shallowRef, type ShallowRef } from 'vue'
import type { FileChangeEvent } from '../../../lib/ai-api'

export type InternalFileChangeEvent = FileChangeEvent & { seq: number }

export interface VaultFileChanges {
  events: ShallowRef<InternalFileChangeEvent[]>
  publish: (event: FileChangeEvent) => void
  markConsumerSeen: (key: object, seq: number) => void
  getConsumerSeen: (key: object) => number
}

export function createVaultFileChanges(): VaultFileChanges {
  const events = shallowRef<InternalFileChangeEvent[]>([])
  let sequence = 0
  const seenByConsumer = new WeakMap<object, number>()

  return {
    events,
    publish(event) {
      sequence += 1
      events.value = [...events.value, { ...event, seq: sequence }]
    },
    markConsumerSeen(key, seq) {
      seenByConsumer.set(key, seq)
    },
    getConsumerSeen(key) {
      return seenByConsumer.get(key) ?? 0
    },
  }
}

let fallbackFileChanges = createVaultFileChanges()

/** Compatibility only for composables mounted without VaultContext. */
export function getFallbackVaultFileChanges(): VaultFileChanges {
  return fallbackFileChanges
}

export function __resetFallbackFileChangesForTesting(): void {
  fallbackFileChanges = createVaultFileChanges()
}
