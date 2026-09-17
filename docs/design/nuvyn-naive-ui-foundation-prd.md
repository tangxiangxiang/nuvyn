# Nuvyn — Naive UI Foundation PRD

**日期：** 2026-09-07  
**模块：** Global UI Foundation  
**状态：** Product Review: Accepted; Icon Foundation Amendment: Accepted
**类型：** 架构重构 / UI Foundation  
**优先级：** P1  
**基线：** main @ 9c65f7aa84c45fba33fd7b586ce042f57366d14c

## 1. 产品概述

Nuvyn 当前的产品模型包含多个核心 Workspace。跨 Workspace 的产品定位与长期设计原则以 [Nuvyn — Personal OS](../product.md) 为准：

~~~
Note   → 我知道什么
Diary  → 我经历了什么
Ledger → 我的钱发生了什么
Board  → 我正在思考和构思什么
~~~

随着产品逐渐成熟，Nuvyn 已经不再处于“快速验证单个页面”的阶段，而开始面临一个跨 Workspace 的长期问题：

> 功能已经可用，但整体 UI 仍然缺乏统一、成熟、精致的产品感。

当前大量基础 UI 能力由 Nuvyn 自行实现或各 Workspace 独立实现，包括：

~~~
Button
Input
Textarea
Select
Date control
Dialog
Confirm
Prompt
Toast
Dropdown
Popover
Tabs
Loading
Empty State
Focus / Hover / Disabled states
Light / Dark adaptation
~~~

这种模式在早期开发阶段灵活且低依赖，但随着 Nuvyn 页面数量、Workspace 数量和交互复杂度增长，会不断增加：

~~~
视觉不一致
交互状态不一致
Accessibility 维护成本
Dark / Light 双主题维护成本
CSS 规模
重复实现
跨 Workspace 视觉漂移
~~~

本次重构引入 **Naive UI**，建立统一的 Nuvyn UI Foundation。

核心定位冻结为：

> **Naive UI = Nuvyn 的基础交互组件层**
>
> **Nuvyn = 自己的产品视觉、信息架构和业务布局层**

本次重构不是把 Nuvyn 改造成 Naive UI Demo，也不是用组件库重新定义 Note、Diary、Ledger、Vault 的产品形态。

Naive UI 是基础设施。

Nuvyn 仍然拥有自己的产品语言。

## 2. 背景与问题

当前 Nuvyn 的主要问题不是某一个 Button 或 Card “不好看”，而是 UI Foundation 缺少一个统一 authority。

不同区域可能独立决定：

~~~
padding
height
radius
border
font-size
hover
pressed
disabled
focus
loading
dialog spacing
form validation
popover behavior
dark mode treatment
~~~

单独看每个页面都可用，但跨页面比较时容易产生：

> 可用，但不精致。

本次重构要解决的不是单纯的 CSS 美化，而是建立一个长期可维护的 UI architecture。

## 3. 产品目标

本次项目完成后，Nuvyn 应具备统一的：

~~~
Design Token System
Theme Authority
Primitive Components
Overlay Infrastructure
Feedback Infrastructure
Form Infrastructure
Interaction States
Accessibility Baseline
Light / Dark behavior
~~~

并使：

~~~
Note
Diary
Ledger
Vault
Global Chrome
Settings
Authentication
~~~

能够共享同一个 UI Foundation。

最终目标：

~~~
功能一致
视觉一致
交互一致
主题一致
Accessibility 一致
代码维护方式一致
~~~

同时必须保留各 Workspace 自己的产品个性。

## 4. 非目标

本次重构不实现：

- 重做 Note 产品结构；
- 重做 Diary 信息架构；
- 重做 Ledger Dashboard；
- 重做 Vault 文件树业务模型；
- 重做 Router；
- 重做 API；
- 重做 Store；
- 修改 Server；
- 修改数据库；
- 修改 Markdown rendering；
- 替换 Shiki；
- 替换 Mermaid；
- 替换 Markmap；
- 替换 Monaco；
- 替换 ECharts；
- 引入 Tailwind；
- 引入第二套 UI Component Library；
- 重做 Nuvyn branding；
- 新增 Workspace；
- 新增 Ledger 功能；
- 新增 Diary 功能；
- 新增 Note 功能。

特别说明：

> 本项目不是“把所有 HTML tag 换成 Naive UI component”。

迁移必须具有明确的 UI Foundation 收益。

## 5. 核心架构原则

### 5.1 Naive UI 负责基础交互

以下能力原则上由 Naive UI 提供：

| 类型 | Authority |
| --- | --- |
| Button | Naive UI |
| Input | Naive UI |
| Textarea | Naive UI |
| Select | Naive UI |
| DatePicker | Naive UI |
| Checkbox | Naive UI |
| Radio | Naive UI |
| Switch | Naive UI |
| Form | Naive UI |
| Form Validation | Naive UI |
| Modal / Dialog | Naive UI |
| Drawer | Naive UI |
| Dropdown | Naive UI |
| Tooltip | Naive UI |
| Popover | Naive UI |
| Tabs | Naive UI |
| Pagination | Naive UI |
| Empty | Naive UI |
| Skeleton | Naive UI |
| Spin / Loading | Naive UI |
| Message | Naive UI |
| Notification | Naive UI |

### 5.1.1 Functional Icon Foundation

这是本次 Naive UI Foundation 的 Design Amendment。Functional icon 也属于基础
交互层；Nuvyn 不再把通用 glyph 当作第二套自绘 icon library 维护。目标架构冻结
为：

~~~
NIcon
  ↓
@vicons/tabler
~~~

`@vicons/tabler` 是产品架构层的 canonical functional icon family。Phase 0 的
implementation candidate 才使用 `@vicons/tabler@0.13.0` exact pin；版本升级属于
dependency upgrade 与 regression review，不改变产品层的 family authority。

冻结以下边界：

- Search、Settings、Plus、Delete、Edit、Save、Calendar、Folder、Document、History、
  Account、Wallet、Income、Expense、Transfer、Copy、Download、Upload、Chevron、
  Arrow、Close、Check、Warning、Info、Error、Theme，以及 toolbar、context-menu、
  AI action 等 functional glyph，迁移时从 approved `@vicons/tabler` family 的实际
  exports 中选择；
