# 知识图谱（Knowledge Graph）设计

> Status: Removed. This document is retained as historical design context; the Graph view and `force-graph` dependency are no longer part of Nuvyn.

> **For agentic workers:** 配套实现计划见 `docs/superpowers/plans/2026-06-13-knowledge-graph-implementation.md`。

## 概述

把 `force-graph` 移植到 nuvyn 作为 vault 内的"知识图谱"视图：节点是 `src/content/archive/` 目录里（包括 `archive/draft/`）的每个 `.md` 笔记，边是这些笔记之间通过 `[[wiki]]` 语法建立的双向链接。点击节点关闭图谱并在编辑器中打开该笔记。

入口是 ActivityBar 的第 4 个按钮（`graph` 图标），与 Files / Tags / Links 互斥，active 时高亮。点击按钮时把 vault 的右侧 `editor-area` 替换为全宽图谱画布；再次点击或点击其他 ActivityBar 按钮即关闭并恢复原编辑区。ActivityBar、侧栏、StatusBar、右侧 AI 面板**不**受影响——保留 vault 导航上下文。

## Tech Stack

- **force-graph** ^1.51.4（原生 JS 版本，与 Vue 3 通过 `onMounted` 集成；vue2-force-graph 已停止维护）
- **Vue 3 Composition API** — 组件框架
- **Hono** — 后端
- **现有的 `/api/links/index`** — 双向链接数据源（已存在，wire shape 见 `src/lib/api.ts:105`）
- **现有的 `/api/posts`** — 用于拉取 archive 目录的笔记摘要（不重写）

## 数据源

### 后端：不新增端点

`/api/links/index` 已经返回了整库（包含 archive + inbox + literature + draft）的 `paths` 和 `outgoing`。前端在拿到 snapshot 后**自己**过滤出 `path.startsWith('archive/')` 的子集——后端是无状态的，前端做范围裁剪符合 nuvyn 现有约定（参考 `useScopeFilter`）。

### 前端数据形状

```ts
interface GraphNode {
  id: string              // = path (no .md, 例如 "archive/init")
  path: string            // 同 id，保留便于 openPost
  title: string           // 来自 PostSummary.title，没有则用 basename
  val: number             // 节点尺寸权重（按入度+出度计算）
  // 不需要 icon：参考项目的 emoji 来自 sidebar 的 icon 字段，nuvyn 笔记没有这个字段
}

interface GraphLink {
  source: string          // GraphNode.id
  target: string          // GraphNode.id
  // 不需要 kind: 参考项目为 sidebar 父子树边，nuvyn 的 [[wiki]] 都是同质边
}
```

### 节点筛选

从 link index 出发：
1. `archivePaths = paths.filter(p => p.startsWith('archive/'))` —— 节点候选集
2. 遍历 `outgoing`，只保留 `source ∈ archivePaths && target ∈ archivePaths && kind === 'wiki'` 的边
3. 节点的 `val` 按度数计算：center=`degree===0` 24px，leaf=`outDegree===0` 12px，中间=16px
4. 过滤后没有出边也没有入边的孤立节点仍然显示（archive 笔记可能是新写的、还没连上别条笔记）

不显示 inbox / literature 节点——它们不是"知识"（inbox 是 inbox，literature 是别人的东西）。这与参考项目"全 sidebar 展示"不同，是 nuvyn 的语义裁剪。

## 组件结构

### 新文件

- **`src/components/vault/KnowledgeGraph.vue`** — 图谱画布组件本身
- **`src/composables/vault/useGraphData.ts`** — 从 link index 推导 `{ nodes, links }` 的纯计算

### 修改文件

- **`src/components/vault/ActivityBar.vue`** — 新增第 4 个按钮 `graph`，扩展 `SidePanel` 类型
- **`src/composables/vault/useVaultLayout.ts`** — `SidePanel` 类型导入源需要扩展 `ActivePanel` 也接受 `'graph'`
- **`src/views/VaultView.vue`** — 在 `editor-area` 里多一个 `v-else-if="activePanel === 'graph'"` 分支渲染 `<KnowledgeGraph>`

### 不用动的部分

- 后端 0 改动（复用 `/api/links/index` + `/api/posts`）
- 路由 0 改动（vault 路径不变）
- 侧栏（FileTree / TagPanel / LinksPanel）0 改动
- AI 面板 0 改动
- StatusBar 0 改动

## 布局与交互

### VaultView 网格调整

现有网格在 `useVaultLayout.ts` 的 `vaultStyle` 计算里只有 4 列。graph 模式下 editor-area 不再是 .content（编辑/预览分屏），而是 KnowledgeGraph 组件。**不**改网格——`1fr` 列宽可以容纳任意内容，只在模板里把 `.content` 块改成 `<KnowledgeGraph v-else-if="activePanel === 'graph'" />`。

### KnowledgeGraph 组件

```vue
<template>
  <div class="kg-container" ref="containerRef" />
</template>
```

