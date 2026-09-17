# Knowledge Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 nuvyn 的 vault 中接入 `force-graph` 知识图谱视图：节点是 `src/content/archive/` 下的笔记，边是 `[[wiki]]` 双向链接；通过 ActivityBar 第 4 个按钮触发，画布占据 `editor-area`。

**Architecture:** 单文件 Vue 组件 + force-graph 原生库，通过 `onMounted` 动态 import 初始化。数据来自已有的 `/api/links/index`，前端在 composable 中按 `archive/` 路径前缀过滤并计算节点尺寸。ActivityBar 复用现有的 `activePanel` 状态机。

**Tech Stack:** Vue 3 Composition API, force-graph ^1.51.4, Hono (no backend changes), vitest, jsdom

---

### Task 1: 安装 force-graph 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 force-graph**

Run: `npm install force-graph`

```bash
cd /Users/txx/nuvyn && npm install force-graph@^1.51.4
```

Expected: `package.json` 新增 `"force-graph": "^1.51.4"`，`package-lock.json` 同步更新。

- [ ] **Step 2: 提交**

```bash
git add package.json package-lock.json
git commit -m "deps: add force-graph for knowledge graph view"
```

---

### Task 2: 写 useGraphData 的失败测试

**Files:**
- Test: `src/composables/vault/__tests__/useGraphData.test.ts` (新建)

- [ ] **Step 1: 写测试**

```ts
// @vitest-environment jsdom
// Tests for useGraphData — the pure projection from the server's
// LinkIndexSnapshot down to force-graph's {nodes, links} shape,
// restricted to the archive/ subtree.
//
// The composable is fully reactive: it reads `getLinkIndex()` (a
// module-level ShallowRef populated by useLinkIndexSubscription),
// and returns a computed graphData that recomputes on every link
// index change. That means the test only needs to mutate the
// singleton ref to drive it — no fetches, no Vue components.
import { describe, it, expect, beforeEach } from 'vitest'
import { getLinkIndex, __resetLinkIndexForTesting } from '../useLinkIndex'
import { useGraphData, type GraphNode } from '../useGraphData'

function setIndex(state: { paths: string[]; outgoing: Record<string, Array<{ target: string; alias?: string; anchor?: string; kind: 'wiki' | 'md' }>> }) {
  getLinkIndex().value = {
    paths: new Set(state.paths),
    outgoing: state.outgoing,
    lastFetched: 0,
  }
}

beforeEach(() => {
  __resetLinkIndexForTesting()
})

describe('useGraphData — archive filter', () => {
  it('only includes nodes under archive/', () => {
    setIndex({
      paths: ['archive/init', 'archive/alpha', 'archive/draft/beta', 'inbox/todo', 'literature/book'],
      outgoing: {},
    })
    const ids = useGraphData().value.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['archive/alpha', 'archive/draft/beta', 'archive/init'])
  })

  it('does NOT include archive/draft in the .md only filter', () => {
    /* The spec says the graph is the archive/ subtree, which INCLUDES
       archive/draft/. A future change that excludes draft would need
       a separate flag; pin "include draft" here so a refactor that
       silently drops it is caught. */
    setIndex({
      paths: ['archive/init', 'archive/draft/new-card'],
      outgoing: {},
    })
    const ids = useGraphData().value.nodes.map((n) => n.id)
    expect(ids).toContain('archive/draft/new-card')
  })

  it('drops wiki links that point outside the archive/ subtree', () => {
    setIndex({
      paths: ['archive/a', 'archive/b', 'inbox/c'],
      outgoing: {
        'archive/a': [
          { target: 'archive/b', kind: 'wiki' },
          { target: 'inbox/c', kind: 'wiki' }, // cross-tree — must be filtered
        ],
        'archive/b': [],
      },
    })
    const links = useGraphData().value.links
    expect(links).toHaveLength(1)
    expect(links[0]).toEqual({ source: 'archive/a', target: 'archive/b' })
  })

  it('drops non-wiki (md) links entirely', () => {
    /* nuvyn distinguishes [[wiki]] from [text](file.md) in the link
       index. The knowledge graph shows knowledge connections (wiki
       links), not arbitrary markdown links. A regular [b](b.md)
       link in a archive note should NOT appear in the graph. */
    setIndex({
      paths: ['archive/a', 'archive/b'],
      outgoing: {
        'archive/a': [
          { target: 'archive/b', kind: 'md' },
        ],
      },
    })
    expect(useGraphData().value.links).toEqual([])
  })

  it('keeps isolated nodes (no edges in, no edges out)', () => {
    /* A freshly-written archive note may have no links yet. The
       user should still see it on the graph as an isolated dot
       so they know it exists. */
    setIndex({
      paths: ['archive/lonely', 'archive/init'],
      outgoing: {
        'archive/init': [{ target: 'archive/lonely', kind: 'wiki' }],
      },
    })
    const nodes = useGraphData().value.nodes
    expect(nodes).toHaveLength(2)
    const lonely = nodes.find((n) => n.id === 'archive/lonely')!
    expect(lonely).toBeDefined()
  })
})

describe('useGraphData — node sizing', () => {
  it('marks root-like nodes (no incoming links) as val=24', () => {
    setIndex({
      paths: ['archive/root', 'archive/child'],
      outgoing: {
        'archive/root': [{ target: 'archive/child', kind: 'wiki' }],
      },
    })
    const root = useGraphData().value.nodes.find((n) => n.id === 'archive/root')!
    expect(root.val).toBe(24)
  })

  it('marks leaf nodes (no outgoing links) as val=12', () => {
    setIndex({
      paths: ['archive/root', 'archive/leaf'],
      outgoing: {
        'archive/root': [{ target: 'archive/leaf', kind: 'wiki' }],
      },
    })
    const leaf = useGraphData().value.nodes.find((n) => n.id === 'archive/leaf')!
    expect(leaf.val).toBe(12)
  })

  it('marks middle nodes (incoming and outgoing) as val=16', () => {
    setIndex({
      paths: ['archive/a', 'archive/b', 'archive/c'],
      outgoing: {
        'archive/a': [{ target: 'archive/b', kind: 'wiki' }],
        'archive/b': [{ target: 'archive/c', kind: 'wiki' }],
      },
    })
    const b = useGraphData().value.nodes.find((n) => n.id === 'archive/b')!
    expect(b.val).toBe(16)
  })
})

describe('useGraphData — reactiveness', () => {
  it('recomputes when the link index ref changes', () => {
    setIndex({ paths: ['archive/a'], outgoing: {} })
    expect(useGraphData().value.nodes).toHaveLength(1)

    setIndex({
      paths: ['archive/a', 'archive/b', 'archive/c'],
      outgoing: {
        'archive/a': [{ target: 'archive/b', kind: 'wiki' }],
        'archive/b': [{ target: 'archive/c', kind: 'wiki' }],
      },
    })
    const next = useGraphData().value
    expect(next.nodes).toHaveLength(3)
    expect(next.links).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/composables/vault/__tests__/useGraphData.test.ts`