- Nuvyn functional icon 只允许使用 Tabler 这一套 family，禁止混入第二个
  `@vicons/*` family、Ionicons、Material、Fluent、Font Awesome、Ant Design、Carbon、
  Lucide、Heroicons、`@tabler/icons-vue` 或临时手写 SVG path；
- `NIcon` 是容器，Tabler component 是 glyph，颜色通过 `currentColor` 和消费方
  CSS 继承；
- Icon size / density 跟随 `NIcon`、Naive UI control 和 Nuvyn 的 `compact` / `default`
  policy，不重新建立 Nuvyn 16×16 geometry authority；状态颜色由消费方和 semantic
  tokens 决定，业务代码不得给普通 glyph 写任意 brand 或状态色；
- icon-only control 必须提供 `aria-label` 或等价 accessible name，带可见文字的
  control 使用该 label，纯 decorative icon 必须 `aria-hidden`；状态不能只靠颜色
  表达；
- Nuvyn logo、brand constellation、品牌装饰 SVG、产品插画、marketing artwork
  仍属于 Nuvyn-owned Brand Artwork；Mermaid、Markmap、ECharts、图表 canvas、
  Markdown / 用户内容 SVG 和第三方 renderer 内部图形由各自 pipeline 拥有；
- 现有 `src/components/vault/icons.ts` 暂时保留为 Legacy Functional Icon Source，
  随对应 Workspace migration 渐进迁移，不进行一次性 repo-wide replacement，也不再
  作为新通用 glyph 的默认扩展点。

Functional icon 的产品语义仍由 Nuvyn 决定，glyph 的几何和绘制由 Tabler 决定：

~~~
Nuvyn semantic choice
        ↓
approved Tabler glyph
        ↓
@vicons/tabler component
        ↓
Naive UI NIcon
        ↓
Nuvyn control / surface
~~~

如果某个独特 domain symbol 无法由 Tabler 语义表达，应先寻找合适的 Tabler glyph，
再考虑文本或 label；只有无法表达明确 domain identity 时，才可提出有产品语义、设计
理由、Review 批准和文档记录的 Nuvyn-owned exception。不得在 Implementation 阶段
自行手绘或复制第三方 SVG path。

### 5.1.2 Amendment rationale

当前 Nuvyn 的 `src/components/vault/icons.ts`、`ICON_*` vocabulary、16×16 custom
grid、stroke / fill rules、contract tests、icon preview、repo-wide icon lint、
`icon-system.md` 和 `icon-usage.md` 已经构成一套小型 icon library。继续扩展它会
重复承担基础 UI 自研成本，增加跨 Workspace 视觉漂移，也无法解决现有自绘 glyph
在视觉上不自然、不统一和不够精致的问题。

Functional glyph 不是 Nuvyn 的产品差异化。Nuvyn 负责选择这里表达的语义和如何把
它组合进产品；Tabler 负责通用 glyph 的绘制、几何和一致性。这次 amendment 只改变
functional icon foundation，不改变 Workspace IA、domain layout、brand artwork、
generated content 或现有 `ICON_*` consumer 的业务语义。

### 5.2 Nuvyn 负责产品表达

以下能力继续由 Nuvyn 自己拥有：

| 类型 | Authority |
| --- | --- |
| Design Tokens | Nuvyn |
| Theme semantics | Nuvyn |
| Page Layout | Nuvyn |
| Workspace Layout | Nuvyn |
| Global product hierarchy | Nuvyn |
| Ledger Dashboard | Nuvyn |
| Ledger domain components | Nuvyn |
| Diary page layout | Nuvyn |
| Diary domain components | Nuvyn |
| Note editor layout | Nuvyn |
| Vault file tree domain structure | Nuvyn |
| Vault pane architecture | Nuvyn |
| Navbar product structure | Nuvyn |
| ECharts | Existing |
| Markdown | Existing |
| Shiki | Existing |
| Mermaid | Existing |
| Markmap | Existing |
| Monaco | Existing |

冻结原则：

~~~
Naive UI 决定“控件如何正确工作”。

Nuvyn 决定“产品应该如何组织和表达”。
~~~

## 6. Card 使用原则

NCard 不作为 Nuvyn 默认布局组件。

只有当一个区域本身就是明确独立的信息对象时，才允许考虑 Card。

禁止为了迁移而把：

~~~
Ledger Cashflow
Account Group
Period Summary
Diary content
Vault pane
~~~

机械包进：

~~~vue
<NCard>
~~~

页面层级优先继续通过：

~~~
Typography
Whitespace
Divider
Surface
Grid
Flex
~~~

建立。

目标是避免：

~~~
Card
  Card
    Card
~~~

形成组件库式 UI。

## 7. Menu 使用边界

NMenu 只用于真正的 Menu / Navigation primitive。

适合：

~~~
用户菜单
设置菜单
简单侧边导航
Dropdown menu
~~~

不自动接管：

~~~
Vault 文件树
note / diary / ledger Workspace switch
复杂 domain tree
~~~

Vault Tree 继续属于 Vault domain component。

## 8. Tabs 使用边界

简单的内容区域切换可以使用 NTabs。

例如：

~~~
属性
历史
大纲
~~~

但如果一个 Tab：

- 对应独立 Route；
- 是 Workspace 一级导航；
- 有独立生命周期；
- 是产品 IA 的正式节点；

则不得为了使用 NTabs 把它降级成 component-local state。

Route authority 必须保留。

## 9. Wrapper 原则

禁止建立无价值的机械 wrapper，例如：

~~~
DButton
DInput
DSelect
DCheckbox
DCard
~~~

如果内部只是：

~~~vue
<NButton v-bind="$attrs">
  <slot />
</NButton>
~~~

则不允许创建。

业务组件可以直接使用：

~~~vue
<NButton />
<NInput />
<NSelect />
~~~

只有形成稳定 Nuvyn 产品语义时才允许封装。

例如：

