// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import { createVaultFileChanges } from '../fileChanges'

describe('VaultFileChanges', () => {
  it('keeps a stable events ref and appends monotonic sequence numbers', () => {
    const changes = createVaultFileChanges()
    const events = changes.events
    changes.publish({ path: 'a.md', kind: 'write' })
    changes.publish({ path: 'b.md', kind: 'delete' })
    changes.publish({ path: 'c.md', kind: 'rename', oldPath: 'a.md' })

    expect(changes.events).toBe(events)
    expect(events.value.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(events.value[2]).toMatchObject({ path: 'c.md', oldPath: 'a.md' })
  })

  it('notifies shallow-ref watchers once per publish', async () => {
    const changes = createVaultFileChanges()
    const watcher = vi.fn()
    watch(changes.events, watcher, { flush: 'post' })
    changes.publish({ path: 'a.md', kind: 'write' })
    await Promise.resolve()
    expect(watcher).toHaveBeenCalledTimes(1)
  })

  it('tracks consumer cursors independently', () => {
    const changes = createVaultFileChanges()
    const a = {}
    const b = {}
    changes.markConsumerSeen(a, 3)
    expect(changes.getConsumerSeen(a)).toBe(3)
    expect(changes.getConsumerSeen(b)).toBe(0)
  })

  it('isolates independently created buses', () => {
    const a = createVaultFileChanges()
    const b = createVaultFileChanges()
    a.publish({ path: 'a.md', kind: 'write' })
    expect(a.events.value).toHaveLength(1)
    expect(b.events.value).toEqual([])
  })
})