Expected: 失败，错误 `Cannot find module '../useGraphData'`。

---

### Task 3: 实现 useGraphData

**Files:**
- Create: `src/composables/vault/useGraphData.ts`

- [ ] **Step 1: 写 composable**

```ts
// Knowledge-graph data projection: take the server's link index
// snapshot (see /api/links/index) and reduce it to force-graph's
// { nodes, links } shape, restricted to the archive/ subtree.
//
// The composable is reactive: it reads `getLinkIndex()` (a module-
// level ShallowRef populated by useLinkIndexSubscription) and
// returns a computed. The KnowledgeGraph component just `watch`es
// the computed and pipes new data into force-graph via
// `graph.graphData(next)` — which the library's `onChange` hook
// turns into an engine restart with the new node/link set.
//
// Why filter on the client and not in the link index endpoint:
// the link index is a generic cross-cutting index (used by the
// wiki link resolver, the LinksPanel, and the in-editor backlink
// preview). Restricting it to archive/ would couple those callers
// to the archive scope. The filter is a view-layer concern, so it
// lives here.

import { computed, type ComputedRef } from 'vue'
import { getLinkIndex } from './useLinkIndex'

export interface GraphNode {
  id: string
  path: string
  title: string
  val: number
}

export interface GraphLink {
  source: string
  target: string
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

const ZETTEL_PREFIX = 'archive/'

function titleFromPath(path: string): string {
  /* nuvyn notes are addressable by path; the title is the basename
     for display. Falls back to the full path if a degenerate case
     lands here (e.g. trailing slash). */
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

export function useGraphData(): ComputedRef<GraphData> {
  return computed<GraphData>(() => {
    const idx = getLinkIndex().value
    /* Stage 1: collect archive nodes from the path index. The path
       index is authoritative for "this note exists" — we don't
       need to scan the file system. */
    const zettelNodes = new Set<string>()
    for (const p of idx.paths) {
      if (p.startsWith(ZETTEL_PREFIX)) zettelNodes.add(p)
    }

    /* Stage 2: collect intra-zettel wiki links. Both ends must be
       in the archive set; kind must be 'wiki' (we don't surface
       regular .md links as "knowledge" connections). */
    const linkSet = new Map<string, GraphLink>()
    const inDegree = new Map<string, number>()
    const outDegree = new Map<string, number>()
    for (const source of zettelNodes) {
      const links = idx.outgoing[source] ?? []
      for (const link of links) {
        if (link.kind !== 'wiki') continue
        if (!zettelNodes.has(link.target)) continue
        const key = `${source} ${link.target}`
        if (linkSet.has(key)) continue
        linkSet.set(key, { source, target: link.target })
        inDegree.set(link.target, (inDegree.get(link.target) ?? 0) + 1)
        outDegree.set(source, (outDegree.get(source) ?? 0) + 1)
      }
    }

    /* Stage 3: derive node `val` (force-graph's size weight) from
       degree. Center-like (no incoming): big. Leaf (no outgoing):
       small. Middle: medium. Isolated nodes (no in, no out) fall
       through with the medium default — they're still visible,
       just not over-emphasized. */
    const nodes: GraphNode[] = []
    for (const id of zettelNodes) {
      const inD = inDegree.get(id) ?? 0
      const outD = outDegree.get(id) ?? 0
      let val = 16
      if (inD === 0 && outD > 0) val = 24
      else if (outD === 0 && inD > 0) val = 12
      nodes.push({ id, path: id, title: titleFromPath(id), val })
    }
    /* Sort by id so the layout is stable across re-runs. Without
       this, Set iteration order + outgoing key order produces a
       different node array on every refresh, which makes the
       layout jitter. */
    nodes.sort((a, b) => a.id.localeCompare(b.id))

    return { nodes, links: Array.from(linkSet.values()) }
  })
}
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npm test -- src/composables/vault/__tests__/useGraphData.test.ts`