~~~
NuvynDangerConfirm
NuvynWorkspaceEmptyState
LedgerMoneyInput
LedgerAccountPicker
DiaryDateNavigator
~~~

这些封装必须提供真实 domain value，而不是隐藏 Naive UI API。

## 10. Nuvyn Design Token Architecture

Nuvyn Semantic Tokens 是整个 UI 系统的 source of truth。

架构固定为：

~~~
Nuvyn Semantic Tokens
        ↓
Naive UI Theme Overrides
        ↓
Naive UI Components
        ↓
Nuvyn Domain Components
        ↓
Nuvyn Workspace
~~~

不得反转为：

~~~
Naive UI default theme
        ↓
Nuvyn looks like Naive UI
~~~

## 11. Token 第一版范围

第一版至少定义以下 semantic tokens。

### 11.1 Color

~~~
--nuvyn-bg
--nuvyn-surface-1
--nuvyn-surface-2

--nuvyn-text-1
--nuvyn-text-2
--nuvyn-text-3

--nuvyn-border
--nuvyn-divider

--nuvyn-accent
--nuvyn-accent-hover
--nuvyn-accent-pressed

--nuvyn-positive
--nuvyn-negative
--nuvyn-warning
--nuvyn-info
~~~

### 11.2 Radius

~~~
--nuvyn-radius-sm
--nuvyn-radius-md
--nuvyn-radius-lg
~~~

### 11.3 Spacing

~~~
--nuvyn-space-1
--nuvyn-space-2
--nuvyn-space-3
--nuvyn-space-4
--nuvyn-space-5
--nuvyn-space-6
~~~

### 11.4 Typography

~~~
--nuvyn-font-size-xs
--nuvyn-font-size-sm
--nuvyn-font-size-md
--nuvyn-font-size-lg
~~~

不要求第一阶段一次建立大型 enterprise design token taxonomy。

目标是建立：

> 少量、稳定、有语义、长期可维护的 token。

## 12. Legacy Token Compatibility 与 Cascade

当前项目已有：

~~~
--bg
--bg-soft
--text
--text-h
--text-muted
--border
--accent
--accent-hover
~~~

第一阶段不得一次性删除这些 token。Phase 1 必须在同一个实现边界内完成以下原子迁移：

1. 将基础 semantic palette 的真实值从 `src/style.css` 移到 `src/ui/tokens.css`；
2. 在 `tokens.css` 定义 `--nuvyn-*` semantic tokens；
3. 在 `tokens.css` 定义 legacy aliases；
4. 同一 Phase / commit boundary 删除 `style.css` 中会冲突的 hard-coded `:root`、dark-mode 和 alias 定义。

`tokens.css` 是 global semantic token value authority，`style.css` 只消费这些变量，不得重新定义相同 alias value。Phase 1 不扩展到 `--vs-*`、`--ledger-*`、Markdown 或 editor-specific tokens；这些由对应 Workspace / Cleanup 阶段负责。

~~~css
--bg: var(--nuvyn-bg);
--bg-soft: var(--nuvyn-surface-1);

--text-h: var(--nuvyn-text-1);
--text: var(--nuvyn-text-2);
--text-muted: var(--nuvyn-text-3);

--border: var(--nuvyn-border);

--accent: var(--nuvyn-accent);
--accent-hover: var(--nuvyn-accent-hover);
~~~

迁移过程中，新代码优先使用 `--nuvyn-*` token，旧代码继续通过 compatibility alias 工作。旧 token 的删除只能发生在 Cleanup Phase。

主题 cascade precedence 固定为：

1. 默认 Light tokens；
2. `prefers-color-scheme` 仅在没有显式持久化主题时提供首次体验；
3. `[data-theme='light']` / `[data-theme='dark']` 作为 explicit application state，优先于 OS preference。

现有 `index.html` boot script 与 `useTheme()` 继续负责 `data-theme` 和 storage key `nuvyn.theme`。不得引入 Naive UI 自己的 theme localStorage。

## 13. Theme Authority

现有 useTheme() 继续作为 Nuvyn application theme authority。

不得让 NConfigProvider 创建第二套 theme state。

主题链路冻结为：

~~~
OS Preference / localStorage
            ↓
         useTheme
            ↓
       light | dark
            ↓
 ┌──────────┼──────────┐
 ▼          ▼          ▼
CSS Tokens  Naive UI   ECharts
~~~

useTheme() 继续负责：

~~~
theme state
localStorage
data-theme
theme switching
~~~

Naive UI 只是 theme consumer。

### 13.1 Locale Authority

现有 `useI18n().locale` 是 Nuvyn 唯一 application locale authority，取值为 `zh | en`。Naive UI 不得创建第二套 locale state。

locale 链路冻结为：

~~~
navigator / Nuvyn locale state
            ↓
         useI18n
            ↓
          zh | en
            ↓
 ┌──────────┼─────────────┐
 ▼          ▼             ▼
Nuvyn      Naive UI       Date locale
copy       locale         formatting
~~~

映射固定为：

~~~text
zh → locale = zhCN, dateLocale = dateZhCN
en → locale = enUS, dateLocale = dateEnUS
~~~

`NConfigProvider` 消费由 `useI18n().locale` 派生的 `locale` 与 `date-locale`。runtime `zh → en → zh` 必须自动同步，不重新 mount App、不刷新页面；DatePicker、Pagination、Empty 和 built-in messages 均必须遵循同一 locale authority。

## 14. Light / Dark 一致性

所有 Naive UI migration 必须同时支持：

~~~
Light
Dark
~~~

不得出现：

> Light 已完成，Dark 后续再处理。

每一个 Phase 的完成标准都包含 Light / Dark parity。

## 15. Naive UI Theme Overrides

新增统一 Naive UI theme mapping。

推荐位置：

~~~
src/ui/naiveTheme.ts
~~~

其职责：

~~~
Nuvyn Semantic Tokens
        ↓
GlobalThemeOverrides
~~~

它不是第二套 design system。

禁止在这里随意产生新的：

~~~
brand color
radius
spacing
typography
~~~

如果 Naive UI 需要某个视觉值，应优先从 Nuvyn semantic tokens 获取。

