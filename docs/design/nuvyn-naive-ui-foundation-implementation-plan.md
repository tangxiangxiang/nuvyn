# Nuvyn — Naive UI Foundation Implementation Plan

**日期：** 2026-09-07
**模块：** Global UI Foundation
**状态：** Implementation Review: PASS — Ready for Phase 0; Icon Foundation Amendment: Accepted
**类型：** Architecture / UI Foundation Refactor
**优先级：** P1
**基线：** main @ 9c65f7aa84c45fba33fd7b586ce042f57366d14c

---

## 1. 实施目标

本计划实现已经冻结的产品方向：

```text
Naive UI
=
基础交互组件层

Nuvyn
=
产品视觉 + 信息架构 + Domain Layout
```

目标不是：

```text
把 <button> 换成 <NButton>
```

而是最终建立：

```text
Nuvyn Semantic Tokens
        ↓
Nuvyn Theme Authority
        ↓
Naive UI Theme Mapping
        ↓
Naive UI Interaction Foundation
        ↓
Nuvyn Domain Components
        ↓
Note / Diary / Ledger / Vault
```

整个实施必须保持：

```text
业务语义不变
Route 不变
Store 不变
API 不变
Server 不变
Workspace IA 不变
```

---

# 2. Starting Baseline

Authoritative starting HEAD：

```text
9c65f7aa84c45fba33fd7b586ce042f57366d14c
```

当前基础设施：

```text
Vue          ^3.5.34
Vite         ^8.0.12
TypeScript   ~6.0.2
Vitest       ^4.1.8
Playwright   ^1.61.1
Naive UI     not installed; Phase 0 candidate 2.45.3 (exact pin)
@vicons/tabler not installed; Phase 0 candidate 0.13.0 (exact pin)
```

这里记录的 `9c65f7a` 是 Icon Foundation Design Amendment 的设计基线，不是未来
Phase 0 的执行基线。Phase 0 开始前必须重新读取当前 `main` HEAD，并把该 SHA 作为
本次 spike 的 authoritative starting baseline；不得假定未来仍从旧 SHA 开始。

本 amendment 不安装 dependency、不修改 `package.json` 或 `package-lock.json`，也不
创建或运行 compatibility fixture。Phase 0 必须先 exact-pin
`naive-ui@2.45.3` 和 `@vicons/tabler@0.13.0`，再创建 test-only evidence；manifest、
lockfile 和 fixture 都是 Phase 0 实施结果的一部分，而不是 Phase 0 通过后的步骤。
Phase 1 消费 Phase 0 提交并验证的 exact pin，不重新安装或重新选择版本。

---

# 3. 总体实施原则

## 3.1 Incremental Migration

禁止：

```text
一个 commit
→ 全项目 Naive UI 化
```

必须：

```text
Foundation
→ Feedback / Overlay
→ Primitive
→ Shared Chrome
→ Diary
→ Ledger
→ Vault / Note
→ Cleanup
```

每个阶段：

```text
独立可运行
独立可测试
独立可 review
独立可回滚
```

---

## 3.2 Preserve Before Improve

迁移优先级：

```text
1. Behavior preservation
2. Accessibility preservation
3. Theme consistency
4. Visual consistency
5. Visual refinement
```

不是：

```text
1. Naive UI 默认样式
2. 再想办法修回产品样子
```

---

## 3.3 Nuvyn Token 是唯一 Design Source

不得形成：

```text
Nuvyn CSS colors
+
Naive TS colors
+
Workspace local colors
```

三套 authority。

最终必须是：

```text
Nuvyn semantic tokens
            ↓
        全部消费方
```

---

# 4. Phase 0 — Architecture Spike

## 4.1 目标

Phase 0 不做正式 Workspace migration。

只验证 compatibility gates，不做正式 Workspace migration：

```text
1. Naive UI 2.45.3 与当前 Vue / TS / Vite 是否兼容
2. themeOverrides 是否能可靠引用 CSS custom properties
3. Light / Dark runtime switch 是否正确
4. Provider / Teleport / Overlay 是否与现有 App Shell 共存
5. 全局 focus-visible 是否与 Naive focus style 冲突
6. Locale / DateLocale bridge 是否与 `useI18n().locale` 同步
7. Bundle / test / build 是否在可接受范围
8. `NIcon + @vicons/tabler` 是否满足 render、currentColor、size、alignment 和 a11y
9. 是否可以冻结单一 approved functional icon family
```

---

## 4.2 Spike dependency

Phase 0 从记录 baseline 开始，exact-pin candidate dependency 和建立可复现的
test-only evidence 都属于 Phase 0 的正式实施步骤。正确的 lifecycle 是：

```text
Phase 0 START
    ↓
resolve current main HEAD and record starting baseline
    ↓
record current production bundle baseline
    ↓
exact-pin candidate dependencies
    ↓
update package-lock.json
    ↓
create test-only compatibility fixture / tests
    ↓
npm ci reproducibility check
    ↓
compatibility gates and full validation
    ↓
commit + push
    ↓
exact-head CI
    ↓
PASS / FAIL
```

执行：

```bash
npm install --save-exact naive-ui@2.45.3 @vicons/tabler@0.13.0
```

禁止：

```json
"naive-ui": "^2.45.3",
"@vicons/tabler": "^0.13.0"
```

Phase 0 实施时，`package.json`、`package-lock.json`、test-only fixture 和
compatibility tests 一起形成可提交、可回滚、可由 `npm ci` 确定性复现的 spike
evidence。若 Phase 0 失败，必须通过 revert Phase 0 commit(s) 回到没有 Naive UI /
Vicons dependency 的 stable baseline；不得以未写入 manifest / lockfile 的临时安装
成功作为通过条件。

Phase 0 的状态必须区分为：