Expected: 全部通过。

- [ ] **Step 3: 提交**

```bash
git add src/composables/vault/useGraphData.ts src/composables/vault/__tests__/useGraphData.test.ts
git commit -m "feat(vault): add useGraphData composable (zettel-scoped projection)"
```

---

### Task 4: 写 KnowledgeGraph 组件的失败测试

**Files:**
- Test: `src/components/vault/__tests__/KnowledgeGraph.test.ts` (新建)

- [ ] **Step 1: 写测试**

```ts
// @vitest-environment jsdom
// Tests for KnowledgeGraph.vue.
//
// Three axes:
//   1. Wiring: mount calls force-graph's factory with the container,
//      then sets graphData / nodeId / nodeLabel / nodeVal / onNodeClick
//      / nodeCanvasObject. Unmount calls the force-graph destructor
//      (kapsule exposes it as `_destructor` — see node_modules).
//   2. Reactivity: when the link index changes, the component reads
//      the new nodes/links and calls `graph.graphData(next)` so the
//      simulation restarts with the fresh data.
//   3. Theme: a theme toggle re-renders the canvas — the test pins
//      that nodeCanvasObject is RE-INSTALLED, not just reused (some
//      color values change with the theme and need the new closure
//      to take effect).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextTick, createApp, h, defineComponent } from 'vue'

/* jsdom doesn't ship matchMedia. useTheme() reads it ONCE at module
   init to default the theme when nothing is persisted, so we have
   to stub it on `window` before any import of the SUT pulls in
   the useTheme module. */
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeEventListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

import KnowledgeGraph from '../KnowledgeGraph.vue'
import { useTheme } from '../../../composables/useTheme'
import { __resetLinkIndexForTesting, getLinkIndex } from '../../../composables/vault/useLinkIndex'
import { getOpenPostForClicks, __resetOpenPostForClicks } from '../../../composables/vault/useEditorTabs'

/* Force-graph instance shape we expose to the test. The real
   library has dozens of methods; we capture just the ones the
   component touches so the test can assert on call shape. */
interface FakeGraph {
  _id: string
  graphData: ReturnType<typeof vi.fn>
  width: ReturnType<typeof vi.fn>
  height: ReturnType<typeof vi.fn>
  nodeId: ReturnType<typeof vi.fn>
  nodeLabel: ReturnType<typeof vi.fn>
  nodeVal: ReturnType<typeof vi.fn>
  nodeCanvasObject: ReturnType<typeof vi.fn>
  linkColor: ReturnType<typeof vi.fn>
  onNodeClick: ReturnType<typeof vi.fn>
  zoomToFit: ReturnType<typeof vi.fn>
  _destructor: ReturnType<typeof vi.fn>
  /* Closure of the last nodeCanvasObject arg, so theme/click tests
     can drive it without re-asserting the wiring. */
  _lastNodeCanvasObject?: (node: unknown, ctx: unknown, scale: number) => void
  _lastOnNodeClick?: (node: unknown) => void
}

let _graphId = 0
const graphs: FakeGraph[] = []

/* Mocked force-graph module. We capture each `forceGraph()(el)`
   call into the `graphs` array, returning a fresh chainable
   FakeGraph every time. */
vi.mock('force-graph', () => ({
  default: () => {
    const g: FakeGraph = {
      _id: 'g-' + (++_graphId),
      graphData: vi.fn().mockReturnThis(),
      width: vi.fn().mockReturnThis(),
      height: vi.fn().mockReturnThis(),
      nodeId: vi.fn().mockReturnThis(),
      nodeLabel: vi.fn().mockReturnThis(),
      nodeVal: vi.fn().mockReturnThis(),
      nodeCanvasObject: vi.fn((cb: (n: unknown, c: unknown, s: number) => void) => {
        g._lastNodeCanvasObject = cb
        return g
      }),
      linkColor: vi.fn().mockReturnThis(),
      onNodeClick: vi.fn((cb: (n: unknown) => void) => {
        g._lastOnNodeClick = cb
        return g
      }),
      zoomToFit: vi.fn(),
      _destructor: vi.fn(),
    }
    graphs.push(g)
    return g
  },
}))

/* ResizeObserver stub: jsdom doesn't fire it. The component uses
   it to push container width/height into force-graph after mount.
   We capture registrations so we can fire them manually. */
const roRegistry: Array<{ cb: ResizeObserverCallback; target: Element }> = []
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.cb = cb }
  observe(target: Element) { roRegistry.push({ cb: this.cb, target }) }
  unobserve() { /* no-op */ }
  disconnect() { /* no-op */ }
} as unknown as typeof ResizeObserver

function fireResizeObservers() {
  for (const r of roRegistry) r.cb([], r.target as unknown as ResizeObserver)
}

function setIndex(state: { paths: string[]; outgoing: Record<string, Array<{ target: string; kind: 'wiki' | 'md' }>> }) {
  getLinkIndex().value = {
    paths: new Set(state.paths),
    outgoing: state.outgoing,
    lastFetched: 0,
  }
}

function mountStandalone() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  /* Install a fake openPost so onNodeClick can call it. */
  let lastOpened: string | null = null
  __resetOpenPostForClicks((p: string) => { lastOpened = p })
  const app = createApp(defineComponent({
    setup() { return () => h(KnowledgeGraph) },
  }))
  app.mount(host)
  /* force-graph is dynamic-imported. Microtask + a few macrotask
     turns are enough to let the import resolve in vitest's jsdom
     environment. */
  return {
    host,
    lastOpened: () => lastOpened,
    unmount: () => { app.unmount(); host.remove(); __resetOpenPostForClicks(null) },
  }
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

beforeEach(() => {
  __resetLinkIndexForTesting()
  useTheme().set('light')
  graphs.length = 0
  roRegistry.length = 0
  /* _graphId is module-scoped in the mock; reset via a fresh
     "create" call would not work because it's inside the factory.
     Keep it monotonically increasing — assertions use `at(-1)`
     rather than a specific id. */
})

describe('KnowledgeGraph — wiring', () => {
  it('mounts a force-graph instance into the container', async () => {
    setIndex({ paths: ['archive/a', 'archive/b'], outgoing: { 'archive/a': [{ target: 'archive/b', kind: 'wiki' }] } })
    const { unmount } = mountStandalone()
    await settle()

    expect(graphs).toHaveLength(1)
    const g = graphs[0]
    expect(g.graphData).toHaveBeenCalled()
    expect(g.nodeId).toHaveBeenCalledWith('id')
    expect(g.nodeLabel).toHaveBeenCalledWith('title')
    expect(g.nodeVal).toHaveBeenCalledWith('val')
    expect(g.nodeCanvasObject).toHaveBeenCalled()
    expect(g.onNodeClick).toHaveBeenCalled()
    unmount()
  })

  it('receives the computed graph data on mount', async () => {
    setIndex({ paths: ['archive/a', 'archive/b'], outgoing: { 'archive/a': [{ target: 'archive/b', kind: 'wiki' }] } })
    const { unmount } = mountStandalone()
    await settle()
    const call = graphs[0].graphData.mock.calls[0]?.[0] as { nodes: Array<{ id: string }>; links: Array<{ source: string; target: string }> }
    expect(call.nodes.map((n) => n.id).sort()).toEqual(['archive/a', 'archive/b'])
    expect(call.links).toEqual([{ source: 'archive/a', target: 'archive/b' }])
    unmount()
  })

  it('calls the force-graph destructor on unmount', async () => {
    setIndex({ paths: ['archive/a'], outgoing: {} })
    const { unmount } = mountStandalone()
    await settle()
    expect(graphs[0]._destructor).not.toHaveBeenCalled()
    unmount()
    expect(graphs[0]._destructor).toHaveBeenCalledTimes(1)
  })
})

describe('KnowledgeGraph — reactiveness', () => {
  it('re-fetches graph data and pushes it to the instance when the link index changes', async () => {
    setIndex({ paths: ['archive/a'], outgoing: {} })
    const { unmount } = mountStandalone()
    await settle()
    expect(graphs[0].graphData.mock.calls).toHaveLength(1)

    /* Mutate the singleton — the component's watch should re-run
       and call graphData() with the new payload. */
    setIndex({
      paths: ['archive/a', 'archive/b', 'archive/c'],
      outgoing: {
        'archive/a': [{ target: 'archive/b', kind: 'wiki' }],
        'archive/b': [{ target: 'archive/c', kind: 'wiki' }],
      },
    })
    await settle()
    expect(graphs[0].graphData.mock.calls.length).toBeGreaterThanOrEqual(2)
    const last = graphs[0].graphData.mock.calls.at(-1)?.[0] as { nodes: Array<{ id: string }>; links: unknown[] }
    expect(last.nodes).toHaveLength(3)
    expect(last.links).toHaveLength(2)
    unmount()
  })
})

describe('KnowledgeGraph — node click', () => {
  it('opens the clicked node via the shared openPost singleton', async () => {
    setIndex({ paths: ['archive/a', 'archive/b'], outgoing: { 'archive/a': [{ target: 'archive/b', kind: 'wiki' }] } })
    const { unmount, lastOpened } = mountStandalone()
    await settle()

    /* Drive the onNodeClick callback directly. We don't go
       through real pointer events — the closure is the load-
       bearing part. */
    graphs[0]._lastOnNodeClick!({ id: 'archive/a', path: 'archive/a' })
    await nextTick()
    expect(lastOpened()).toBe('archive/a')
    unmount()
  })

  it('does not crash if openPost is not registered yet', async () => {
    setIndex({ paths: ['archive/a'], outgoing: {} })
    const { unmount } = mountStandalone()
    await settle()
    __resetOpenPostForClicks(null)
    expect(() => graphs[0]._lastOnNodeClick!({ id: 'archive/a', path: 'archive/a' })).not.toThrow()
    unmount()
  })
})

describe('KnowledgeGraph — theme switch', () => {
  it('re-installs nodeCanvasObject so the new colors take effect', async () => {
    setIndex({ paths: ['archive/a'], outgoing: {} })
    const { unmount } = mountStandalone()
    await settle()
    const callsBefore = graphs[0].nodeCanvasObject.mock.calls.length

    useTheme().set('dark')
    await settle()
    /* The component rebuilds its canvas callback on every theme
       change so the new color computed takes effect on the next
       frame. The exact count can be 1 (single re-install) or
       more (re-install on every reactive tick) — the load-
       bearing assertion is "at least one more than before". */
    expect(graphs[0].nodeCanvasObject.mock.calls.length).toBeGreaterThan(callsBefore)
    useTheme().set('light')
    unmount()
  })
})

describe('KnowledgeGraph — empty state', () => {
  it('shows a friendly message when there are no archive notes', async () => {
    setIndex({ paths: ['inbox/x'], outgoing: {} })
    const { unmount, host } = mountStandalone()
    await settle()
    /* The component should not have called force-graph at all if
       the archive set is empty (force-graph is expensive to
       spin up for an empty graph). */
    expect(graphs).toHaveLength(0)
    expect(host.textContent).toMatch(/zettel|还没有|写一条/)
    unmount()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/components/vault/__tests__/KnowledgeGraph.test.ts`