## 16. Token Single Source of Truth

原则上禁止长期维护：

~~~
CSS tokens 一套颜色
+
TypeScript theme constants 一套颜色
~~~

形成两个 source of truth。

Phase 0 必须验证：

Naive UI themeOverrides 对 CSS Custom Properties 的支持范围。

如果目标字段可以可靠使用：

~~~
var(--nuvyn-accent)
~~~

则优先直接引用 CSS token。

只有 Naive UI API 存在明确技术限制时，Implementation Plan 才允许建立受控 TS token mirror。

Phase 0 必须验证 Naive UI 对颜色值的实际解析边界。若部分派生颜色字段不能接收
`var(--token)`，Implementation Plan 只允许为这些字段建立最小、受控且可追溯的
Naive-compatible TS color mirror；这不是第二套 Nuvyn design system，原始 token
authority 仍然是 Nuvyn semantic CSS tokens。本 amendment 不执行该验证，也不创建
compatibility fixture。

## 17. Root Provider Architecture

Naive UI Provider 不直接散落在各个 Workspace。

必须建立统一 Root。

固定位置：

~~~
src/ui/NuvynUiRoot.vue
~~~

结构概念：

~~~
NuvynUiRoot
  └─ NConfigProvider
       └─ NDialogProvider
            └─ NMessageProvider
                 └─ NNotificationProvider
                      └─ App
~~~

`NConfigProvider` 同时接收：

~~~vue
<NConfigProvider
  :theme="naiveTheme"
  :theme-overrides="nuvynNaiveThemeOverrides"
  :locale="naiveLocale"
  :date-locale="naiveDateLocale"
>
~~~

其中 `naiveLocale` / `naiveDateLocale` 由 `useI18n().locale` reactive 派生。具体 provider 顺序可按 Naive UI API 约束微调，但 App 必须位于全部需要的 providers 下方。

App.vue 不承担 provider bootstrap。

## 18. 第一版 Provider 范围

第一版只引入确有使用价值的 Provider：

~~~
NConfigProvider
NDialogProvider
NMessageProvider
NNotificationProvider
~~~

不因为 Naive UI 提供某 Provider 就全部挂载。

例如：

NLoadingBarProvider

只有出现明确全局 Loading Bar 产品需求时再引入。

保留 `NNotificationProvider` 不代表所有 toast 都迁成 Notification。第一版默认 transient feedback 使用 `NMessage`；只有需要标题、长生命周期或更丰富内容时才使用 Notification。

## 19. Global Feedback Migration

当前 Nuvyn 已有：

~~~
ToastHost
ConfirmHost
PromptHost
~~~

目标不是立即删除业务层 API，而是先替换底层实现。Host Bridge 是 feedback / overlay 的唯一 canonical architecture。

现有：

~~~
useToast
useConfirm
usePrompt
~~~

属于有价值的 Nuvyn semantic abstraction。

因此冻结为：

~~~
Business Components
        ↓
useToast / useConfirm / usePrompt
(provider-independent Nuvyn semantic APIs)
        ↓
ToastHost / ConfirmHost / PromptHost
(or clearly renamed equivalent Hosts)
        ↓
Naive UI provider hooks / components
~~~

业务组件不得要求位于 `useMessage` / `useDialog` injection context 才能调用。Naive UI 的 `useMessage`、`useDialog`、`useNotification` 只允许在 Provider descendants 或 Host bridge 内部使用。

Host Bridge 是 provider-aware 的 domain adapter，不是绕过 Provider 的 global singleton。

## 20. Toast

目标：

~~~
ToastHost
→ NMessage / NNotification
~~~

原则：

短暂即时反馈：

~~~
success
info
warning
error
~~~

优先由 NMessage 承担。

ToastHost 负责把 Nuvyn semantic state 转为 NMessage / NNotification。默认 `info`、`success`、`warning`、`error` 使用 NMessage；需要标题或长生命周期时才使用 NNotification。必须保留 `ttl`、manual dismiss、type 与 call timing；若 duration 单位不同，由 Adapter 做转换。

业务调用方不应因为迁移发生大规模改写。

## 21. Confirm

目标：

~~~
ConfirmHost
→ NDialog
~~~

现有：

~~~
useConfirm()
~~~

继续作为 Nuvyn confirm semantic API。

现有 contract 必须完整保留：

~~~text
confirm()
confirmCancellable()
queue semantics
cancel()
destructive
confirmLabel
cancelLabel
detail
single-settlement protection
~~~

它负责表达：

~~~
用户意图
危险等级
确认文案
~~~

Naive UI 负责：

~~~
focus trap
overlay
keyboard
ESC
buttons
a11y
~~~

ConfirmHost 负责将 semantic request 映射到 NDialog，维护 queue、destroy 对应 dialog、`cancel()` resolve `false` 和 single-settlement。`cancel()` 不能只从 queue 删除而留下可见 dialog。

observable accessibility contract 必须保持：打开后 focus 进入 dialog；destructive confirm 默认 focus 保持在安全 / cancel action；ESC resolve `false`；关闭后 focus 恢复到原触发元素。若 Naive UI 默认 initial focus 不满足，Host Adapter 必须显式配置或补偿。

## 22. Prompt

PromptHost 保留为 domain bridge，不要求强行替换成一个 Naive UI built-in API。

允许建立：

~~~
Nuvyn Prompt semantics
+
NModal / NDialog
+
NInput
+
NButton
~~~

目标是保留：

~~~
usePrompt()
~~~

调用语义，同时统一：

~~~
overlay
input
focus
buttons
validation presentation
~~~

`usePrompt()` contract 保留 `title`、`placeholder`、`initial`、`actionLabel`、`actionTitle`、`transform` 和 `Promise<string | null>`。必须保持 initial value、input auto focus、合理的 selection、Enter submit、ESC cancel、与现状一致的 outside-click semantics、async transform、busy、double-submit prevention、transform 完成后重新 focus/select，以及 Promise exactly once settlement。

