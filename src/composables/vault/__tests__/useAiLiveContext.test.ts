// @vitest-environment jsdom

import { computed, defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../components/vault/tabs'
import type { AiLiveContextCapture } from '../aiLiveContext'
import { useAiLiveContext } from '../useAiLiveContext'
import { createVaultContext } from '../context/createVaultContext'
import { createVaultFileChanges } from '../context/fileChanges'
import { provideVaultContext } from '../context/useVaultContext'

function contextWithCapture(captureAiContext: () => AiLiveContextCapture) {
  return createVaultContext({
    vaultId: ref('vault-a'),
    fileChanges: createVaultFileChanges(),
    tabs: ref<Tab[]>([]),
    activePath: ref<string | null>(null),
    activeTab: computed(() => null),
    openPost: async () => {},
    captureAiContext,
  })
}

function mountWithProvider(captureAiContext: () => AiLiveContextCapture) {
  const context = contextWithCapture(captureAiContext)
  let api: ReturnType<typeof useAiLiveContext> | null = null
  const Child = defineComponent({
    setup() {
      api = useAiLiveContext()
      return () => h('div')
    },
  })
  const Parent = defineComponent({
    setup() {
      provideVaultContext(context)
      return () => h(Child)
    },
  })
  const wrapper = mount(Parent)
  return { wrapper, api: api!, context }
}

describe('useAiLiveContext', () => {
  it('captures none outside any component instance', () => {
    // No Vue instance → useOptionalVaultContext() cannot inject, and the
    // API must still answer synchronously with the fail-closed none.
    const api = useAiLiveContext()
    expect(api.capture()).toEqual({ status: 'none' })
  })

  it('captures none inside a component with no Vault provider', () => {
    let api: ReturnType<typeof useAiLiveContext> | null = null
    const Child = defineComponent({
      setup() {
        api = useAiLiveContext()
        return () => h('div')
      },
    })
    mount(Child)
    expect(api!.capture()).toEqual({ status: 'none' })
  })

  it('delegates to VaultContext.ai.capture() when provided', () => {
    const unavailable: AiLiveContextCapture = { status: 'unavailable', reason: 'loading' }
    const { api } = mountWithProvider(() => unavailable)
    expect(api.capture()).toBe(unavailable)
  })

  it('re-reads workspace state on every call with no caching', () => {
    let calls = 0
    const { api } = mountWithProvider(() => {
      calls += 1
      return calls === 1
        ? { status: 'none' }
        : { status: 'unavailable', reason: 'stale-workspace' }
    })
    expect(api.capture()).toEqual({ status: 'none' })
    expect(api.capture()).toEqual({ status: 'unavailable', reason: 'stale-workspace' })
    expect(calls).toBe(2)
  })

  it('follows the late-bound workspace delegate after rebind', () => {
    // Mirrors VaultView: the context is created before the workspace
    // viewers exist, so the delegate starts as none and is rebound once
    // all state exists. useAiLiveContext must see the post-rebind result.
    let delegate: () => AiLiveContextCapture = () => ({ status: 'none' })
    const { api } = mountWithProvider(() => delegate())

    expect(api.capture()).toEqual({ status: 'none' })

    delegate = () => ({ status: 'unavailable', reason: 'missing-identity' })
    expect(api.capture()).toEqual({ status: 'unavailable', reason: 'missing-identity' })
  })

  it('needs no router, route, or post fetch to answer', () => {
    // Mounted WITHOUT vue-router: a composable that consulted the route
    // (like the legacy useCurrentNote) would throw here. useAiLiveContext
    // derives everything from the vault context alone.
    let api: ReturnType<typeof useAiLiveContext> | null = null
    const Child = defineComponent({
      setup() {
        api = useAiLiveContext()
        return () => h('div')
      },
    })
    mount(Child)
    expect(() => api!.capture()).not.toThrow()
    expect(api!.capture()).toEqual({ status: 'none' })
  })
})