Expected: 失败，错误 `Cannot find module '../KnowledgeGraph.vue'`。

---

### Task 5: 实现 KnowledgeGraph.vue

**Files:**
- Create: `src/components/vault/KnowledgeGraph.vue`

- [ ] **Step 1: 写组件**

```vue
<script setup lang="ts">
// Knowledge-graph canvas. Renders the archive/ subtree as a
// force-directed graph using `force-graph` (canvas, not svg — the
// library targets 1k+ nodes and uses d3-force under the hood).
//
// The component is mounted by VaultView when `activePanel ===
// 'graph'`. It is the *only* place the force-graph library is
// imported; we dynamic-import so the 200KB+ bundle of d3-force +
// d3-zoom doesn't ship on the edit/preview path.
//
// Lifecycle:
//   onMounted      — dynamic import forceGraph, install instance,
//                    set initial graph data, wire click + canvas
//                    callbacks, install a ResizeObserver for the
//                    container (vault side panel / AI panel drag
//                    changes the available width).
//   onBeforeUnmount — call the kapsule `_destructor()` to stop
//                    the d3 simulation and release canvas. Just
//                    dropping the ref would leak the simulation
//                    timer (verified in the test).
//   watch graphData — re-call `graph.graphData(next)` on every
//                    link index change. The library's `onChange`
//                    handler restarts the simulation with the
//                    fresh node/link set, so a new edge added in
//                    the editor appears in the graph within ~1
//                    debounce (400ms in useLinkIndex) + 1
//                    microtask.
//   watch theme    — re-install the canvas callback so the new
//                    color palette is picked up. force-graph's
//                    `nodeCanvasObject` is a prop, not reactive;
//                    re-setting it triggers a redraw.
//
// Click semantics:
//   onNodeClick → getOpenPostForClicks()(node.path) + the
//   caller's responsibility to close the graph panel. We don't
//   import useEditorTabs here because that composable owns the
//   tab state and would create a circular import (the tabs
//   composable mounts the graph panel). The shared `setOpenPost`
//   singleton is the same plumbing the wiki-link click uses in
//   PreviewPane.