如果 `transform` throws / rejects：Prompt 保持打开，busy 恢复 `false`，不得产生 unhandled rejection 或 double settlement。除非已有 caller 语义，文档不新增产品级 error copy；Host 可捕获错误并允许继续编辑 / 重试。

## 23. Form Strategy

新 Form 优先使用：

~~~
NForm
NFormItem
Naive UI validation
~~~

已有复杂 Form 不要求在 Phase 1 立即重写。

Form migration 按 Workspace 逐步进行。

禁止仅为了组件库一致性重写稳定 domain validation。

Domain validation authority 必须保留。

例如：

~~~
Server validation
Ledger domain validation
Diary access semantics
Auth semantics
~~~

不得迁移成纯 UI validation authority。

## 24. Primitive Strategy

以下原生控件应逐步收敛到 Naive UI：

~~~
button
input
textarea
select
checkbox
radio
switch
date picker
~~~

但 Naive UI 是默认 authority 而非绝对强制替换 authority。迁移必须是产品语义等价迁移；若 Naive UI replacement 无法保持 existing domain semantics、timezone / calendar semantics、accessibility、browser / platform behavior 或 lifecycle guarantees，允许保留现有 primitive。

任何 exception 必须记录 concrete reason、保持 domain behavior、保留测试，并在 Phase Final Report 记录；exception 不得扩散为重新自研全部 primitives。

不能因为 Naive UI 默认 API 不同就改变：

~~~
routing
keyboard behavior
date semantics
validation authority
loading state
disabled state
business events
~~~

### 24.1 Control Density / Size Policy

Nuvyn 只冻结两档 canonical control density：

~~~text
compact  → Naive small
default  → Naive medium / library default equivalent
~~~

`compact` 用于 Navbar、compact workspace chrome、dense inline toolbar 和 small auxiliary actions；`default` 用于 forms、dialogs、settings、Ledger record forms、Diary access forms 以及普通 primary / secondary actions。`large` 默认不是 Nuvyn canonical size，只能在明确的产品强调场景按需使用。

同一产品语义必须使用同一 density。不要由各 Workspace 任意引入本地高度或 size token。

## 25. DatePicker 特别规则

DatePicker 迁移时必须保留领域 authority。

例如 Ledger：

~~~
Server today authority
Ledger timezone
future validation
anchorDate
canonical URL
~~~

这些均不属于 Naive UI。

Naive UI 只负责：

> 用户如何选择日期。

不得让 DatePicker 自己成为 financial date authority。

默认迁移规则：timezone-safe 且能稳定得到 canonical `YYYY-MM-DD` 时迁移到 `NDatePicker`；无法证明 timezone-safe 时保留 native `<input type="date">`，并在 Final Report 标记 `intentional domain exception`。这条规则同样适用于其他拥有日期领域 authority 的 Workspace。

## 26. Workspace Migration Boundary

迁移 Workspace 时遵循：

~~~
Naive UI 接管 primitives
Nuvyn 保留 domain components
~~~

示例：

### Ledger

可以迁移：

~~~
Button
Select
DatePicker
Dialog
Form
Input
Loading / Empty primitive
~~~

不迁移：

~~~
Dashboard hierarchy
Metric layout
Cashflow layout
Account list
Category bars
Period Summary
Trend composition
~~~

### Diary

可以迁移：

~~~
Date controls
Buttons
Dialog
Form
Inputs
Tabs where appropriate
~~~

不迁移：

~~~
Diary content layout
Diary calendar product behavior
Diary timeline / content hierarchy
~~~

### Vault

可以迁移：

~~~
Button
Dropdown
Tooltip
Dialog
Input
simple Tabs
~~~

不迁移：

~~~
FileTree domain model
pane architecture
editor lifecycle
document rendering
command model
~~~

## 27. Migration Order

整个项目冻结为以下迁移阶段。

### Phase 0 — Architecture Spike

目标：

验证：

~~~
exact-pinned dependency 与 package-lock 可复现性
Naive UI 与当前 Vue/Vite/TypeScript 兼容性
themeOverrides 与 CSS var mapping
bundle impact
test environment
Teleport
Provider hooks
Locale / DateLocale integration
Dark / Light integration
E2E implications
NIcon + @vicons/tabler compatibility
Tabler currentColor / size / alignment / accessibility
approved single icon-family import policy
Vue SSR renderToString compatibility
~~~

本阶段计划验证 `naive-ui@2.45.3` 与 `@vicons/tabler@0.13.0` 的 exact pin、真实
TypeScript exports、NIcon integration、tree-shaking、`currentColor`、Light / Dark、
compact / default 对齐、icon-only accessibility 和 Vue SSR `renderToString`。Phase 0
从记录当前 `main` HEAD 与 production bundle baseline 开始，随后 exact-pin candidate
dependency、更新 lockfile、创建可复现的 test-only fixture / compatibility tests，再
执行 `npm ci`、compatibility gates、full validation、commit + push 和 exact-head CI。
candidate dependency 与 fixture 都是 Phase 0 实施步骤，不能推迟到 Phase 0 通过之后。
只有 local gates 与 exact-head CI 全部通过，Phase 0 才能标记为 PASS；本 amendment 不
安装 dependency、不创建 fixture，也不执行 Phase 0。不得正式接管 App UI、引入
production NuvynUiRoot、迁移 Workspace 或改业务页面。Phase 0 是“可提交、可复现、无
用户可见 migration”的 compatibility spike，当前状态为 Pending / Ready to Start。

Phase 0 的 bundle checkpoint 必须记录 dependency 安装后 production import 仍为
`NONE`；
第一次真实 production Tabler import 要到后续 Shared Primitive / Shared Chrome phase
再测量 tree-shaking 和增量。即使 dependency 在未来 Phase 0 安装，也不得借 spike
提前替换 NavBar、Ledger、Diary、Vault 或 Note 的 production icon。

### Phase 1 — UI Foundation

完成：

~~~
NuvynUiRoot
NConfigProvider
Theme mapping
tokens.css
legacy aliases
provider baseline
theme / locale bridge
~~~

Phase 1 将消费 Phase 0 提交并验证的 exact-pinned dependencies，不重复安装或重新
选择版本；本 amendment 尚未安装或验证这些 dependency，业务 UI 基本保持不变。