- `onMounted`：动态 `import('force-graph')`，调用 `forceGraph()(containerRef.value)`，灌入 `graphData`
- `onBeforeUnmount`：调用 graph instance 的 `_destroy` 方法（force-graph 原生 API，参见其 README），置空实例引用
- 监听 `useLinkIndex().value` 的变化：snapshot 变化时调 `graph.graphData(nextNodesLinks)`——这覆盖了用户编辑导致边集变化的情况
- `nodeCanvasObject` 回调：画圆 + emoji 标题文字。**用节点 title 第一个字**（不是 emoji——nuvyn 笔记没有 icon 字段；fallback 到 `📄`）
- `onNodeClick`：调 `useEditorTabs` 暴露的 `openPost(node.path)` + `selectPanel('files')` 关闭图谱并打开编辑器
- `onNodeDragEnd`：force-graph 内置支持，拖完后节点自动 `fx/fy` 固定（force-graph 默认行为）
- `zoomToFit(400, 50)` 1s 后调一次，让初始画布居中

### force-graph 主题适配

force-graph 的画布是 canvas 元素，主题变量在 CSS 里通过 `var(--ngm-*)` 调不到。组件用一个 computed 颜色调色板，订阅 `useTheme()`：

```ts
const colors = computed(() => {
  const dark = useTheme().theme.value === 'dark'
  return {
    bg: dark ? '#0A0E1A' : '#FAFAFA',
    nodeFill: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    nodeStroke: dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)',
    linkColor: dark ? 'rgba(140,180,255,0.35)' : 'rgba(70,100,180,0.30)',
    text: dark ? '#E2E8F0' : '#1F2937',
  }
})
```

`nodeCanvasObject` 和 `linkColor` 都用这个 computed 引用。force-graph 的 `width()` / `height()` 是基于父容器的，所以 onMounted + ResizeObserver 调一次 `graph.width(container.clientWidth).height(container.clientHeight)` 即可。

## 错误处理

| 场景 | 行为 |
|------|------|
| force-graph 动态 import 失败 | 容器内显示文字"图谱加载失败"，不抛错阻塞 vault |
| `/api/links/index` 网络失败 | 容器内显示"暂无图谱数据"，保留之前的 graph 实例（如果 mount 时已成功） |
| archive 没有任何笔记 | 容器内显示"还没有 archive 笔记，先去 inbox 写一条吧" |
| 用户在编辑器里保存导致链接变化 | `useLinkIndex()` 的 bus subscription 自动 refetch，computed 重新计算，graph.graphData() 增量更新 |
| 用户拖动节点后再次打开图谱 | force-graph 的 fx/fy 在 unmount 时被 force-graph 内部的 `_destroy` 清掉，下次 mount 重新居中 |

## 测试

### `src/composables/vault/__tests__/useGraphData.test.ts`（新建）

纯计算，无 DOM / 无 force-graph 依赖。覆盖：
- 节点是 archive 路径的子集
- 边只在 archive 内部 wiki 链接里产生
- 跨目录（archive → inbox）的链接不出现在图里
- 孤立节点（无入无出）仍出现在 nodes
- `val` 字段按度数计算正确
- link index 变化（paths 增减、outgoing 增减）能产生新结果

### `src/components/vault/__tests__/KnowledgeGraph.test.ts`（新建）

- mount 时调用 `forceGraph(...)` 一次（用 `vi.mock('force-graph')`）
- 收到的 `graphData` 包含 useGraphData 计算的结果
- unmount 时调用 force-graph 实例的 destroy 方法
- 模拟 link index 变化：computed 重算，graph.graphData() 被再次调用
- 节点点击：emit 一个 `open` 事件（让 VaultView 调 openPost + selectPanel）
- 主题切换：nodeCanvasObject 引用新的 colors

### 视觉测试

不写截图测试。参考项目也没写。canvas 渲染正确性由手测保证。

## 文件清单

### Create

- `src/composables/vault/useGraphData.ts`
- `src/composables/vault/__tests__/useGraphData.test.ts`
- `src/components/vault/KnowledgeGraph.vue`
- `src/components/vault/__tests__/KnowledgeGraph.test.ts`

### Modify

- `package.json` — `force-graph` 依赖
- `src/components/vault/ActivityBar.vue` — 加 graph 按钮，扩 `SidePanel` 类型
- `src/composables/vault/useVaultLayout.ts` — `ActivePanel` 接受 `'graph'`，类型在 `serializer.read` 里也要认
- `src/views/VaultView.vue` — editor-area 加 graph 分支

## 设计权衡

| 选择 | 原因 |
|------|------|
| 复用 `/api/links/index` 不过滤在后端 | 后端保持无状态、单一职责；过滤是前端的视图层职责 |
| 节点 emoji 用 title 第一个字 | 笔记没有 icon 字段，title 第一字（中文一般是名词）有视觉指示性；fallback 📄 |
| 不在 graph 模式下保留 editor 缩略 | 用户明确选择"看图谱"——再混一个迷你编辑器反而割裂 |
| 点击节点**关闭图谱并打开**而不是只在图内高亮 | 用户操作意图明确是"去看这条笔记"；高亮适合无目标浏览但和编辑器分离感强 |
| force-graph 原生版本而非 vue2-force-graph | vue2-force-graph 停止维护；原生 + onMounted 集成成本与 vue2-force-graph 等价 |
| canvas 而非 svg | force-graph 的设计就是 canvas（1k+ 节点性能好），改 svg 是 YAGNI |
| 边只取 wiki | `[[wiki]]` 是 nuvyn 知识库的关系表达；`.md` 链接是普通 markdown 链接，语义上不是"知识连接" |