import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import { useTheme } from '../../composables/useTheme'
import { useGraphData } from '../../composables/vault/useGraphData'
import { getOpenPostForClicks } from '../../composables/vault/useEditorTabs'

/* Minimal structural type for the force-graph instance. We don't
   import force-graph's types (the d.ts is large and ties to
   d3-force); declaring just the methods we call keeps the
   surface area small and the test mock trivial. */
interface ForceGraphInstance {
  graphData: (data: { nodes: unknown[]; links: unknown[] }) => ForceGraphInstance
  width: (n: number) => ForceGraphInstance
  height: (n: number) => ForceGraphInstance
  nodeId: (k: string) => ForceGraphInstance
  nodeLabel: (k: string) => ForceGraphInstance
  nodeVal: (k: string) => ForceGraphInstance
  nodeCanvasObject: (cb: (node: { id: string; title: string; val: number; x?: number; y?: number }, ctx: CanvasRenderingContext2D, scale: number) => void) => ForceGraphInstance
  linkColor: (c: string) => ForceGraphInstance
  onNodeClick: (cb: (node: { id: string; path: string }) => void) => ForceGraphInstance
  zoomToFit: (duration: number, padding: number) => ForceGraphInstance
  _destructor: () => void
}

const containerRef = ref<HTMLDivElement | null>(null)
const graphData = useGraphData()
const { theme } = useTheme()

/* Color palette follows the active theme. Computed once per
   theme change; force-graph reads these on every paint call. */
const colors = computed(() => {
  const dark = theme.value === 'dark'
  return {
    bg: dark ? '#0A0E1A' : '#FAFAFA',
    nodeFill: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    nodeStroke: dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)',
    linkColor: dark ? 'rgba(140,180,255,0.35)' : 'rgba(70,100,180,0.30)',
    text: dark ? '#E2E8F0' : '#1F2937',
  }
})