Phase 1 同时冻结 Functional Icon Foundation：

~~~
NIcon + @vicons/tabler
one approved family only
legacy icons.ts remains migration-only
~~~

### Phase 2 — Feedback / Overlay

迁移：

~~~
ToastHost
ConfirmHost
PromptHost
适合迁移的 Dialog
~~~

保持：

~~~
useToast
useConfirm
usePrompt
~~~

调用契约尽可能稳定。

### Phase 3 — Primitive Controls

迁移跨项目重复度最高的：

~~~
Button
Input
Textarea
Select
Checkbox
Radio
Switch
DatePicker
~~~

不要求一个 commit 全项目完成。

可以按小批次迁移，但 Phase 退出时必须确定 canonical implementation。

### Phase 4 — Shared Chrome

迁移：

~~~
NavBar 中适合的 Button
Dropdown
Tooltip
简单 menu control
Settings controls
Auth shared controls
~~~

不得改变：

~~~
note / diary / ledger
Workspace navigation semantics
route behavior
~~~

### Phase 5 — Diary

Diary 作为第一个完整 Workspace migration validation target。

原因：

- 产品边界清晰；
- 交互足够丰富；
- 风险低于 Vault；
- 可以验证 Date / Dialog / Form / Controls；
- 不需要立即扰动刚完成 UI 稳定化的 Ledger。

### Phase 6 — Ledger

迁移：

~~~
buttons
date picker
scope select
forms
dialogs
inputs
loading / empty primitives where appropriate
~~~

保留当前 Ledger Visual Language。

不得因为 Naive UI 重构重新设计 Dashboard。

### Phase 7 — Vault / Note

最后迁移风险最高的：

~~~
Vault
Note
~~~

原因：

~~~
File tree
Editor
Preview
Pane lifecycle
Tabs
Keyboard
Focus
Scroll
Command palette
Markdown rendering
~~~

交互高度复杂。

必须等 Foundation 已在其他 Workspace 验证稳定后再进入。

### Phase 8 — Cleanup

最终清理：

~~~
unused custom primitive CSS
obsolete Host
deprecated compatibility styles
legacy primitive classes
dead utilities
duplicate focus styles
duplicate theme rules
~~~

Legacy token 只允许在此阶段评估删除。

Functional icon migration 与上述顺序绑定：

~~~
Phase 0  验证 NIcon + Tabler，不迁 production icons
Phase 1  建立 policy / runtime compatibility，不做全站替换
Phase 2  overlay / feedback 按需采用 Tabler
Phase 3  迁移 shared primitive icons
Phase 4  迁移 NavBar、Settings、Auth 和 global chrome icons
Phase 5  迁移 Diary icons
Phase 6  迁移 Ledger icons，并保留 Dashboard visual language
Phase 7  迁移 Vault / Note 的 legacy ICON_* consumers
Phase 8  zero consumer 后清理 legacy icon infrastructure
~~~

迁移期间允许 `ICON_*` legacy 与 Tabler 短期共存，但 legacy 必须明确处于退出路径；
Phase 8 完成后只保留 Tabler functional icons 和已记录的 Brand / Domain exceptions。

## 28. Migration Incrementality

禁止 Big Bang migration。

不得提交：

> Replace all Nuvyn UI with Naive UI

这种一次覆盖整个项目的变更。

每个阶段必须：

~~~
独立可运行
独立可测试
独立可回滚
独立可 review
~~~

## 29. Canonical Implementation Rule

短期迁移期间允许：

~~~
Legacy Primitive
+
Naive UI Primitive
~~~

并存。

但每个 Phase 完成时必须明确：

> 对本阶段覆盖范围，哪一种实现是 canonical。

禁止长期出现：

~~~
页面 A → NButton
页面 B → .primary-button
页面 C → 自制 Button 2
~~~

而没有迁移计划。

## 30. Visual Preservation

本项目不是全站 redesign。

迁移的第一优先级：

~~~
Behavior Preservation
Visual Consistency
Interaction Quality
~~~

不是：

~~~
全部页面看起来像 Naive UI 默认主题。
~~~

现有已经被用户认可的 UI，应优先视觉保真迁移。

特别是：

~~~
Ledger Dashboard
~~~

当前视觉方向必须作为 migration baseline 保留。

## 31. Theme Acceptance

每个迁移后的组件必须覆盖：

~~~
default
hover
active / pressed
focus-visible
disabled
loading
error where applicable
~~~

并同时验证：

~~~
Light Mode
Dark Mode
~~~

## 32. Accessibility

引入 Naive UI 的目标之一是降低基础交互 accessibility 自研成本。

迁移不得降低现有：

~~~
keyboard navigation
focus visibility
aria labeling
dialog semantics
screen reader behavior
loading status
error alerts
~~~

Naive UI 自带 accessibility 不意味着无需测试。

Domain-level accessible naming 仍属于 Nuvyn。

## 33. Focus Strategy

现有 Nuvyn 已有全局 :focus-visible 规则。

迁移期间必须避免出现：

~~~
Naive UI focus ring
+
Nuvyn global focus ring
~~~

形成 double focus indicator。

Phase 0 / 1 必须明确：

~~~
Native / Nuvyn component
Naive component
Vault custom component
~~~

各自的 focus authority。

最终用户看到的 focus indicator 应统一、清晰、非重复。

## 34. Overlay / Teleport

Naive UI Dialog / Dropdown / Popover 等可能使用 Teleport。

必须验证：

~~~
z-index
Vault pane
Navbar
Modal
Auth page
Diary dialog
Ledger dialog
scroll lock
body class
dark/light theme inheritance
~~~

不得出现：

~~~
overlay 被 pane 截断
popover 跑到错误层级
modal 被 navbar 压住
Vault body lock 冲突
~~~

## 35. Router Preservation

Naive UI migration 不允许改变：

~~~
route structure
browser back / forward
route query
deep link
workspace route semantics
~~~

Tabs、Menu、Button 可以改变实现，但 URL authority 不变。

## 36. Store / Server Boundary