```text
implementation commit 已完成、exact-head CI 尚未结束
→ Phase 0 IMPLEMENTED / AWAITING EXACT-HEAD CI

local gates PASS + exact-head CI PASS
→ Phase 0 PASS

任一 blocking compatibility failure
→ Phase 0 FAIL，revert Phase 0 commit(s)
```

本 amendment 不执行上述命令、不创建 fixture，也不执行 Phase 0；当前状态仍为
Pending / Ready to Start。

---

## 4.3 Theme Spike

建立临时最小 demo：

```text
NConfigProvider
NButton
NInput
NSelect
NDialogProvider
NMessageProvider
NNotificationProvider
NIcon + Tabler Search / Plus / Calendar
```

验证：

```text
Light
↓
切换
↓
Dark
↓
切换
↓
Light
```

过程中不得：

```text
重新 mount App
刷新页面
产生第二套 theme state
```

## 4.4 Icon Foundation Spike

Functional icon compatibility 与 Naive UI provider compatibility 应在同一个
test-only fixture 中验证：

```vue
<NButton>
  <template #icon>
    <NIcon aria-hidden="true">
      <Search />
    </NIcon>
  </template>
  Search
</NButton>
```

Phase 0 临时 fixture 建议使用：

```text
src/ui/__tests__/fixtures/NaiveUiFoundationSpike.vue
src/ui/__tests__/naive-ui-foundation-spike.test.ts
```

必须通过：

```text
Tabler SVG renders on its 24×24 outline grid
NIcon size aligns with NButton icon slot and standalone usage
Tabler currentColor remains inherited from the consuming control
icon-only control has an accessible name
decorative icon is aria-hidden
no Nuvyn SVG path is copied into the fixture
Vue SSR renderToString compatibility
```

fixture 应以 `@vicons/tabler@0.13.0` 的真实 TypeScript exports 为准，至少覆盖
Search、Settings、Plus、Calendar、Trash/Delete equivalent、Folder、File/Document
equivalent、Chevron、Check、Alert/Warning；不得在未验证 export 前把猜测名称写入
production code。本 amendment 不执行该 fixture 或验证。fixture 的创建本身属于 Phase 0
实施步骤，不能推迟到 Phase 0 PASS 之后。

## 4.5 Locale / DateLocale Spike

现有 `useI18n().locale`（`zh | en`）是唯一 application locale authority。Naive UI locale 与 date locale 只能作为 consumer，不得创建第二套 locale state。

验证 runtime：

```text
zh → en → zh
```

并确认 Naive primitive UI、DatePicker date locale、Pagination、Empty、built-in messages 与现有 Nuvyn copy 同步；切换不得重新 mount App 或刷新页面。

固定映射：

```text
zh → locale = zhCN, dateLocale = dateZhCN
en → locale = enUS, dateLocale = dateEnUS
```

---

# 5. CSS Variable Theme Spike

验证类似：

```ts
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: 'var(--nuvyn-accent)',
    textColor1: 'var(--nuvyn-text-1)',
    bodyColor: 'var(--nuvyn-bg)',
    borderColor: 'var(--nuvyn-border)',
  },
}
```

是否在：

```text
Button
Input
Select
Dialog
Message
```

真实生效。

如果全部可靠：

```text
CSS semantic token
=
single source of truth
```

如果存在 Naive UI theme property 无法可靠消费 CSS `var()`：

不得立刻建立一整套 TS theme。

先记录：

```text
具体哪个 property
为什么失败
是否只需局部 override
```

Phase 0 同时记录 theme mapping 的实际边界：Naive UI 部分派生颜色字段可能交给
`seemly` 解析，不能直接接收 CSS `var()`；raw surface fields 可以直接消费 CSS
custom properties。Implementation Plan 只允许为前者保留最小、受控且可追溯的 TS
color mirror，不得把它扩展成第二套 Nuvyn token authority。本 amendment 不执行
该验证。

---

# 6. DatePicker Spike — Blocking Gate

这是 Phase 0 最重要的 domain compatibility test 之一。

Naive UI DatePicker 的用户交互可以迁移，但：

```text
Naive DatePicker
≠
Nuvyn 时间 authority
```

特别是 Ledger。

Ledger 使用：

```text
YYYY-MM-DD calendar date
+
Ledger timezone
+
Server authority
```

不得把：

```text
Browser-local JS timestamp
```

偷偷变成 Ledger date authority。