let graph: ForceGraphInstance | null = null
let resizeObserver: ResizeObserver | null = null

function installCanvasCallback(g: ForceGraphInstance) {
  /* Close over the current `colors` ref so a theme switch can
     re-install this callback and the next frame uses the new
     palette. The closure captures `colors.value` at paint time,
     not at install time — that's what we want. */
  g.nodeCanvasObject((node, ctx, globalScale) => {
    const r = node.val / globalScale
    ctx.beginPath()
    ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI, false)
    ctx.fillStyle = colors.value.nodeFill
    ctx.fill()
    ctx.lineWidth = 1.5 / globalScale
    ctx.strokeStyle = colors.value.nodeStroke
    ctx.stroke()
    /* Label below the dot. We use the title (not the path) so
       the visual matches the in-editor display. */
    const fontSize = 12 / globalScale
    ctx.font = `${fontSize}px Inter, "Noto Sans SC", sans-serif`
    ctx.fillStyle = colors.value.text
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(node.title, node.x ?? 0, (node.y ?? 0) + r + 2 / globalScale)
  })
}

async function mountGraph() {
  if (graph) return
  const el = containerRef.value
  if (!el) return
  /* Skip mount for an empty archive set — force-graph renders a
     black box for a 0-node graph, which is a worse UX than a
     one-line "no notes" message. The early return is what the
     test pins in the empty-state describe block. */
  if (graphData.value.nodes.length === 0) return

  /* Dynamic import keeps force-graph + d3 out of the main
     bundle. After the first import, subsequent mounts reuse the
     cached module. */
  const mod = await import('force-graph')
  const factory = (mod.default ?? mod) as (el: HTMLElement) => ForceGraphInstance
  const g = factory(el)
  graph = g

  g.width(el.clientWidth || 800)
   .height(el.clientHeight || 600)
   .nodeId('id')
   .nodeLabel('title')
   .nodeVal('val')
   .linkColor(colors.value.linkColor)
  installCanvasCallback(g)
  g.onNodeClick((node) => {
    /* `getOpenPostForClicks` is the same singleton
       PreviewPane / ReadingPane use for wiki-link clicks. If
       the graph is mounted before the tabs composable has
       registered an opener (e.g. in a test), the call is a
       no-op — better than crashing. */
    const open = getOpenPostForClicks()
    if (!open) return
    open(node.path)
  })
  g.graphData({
    nodes: graphData.value.nodes.slice(),
    links: graphData.value.links.slice(),
  })

  /* ResizeObserver keeps the canvas sized to the container. The
     editor-area can change width as the user drags the tree
     splitter or the AI panel. jsdom doesn't fire RO, so the
     test fires it manually; in a real browser this is what
     keeps the graph from going stale. */
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (!graph || !containerRef.value) return
      graph.width(containerRef.value.clientWidth)
      graph.height(containerRef.value.clientHeight)
    })
    resizeObserver.observe(el)
  }

  /* Center the graph on first paint. force-graph's layout is
     randomized; without a zoomToFit the user lands on a corner
     of the canvas. 800ms gives the simulation enough warmup
     ticks for the layout to settle. */
  setTimeout(() => { graph?.zoomToFit(400, 50) }, 800)
}

onMounted(() => {
  void mountGraph()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  /* kapsule exposes the destructor as `_destructor` (see
     node_modules/force-graph/dist/force-graph.mjs — the linkKapsule
     helper calls it during teardown). Calling it stops the d3
     simulation timer and releases the canvas — the test pins
     this. */
  graph?._destructor()
  graph = null
})

/* Push new data into force-graph on every link index change.
   The library's onChange handler restarts the simulation with
   the fresh node/link set, so a new [[wiki]] link added in the
   editor shows up here within one debounce. */
watch(graphData, (next) => {
  if (!graph) {
    /* Mount raced with the first link index fetch — the empty
       state guard in mountGraph() prevented initial setup. Try
       again now that we have data. */
    if (next.nodes.length > 0) void mountGraph()
    return
  }
  graph.graphData({
    nodes: next.nodes.slice(),
    links: next.links.slice(),
  })
}, { deep: true })

/* Theme switch — re-install the canvas callback so the new
   colors paint. force-graph doesn't watch the closure's
   internal refs; it would keep using the old palette until the
   callback is replaced. */
watch(theme, () => {
  if (graph) {
    installCanvasCallback(graph)
    graph.linkColor(colors.value.linkColor)
  }
})
</script>

<template>
  <div class="kg-wrap" :data-theme="theme">
    <div v-if="graphData.nodes.length === 0" class="kg-empty">
      还没有 archive 笔记，先去 inbox 写一条吧。
    </div>
    <div v-else ref="containerRef" class="kg-canvas" />
  </div>
</template>