UI Foundation 不得侵入：

~~~
Store state machine
API contract
Server semantics
database
domain projection
~~~

UI component 只能消费现有 domain state。

禁止出现：

> 因为 NForm 方便，所以把 domain validation 搬到 component。

## 37. ECharts

ECharts 保留。

Naive UI 不替代数据可视化。

Ledger 趋势等继续使用：

~~~
ECharts
~~~

Theme 颜色可以从 Nuvyn semantic tokens 获取。

## 38. Markdown / Content Rendering

以下保持原实现：

~~~
Markdown-it
Shiki
Mermaid
Markmap
KaTeX
Monaco
~~~

Naive UI 不进入 content rendering pipeline。

## 39. Bundle Strategy

Naive UI 引入后必须关注客户端 bundle。

实现应优先：

~~~
按需 import
tree-shaking friendly
不全局注册全部 component
~~~

禁止为了方便一次性暴露整个 Naive UI component set。

Functional Icon Foundation 的唯一 approved functional icon family 是
`@vicons/tabler`。Phase 0 implementation 才使用 `@vicons/tabler@0.13.0` 与
`naive-ui@2.45.3` exact pin；禁止以 `@vicons/*` 泛化或引入第二个 icon package。版本
升级属于 dependency upgrade 与 regression review；如果未来出现 family blocker，必须
回到 Design / Implementation Review。Phase 0 必须记录 baseline、dependency 安装后
production import `NONE` 的 bundle checkpoint，以及第一次 production Tabler import
后的实际 tree-shaken delta。

## 40. Root Bootstrap

当前应用 bootstrap 应由：

~~~
router
+
Nuvyn UI root
~~~

组成。

推荐目标：

~~~
main.ts
  ↓
NuvynUiRoot
  ↓
App
~~~

main.ts 继续保持轻量。

不得把大量 Theme / Overlay business logic 直接塞入 main.ts。

## 41. File Architecture

目标结构建议：

~~~
src/
├── ui/
│   ├── NuvynUiRoot.vue
│   ├── naiveTheme.ts
│   ├── tokens.css
│   └── ...
│
├── components/
│   ├── diary/
│   ├── ledger/
│   ├── vault/
│   └── ...
│
├── composables/
│   ├── useTheme.ts
│   ├── useToast.ts
│   ├── useConfirm.ts
│   ├── usePrompt.ts
│   └── ...
~~~

src/ui 只存放 UI Foundation。

不要把业务组件搬入 src/ui。

## 42. Testing Strategy

每个 Phase 至少覆盖：

~~~
Unit
Typecheck
Build
Relevant Integration
Relevant Browser E2E
Light / Dark
Keyboard
Exact-head CI
~~~

Overlay migration 额外覆盖：

~~~
focus
ESC
confirm
cancel
busy
double submit
close behavior
~~~

当前 `ConfirmHost` / `PromptHost` 测试中的 observable behavior 是 migration regression evidence。Confirm 至少保留 safe cancel focus、ESC、focus restore、destructive labels；Prompt 至少保留 focus、Enter、ESC、async transform、busy。测试应断言 role、accessible name、用户可见 label 或确有必要的 `data-testid`，不得断言 `.n-dialog`、`.n-button` 等 Naive UI implementation class。

## 43. Visual Acceptance Gate

Visual Acceptance Gate 是正式 Phase gate，采用两级方式：

1. 已存在稳定 automated visual baseline 的 surface，必须 automated screenshot regression PASS；
2. 尚无 automated baseline 的 surface，必须人工验证 Desktop Light、Desktop Dark、Mobile Light、Mobile Dark。

每个 Phase Final Report 必须记录 reviewed surfaces、intentional visual changes、regressions found / fixed 和 remaining accepted differences。

随着 Workspace migration，NavBar / Shared Chrome、Diary main surface、Ledger Dashboard、Vault critical chrome 等稳定且高风险 surface 可以逐步加入 automated visual baseline；Phase 0 / Phase 1 不强制建立全站 screenshot suite。

视觉变化必须说明原因，不得以“Naive UI 默认就是这样”作为接受理由。

## 44. Phase Exit Criteria

每个 Phase 只有满足以下条件才允许关闭。

1. 本 Phase 定义的 migration scope 已完成。
2. 已确定 canonical implementation。
3. 不存在未记录的 Legacy / New 双体系。
4. Light Mode PASS。
5. Dark Mode PASS。
6. Keyboard PASS。
7. Focus state PASS。
8. Disabled / Loading state PASS。
9. Relevant unit tests PASS。
10. Relevant E2E PASS。
11. Typecheck PASS。
12. Build PASS。
13. No unapproved domain behavior change。
14. No unapproved route change。
15. Exact-head CI PASS。
16. Visual Acceptance Gate PASS。
17. Locale / DateLocale parity PASS。
18. 涉及 icon migration 时，不新增手写 generic functional SVG 或复制第三方 path；
19. 涉及 icon migration 时，只使用 approved Tabler family，且保留 Nuvyn semantic
    distinction；
20. icon-only control 具备 accessible name，decorative icon 不产生重复朗读；
21. Icon 在 compact / default density 下对齐，且没有未解释的 bundle 增长；
22. 不存在未经批准的第二个 icon family；尚未覆盖的 legacy consumer 都有明确
    migration phase 归属。

## 45. Epic Completion Criteria

整个 Naive UI Foundation Epic 只有在以下条件全部满足时关闭：

- Naive UI Foundation 已稳定；
- Nuvyn semantic tokens 成为 UI source of truth；
- Theme authority 唯一；
- Root Provider 唯一；
- Global feedback / overlay 已统一；
- Primitive control canonical implementation 已明确；
- Note / Diary / Ledger / Vault 已完成计划范围内迁移；
- 已无无主的重复 primitive system；
- Legacy CSS debt 已清理；
- Functional Icon Authority 已统一为 `NIcon + @vicons/tabler`；
- `ICON_*` production consumers 已迁移为 0，除明确批准的 Brand / Domain exception；
- 不再新增手写通用 functional SVG，不复制第三方 glyph path，也不保留第二个 icon
  family；
- legacy icon geometry、preview、contract tests 和 lint 规则只在 zero consumer 后
  清理，且不会误删 brand artwork；
- Light / Dark 一致；
- Accessibility 没有明显退步；
- 所有主路径 E2E 通过；
- CI 完整通过；
- Nuvyn 保留自己的 Workspace 视觉和 IA。

## 46. 成功标准

本项目成功不是：

~~~
Naive UI component 数量很多
~~~

而是用户能感知到：

~~~
Button 更一致
Input 更一致
Dialog 更成熟
Forms 更统一
Hover / Focus / Disabled 更精致
Light / Dark 更完整
不同 Workspace 像同一个产品
~~~

工程侧应感知到：

~~~
基础 UI 重复代码减少
基础交互 bug 减少
新页面不再重新造 Button / Input / Dialog
Theme 调整成本下降
CSS primitive debt 降低
Accessibility 基线提高
~~~

## 47. Anti-goals

如果迁移完成后 Nuvyn 看起来像：

~~~
Naive UI Admin
组件库 Showcase
企业后台模板
~~~

则本项目失败。

最终应该仍然明显是：

> **Nuvyn**

只是基础交互更加统一、成熟、精致。

## 48. 冻结决策

以下决策在 Product Review 中视为当前冻结 baseline：

### Architecture

~~~
Naive UI = Primitive / Interaction Foundation
Nuvyn = Product / Domain / Layout Authority
~~~

### Theme

~~~
Nuvyn Semantic Tokens = Source of Truth
Naive UI Theme = Consumer
~~~

### Appearance Authority

~~~
useTheme = 唯一 Light / Dark authority
~~~

### Provider

~~~
独立 NuvynUiRoot 包裹 App
~~~

### Wrappers

~~~
禁止机械 wrapper
允许有真实 domain semantics 的 wrapper
~~~

### Migration

~~~
Incremental
不是 Big Bang
~~~

### Workspace Order

~~~
Foundation
→ Overlay / Feedback
→ Primitives
→ Shared Chrome
→ Diary
→ Ledger
→ Vault / Note
→ Cleanup
~~~

### Existing technologies

~~~
ECharts 保留
Markdown 保留
Shiki 保留
Mermaid 保留
Markmap 保留
Monaco 保留
~~~

### Functional Icon Foundation

~~~
Functional icon presentation = Naive UI NIcon
Functional glyph family = @vicons/tabler only
Phase 0 candidate version = @vicons/tabler@0.13.0 exact pin
Product semantic authority = Nuvyn
Brand artwork = Nuvyn-owned
Generated / content SVG = existing renderer or content pipeline
Legacy icons.ts = temporary migration source
~~~

从 amendment Accepted 起，不新增手写通用 functional SVG，不复制 Tabler path，也
不引入第二个 icon family。`icons.ts`、旧 icon preview、geometry contract test 和
legacy lint 在 zero consumer 前继续保护迁移中的旧 surface；清理只能在 Phase 8
证明 zero consumer 后进行。

## 49. Frozen Product Decisions

以下 Product Review 决策已冻结并标记为 **ACCEPTED**：

### Q1. Phase 0 是否允许只做技术 Spike、不产生用户可见 UI 变化？

允许。Phase 0 只提交 exact-pinned dependency、可复现 compatibility evidence 和 test-only fixture，不接管 App UI。**ACCEPTED**

### Q2. Legacy semantic token alias 是否保留到最终 Cleanup Phase？

是。Legacy aliases 保留至 Cleanup Phase，并在确认无消费者后再评估删除。**ACCEPTED**

### Q3. useToast / useConfirm / usePrompt 是否保持为 Nuvyn public composable API？

是。三者保持 provider-independent Nuvyn semantic APIs，由 Host Bridge 适配 Naive UI。**ACCEPTED**

### Q4. Ledger 是否必须在 Diary 之后迁移？

是。Ledger 在 Diary 完成后进行保真迁移。**ACCEPTED**

### Q5. Vault 与 Note 是否作为最后一组高风险迁移？

是。Vault / Note 最后迁移。**ACCEPTED**

### Q6. Functional icon 是否统一采用 `NIcon + @vicons/tabler`？

是。`@vicons/tabler` 是唯一 approved functional icon family；Phase 0 使用
`@vicons/tabler@0.13.0` exact-pinned candidate。现有 `icons.ts` 作为 migration-only
legacy 保留，brand / generated artwork 继续由 Nuvyn 或原 renderer 拥有。**ACCEPTED**

Blocking Open Questions: **0**

## 50. Product Review Exit Criteria

Product Review 通过前必须确认：

- Naive UI 与 Nuvyn 的职责边界无歧义；
- Token ownership 无歧义；
- Theme authority 无歧义；
- Provider architecture 无歧义；
- Wrapper policy 无歧义；
- Card / Menu / Tabs 使用边界明确；
- Feedback / Overlay migration strategy 明确；
- Workspace migration order 明确；
- Big Bang migration 被明确禁止；
- Ledger Visual Language 要求保留；
- Vault / Note 高风险顺序明确；
- Existing renderer / editor / ECharts 不迁移；
- Phase exit criteria 可执行；
- 没有要求业务层因 UI library 改变 domain behavior；
- Locale authority、DatePicker exception、Host Bridge、token cascade、Visual Acceptance Gate 和 control density 均已冻结；
- Functional Icon Foundation、single-family policy、legacy `icons.ts` migration
  boundary 和 brand / generated SVG exception 均已冻结；
- P0: 0；P1: 0；P2: 0；
- Blocking Open Questions = 0；
- Product Review: **Accepted**。

这份 PRD 已通过正式 **Product Review**。

它的核心定位不是“安装 Naive UI 的 PRD”，而是 **Nuvyn UI Foundation 重构 PRD**。后续 Implementation Plan 负责回答：

~~~
Naive UI 具体版本
具体 Provider nesting
themeOverrides 字段
哪些文件先迁
每一阶段 commit sequence
测试如何改
CSS 如何逐步退出
bundle baseline 怎么测
~~~

这样产品职责与实现职责保持清晰。