Naive UI 的 [DatePicker timezone issue search](https://github.com/tusen-ai/naive-ui/issues?q=DatePicker%20timezone) 表明不能假设组件本身会替 Nuvyn 正确解决领域时区语义。

Phase 0 必须验证：

```text
Asia/Shanghai Ledger
+
America/Los_Angeles Browser
```

这种跨 timezone 场景。

### Gate

如果不能安全得到：

```text
selected calendar date
→ YYYY-MM-DD
```

而不经过 browser-local date interpretation，

则：

**Ledger 暂时保留 native `<input type="date">`。**

这不是 Epic failure。

PRD 冻结的是：

> Naive UI 负责 DatePicker primitive where suitable。

不是：

> 所有 date input 必须不计代价替换。

---

# 7. Focus Spike

当前 Nuvyn 有全局：

```css
:focus-visible
```

策略。

Naive UI 自己也提供 focus state。

Phase 0 要检查：

```text
NButton
NInput
NSelect
NCheckbox
NSwitch
NDatePicker
```

是否出现：

```text
Naive focus ring
+
Nuvyn outline
```

双重 focus。

最终 authority：

```text
Naive primitives
→ Naive focus presentation

Native / Nuvyn domain controls
→ Nuvyn global focus-visible
```

不要通过：

```css
[class*="n-"] {
  outline: none;
}
```

这种宽泛 hack 解决。

必须根据实际 rendered focus target 定义最小 selector boundary。

---

# 8. Teleport / Overlay Spike

至少验证：

```text
普通页面
Ledger
Vault
Auth
```

中的：

```text
Dialog
Message
Dropdown
Popover
```

关注：

```text
z-index
Navbar
body scroll
Vault body lock
Dark Theme
Teleport theme
ESC
focus return
```

当前 App 明确存在：

```text
vault-mode body lock
ledger-mode scrollbar behavior
```

所以 overlay 不得破坏现有 document lifecycle。

---

# 9. Bundle Baseline

Phase 0 开始前记录 Baseline：

```text
npm run build
```

得到：

```text
entry JS
largest async chunk
total JS bytes
total CSS bytes
```

Phase 0 exact-pinned dependency + compatibility test state 再次比较。由于 Phase 0 不做 production import，单纯依赖增加不应显著改变 production bundle；这是 Phase 0 gate。Phase 1 首次引入 production provider / theme imports 后，再记录一次真实 production bundle delta。

不新增：

```text
webpack-bundle-analyzer
rollup-visualizer
```

除非已有工具不足。

第一轮只使用 Vite build output + filesystem size。

---

# 10. Phase 0 Exit Criteria

Phase 0 的 implementation commit 完成并推送后，在 exact-head CI 结束前只能标记为：

```text
Phase 0 IMPLEMENTED / AWAITING EXACT-HEAD CI
```

只有 local gates 与 exact-head CI 全部通过，才能标记为 `Phase 0: PASS`。任一
blocking compatibility failure 都标记为 `Phase 0: FAIL`，并按 4.2 节 revert Phase 0
commit(s)。

Phase 0 是 exact-head reproducible gate。PASS 必须满足：

```text
package.json exact pin PASS
package-lock deterministic PASS
npm ci PASS
Vue compatibility PASS
TypeScript PASS
Vite build PASS
Vitest mount PASS
CSS token mapping PASS
Light/Dark PASS
Locale/DateLocale PASS
Provider PASS
Teleport PASS
Focus strategy identified
DatePicker Ledger strategy identified
NIcon + Tabler render PASS
Approved single icon family PASS
Icon currentColor / size / alignment / a11y PASS
CSS var safe-field mapping PASS
Derived-color TS mirror boundary documented PASS
Vue SSR renderToString PASS
Bundle impact recorded
exact-head CI PASS
```

任何一个 blocking compatibility failure：

```text
停止 Phase 1
```

不得边迁移边补架构。

---

# 11. Phase 1 — UI Foundation

Phase 1 将消费 Phase 0 提交并验证的 exact-pinned
`naive-ui@2.45.3` 与 `@vicons/tabler` dependency；不得在 Phase 1 重复安装或重新
选择版本。本 amendment 尚未执行 Phase 0。

本 amendment 将 Functional icon foundation 冻结为：

```text
NIcon
  ↓
@vicons/tabler
```

Phase 1 不安装第二个 icon family，不复制 SVG path，不把 legacy `icons.ts`
扩展为新的 functional icon source。System font 仍由 Nuvyn 控制；brand / generated
SVG 不属于 functional icon foundation。

Phase 0 的 implementation candidate 仍为 `@vicons/tabler@0.13.0` exact pin；该版本
属于实现与兼容性验证，不属于永久的产品架构名称。

Naive UI 本身不要求额外 CSS import；依赖只通过按需 import 使用。

---

# 12. 新增目录结构

建立：

```text
src/ui/
├── NuvynUiRoot.vue
├── naiveTheme.ts
├── tokens.css
└── __tests__/
    ├── NuvynUiRoot.test.ts
    └── naiveTheme.test.ts
```

后续如果 Overlay Bridge 确有必要，再增加：

```text
src/ui/runtime/
```

不要预创建空 architecture。

---

# 13. `tokens.css`

将 semantic design tokens 集中到：

```text
src/ui/tokens.css
```

Phase 1 必须在同一 commit boundary 内先把 `src/style.css` 中基础 semantic palette 的真实值移动到 `tokens.css`，再定义 aliases，并删除 `style.css` 中冲突的 hard-coded `:root`、dark-mode 和 alias 定义。`tokens.css` 是 semantic value authority，`style.css` 只能消费变量；不得把 Phase 1 扩成 `--vs-*`、`--ledger-*`、Markdown 或 editor token 的全量重写。

第一版：

```css
:root {
  --nuvyn-bg: ...;
  --nuvyn-surface-1: ...;
  --nuvyn-surface-2: ...;

  --nuvyn-text-1: ...;
  --nuvyn-text-2: ...;
  --nuvyn-text-3: ...;

  --nuvyn-border: ...;
  --nuvyn-divider: ...;

  --nuvyn-accent: ...;
  --nuvyn-accent-hover: ...;
  --nuvyn-accent-pressed: ...;

  --nuvyn-positive: ...;
  --nuvyn-negative: ...;
  --nuvyn-warning: ...;
  --nuvyn-info: ...;

  --nuvyn-radius-sm: ...;
  --nuvyn-radius-md: ...;
  --nuvyn-radius-lg: ...;

  --nuvyn-space-1: ...;
  ...
}
```

数值应优先从当前 Nuvyn 已经验证过的视觉语言提取。

不要重新发明品牌配色；数值优先从当前 Nuvyn 已验证的视觉语言提取。

---

# 14. Legacy Aliases

Phase 1 保留：

```css
--bg: var(--nuvyn-bg);
--bg-soft: var(--nuvyn-surface-1);

--text-h: var(--nuvyn-text-1);
--text: var(--nuvyn-text-2);
--text-muted: var(--nuvyn-text-3);

--border: var(--nuvyn-border);

--accent: var(--nuvyn-accent);
--accent-hover: var(--nuvyn-accent-hover);
```

当前大量 CSS 已依赖旧变量，所以 Phase 1 绝不进行全文件 rename。Aliases 与 semantic values 必须在 `tokens.css` 中共同拥有，`style.css` 不得再次定义同名 alias。

---

# 15. Dark Mode Token Authority

从 `style.css` 中逐步抽离：

```text
:root light token
prefers-color-scheme dark token
[data-theme='light']
[data-theme='dark']
```

真正颜色定义最终归：

```text
tokens.css
```

`style.css` 只消费。

主题 cascade precedence 固定为：默认 Light tokens → 无显式持久化主题时的 `prefers-color-scheme` fallback → `[data-theme='light']` / `[data-theme='dark']` explicit application state。显式 state 优先于 OS preference；storage key 固定为 `nuvyn.theme`。

但 Phase 1 只移动基础 semantic token。

Vault 特有：

```text
--vs-*
```

Ledger scoped：

```text
--ledger-*
```

暂不重构。

---

# 16. `useTheme()` 保持不变

继续保留：

```text
storage key = nuvyn.theme
light / dark
data-theme
OS fallback
```

现有实现已经是 theme authority。

`index.html` 首屏 boot script 同样保留。

它现在会在 Vue mount 前写入 `data-theme`，用于避免首屏主题闪烁。

Phase 1 不重写这套 boot mechanism。

## 16.1 `useI18n()` Locale Bridge

`useI18n().locale`（`zh | en`）是唯一 locale authority。NuvynUiRoot 中派生：

```ts
const { locale } = useI18n()

const naiveLocale = computed(() =>
  locale.value === 'zh' ? zhCN : enUS,
)

const naiveDateLocale = computed(() =>
  locale.value === 'zh' ? dateZhCN : dateEnUS,
)
```

runtime `zh → en → zh` 必须同步 Naive UI locale 与 date locale，不重新 mount App、不刷新页面。

---

# 17. `naiveTheme.ts`

职责只有：

```text
Nuvyn token
→ Naive token
```

例如：

```ts
export const nuvynNaiveThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: 'var(--nuvyn-accent)',
    primaryColorHover: 'var(--nuvyn-accent-hover)',
    primaryColorPressed: 'var(--nuvyn-accent-pressed)',

    textColor1: 'var(--nuvyn-text-1)',
    textColor2: 'var(--nuvyn-text-2)',
    textColor3: 'var(--nuvyn-text-3)',

    bodyColor: 'var(--nuvyn-bg)',
    cardColor: 'var(--nuvyn-surface-1)',
    modalColor: 'var(--nuvyn-surface-1)',

    borderColor: 'var(--nuvyn-border)',
    dividerColor: 'var(--nuvyn-divider)',

    borderRadius: 'var(--nuvyn-radius-md)',
  },
}
```

只 override 真正需要统一的 common / component variables；CSS custom properties 可用时优先直接引用 `var(--nuvyn-*)`，不得建立第二套长期 TS palette。

不要一开始复制 Naive UI 几百个 theme variable。

---

# 18. `NuvynUiRoot.vue`

推荐结构：

```vue
<script setup lang="ts">
import { computed } from 'vue'
import {
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  zhCN,
} from 'naive-ui'
import App from '../App.vue'
import { useI18n } from '../composables/useI18n'
import { useTheme } from '../composables/useTheme'
import { nuvynNaiveThemeOverrides } from './naiveTheme'

const { theme } = useTheme()
const { locale } = useI18n()

const naiveTheme = computed(() =>
  theme.value === 'dark' ? darkTheme : null
)

const naiveLocale = computed(() =>
  locale.value === 'zh' ? zhCN : enUS,
)

const naiveDateLocale = computed(() =>
  locale.value === 'zh' ? dateZhCN : dateEnUS,
)
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :theme-overrides="nuvynNaiveThemeOverrides"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
  >
    <NDialogProvider>
      <NMessageProvider>
        <NNotificationProvider>
          <App />
        </NNotificationProvider>
      </NMessageProvider>
    </NDialogProvider>
  </NConfigProvider>
</template>
```

具体 nesting 可以依据 Naive UI API 约束微调，但：

```text
App 必须位于 Provider 下方
```

是冻结要求。

第一版保留 `NNotificationProvider` 以支持未来 richer notification，但 transient `useToast()` 默认由 NMessage 承担；Provider 存在不等于所有 toast 都迁成 Notification。

---

# 19. `main.ts`

由当前：

```ts
createApp(App)
  .use(router)
  .mount('#app')
```

改为：

```ts
createApp(NuvynUiRoot)
  .use(router)
  .mount('#app')
```

当前入口非常轻量，应继续保持这个特性。

同时 import：

```ts
import './ui/tokens.css'
import './style.css'
```

顺序：

```text
tokens
↓
global styles
```

---

# 20. Phase 1 Tests

新增测试至少覆盖：

### Theme

```text
light → Naive default light theme
dark → darkTheme
runtime switch 不 remount App
locale `zh → en → zh` 同步 `locale` 与 `date-locale`
```

### Tokens

验证：

```text
核心 semantic token 存在
legacy alias 存在
同名 alias 不在 `style.css` 重复定义
```

不要 snapshot 整个 CSS 文件。

### Root

验证：

```text
App 位于 provider tree
Router 继续工作
```

---

# 21. Phase 1 Exit Criteria

```text
Naive dependency pinned
NuvynUiRoot installed
Theme bridge works
Tokens established
Legacy CSS still works
App routes unchanged
No visible workspace redesign
Light PASS
Dark PASS
Unit PASS
Typecheck PASS
Build PASS
E2E PASS
Locale / DateLocale PASS
Visual Acceptance Gate PASS
Exact-head CI PASS
Icon Foundation policy documented; no new handwritten generic functional SVG
Approved Tabler family only; semantic distinctions preserved
Icon-only controls have accessible names; decorative icons are hidden
Compact / default icon alignment PASS
No unexplained icon bundle growth
Legacy consumers remain only in their documented migration phase
```

---

# 22. Phase 2 — Feedback / Overlay

目标：

```text
Toast
Confirm
Prompt
```

底层切换到 Naive UI。

但业务 API：

```text
useToast()
useConfirm()
usePrompt()
```

必须保留。

Host Bridge 是唯一 canonical architecture：

```text
Business Components
        ↓
useToast / useConfirm / usePrompt
(provider-independent Nuvyn semantic APIs)
        ↓
ToastHost / ConfirmHost / PromptHost
(or clearly renamed equivalent Hosts)
        ↓
Naive UI provider hooks / components
```

Naive UI 的 `useMessage`、`useDialog`、`useNotification` 只允许在 Provider descendants / Host bridge 内部调用；业务组件不需要处于 Naive UI injection context。

Host Bridge 是 provider-aware 的 domain adapter，不是绕过 Provider 的 global singleton。

---

# 23. Toast Migration

当前 `useToast()` API：

```text
info
success
error
dismiss
ttl
```

且当前由 reactive queue + `ToastHost` 渲染。

迁移时禁止全项目：

```text
useToast()
→
useMessage()
```

### Frozen adapter-first strategy

保留：

```text
useToast
```

将：

```text
ToastHost
```

改造成：

```text
Naive Message bridge
```

要求保持：

```text
TTL
类型
dismiss
调用时机
```

等价。

短反馈 `info` / `success` / `warning` / `error` 默认映射到 NMessage；只有标题、长生命周期或 richer content 才使用 NNotification。若 Naive duration 与 Nuvyn `ttl` 单位不同，由 Adapter 做 conversion。不得让业务层直接从 `useToast()` 改写为 `useMessage()`。

---

# 24. Confirm Migration

当前 Confirm 支持：

```text
queue
confirm
confirmCancellable
destructive
custom labels
detail
```

并且 cancellation 是真实业务 contract。

迁移后必须继续支持：

```ts
const { promise, cancel } = confirmCancellable(...)
```

不能因为 `NDialog` imperative API 简单，就丢弃 cancellation。

实现固定为：

```text
useConfirm semantics
        ↓
Confirm Naive Adapter
        ↓
NDialog
```

Adapter 负责：

```text
queue
destroy dialog
resolve false on cancel
double settle protection
```

`cancel()` 必须主动 destroy 对应 Naive dialog，并 resolve `false`；不能只从 queue 删除而留下可见 dialog。必须保留 safe cancel focus、ESC cancel、focus restore，以及 destructive confirm 不默认 focus 危险 action 的 observable behavior。

---

# 25. Prompt Migration

当前 Prompt 支持：

```text
title
placeholder
initial
actionLabel
actionTitle
async transform
```

迁移后保持 API。

推荐实现：

```text
NModal / NDialog
+
NInput
+
NButton
```

而不是寻找一个不存在的“一键 prompt API”。

`transform()` 必须继续支持 async。

提交期间：

```text
busy
double submit
transform error
cancel
ESC
```

都需要测试。

如果 `transform` throws / rejects：Prompt 保持打开，busy 恢复 `false`，不得产生 unhandled rejection 或 double settlement。除非已有 caller 语义，不新增产品级 error copy；Host 可捕获错误并允许继续编辑 / 重试。

---

# 26. Phase 2 删除策略

Phase 2 完成后：

如果：

```text
ToastHost / ConfirmHost / PromptHost
```

只是名称仍存在，但内部已经成为正式 adapter，

允许暂时保留。

不要为了“文件消失”而把逻辑塞进奇怪 singleton。

Cleanup Phase 再决定是否删除这些 Host。

---

# 27. Phase 2 Tests

重点覆盖：

```text
Toast success/info/error
TTL
manual dismiss

Confirm confirm
Confirm cancel
Confirm destructive
Confirm cancellable.cancel()
queued confirms
ESC

Prompt initial value
Prompt submit
Prompt cancel
async transform
busy
double submit
```

以及：

```text
focus enters overlay
focus leaves overlay correctly
keyboard works
```

这些测试应优先断言 role、accessible name、用户可见 label 或必要的 `data-testid`，而不是 `.btn`、`.confirm-actions`、`.n-dialog`、`.n-button` 等 implementation class。

---

# 28. Phase 3 — Primitive Foundation

先做完整 inventory：

```bash
rg -n '<button\b' src --glob '*.vue'
rg -n '<input\b' src --glob '*.vue'
rg -n '<textarea\b' src --glob '*.vue'
rg -n '<select\b' src --glob '*.vue'
```

并分类：

```text
Shared
Auth
Settings
Diary
Ledger
Vault
Note
Domain-specialized
```

inventory 必须同时记录每个 control 的：current density、target density、reason / exception、keyboard / focus contract。Nuvyn 只允许两档 canonical density：`compact → Naive small`，`default → Naive medium / library default equivalent`；`large` 仅在明确产品强调场景按需使用。不要搜索到一个就机械替换一个。

---

# 29. Primitive Canonical Mapping

默认 mapping：

```text
button
→ NButton

input text
→ NInput

textarea
→ NInput type="textarea"

select
→ NSelect

checkbox
→ NCheckbox

radio
→ NRadio / NRadioGroup

toggle
→ NSwitch

simple date input
→ NDatePicker
```

默认前提是 domain semantics 可保持。Naive UI 是 primitive 默认 authority，但不是绝对强制替换 authority；若 replacement 无法保持 existing domain semantics、timezone / calendar semantics、accessibility、browser / platform behavior 或 lifecycle guarantees，允许保留现有 primitive。

每个 exception 必须记录 concrete reason、保持 domain behavior、保留测试，并在 Phase Final Report 标记；exception 不得扩散成重新自研全部 primitives。

control size 统一按：

```text
compact  → Naive small
default  → Naive medium / library default equivalent
```

`compact` 用于 Navbar、compact workspace chrome、dense inline toolbar 和 small auxiliary actions；`default` 用于 forms、dialogs、settings、Ledger record forms、Diary access forms 以及普通 primary / secondary actions。

前提：

```text
domain semantics 可保持
```

---

# 30. 不创建 `DButton / DInput`

禁止：

```text
src/ui/DButton.vue
src/ui/DInput.vue
src/ui/DSelect.vue
```

除非后续真实出现稳定 Nuvyn domain semantics。

普通页面直接：

```ts
import { NButton, NInput } from 'naive-ui'
```

---

# 31. Phase 3 Scope

Phase 3 只迁移：

```text
Shared / low-risk primitives
```

Workspace specific controls 留给对应 Workspace Phase。

否则 Phase 3 会重新变成 Big Bang。

---

# 32. Phase 4 — Shared Chrome

范围：

```text
NavBar
Settings
Auth shared UI
global command surfaces
```

可以迁：

```text
Button
Dropdown
Tooltip
Select
Switch
Input
```

但保留：

```text
Navbar layout
note / diary / ledger IA
Route semantics
Workspace visual identity
```

---

# 33. NavBar 特别规则

禁止：

```text
整个 NavBar
→ NMenu
```

只有真正 menu-like 的部分：

```text
账号菜单
设置菜单
dropdown action list
```

才考虑 `NDropdown / NMenu`。

Workspace switch 继续是 Nuvyn product navigation。

---

# 34. Phase 5 — Diary

Diary 是第一个完整 Workspace validation target。

迁移：

```text
Dialog
Buttons
Inputs
Form
Password fields
Date controls where safe
Select
Loading
Empty state where appropriate
```

---

# 35. Diary Calendar 特别规则

项目当前仍依赖：

```text
v-calendar 3.1.2
```

Diary 的完整 Calendar 如果承担：

```text
日期浏览
日记导航
Workspace spatial layout
```

它属于：

> Domain UI

不是普通 DatePicker primitive。

因此：

**不得因为引入 NDatePicker 就顺便删除 v-calendar。**

是否未来替换是另一个独立需求。

---

# 36. Phase 6 — Ledger

这是保真迁移。

当前 Ledger Dashboard 视觉已被冻结。

不得调整：

```text
section order
metric layout
cashflow hierarchy
accounts layout
category bars
recent list
period summary
ECharts composition
```

只迁移：

```text
按钮
日期控件
Scope Select
Form
Dialog
Input
Empty / Loading primitive where appropriate
```

---

# 37. Ledger DatePicker Decision

待依据 Phase 0 结果决定。

### 如果 timezone-safe

则迁：

```text
native date
→ NDatePicker
```

但 Component Boundary 必须显式完成：

```text
Naive selected calendar date
        ↓
YYYY-MM-DD
        ↓
Ledger route
        ↓
Server
```

### 如果 timezone 不安全

保留：

```html
<input type="date">
```

并在 Final Report 标记：

```text
intentional domain exception
```

这是允许的。

无法证明 timezone-safe 时保留 native 是正式的 `intentional domain exception`，与 PRD 的 Primitive Exception Policy 一致。

---

# 38. Ledger Select

Scope：

```text
today
week
month
year
all
```

transport value 必须保持。

NSelect 只改变 UI。

不得改变：

```text
Store enum
URL
Server request
anchored semantics
```

---

# 39. Ledger ECharts

完全不迁。

只允许 theme color source 从：

```text
旧 CSS token
```

逐渐切到：

```text
Nuvyn semantic token
```

不得改：

```text
series
balance tooltip semantics
notMerge
ResizeObserver
six-month domain contract
```

---

# 40. Phase 7 — Vault / Note

最后执行。

第一步不是替换控件。

而是先做：

```text
interaction inventory
```

分类：

```text
FileTree
Tabs
Editor toolbar
Preview toolbar
Command Palette
Properties
History
Search
Context menu
Dialog
Tooltip
Keyboard controls
```

---

# 41. Vault High-Risk Boundary

明确不迁：

```text
File tree model
Pane lifecycle
Editor lifecycle
Document lifecycle
Scroll ownership
Command system
Monaco
Preview rendering
Markdown
```

Naive UI 只能进入它们内部的：

```text
Button
Dropdown
Tooltip
Input
Dialog
simple Tabs
```

---

# 42. Vault Tabs

只有确认现有 Tabs：

```text
不是 Route authority
不是 editor lifecycle authority
```

之后，才允许评估 `NTabs`。

如果现有 tab system 管理：

```text
opened documents
active document
editor preservation
```

则它是 domain component。

不能直接换 `NTabs`。

---

# 43. Note

Note 的 Markdown/content rendering：

```text
Markdown-it
Shiki
Mermaid
Markmap
KaTeX
Monaco
```

全部不动。

Naive UI 只进入：

```text
外围 controls
dialogs
menus
forms
feedback
```

---

# 44. Phase 8 — Cleanup

只有所有 Workspace migration 完成后才开始。

Cleanup inventory：

```text
legacy primitive CSS
old button classes
old input classes
obsolete modal CSS
Toast / Confirm / Prompt dead styles
duplicate focus rules
unused tokens
duplicate theme rules
dead helper components
```

---

# 45. `style.css` Cleanup

当前 `src/style.css` 规模约 170KB，是 Cleanup 重点之一。

但目标不是：

```text
把 170KB 压到某个 KPI 数字
```

目标：

```text
删除基础 primitive 重复样式
保留真正的 domain / layout / rendering CSS
```

例如这些仍可能合理存在：

```text
Vault pane
Ledger dashboard
Diary layout
Markdown
Preview
Editor
```

---

# 46. Legacy Token Removal

只有确认：

```bash
rg -- '--bg\b' src
rg -- '--text-h\b' src
rg -- '--accent\b' src
```

不存在需要保留的使用后，

才允许删除 compatibility aliases。

不是 Cleanup 一开始就删。

---

# 47. Test Architecture

整个 Epic 不要求把已有 unit test 全改成“测试 Naive UI 内部实现”。

测试重点仍然是：

```text
Nuvyn behavior
Nuvyn semantics
Nuvyn accessibility
```

避免：

```text
expect(component.classes()).toContain('n-button')
```

这种 library implementation assertion。

---

# 48. E2E Selector Policy

迁移后仍优先：

```text
role
aria-label
data-testid
user-visible text
```

禁止大量依赖：

```text
.n-button
.n-input
.n-base-selection
```

避免以后升级 Naive UI 时 E2E 全碎。

---

# 49. Visual Acceptance Gate

Visual Acceptance Gate 是正式 Phase gate，采用两级方式：

1. 已存在稳定 automated visual baseline 的 surface，必须 automated screenshot regression PASS；
2. 尚无 automated baseline 的 surface，必须人工验证 Desktop Light、Desktop Dark、Mobile Light、Mobile Dark。

每个 Phase Final Report 必须记录：

```text
reviewed surfaces
intentional visual changes
regressions found / fixed
remaining accepted differences
```

随着 Workspace migration，可逐步为 NavBar / Shared Chrome、Diary main surface、Ledger Dashboard、Vault critical chrome 建立 automated baseline；Phase 0 / Phase 1 不强制建立全站 screenshot suite。视觉变化必须说明原因，不得以“组件库默认就是这样”作为接受理由。

---

# 50. CI Gate

当前 CI 已覆盖：

```text
Node 24:
Ubuntu
macOS
Windows

Node 22:
Ubuntu

typecheck
build
unit + integration
browser E2E
Draft Store E2E
auth E2E
visual
docker smoke
```

每个 Phase 都必须通过现有 CI。

不得为了迁移降低 CI gate。

---

# 51. Validation Commands

每个实现 Phase 至少：

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:e2e:draft-store
npm run test:e2e:auth
npm run test:ui-foundation-spike
npm run lint:icons
git diff --check
git status --short
```

根据 Phase 再执行 focused tests。

CI 最终作为 exact-head authority。

---

# 52. Bundle Gate

每个主要 Phase：

```text
Foundation
Phase 0
Phase 1
Diary
Ledger
Vault
```

记录 build size，并按 Baseline、Phase 0、Phase 1、Diary、Ledger、Vault 六个 checkpoint 比较 entry JS、largest async chunk、total JS bytes 和 total CSS bytes。

禁止出现：

> 因为 tree shaking 应该有效，所以不测。

Naive UI 官方支持 tree-shaking；Nuvyn 仍必须验证自己的 import pattern。

---

# 53. Import Policy

推荐：

```ts
import {
  NButton,
  NInput,
  NSelect,
} from 'naive-ui'
```

依赖 bundler tree-shaking。

禁止：

```text
自制全组件 installer
全局注册所有 Naive component
```

除 Provider 外，普通组件按需 import。

Functional icon 的 canonical import：

```ts
import { NIcon } from 'naive-ui'
import { Search } from '@vicons/tabler'
```

页面不得直接复制 Tabler SVG path；不得从第二个 icon family import functional
glyph。

---

# 54. Nuvyn Functional Icon Foundation

Naive UI Foundation 的 Functional Icon Foundation 已冻结为：

```text
NIcon
  ↓
@vicons/tabler
```

必须：

```text
一个 approved functional icon family
NIcon 作为统一容器
Tabler component 作为 glyph
currentColor 由消费方继承
icon-only control 提供 accessible name
```

这是一套 One Functional Icon System：Nuvyn 负责 semantic choice 和产品组合，
`NIcon` 负责 presentation container，`@vicons/tabler` 负责通用 glyph。Tabler 是
唯一 canonical functional family；不得混入 Ionicons、Material、Fluent、Font
Awesome、Ant Design、Carbon、Lucide、Heroicons、`@tabler/icons-vue` 或其他
`@vicons/*` family。

禁止：

```text
新增 Nuvyn 手写 functional <svg>
直接复制 SVG path
引入第二个 @vicons family
混入 Material / Lucide / Heroicons / Ionicons
把 legacy icons.ts 当作新页面默认 icon source
```

迁移期间允许现有 `ICON_*` 与 Tabler 短期共存，但 legacy system 必须处于明确退出
路径；Phase 8 证明 zero consumer 后，只保留 Tabler functional icons 和已记录的
Brand / Domain exceptions。

例外：

```text
Nuvyn logo / brand artwork
Mermaid / Markmap / generated artwork
ECharts / chart SVG or canvas / third-party renderer graphics
Markdown / 用户内容 SVG
Phase 8 前尚未迁移的 legacy icons.ts
```

例外必须有 documented ownership；legacy icon preview、contract test 和
geometry lint 在 Phase 8 前继续用于迁移回归，不得用于阻止 approved Tabler
component。

---

# 55. Commit Strategy

每个 Phase 建议最少一个独立 commit。

推荐：

```text
chore(ui): add naive ui foundation

refactor(ui): migrate global feedback overlays

refactor(ui): standardize shared primitive controls

refactor(ui): migrate shared chrome controls

refactor(diary): adopt naive ui primitives

refactor(ledger): adopt naive ui primitives

refactor(vault): adopt naive ui interaction primitives

refactor(note): adopt naive ui interaction primitives

refactor(ui): remove legacy primitive styles
```

不要 amend 已 push history。

不要 force push。

---

# 56. 不建议一个 Phase 一个超大 Commit

例如 Ledger Phase 可以合理拆：

```text
refactor(ledger): migrate form controls
refactor(ledger): migrate overview period controls
```

前提：

每个 commit：

```text
buildable
testable
reviewable
```

禁止产生：

```text
commit A 页面坏掉
commit B 再修回来
```

---

# 57. Rollback Strategy

因为整个迁移是 incremental：

任意 Phase 出现严重 regression 时：

```text
revert current Phase commits
```

应该可以恢复上一 stable phase。

因此不得跨 Phase 同时改：

```text
UI Foundation
+
Store
+
Server
+
Domain
```

否则回滚边界失效。

---

# 58. Feature Flag

本计划默认：

**不引入 UI migration feature flag。**

理由：

双 UI runtime：

```text
legacy UI
+
Naive UI
```

长期并行会增加复杂度。

Incremental commit 本身已经提供 rollback boundary。

只有某一个高风险 Vault surface 确实无法独立切换时，再在 Implementation Review 单独批准局部 flag。

---

# 59. 主要风险

## Risk 1 — Default Naive Appearance 覆盖 Nuvyn

Mitigation：

```text
Nuvyn tokens
themeOverrides
visual baseline
不滥用 NCard / NLayout
```

---

## Risk 2 — DatePicker 时间语义污染

Mitigation：

```text
Phase 0 timezone spike
domain adapter
无法安全则保留 native
```

---

## Risk 3 — Overlay / Focus Regression

Mitigation：

```text
Provider spike
focus trap tests
ESC tests
Vault overlay tests
```

---

## Risk 4 — CSS 双体系越来越大

Mitigation：

```text
每个 Phase 明确 canonical scope
Cleanup debt ledger
最终 Phase 8 清理
```

---

## Risk 5 — Bundle 明显增长

Mitigation：

```text
exact dependency
tree-shaken imports
one approved @vicons family
tree-shaken icon imports
build-size checkpoints
```

---

## Risk 6 — Ledger 被重新设计

Mitigation：

```text
Ledger migration = visual preservation
Dashboard domain layout frozen
```

---

## Risk 7 — Vault 生命周期被 UI Library 改坏

Mitigation：

```text
Vault last
domain components remain custom
UI primitive only
```

---

# 60. Implementation Tracking

建议在 Implementation Plan 内维护：

```text
Phase | State | Start SHA | Final SHA | CI
```

例如：

```text
Phase | State | Scope
0     | Pending | exact dependency + reproducible compatibility validation
1     | Pending | production tokens/theme/provider/locale integration
2     | Pending | feedback / overlay Host Bridge
3     | Pending | shared low-risk primitives
4     | Pending | Shared Chrome controls
5     | Pending | Diary primitives
6     | Pending | Ledger primitives with visual preservation
7     | Pending | Vault / Note high-risk primitives
8     | Pending | legacy cleanup
```

不要另外建立复杂 project tracking 系统。

---

# 61. 每 Phase Final Report

每阶段实现报告必须至少包含：

```text
Starting HEAD
Final HEAD
Changed files
Behavior changed?
Visual changed?
Theme changed?
Locale changed?
Tests
Typecheck
Build
E2E
Exact-head CI
Bundle delta
Known exceptions
Visual Acceptance Gate result
Rollback boundary
```

---

# 62. 整个 Epic 最终 Gate

全部完成前验证：

```text
Note main path
Diary main path
Ledger main path
Vault main path
Auth
Settings
Theme switch
Overlay
Keyboard
Responsive
```

并确保：

```text
No P0
No P1
P2 有明确接受理由
```

---

# 63. Explicit Non-Changes

整个 Implementation Plan 禁止修改：

```text
Server architecture
Database schema
API protocol
Ledger financial semantics
Ledger historical semantics
Diary access semantics
Vault identity semantics
Document persistence
Router contract
Markdown pipeline
ECharts domain data
```

任何需要修改上述范围的发现：

```text
STOP
→ Implementation Review
```

不能现场“顺手解决”。

---

# 64. Implementation Review Checkpoints

以下 Frozen Implementation Decisions 均为 **ACCEPTED**：

1. `naive-ui@2.45.3` 作为 Phase 0 candidate exact-pin dependency；
2. CSS custom properties 作为 `themeOverrides` 首选 single source 方案；
3. `NuvynUiRoot → App` Provider hierarchy；
4. `useToast / useConfirm / usePrompt` public semantic API；
5. Ledger DatePicker 采用 safe-migrate / native-exception rule；
6. Diary full calendar / Vault domain tree 不属于 primitive migration；
7. Legacy aliases / primitive CSS cleanup 在 Phase 8 最终完成；
8. `useI18n().locale` 是唯一 locale authority；
9. Host Bridge 是 feedback / overlay canonical architecture；
10. `tokens.css` 是 global semantic token value authority，`style.css` 不得重新定义相同 alias value；
11. Visual Acceptance Gate 采用 automated where available + documented manual where unavailable；
12. Control Density 只冻结 `compact` / `default` 两级 canonical policy；
13. Functional Icon Foundation 使用 `NIcon + @vicons/tabler`，只允许一个
    approved family；legacy `icons.ts` 在迁移完成前保留为 migration-only source；
14. Naive UI 无法解析 CSS `var()` 的派生颜色字段只允许使用最小、可追溯的
    TS color mirror，不得形成第二套 token authority。
15. `@vicons/tabler@0.13.0` 是 Phase 0 的 exact-pinned implementation candidate；
    本 amendment 不安装或验证它。
16. 不新增手写 generic functional SVG，也不复制第三方 SVG path。
17. `icons.ts` 是迁移期 legacy source，不是未来 functional icon authority。
18. Brand artwork、generated / content SVG 属于各自 Nuvyn 或 renderer owner，
    不受 Functional Icon Foundation 的 glyph family 约束。
19. legacy icon infrastructure 只在证明 zero production consumers 后于 Phase 8
    清理。

---

# 65. Ready-for-Implementation 条件

只有以下全部通过：

```text
Product Review: Accepted
Implementation Review: PASS
Phase 0 gates 清晰
Icon Foundation Amendment: Accepted
NIcon + @vicons/tabler policy 清晰
Migration boundary 清晰
No blocking open question
```

文档现在满足上述条件，可以进入新的 Phase 0。当前文档状态：

```text
Implementation Review: PASS
Ready for Phase 0
P0: 0
P1: 0
P2: 0
Blocking Open Questions: 0
```

Phase 0 尚未执行；上述状态表示实现计划已获通过并可进入新的 Phase 0，不能解读为
dependency、fixture 或 production icon 已经落地。