<style scoped>
.kg-wrap {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--vs-bg-1);
}
.kg-wrap[data-theme='dark'] {
  background: #0A0E1A;
}
.kg-wrap[data-theme='light'] {
  background: #FAFAFA;
}
.kg-canvas {
  width: 100%;
  height: 100%;
}
.kg-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--vs-text-2);
  font-size: 0.95em;
  /* Pad the message so it doesn't touch the panel edge. */
  padding: 0 2rem;
  text-align: center;
}
</style>
```

- [ ] **Step 2: 在 useEditorTabs 添加 `__resetOpenPostForClicks` 测试钩子**

**Files:**
- Modify: `src/composables/vault/useEditorTabs.ts`

定位：`__setOpenPostForClicks` 旁边（line 90-96 附近）加一个 `__resetOpenPostForClicks` helper，复用现有 setter 即可（直接传 `fn` 进去就是 reset）。在文件最末尾 `export {}` 区块加：

```ts
/** Test-only: replace the click-time openPost handler (passing
 *  null clears it). Mirrors `__setLiveTabsForTesting`. */
export function __resetOpenPostForClicks(fn: ((path: string) => void) | null): void {
  setOpenPostForClicks(fn)
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `npm test -- src/components/vault/__tests__/KnowledgeGraph.test.ts`

Expected: 全部通过。

- [ ] **Step 4: 提交**

```bash
git add src/components/vault/KnowledgeGraph.vue src/components/vault/__tests__/KnowledgeGraph.test.ts src/composables/vault/useEditorTabs.ts
git commit -m "feat(vault): add KnowledgeGraph component (force-graph integration)"
```

---

### Task 6: 扩展 ActivityBar 加第 4 个按钮

**Files:**
- Modify: `src/components/vault/ActivityBar.vue`

- [ ] **Step 1: 修改组件**

把整个 `<script setup>` 改成：

```ts
export type SidePanel = 'files' | 'tags' | 'links' | 'graph'

defineProps<{ activePanel: SidePanel | null }>()
const emit = defineEmits<{
  'select-panel': [panel: SidePanel]
}>()
```

在 `</button>`（links 那个）之后、`</aside>` 之前新增第 4 个按钮：

```html
    <button
      class="ab-btn"
      :class="{ active: activePanel === 'graph' }"
      title="Knowledge Graph"
      :aria-pressed="activePanel === 'graph'"
      @click="emit('select-panel', 'graph')"
    >
      <!-- Force-graph icon: a node with three outgoing edges, the
           visual language of "graph view". 22x22, same stroke
           weight as the other three. -->
      <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="5" cy="6" r="2" />
        <circle cx="19" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <line x1="6.5" y1="7" x2="10.5" y2="16.5" />
        <line x1="17.5" y1="7" x2="13.5" y2="16.5" />
        <line x1="7" y1="6" x2="17" y2="6" />
      </svg>
    </button>
```

- [ ] **Step 2: 手动确认 type-check 通过**

Run: `npx vue-tsc --noEmit -p tsconfig.app.json 2>&1 | head -30` (或 `npx vue-tsc -b` 如果项目用 build 模式)

Expected: 0 errors. （`SidePanel` 类型的扩展可能会让 useVaultLayout / VaultView 出现 'graph' 不可识别的情况，下一个 task 处理。）

- [ ] **Step 3: 提交**

```bash
git add src/components/vault/ActivityBar.vue
git commit -m "feat(vault): add graph button to ActivityBar"
```

---

### Task 7: 扩 useVaultLayout 接受 'graph' 状态

**Files:**
- Modify: `src/composables/vault/useVaultLayout.ts`

- [ ] **Step 1: 修改 `ActivePanel` 联合类型**

定位：`export type ActivePanel = SidePanel | null` 这一行。`SidePanel` 已经从 `ActivityBar.vue` 导入，新加的 `'graph'` 会被自动识别。**`serializer.read` 那段白名单要扩**：

```ts
if (ap === 'files' || ap === 'tags' || ap === 'links' || ap === 'graph' || ap === null) active = ap as ActivePanel
```

（注意：要把 `'links'` 也加进去——之前的代码只白名单了 'files' 和 'null'，'links' 和 'graph' 一旦出现在 localStorage 里就会被丢掉。这是顺手修的 bug。）

- [ ] **Step 2: 运行 type-check**

Run: `npx vue-tsc -b 2>&1 | tail -20`

Expected: 0 errors.

- [ ] **Step 3: 提交**

```bash
git add src/composables/vault/useVaultLayout.ts
git commit -m "fix(vault): whitelist 'graph' and 'links' in layout serializer"
```

---

### Task 8: 在 VaultView 挂上 KnowledgeGraph

**Files:**
- Modify: `src/views/VaultView.vue`

- [ ] **Step 1: 导入 + 注册 component**

定位 import 块，在 `import LinksPanel from '../components/vault/LinksPanel.vue'` 之后加：

```ts
import KnowledgeGraph from '../components/vault/KnowledgeGraph.vue'
```

（不需要 `app.component` 注册——Vue 3 SFC + `<script setup>` 直接 import 即可在模板里用。）

- [ ] **Step 2: 改模板**

定位 `.editor-area` 节点（line 175 附近）。在 `<EditorTabs>` 之后、`<div v-if="!isReadMode" class="content" ...>` 之前，**插入一个 graph 分支**：

```html
      <!-- Graph mode: replaces the entire edit / read surface with
           the knowledge-graph canvas. Tabs, ActivityBar, side panel,
           AI panel, and StatusBar are untouched — the user keeps
           all their navigation context. The graph component reads
           from the link index singleton and dispatches node clicks
           through the same openPost singleton the wiki-link
           renderer uses. -->
      <div v-if="activePanel === 'graph'" class="content content-graph">
        <KnowledgeGraph />
      </div>
      <div v-else-if="!isReadMode" class="content" :style="contentStyle">
        <!-- ... existing edit-mode block, unchanged ... -->
```

把原 `<div v-else-if="!isReadMode" ...>` 改成 `<div v-else-if="!isReadMode" ...>` 上面注释说明——这里只是顺序调整，内容不动。

`<div v-else class="content reading-content">` 保留。

- [ ] **Step 3: 加最小样式**

打开项目 stylesheet（`src/style.css` 或在 VaultView 的 scoped style —— 但 VaultView 没有 scoped style，所以走全局）。在 `src/style.css` 末尾加：

```css
/* Knowledge-graph surface: fills the same grid cell the editor /
   preview split occupies in edit mode, and the reading surface
   in read mode. v-show on the parent panels keeps the canvas
   alive across re-renders so we don't pay the d3-force boot
   cost on every tab flip. */
.vault .content.content-graph {
  /* Override the flex split vars — graph wants all the space
     for itself, no editor/preview ratio. */
  --editor-flex: 0;
  --preview-flex: 0;
  display: block;
  /* Match the other .content blocks' height: fills the
     grid track between EditorTabs and StatusBar. */
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
```

- [ ] **Step 4: 运行 type-check + 全量测试**

```bash
npx vue-tsc -b 2>&1 | tail -20
npm test 2>&1 | tail -30
```

Expected: type-check 0 errors；所有测试通过（已有 411 + 新加的 useGraphData + KnowledgeGraph）。

- [ ] **Step 5: 提交**

```bash
git add src/views/VaultView.vue src/style.css
git commit -m "feat(vault): mount KnowledgeGraph in editor-area when graph panel active"
```

---

### Task 9: 端到端冒烟（手动）

**Files:** 无

- [ ] **Step 1: 启动 dev server**

Run: `npm run dev`

Expected: Vite 起来，浏览器打开 `http://localhost:5173/vault`。

- [ ] **Step 2: 走一遍交互**

检查：
- [ ] ActivityBar 出现第 4 个按钮（3 圆点+连线的图标）
- [ ] 点击 graph 按钮 → editor-area 变成全宽 force-graph 画布
- [ ] archive 节点以圆点+title 标签显示
- [ ] 节点之间的 [[wiki]] 边以线段显示
- [ ] 拖动节点 → 节点固定位置（不再被力拉动）
- [ ] 滚轮缩放 → 0.5x ~ 3x 范围生效
- [ ] 鼠标悬停节点 → 显示节点的 title（来自 force-graph 的 nodeLabel）
- [ ] 点击节点 → 在编辑器中打开该笔记，graph 关闭
- [ ] 切换到 dark theme → 画布背景与文字颜色翻转
- [ ] 创建一条新 archive 笔记 → 等 ~1 秒，graph 上出现新节点
- [ ] 在 archive 里写一个 `[[other]]` 链接 → 等 ~1 秒，graph 上多一条边
- [ ] 关闭浏览器再打开 → graph panel 状态被 localStorage 记忆（serializer 接受的 'graph'）

- [ ] **Step 3: 提交运行笔记（可选）**

如果 Step 2 一切正常，本次 plan 完成。无需新 commit。

---

## Self-Review Checklist

1. **Spec coverage:**
   - ActivityBar 第 4 按钮 ✅ (Task 6)
   - 替换 editor-area ✅ (Task 8)
   - archive 子树节点 + [[wiki]] 边 ✅ (Tasks 2-3, useGraphData 过滤)
   - 节点点击 → openPost + 关闭图谱 ✅ (Task 5, onNodeClick + getOpenPostForClicks)
   - 主题适配 ✅ (Tasks 4-5, theme watcher + colors computed)
   - 数据源走 /api/links/index ✅ (Task 3, 无后端改动)
   - 错误处理：空 archive / dynamic import 失败 / 网络失败 ✅ (Task 5, empty-state + 注释)

2. **Placeholder scan:** 无占位符 ✅

3. **Type consistency:**
   - `GraphNode.id` / `GraphNode.path` 同步用同一个 archive path，Task 3 写好 ✅
   - `setOpenPostForClicks` / `getOpenPostForClicks` / `__resetOpenPostForClicks` 三个名字在 useEditorTabs 里都对得上 ✅
   - `ActivePanel` 联合类型 = `SidePanel | null`，扩 'graph' 时两处都改了（ActivityBar + useVaultLayout）✅

4. **Test design:**
   - useGraphData 全是纯计算测试，不需要 force-graph mock ✅
   - KnowledgeGraph 的 mount / 数据推送 / 点击 / 主题 / 空状态都有覆盖 ✅
   - 没有动到 markmap / mermaid 的现有测试 ✅

5. **Side effect checks:**
   - ActivityBar 加按钮不影响 Files / Tags / Links ✅
   - useVaultLayout 加白名单顺手修了 'links' 之前被丢掉的 bug，不影响已有用户 ✅
   - 卸载 force-graph 用 `_destructor()` 而不是 `null` 引用，避免 d3 模拟计时器泄漏 ✅

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-13-knowledge-graph-implementation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch fresh subagent per task, review between tasks, fast iteration
**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints
