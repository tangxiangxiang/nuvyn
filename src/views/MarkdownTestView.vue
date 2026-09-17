<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import ReadingPane from '../components/vault/ReadingPane.vue'
import { createVaultContext } from '../composables/vault/context/createVaultContext'
import { createVaultFileChanges } from '../composables/vault/context/fileChanges'
import { provideVaultContext } from '../composables/vault/context/useVaultContext'
import type { Resolver } from '../lib/wikiLinks'

const fileChanges = createVaultFileChanges()
const tabs = ref([])
const activePath = ref<string | null>(null)
const vaultContext = createVaultContext({
  vaultId: ref(null),
  fileChanges,
  tabs,
  activePath,
  activeTab: computed(() => null),
  openPost: async () => {},
  // Visual specimen only — no real workspace, so the AI context is
  // explicitly none (Edit-10.2 fail-closed option).
  captureAiContext: () => ({ status: 'none' }),
})
provideVaultContext(vaultContext)
onBeforeUnmount(() => vaultContext.dispose())

const resolveLink: Resolver = (ref) => ({ target: ref === 'missing-note' ? null : ref })
const sample = `---
title: Markdown Style Specimen
---

这是一段用于视觉回归的中文正文，包含 ==高亮==、**粗体**、*强调*、\`inline code\` 与 [外部链接](https://example.com)。

## Emoji

Emoji: :smile: :rocket: :+1:

完成 :rocket:

Unknown :not_an_emoji:

Inline code: \`:smile:\`

\`\`\`text
:smile:
\`\`\`

Explicit link: [:smile:](https://example.com)

## Content hierarchy

### Lists and tasks

- 第一项
- 第二项
  - 嵌套内容
- [x] 已完成任务
- [ ] 待处理任务

> 同一份内容在 Preview 和 Reading 中应保持相同的视觉语义，只改变阅读密度和页面留白。

> [!NOTE]
> 强调用户在快速浏览文档时也不应忽略的重要信息。

> [!TIP]
> 有助于用户更顺利达成目标的建议性信息。

> [!IMPORTANT]
> 对用户达成目标至关重要的信息。

> [!WARNING]
> 因为可能存在风险，所以需要用户立即关注的关键内容。

> [!CAUTION]
> 行为可能带来的负面影响。

::: info 信息
这是 Info Container。
:::

::: tip 提示
这是 Tip Container。
:::

::: warning 警告
这是 Warning Container。
:::

::: danger 危险
这是 Danger Container。
:::

::: details 查看详情
这是 Details Container。
:::

### Mathematics

Inline: $E = mc^2$

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

#### Data table

| Surface | Semantic style | Density |
| --- | --- | --- |
| Preview | Shared | Compact |
| Reading | Shared | Comfortable |

### Links and media

[[archive/example|有效 Wiki Link]] · [[missing-note|失效 Wiki Link]]

![Nuvyn logo](/logo.svg)

---

### Code and diagrams

\`\`\`typescript
const consistent = preview.style === reading.style
\`\`\`

### Code line surfaces

\`\`\`typescript {1,3-5}
const metaFirst = 1
const metaSecond = 2
const metaThird = 3
const metaFourth = 4
const metaFifth = 5
const metaSixth = 6
\`\`\`

\`\`\`typescript
const sourceFirst = 1
const sourceHighlighted = 2 // [!code highlight]
const sourceThird = 3
\`\`\`

\`\`\`typescript {2,4}:line-numbers=20
const numberedFirst = 1
const numberedSecond = 2
const numberedThird = 3
const numberedFourth = 4
\`\`\`

\`\`\`mermaid
flowchart LR
  Markdown --> Preview
  Markdown --> Reading
\`\`\`

\`\`\`markmap
# Knowledge
## Mathematics $E = mc^2$
## Fraction $\\frac{a}{b}$
## Reading
\`\`\`

Term
: Definition list content

Footnote reference.[^1]

[^1]: Shared footnote styling.
`
</script>

<template>
  <div class="vault markdown-test-view">
    <div class="reading-slot">
      <ReadingPane :raw="sample" :resolver="resolveLink" />
    </div>
  </div>
</template>

<style scoped>
.markdown-test-view { min-height: calc(100vh - var(--navbar-h)); background: var(--vs-bg-1); }
.reading-slot { width: 100%; min-height: calc(100vh - var(--navbar-h)); }
.markdown-test-view :deep(.reading-pane),
.markdown-test-view :deep(.article) { height: auto; overflow: visible; }
</style>
