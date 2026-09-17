# Nuvyn Emoji Support PRD

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| Status | Approved for Implementation；仅完成调研与产品/架构定义 |
| Date | 2026-08-12 |
| Owner | Nuvyn Markdown / Editor platform（待项目分配具体负责人） |
| Phase | Emoji MVP |
| Target | Nuvyn Personal OS 的 Note / Editor 能力 |
| Scope | Markdown renderer、Monaco completion、`/emoji` Slash Command 及其验证 |
| Implementation constraint | 本文对应的任务只允许修改 PRD 文档；不实现功能、不安装依赖、不修改 `package.json`、`package-lock.json`、业务代码或测试 |

本文是后续 Implementation Plan、Test Plan 和 Code Review 的约束来源。除非另立 RFC，本 PRD 中的行为定义优先于实现便利性。

## 2. Executive Summary

Nuvyn 第一版 Emoji 支持采用 Markdown shortcode 作为持久化源码格式，采用原生 Unicode Emoji 作为预览结果：

```text
:smile:  →  😄
:rocket: →  🚀
:+1:     →  👍
```

推荐方案如下：

- renderer 支持 `:emoji_name:`，未知 shortcode 原样保留；原生 Unicode 原样保留。
- 使用 full Emoji definitions，保留 aliases；例如 `:+1:` 和 `:thumbsup:` 都有效，即使它们显示同一个 glyph。
- 第一版关闭 `:)`、`:D`、`:-)` 等 emoticon shortcuts。
- Markdown renderer 与 Monaco autocomplete 共用一份 Nuvyn-local generated Emoji definitions。该数据由 upstream 数据源生成，不手工维护两份 allowlist。
- 使用 `@mdit/plugin-emoji` 提供 MarkdownIt Emoji 解析/渲染规则；优先使用其 `bareEmoji` 能力注入 Nuvyn 的 full definitions 和空 shortcuts 配置，以同时满足 full dataset 与“关闭 emoticon shortcuts”的产品决策。
- Emoji MVP pin 已发布的 `@mdit/plugin-emoji@1.1.1`：该版本的 `markdown-it ^14.2.0` peer 与 Nuvyn 当前实际锁定的 14.2.0 兼容。upstream `main` 是另一条迁移到 MarkdownIt 15 的开发线，不作为 MVP 依赖来源；Emoji Phase 不升级 MarkdownIt major version，也不跟随 upstream main / future latest。
- Monaco 增加 `:` 触发，但必须先通过严格的 shortcode 上下文判断。`/emoji` 插入 `:` 并调用现有 `editor.action.triggerSuggest`，不直接插入 Unicode，也不创建第二套 popup 或 Wiki 搜索系统。
- Emoji renderer 只输出 Unicode 文本，不输出 HTML、SVG、图片、CDN 资源或用户定义的可执行内容。因此主 DOMPurify policy 不需要也不得放宽。

## 3. 背景与问题定义

Nuvyn 的 Markdown / Editor 能力是 Personal OS 中 Note 内容的基础。现有 Markdown architecture 已支持 task list、heading anchor、footnote、definition list、highlight、Wiki Link、callout、KaTeX、Mermaid、Markmap 和 DOMPurify 安全边界；Monaco 编辑器已经有 Slash Commands、代码语言 completion、Wiki Link completion、IME handling 和大文档行为。

当前缺少 Emoji 会造成三个不一致：

1. Markdown renderer 没有稳定的 `:name:` → Unicode 语义，用户无法以可移植、可搜索的 shortcode 保存 Emoji。
2. Monaco 没有 `:query` completion，用户只能记忆名称或直接输入 Unicode。
3. Slash Command 没有将用户带入 Emoji completion 的入口。

本阶段解决的是 Markdown 内容表达和编辑体验，不解决 Emoji picker、工作区自定义 Emoji、反应系统或图片 Emoji。

## 4. 当前系统现状（基于仓库调研）

### 4.1 Markdown 依赖与初始化

- `package.json` 声明 `markdown-it: ^14.1.0`。
- `package-lock.json` 与 `pnpm-lock.yaml` 当前实际解析到 `markdown-it@14.2.0`。
- `src/lib/markdown.ts` 使用一个缓存的异步 MarkdownIt 实例；当前主要初始化顺序为：

  ```text
  task-lists
  → anchor
  → footnote
  → deflist
  → mark
  → Wiki Link
  → callout
  → math
  ```

- MarkdownIt 开启 HTML、linkify、typographer 等当前能力；当前没有开启 `breaks: true`。代码 span、fenced code、link destination 等由 MarkdownIt tokenization 处理。
- `render()` 在 MarkdownIt 输出完成后进入 `sanitizeMarkdownHtml()`，DOMPurify 是最终 Markdown HTML 的安全边界。

### 4.2 现有 sanitizer 边界

`src/lib/markdown.ts` 的 policy 明确禁止用户 HTML 中的 script、事件属性、危险 URL、style、iframe、object、SVG、math 等内容，并且只允许有限的 `data-*` 属性。Emoji MVP：

- 不修改 DOMPurify allowlist、denylist、URI policy 或 hook。
- 不把 Emoji 定义放入 frontmatter。
- 不允许用户把 shortcode 映射到 HTML。
- 只产生普通 Unicode 文本，不能扩大 sanitizer attack surface。

### 4.3 Monaco completion 架构

`src/components/vault/EditorPane.vue` 和 `src/components/vault/monacoMarkdownProviders.ts` 共同形成当前 completion 路径：

```text
Markdown model context
→ per-model completion provider
→ CompletionItem
→ insertText / insertTextRules
→ Monaco insertion
```

当前 provider 已处理：

- Slash Commands；
- Wiki Link completion，使用现有 `rankWikiTargets` 和 target resolver 语义；
- code fence language completion；
- 其它 Markdown 编辑辅助。

Slash Command completion 当前使用 `CompletionItemKind.Snippet`、`InsertAsSnippet` 和可选的 Monaco command。`/wiki` 已采用“插入 `[[` 后触发 `editor.action.triggerSuggest`”的路径。Emoji 应复用这条路径。

当前 provider 的全局 trigger 字符包括 `[`, `` ` `` 和 `/`；尚未有 Emoji 专用的 `:` trigger。编辑器选项已开启 `suggestOnTriggerCharacters`，并已有 composition 状态处理。

### 4.4 编辑器上下文判断能力

当前 Monaco 代码能识别部分 fenced-code language completion 场景，但没有一个通用、完整的 Markdown cursor-context parser。大文档模式主要关闭 folding、smooth scrolling 和装饰性工作，completion provider 仍可用，且不应扫描全文。

因此 Emoji completion 的 MVP 必须使用小而明确的当前行/有限上下文判断，不能假设已有完整 Markdown AST，也不能为 Emoji 引入通用编辑器框架。

### 4.5 现有测试与浏览器验证

- `src/lib/__tests__/markdown.test.ts` 使用真实 Markdown renderer 覆盖 footnote、definition list、highlight、math、Wiki、raw HTML 和 diagram placeholder 等。
- `src/lib/__tests__/wikiLinks.test.ts` 覆盖 Wiki syntax、alias、普通链接、inline code 和 fenced code。
- `src/components/vault/__tests__/monacoMarkdown.test.ts` 覆盖 Slash Command 数据和 helper。
- `src/components/vault/__tests__/MonacoEditorPane.test.ts` 覆盖真实 provider 路径、`InsertAsSnippet`、Slash Command、Wiki completion、code/fence 行为、IME 和 large document 行为。
- `e2e/markdown-visual.spec.ts` 与 Markmap math E2E 已能定位 Markdown article 和 Markmap 内部内容；现有浏览器套件适合增加小型 Emoji renderer 验收，但目前没有可直接复用的 Monaco 真实浏览器 Emoji flow。

后续实现应优先扩展现有测试路径，而不是新建大型 editor test framework。

## 5. Upstream 调研

### 5.1 `@mdit/plugin-emoji` 当前结论

截至本文日期，必须区分两个不同的 upstream 状态（npm `1.1.1` 的发布 manifest 与 GitHub `main` 的当前 manifest）：

1. **已发布 npm `@mdit/plugin-emoji@1.1.1`**：这是 Emoji MVP 的依赖基线；其 manifest 的 peer dependency 为 `markdown-it ^14.2.0`。
2. **upstream GitHub `main`**：这是 moving development branch。2026-08-11 的 `feat: migrate to markdown-it v15` 已将 main 上的 peer dependency 改为 `markdown-it ^15.0.0`；main 的 package version 字段仍可能显示 `1.1.1`，不能仅凭 version 字段判断兼容性。该 main 状态来自本次 review 对 upstream commit/manifest 的核对，不代表已发布 npm artifact。

因此，Nuvyn Emoji MVP 必须 pin 已发布的 npm `@mdit/plugin-emoji@1.1.1`，不读取 upstream main 的未发布 peer 状态，也不跟随 future latest。关键事实：

| 项目 | 调研结论 |
| --- | --- |
| License | MIT |
| peer dependency | npm `1.1.1`：`markdown-it: ^14.2.0`，peer metadata 标记为 optional |
| upstream main peer | 当前 main：`markdown-it: ^15.0.0`；不属于 MVP 依赖基线 |
| package exports | 公开主入口；提供 preset/plugin API，不将内部 `emojiData` 作为稳定 public data export |
| `sideEffects` | `false` |
| Node engine | `>=22`；未来实现必须与 Nuvyn 支持的 Node floor 一起验证 |
| 主要 preset | `fullEmoji`、`lightEmoji`、`bareEmoji` |
| 默认 renderer | 返回 Unicode 文本；不是 HTML、SVG 或图片 |
| plugin behavior | 在 inline token 处理阶段识别已知 shortcode，并生成 Emoji token；未知 shortcode 保持文本 |

Nuvyn 的实际 `markdown-it@14.2.0` 满足 npm `@mdit/plugin-emoji@1.1.1` 的 peer range；因此 MVP 没有 MarkdownIt 版本兼容阻塞，也没有为了 Emoji 升级到 15.x 的理由。未来依赖 PR 需要遵循项目 lockfile policy，并明确 pin 到已发布的 1.1.1；不得把 upstream main 或 MarkdownIt major upgrade 混入 Emoji Phase。

### 5.2 Preset 语义

| Preset | 语义 | 本阶段结论 |
| --- | --- | --- |
| `fullEmoji` | 使用完整默认 definitions，并带 upstream 默认 shortcuts | 不直接使用默认 shortcuts；可作为 upstream 参考，但不满足本阶段 shortcut policy |
| `lightEmoji` | 只提供小型常用 Emoji 集合 | 不采用；会降低 shortcode 覆盖和 autocomplete 完整度 |
| `bareEmoji` | 不预置完整 definitions/shortcuts，由调用方提供 | 推荐；注入 Nuvyn generated full definitions，并显式传入空 shortcuts |

Upstream options 支持 definitions、enabled 和 shortcuts。第一版只需要完整 definitions 和“关闭 shortcuts”的明确配置，不需要用户可配置的 enabled/filter UI。

### 5.3 Renderer behavior

upstream Emoji rule 的重要行为与 Nuvyn 目标一致：

- 只对已知 `:name:` 进行替换；未知名称保留原文。
- 默认 renderer 输出 Unicode glyph。
- rule 处理 inline text 子 token，不会把 inline code 或 fenced code 的代码内容当作普通文本替换。
- autolink URL 部分会被跳过；普通 Markdown link 的 label 是正常 inline 内容，可以转换，destination 不作为普通 text 内容处理。
- alias 是独立有效 shortcode，不应因为 glyph 相同而在数据层去重。
- emoticon shortcuts 是单独的 shortcuts 配置，不应与 `:name:` shortcode 解析混为一谈。

### 5.4 Data provenance

upstream `full.ts` 是 generated data，而不是适合 Nuvyn 手工复制和长期维护的业务数据。upstream update script 当前从 `gemoji-json` 生成名称/alias 到 Unicode glyph 的 definitions；`gemoji-json` README 标注 MIT，并维护 GitHub/Unicode Emoji 数据及 aliases 等元数据。

因此 Nuvyn 不应从 `@mdit/plugin-emoji` 的内部 dist 或未公开的 `emojiData` 路径读取数据。这些路径不是稳定的 package API，且会让 renderer 与 Monaco 绑定到 upstream 内部文件结构。

## 6. 产品目标与成功标准

### 6.1 目标

第一版完成后，用户可以：

1. 在 Markdown source 中稳定保存 `:smile:`、`:rocket:`、`:+1:` 等可搜索 shortcode。
2. 在 preview 中看到原生 Unicode Emoji。
3. 在 Monaco 中输入 `:smi`，得到有限、可预测的 Emoji suggestions。
4. 通过 `/emoji` 进入同一套 Emoji completion，而不是进入另一个 picker。
5. 在未知 shortcode、代码、URL、技术文档中的 colon 表达式中保持内容可预测。

### 6.2 成功标准

- renderer 与 Monaco 使用同一份 definitions，新增/删除 shortcode 不会产生两套行为。
- source round-trip 不把 shortcode 变成 Unicode 后再保存。
- 普通 Markdown、代码、URL、Wiki completion、Slash Commands 和 sanitizer 没有回归。
- completion 只处理当前 cursor 的短 query，不随文档长度线性扫描全文。
- 任何 Emoji suggestion 都不能注入 HTML、SVG、图片或外部资源。

## 7. Non-Goals

第一版明确不做：

- Emoji skin-tone picker UI；
- Emoji category picker 或图形化网格；
- recent/frequently used Emoji history；
- custom Emoji、workspace Emoji、Discord/Slack 风格 Emoji；
- user-defined Emoji aliases 或 frontmatter definitions；
- Twemoji、SVG Emoji、图片 Emoji、远程 Emoji CDN；
- animated Emoji；
- reactions、comments 或独立 Emoji reaction system；
- emoticon shortcuts（`:)`、`:D`、`:-)` 等）；
- MarkdownIt 15 migration；
- generic renderer registry、generic editor completion framework 或新的 Wiki search service。

## 8. 用户场景

### 8.1 Markdown 作者

```markdown
今天完成了 :rocket: 发布。

状态：:white_check_mark:
```

Preview：

```text
今天完成了 🚀 发布。

状态：✅
```

### 8.2 Monaco 作者

用户输入：

```text
:smi
```

建议项示例：

```text
😄 :smile:
😃 :smiley:
🙂 :slightly_smiling_face:
```

选择 `😄 :smile:` 后，source 保存为：

```text
:smile:
```

### 8.3 Slash Command 作者

用户输入 `/emoji` 并选择 Emoji：

```text
:
```

随后进入同一套 `:` completion。Slash Command 不直接插入 `😀`，也不固定插入 `:smile:`。

### 8.4 技术文档作者

以下内容应继续按原文或原有 Markdown 语义处理：

```text
key:value
12:30
https://example.com/:smile
foo::bar
C:\Users
```

## 9. Markdown Emoji Syntax

### 9.1 支持语法

第一版支持由 definitions 定义的闭合 shortcode：

```text
:emoji_name:
```

名称可以包含 upstream 数据中的合法字符，包括字母、数字、下划线、连字符和 `+` 等 alias 所需字符。Nuvyn 不自行扩展一套与 upstream 不同的名称 grammar。

### 9.2 已知、未知与原生 Unicode

| 输入 | 结果 |
| --- | --- |
| `:smile:` | `😄` |
| `:rocket:` | `🚀` |
| `:+1:` | `👍` |
| `:thumbsup:` | `👍` |
| `:this_emoji_does_not_exist:` | 原文保留 |
| `😀` | 原样保留 |
| 空 shortcode、未闭合 shortcode | 原文保留，不抛异常 |

未知 shortcode 不得被删除、替换为空字符串或触发错误。

### 9.3 Shortcut policy

第一版不启用 emoticon shortcuts：

```text
:)  → :)
:D  → :D
:-) → :-)
:(  → :(
```

shortcode aliases（如 `:+1:`、`:thumbsup:`）仍然全部有效；它们不是 emoticon shortcuts，不能因关闭 shortcuts 而被删除。

原因：

- 技术文档、URL、时间、配置和日志中的冒号密度高；
- emoticon 解析会增加 Markdown source 的隐式变化；
- knowledge base 更需要可预测的 round-trip 和可读 source；
- shortcode 形式已经足够表达第一版 Emoji。

## 10. Renderer 行为

### 10.1 普通文本

```markdown
Hello :smile: :rocket:
完成 :white_check_mark:
```

应分别输出对应的原生 Unicode 文本。

### 10.2 Inline code 与 fenced code

以下内容必须保持代码语义，不转换：

```markdown
`:smile:`
```

````markdown
```text
:smile:
```
````

Renderer 侧以 MarkdownIt 的 code tokenization 为准；Emoji rule 不能重新扫描 code token 的原始内容。

### 10.3 Link label、link destination 与 autolink

采用 upstream Emoji rule 的自然 token 语义，不为“看起来像 URL 的 explicit link label”增加 Nuvyn 特殊 parser：

| 内容 | 行为 |
| --- | --- |
| `[:smile:](https://example.com)` | explicit link label 转换为 `😄`；destination 保持 URL |
| `[https://example.com/:smile](https://example.com/:smile)` | explicit link label 中的 `:smile:` 也转换为 `😄`；destination 保持 URL |
| `<https://example.com/:smile>` | autolink URL 中不转换 |
| 普通文本 `Text :rocket: text` | 转换 |

Emoji 不得改变 link destination、autolink URL、href 或 sanitizer URI 判断。explicit Markdown link label 仍是正常 inline Markdown 内容，可以按普通文本规则处理；只有 upstream rule 明确识别的 autolink URL 区域不转换。不要为了识别 URL-looking label 增加第二套 URL parser。

### 10.4 与现有 Markdown extensions 的交互

- `==:smile:==`：Emoji 可作为 mark 内的普通文本转换，最终保持 `<mark>` 的既有语义。
- math 内容由 math plugin 负责；数学表达式内部的 `:name:` 不应被 Emoji rule 改写。
- inline code 和 fenced code 不转换。
- Wiki Link target/resolver 语义不改变。Wiki label 若被 MarkdownIt 暴露为普通 inline text，可按 link label 规则转换；target、alias 分隔符和 resolver 不得被 Emoji completion 或 renderer 改写。实现阶段必须增加一个真实 Wiki/Emoji 交互测试确认 token 行为。
- footnote、definition list、callout 仅在其中的普通文本节点中转换，不改变其 block/token 结构。

### 10.5 Raw HTML 与安全边界

Emoji 不在 raw HTML 属性、URL、script/style 等上下文中注入任何内容。Emoji renderer 只产生 Unicode text token；不得提供如下用户能力：

```yaml
emoji:
  smile: "<img src=...>"
```

如未来需要 custom Emoji，必须另立 PRD 和安全评审。

## 11. Emoji Data Source

### 11.1 方案比较

| 方案 | 优点 | 问题 | 结论 |
| --- | --- | --- | --- |
| A. 直接使用 upstream full dataset | 覆盖完整、语义接近 upstream | plugin public exports 不提供稳定 `emojiData`；Monaco 难以复用 | 不直接采用 |
| B. `lightEmoji` | 体积较小 | coverage 和 autocomplete 完整度不足 | 不采用 |
| C. Nuvyn curated subset | 简单、体积可控 | 漏掉用户需要的 alias，长期维护和产品解释成本高 | 不采用 |
| D. 只依赖 `@mdit/plugin-emoji` preset | parser 简单 | renderer 与 Monaco 只能依赖内部数据或维护第二份数据 | 不采用 |
| E. 兼容的第三方 Emoji package | 可能有现成 autocomplete data | 语义、license、alias 与 upstream 不一定一致 | 不采用 |
| F. Nuvyn-local generated data | renderer/Monaco 同源，可审计、可锁版本、可保留 aliases | 需要生成流程、license provenance 和更新责任 | **推荐** |

### 11.2 推荐数据架构

```text
upstream gemoji-json / Unicode provenance
        ↓ controlled generator
Nuvyn generated full definitions
        ├─ MarkdownIt Emoji plugin definitions
        └─ Monaco completion index
```

推荐的 parser 组合是：

- 使用 `@mdit/plugin-emoji` 的解析规则和默认 Unicode renderer；
- 使用 `bareEmoji` 注入 Nuvyn generated full definitions；
- 显式传入空 `shortcuts`，避免 upstream preset 的 emoticon defaults；
- Monaco 只读取同一个 generated definitions module 的名称、glyph 和 alias metadata，不复制一份 list。

这不是重新设计 Emoji parser；Nuvyn 只负责数据 provenance、产品配置和 Monaco adapter。

### 11.3 Full dataset 决策

采用 full dataset，理由：

- personal knowledge base 的内容来源广，用户可能使用不常见 Emoji；
- aliases 对 source readability 和迁移兼容有价值；
- autocomplete 可以用 ranking 和 30 项上限控制 UI 噪音；
- upstream 数据已经是 generated data，Nuvyn 不必手工维护每个 Unicode 映射。

full dataset 的体积必须在实现 PR 中用 production build 实测，而不是用理论值否决完整性。当前 npm metadata 显示 plugin package unpacked size 约 282 KB；这不是 Nuvyn 最终 bundle size，不能直接当作 bundle budget 结论。

### 11.4 License、attribution 与更新策略

未来实现若生成或分发 definitions，必须：

1. 保留 generated file 的 provenance header，记录 upstream source、source revision/version、生成日期和 generator 版本。
2. 在仓库现有 third-party notice 机制中保留 `@mdit/plugin-emoji` 的 MIT attribution，以及 `gemoji-json`/相关 Unicode 数据源的许可信息。
3. 不手工修改 generated data；更新通过明确的 data update PR 完成，并在 review 中检查新增/删除 aliases 和 license 变化。
4. 每次升级 `@mdit/plugin-emoji` 或 Emoji dataset 时重新核实 package exports、license、source provenance 和 MarkdownIt peer range。
5. 如果上游数据源的 Unicode provenance 或许可发生变化，在未完成法律/合规确认前不得发布新数据。

## 12. Monaco Emoji Completion

### 12.1 目标体验

用户输入：

```text
:smi
```

completion item 至少包含：

```text
😄 :smile:
```

选择后保存的 source 是：

```text
:smile:
```

Editor 显示 Unicode preview 是 completion UI 的 preview，不代表要把 Unicode 写入 Markdown source。

### 12.2 Completion item UI

| 字段 | 产品要求 |
| --- | --- |
| Label | `glyph + 空格 + :shortcode:`，例如 `😄 :smile:` |
| Detail | `Emoji`；不把 glyph 当作唯一名称 |
| Documentation | 可选；第一版不要求长描述、category 或 skin tone UI |
| InsertText | 插入 shortcode 的剩余部分，通常为 `smile:`，因为用户已输入 `:` |
| InsertTextRule | 复用现有 provider 的 `InsertAsSnippet` 路径；Emoji 不需要另建插入系统 |
| Replacement range | 从已输入 colon 之后的 query 起始位置到 cursor；colon 保留 |

示例：

```text
用户已输入 :smi
替换范围：smi
插入内容：smile:
最终 source：:smile:
```

如果 `/emoji` 只插入一个 colon，则 provider 的显式 invocation 可以展示 top suggestions；普通用户仅输入一个 colon 时不得无条件弹出全量列表。

### 12.3 Aliases

alias 是有效 source identifier，不因显示 glyph 相同而去重：

```text
:+1:       → 👍
:thumbsup: → 👍
```

completion 可以分别列出两个 item。item label 必须包含 shortcode，避免用户无法区分同 glyph 的 aliases。

### 12.4 搜索、排序与上限

MVP 排序：

1. exact shortcode match；
2. shortcode starts with query；
3. shortcode contains query；
4. alias/重复 glyph 仍保留，按同样的名称 ranking；
5. stable lexical fallback；
6. 相同 rank 时保持 generated dataset 的稳定顺序，不使用随机或时间相关排序。

每次最多返回 30 项。`MAX_EMOJI_SUGGESTIONS = 30` 是产品默认上限，后续可通过测量调整，但不得把 full dataset 全部塞入 Monaco suggestion list。

查询应对 ASCII shortcode 名称做规范化比较（至少 lowercase）；不要求把用户输入的 Unicode glyph 反向解析成 shortcode。

### 12.5 Unknown query

```text
:this_does_not_exist
```

应返回零个 Emoji suggestion，且不改写 source。未知 shortcode 在 renderer 中仍保持原文。

## 13. `/emoji` Slash Command

### 13.1 推荐实现行为

新增 Slash Command：

| 字段 | 值 |
| --- | --- |
| label | `emoji` |
| detail | `Emoji`（可配合现有中文 detail 搜索策略） |
| insertText | `:` |
| command | `editor.action.triggerSuggest` |
| insertion mode | 复用现有 Slash completion 的 `InsertAsSnippet` |

用户选择后进入 Emoji provider，不直接插入 glyph，不固定插入 `:smile:`。

### 13.2 Provider 连接

`/emoji` 必须连接到当前 model 的 Emoji completion provider，而不是新建 Emoji picker 或第二个 suggestion provider。实现阶段应使用 Monaco 已有的 completion invocation 语义或等价的短期显式上下文标记，使以下两类行为同时成立：

- 普通输入 `:` 不会在没有 query 时产生不可控的全量噪音；
- `/emoji` 插入 `:` 后可以立即进入有意义的 top suggestions。

现有 `/wiki` 的 command + `triggerSuggest` 路径是连接方式参考。Wiki target ranking、resolver、completion range 和命令行为不得复制或修改。

### 13.3 与现有 Slash Commands 的兼容

heading、list、task、quote、callout、math、code block、Mermaid、Markmap、table 和现有 `/wiki` 的 label、insertText、snippet placeholder、filtering 与 keyboard behavior 必须保持不变。

## 14. Trigger、Prefix 与 False Positive Rules

Renderer 的 shortcode 解析和 Monaco autocomplete 是两个独立边界：renderer 以 MarkdownIt token 为准；editor 以 cursor context 为准。两者应有相同的用户直觉，但不强求共享一个脆弱的 regex。

### 14.1 允许触发的基本条件

Emoji candidate 的 colon 必须：

- 位于行首，或前面是 whitespace，或前面是明确的普通文本/Markdown label boundary；
- colon 后只能有合法 name characters，至少包括 ASCII 字母、数字、下划线、连字符和 `+`；
- query 不含 whitespace、`/`、`\\`、`.`、第二个 colon 或 URL punctuation；
- cursor 不处于 inline code、fenced code、link destination、autolink URL 或 composition 状态。

正例：

```text
:s
:smi
:rocket
:+1
今天完成了 :rocket:
[:smi](https://example.com)
```

### 14.2 必须抑制的上下文

| 场景 | 例子 | 结果 |
| --- | --- | --- |
| URL destination/path | `https://example.com/:smile` | 不触发、不替换 URL |
| autolink URL | `<https://example.com/:smile>` | 不触发 |
| 时间 | `12:30`、`2026-08-12T14:30` | 不触发 |
| key/value | `key:value`、`name: value` | 不触发 |
| 双 colon | `foo::bar`、`::1` | 不触发 |
| Windows/path | `C:\Users` | 不触发 |
| CSS/config | `color: red` | 不触发 |
| inline code | `` `foo :smile:` `` | 不触发 |
| fenced code | fence 内的 `:smile:` | 不触发 |
| composition | 中文 IME composition 中的中间文本 | 不触发 |

“不触发”表示不提供 Emoji suggestions；不要求编辑器阻止用户手工输入文本。

### 14.3 Code context MVP

Renderer 侧必须完整保证 code token 不转换。Monaco 侧 MVP 必须覆盖常见 inline code 和 fenced code：

- inline code：使用当前行 cursor 附近的 Markdown code span 判断；
- fenced code：识别常见 backtick/tilde fence，并判断 cursor 是否位于未闭合 fence 内；
- 大文档：只做当前行和有限向前上下文分析，不扫描 500k+ 文档全文。

复杂嵌套 Markdown、异常 fence 或跨巨大区域的精确语法恢复可以作为后续增强，但不能作为 MVP 放弃明显的 code false positive 测试的理由。

### 14.4 中文、IME 与普通文本

```text
今天完成了 :rocket:
```

应正常触发。中文 IME composition 期间复用现有 `composing` 状态，抑制 Emoji suggestions；composition end 后再按正常规则判断。不得重构现有 IME architecture。

## 15. Markdown Plugin 顺序与 Architecture

### 15.1 推荐顺序

upstream Emoji rule 在 inline second-pass 中位于 `linkify` 之后，且只处理 inline text children。Nuvyn 实现阶段推荐将 Emoji plugin 注册在现有 `math` plugin 之后，作为当前 inline extension chain 的最后一个明确插件，同时保留 upstream rule 自己对 `linkify` 的相对位置。

目标 token 顺序：

```text
MarkdownIt core tokenization
→ code / links / linkify / math / Wiki token boundaries
→ Emoji inline text rule
→ Markdown HTML render
→ existing DOMPurify sanitizer
```

这样可以：

- 让 code token、math token 和 link destination 不被普通 text 扫描；
- 让普通 link label、mark、footnote/definition text 保持自然 inline 行为；
- 不改变现有 block plugin 的顺序语义；
- 不把 Emoji 变成 post-render HTML string replacement。

实现 PR 必须用真实 Nuvyn renderer 验证这个顺序，而不是只测试独立 MarkdownIt 实例。

### 15.2 不做的架构变化

- 不新建 `EmojiEngine`、`EmojiRuntime`、`EmojiRegistryService` 或 generic extension framework；
- 不让 Monaco 直接解析整篇 Markdown AST；
- 不将 Nuvyn math placeholder、Markmap 或 Mermaid lifecycle 与 Emoji 合并；
- 不为 Emoji 修改 raw HTML sanitizer 或 security boundary。

## 16. Security

安全不变量：

```text
known shortcode → Unicode text
unknown shortcode → original text
user definition → not supported
shortcode → arbitrary HTML/URL/script → impossible by design
```

必须保持：

| 安全项 | 目标 |
| --- | --- |
| Main Markdown sanitizer changed | **NO** |
| DOMPurify allowlist/denylist | 不变 |
| `<script>` / event attributes / unsafe URL | 继续由现有 sanitizer 处理 |
| Emoji output | 仅 native Unicode text |
| user frontmatter Emoji mapping | 禁止 |
| remote Emoji asset/CDN | 禁止 |
| custom HTML renderer | 不属于 MVP |

Emoji definitions 是受版本控制的 trusted application data，不是 Markdown author input。任何未来 custom Emoji 设计都必须重新审查 XSS、URL、asset 和 sanitizer 边界。

## 17. Compatibility

### 17.1 MarkdownIt

Emoji Phase 不升级 MarkdownIt major version。实现时必须 pin 已发布的 `@mdit/plugin-emoji@1.1.1`；Nuvyn 当前锁定的 14.2.0 满足该版本的 `^14.2.0` peer requirement。不要使用 upstream main 当前的 `^15.0.0` peer 状态，也不要跟随 future latest。

如果 Nuvyn 的受支持 Node runtime 低于 upstream package 的 `>=22` engine：

- 不得静默放宽 engine 或升级其它 runtime；
- 先选择与项目 runtime policy 兼容的 plugin release，或评估一个小型兼容 adapter；
- 该差异必须在依赖 PR 的 review 中明确记录。

### 17.2 Existing Markdown features

以下行为必须通过现有测试保持：

- task list checkbox；
- footnote；
- definition list；
- highlight/mark；
- Wiki Link target、alias、ranking、resolver；
- KaTeX math；
- Mermaid/Markmap placeholder 和 assets；
- fenced/inline code 与 highlight；
- raw HTML sanitizer、data attribute allowlist、unsafe URL policy。

### 17.3 Existing editor features

- existing Slash Commands 不改名、不改 insertText 和 placeholder 行为；
- `/wiki` 仍使用原有 completion，不引入 Emoji 对 Wiki 的共享搜索副作用；
- Monaco keyboard handling、IME composition、large document mode 不重构；
- Emoji completion 的 provider context 必须按 model URI 隔离，不能把一个文档的 query 或 suggestions 泄漏到另一个文档。

## 18. Performance

### 18.1 Renderer

Emoji rule 应只处理 MarkdownIt 已经产生的 inline text token，不重复扫描 HTML string，不对 DOM 做二次遍历。未知 shortcode 的处理应保持线性、无异常。

### 18.2 Monaco

- definitions 在模块加载/feature 首次使用时建立一次 normalized index；
- query 过滤只处理名称 index，不扫描整篇文档；
- 每次最多 30 个 CompletionItems；
- 不在每次按键时重新构造完整 Emoji definitions；
- 排序不能依赖网络、随机数或异步远程服务；
- large-document 模式仍允许 Emoji completion，因为工作量只与当前 query 和有限 cursor context 有关。

### 18.3 Bundle 与加载

full dataset 会增加 JS 数据量，这是选择完整 coverage 的明确 trade-off。实现阶段必须比较：

- renderer chunk 增量；
- editor chunk 增量；
- 是否因为两个入口重复打包 definitions；
- 首次 Markdown render 和首次 completion 的耗时。

MVP 先使用一个共享 generated module；只有 production build 实测超过项目 bundle budget 时，才评估 lazy/dynamic import。不得为了理论上的性能问题提前引入 registry 或复杂 loader。

建议实现验收目标：在代表性 desktop 文档中，已有 completion provider 的 query filtering 不产生可感知卡顿，单次过滤目标为一个 animation frame 内完成；如实测不能满足，必须以 profiling 结果驱动优化。

## 19. UX、Accessibility、Search 与 Copy/Paste

### 19.1 Source 与 Preview 分离

持久化 source：

```text
:rocket:
```

preview：

```text
🚀
```

保存、重新加载、重新渲染后仍保持 shortcode source。不得把 preview DOM 的 Unicode 反向写回 editor model。

### 19.2 Searchability

shortcode source 让用户可以搜索 `rocket`、`smile` 和 alias；直接输入的 Unicode（例如 `🚀`）也正常保存和显示。Nuvyn 不自动把用户手写的 Unicode normalize 成 shortcode。

### 19.3 Copy/Paste

- 复制 Markdown source 得到 `:rocket:`；
- 复制 preview 中的文本得到 `🚀`；
- 不增加隐藏 conversion layer，不修改浏览器原生 text selection 的语义。

### 19.4 Completion 可读性

completion item 同时显示 glyph 和 shortcode，避免只显示不可搜索的图形。原生 Unicode 的显示会受平台字体影响，但 source 仍然可读、可移植；第一版不引入图片 fallback。

## 20. Test Strategy

本节是后续实现的最低 Test Plan。当前 PRD 任务不新增测试代码。

### 20.1 Renderer unit tests

使用真实 Nuvyn Markdown renderer，至少覆盖：

1. `:smile:` → `😄`；
2. `:rocket:` → `🚀`；
3. `:+1:` → `👍`；
4. `:thumbsup:` 与 `:+1:` 都有效；
5. unknown shortcode 原样保留；
6. native Unicode 原样保留；
7. 多个 Emoji 和中文混合文本；
8. inline code 中的 `:smile:` 不转换；
9. fenced code 中的 `:smile:` 不转换；
10. explicit link label 可转换（包括 URL-looking label）、link destination 不转换；
11. autolink URL 不转换；
12. `12:30`、`key:value`、`foo::bar` 等普通 colon 文本不被错误转换；
13. `:)`、`:D`、`:-)` 在 shortcut disabled policy 下保持原文；
14. 与 highlight、math、Wiki、footnote、definition list 同文档时 token 结构和既有功能不变；
15. malformed shortcode 不抛异常、不吞掉周围文本；
16. existing sanitizer security tests 继续通过，且 Emoji 不改变 sanitizer policy。

### 20.2 Shared data tests

1. generated definitions 包含 `smile`、`rocket`、`+1` 和 alias `thumbsup`；
2. renderer 和 Monaco 使用同一 data module，而非两个独立常量；
3. generated header 包含 source、revision、license/provenance；
4. definitions 中不存在用户 frontmatter 或运行时 HTML；
5. aliases 不因 glyph 相同而被数据层去重；
6. update/regeneration 校验能检测 generated data 与 generator 输出不一致。

### 20.3 Monaco completion unit/component tests

沿用 `monacoMarkdown.test.ts`、`MonacoEditorPane.test.ts` 的真实 provider 调用路径，至少覆盖：

1. `:smi` 返回 `smile` item；
2. item label 同时显示 `😄` 和 `:smile:`；
3. `:smi` 的 replacement range 只替换 `smi`，不删除 colon；
4. 选择后 source 为 `:smile:`；
5. `:+1` 和 `:thumbsup` 均能独立建议；
6. unknown query 返回零 suggestion；
7. exact/startsWith/contains/stable fallback ranking 正确；
8. 返回数量不超过 30；
9. `InsertAsSnippet` 经过现有 provider insertion path；
10. 普通 `:` 不产生无限/全量噪音，`/emoji` 显式 invocation 能产生 top suggestions；
11. `/emoji` 插入 `:` 并触发 `editor.action.triggerSuggest`；
12. Slash filtering 能找到 `emoji`，且现有 `footnote`、`highlight`、`definition list`、`wiki` 与旧命令不回归；
13. URL、time、ISO date、key/value、双 colon、Windows path、CSS/YAML 场景不触发；
14. inline code 和 fenced code 内不触发；
15. 中文文本正常，IME composition 中不触发，composition end 后恢复；
16. large document 不执行全文扫描；
17. provider 按 model context 隔离，A 文档 query 不影响 B 文档；
18. Wiki completion 仍使用原有 ranking/resolver，Emoji 不复制或修改 Wiki 逻辑。

### 20.4 Integration / browser tests

建议使用现有 Markdown visual fixture，增加一个小型 Emoji specimen，至少包含：

```markdown
Hello :smile: :rocket:

`:smile:`

```text
:smile:
```

Unknown :not_an_emoji:
```

浏览器断言应限定在 article preview 容器内：

- 预览出现 `😄`、`🚀`；
- inline/fenced code 保留 `:smile:`；
- unknown shortcode 保留；
- 不要求像素级 Emoji glyph snapshot，因为 native font 由平台决定；
- 不使用 fixed `waitForTimeout`、retry 或 skip 掩盖异步问题。

如果增加 Monaco browser test，使用真实 Monaco model：输入 `:smi`，选择 item，断言 editor source 为 `:smile:`，再断言 preview 为 `😄`。该 E2E 应是一个小型 functional test，不建立大型新的 editor suite。

### 20.5 Regression gates

后续实现 PR 必须运行项目现有 typecheck、unit test 和相关 Markdown/Monaco focused tests；还必须保留现有 Mermaid、Markmap、KaTeX、sanitizer、Wiki、Slash Command 测试。

## 21. Acceptance Criteria

### Renderer

- [ ] 支持已知 `:emoji_name:` shortcode。
- [ ] `:smile:` 正确显示 `😄`。
- [ ] `:rocket:` 正确显示 `🚀`。
- [ ] `:+1:` 正确显示 `👍`。
- [ ] alias `:thumbsup:` 与 `:+1:` 都有效。
- [ ] unknown shortcode 保留原文。
- [ ] native Unicode Emoji 保持原样。
- [ ] inline code 不转换。
- [ ] fenced code 不转换。
- [ ] explicit link label 可以转换，包括 URL-looking label。
- [ ] link destination 和 autolink URL 不转换。
- [ ] 第一版不启用 `:)`、`:D`、`:-)` 等 emoticon shortcuts。
- [ ] malformed shortcode 不抛异常、不吞掉相邻文本。

### Data 与安全

- [ ] renderer 与 Monaco 共用一份 full Emoji definitions source。
- [ ] full definitions 保留 aliases，不按 glyph 去重。
- [ ] generated data 有 source、revision、license/provenance 记录。
- [ ] Emoji 不接受用户 frontmatter custom mapping。
- [ ] Emoji 不输出 arbitrary HTML、SVG、image 或 remote asset。
- [ ] Main Markdown sanitizer changed: **NO**。
- [ ] 现有 DOMPurify security tests 全部继续通过。

### Monaco

- [ ] `:query` completion 可用。
- [ ] `:smi` 能建议 `😄 :smile:`。
- [ ] suggestion 显示 Unicode preview + shortcode。
- [ ] selection 保存 shortcode source，不保存 glyph。
- [ ] replacement range 不重复 colon。
- [ ] alias 可以分别搜索和选择。
- [ ] suggestion 数量有上限，默认不超过 30。
- [ ] 排序为 exact、startsWith、contains、stable fallback，结果可预测。
- [ ] unknown query 无 suggestion。
- [ ] inline/fenced code、URL、time、key/value、path、CSS/YAML 场景不误触发。
- [ ] 中文文本正常，IME composition 不产生错误 suggestions。
- [ ] large document 不扫描全文。
- [ ] Monaco 实际使用现有 `InsertAsSnippet` insertion path。

### Slash Command 与兼容性

- [ ] `/emoji` 存在。
- [ ] `/emoji` 选择后插入 `:` 并触发既有 completion provider。
- [ ] `/emoji` 不直接插入 Unicode，不固定插入 `:smile:`。
- [ ] Wiki completion 不变，不创建第二套 Wiki search/ranking。
- [ ] 现有 Slash Commands、Markdown renderer、Markmap、Mermaid、KaTeX 和 sanitizer 无回归。
- [ ] 不升级 MarkdownIt major version。
- [ ] 不引入 Twemoji 或 remote Emoji assets。

## 22. 风险与缓解

| 风险 | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| MarkdownIt/plugin peer version drift | Medium | High | 当前锁定 14.2.0；选择 peer-compatible plugin；禁止混入 15.x migration |
| upstream Node engine `>=22` 与 Nuvyn runtime policy 不一致 | Medium | High | 依赖 PR 前核实 supported Node floor；不静默破坏旧 runtime |
| full dataset bundle 增大 | Medium | Medium | 共享 generated module、上限 30、production build 测量；仅在实测超预算时 lazy load |
| colon false positive | High | High | 严格 boundary/context rules；renderer 与 Monaco 分别测试 URL、time、key/value、code |
| inline/fenced code context 判断不完整 | Medium | High | renderer 依赖 MarkdownIt token；editor MVP 做常见 code context 检测；复杂情况列为后续增强 |
| alias 与重复 glyph 产生 UI 噪音 | Medium | Medium | 保留 aliases，但 label 显示 shortcode；stable ranking + 30 项上限 |
| upstream dataset 漂移 | Medium | Medium | generated data 锁 revision；更新 PR 检查数据、license、aliases 和 parser version |
| license/provenance 遗漏 | Low/Medium | High | generated header、third-party notice、更新时重新核实 gemoji/Unicode provenance |
| link label/destination 解析差异 | Medium | Medium | 依赖 upstream token rule；加入普通 link、autolink、Wiki label 的真实 renderer tests |
| native Emoji glyph 跨平台差异 | Medium | Low | 不做像素级 glyph snapshot；功能断言 source/text semantics |
| IME composition 中 suggestion 噪音 | Medium | Medium | 复用现有 composing 状态；组件测试覆盖中文输入流程 |
| provider 对大文档产生额外扫描 | Low/Medium | High | 只使用当前 line/有限上下文；性能测试和 large-document regression gate |

## 23. Architecture Decision Records

### ADR-1：Markdown source 使用 shortcode

**Decision**：持久化 source 使用 `:rocket:`，不自动写入 `🚀`。

**Reason**：可搜索、可读、可移植，且能稳定 round-trip。用户可以明确区分 source 与 preview。

**Trade-offs**：source 比直接 Unicode 更冗长；需要 renderer definitions 和 Monaco completion 支持未知名称/aliases。

### ADR-2：Preview 使用 native Unicode Emoji

**Decision**：默认 renderer 输出原生 Unicode，不引入图片或 SVG。

**Reason**：无远程依赖、无额外 asset lifecycle、DOM 简单、不会扩展 sanitizer attack surface。

**Trade-offs**：不同平台字体和 glyph 外观可能不同，不能用跨平台像素 snapshot 作为验收标准。

### ADR-3：第一版关闭 emoticon shortcuts

**Decision**：`:)`、`:D`、`:-)`、`:(` 不转换；只有闭合且已知的 `:name:` shortcode 转换。

**Reason**：避免技术文档、时间、URL、配置和日志的隐式误命中，保证 Markdown source 可预测。

**Trade-offs**：习惯 emoticon 的用户需要使用 named shortcode 或原生 Unicode。

### ADR-4：Renderer 与 Monaco 共用 generated full definitions

**Decision**：使用 Nuvyn-local generated canonical data，同时供 MarkdownIt plugin 和 Monaco completion 使用。

**Reason**：避免 upstream parser 一份数据、editor 另一份数据造成 drift；保留 full coverage 和 aliases。

**Trade-offs**：Nuvyn 需要维护生成流程、source revision 和 license attribution；不能直接依赖 upstream 未公开的 `emojiData` export。

### ADR-5：不为了 Emoji 升级 MarkdownIt major version

**Decision**：Emoji Phase 保持 MarkdownIt 14.x，并 pin 已发布的 `@mdit/plugin-emoji@1.1.1`；当前 lockfile 的 14.2.0 满足该发布版本的 peer range。upstream main 的 MarkdownIt 15 迁移另立 RFC。

**Reason**：这是局部 Markdown extension，不足以证明一次 parser major migration 的收益；major migration 应另立 RFC。

**Trade-offs**：如果未来 plugin 只支持 MarkdownIt 15，需要选择仍兼容 14.x 的 release 或单独做 migration，不把两个风险叠加。

### ADR-6：`/emoji` 复用 Monaco completion

**Decision**：`/emoji` 插入 `:`，调用现有 `editor.action.triggerSuggest`，继续使用同一个 Emoji provider。

**Reason**：与现有 `/wiki` 体验一致，复用 range、keyboard navigation、IME 和 Monaco suggestion infrastructure。

**Trade-offs**：需要 provider 区分普通 colon trigger 与显式 `/emoji` invocation，避免空 query 的 suggestion 噪音。

### ADR-7：不引入 Twemoji

**Decision**：MVP 不使用 Twemoji、SVG Emoji、image Emoji 或 CDN Emoji。

**Reason**：减少依赖、license、asset loading、DOM/SVG sanitizer 和跨 subsystem 生命周期风险。

**Trade-offs**：视觉呈现依赖系统字体，不提供统一品牌化 glyph。

### ADR-8：不支持用户自定义 Emoji definitions

**Decision**：definitions 是受版本控制的 trusted application data，不来自 Markdown/frontmatter。

**Reason**：防止 shortcode 变成任意 HTML/URL/script 注入入口，维持现有 DOMPurify boundary。

**Trade-offs**：workspace/custom Emoji 需要独立的 product、storage、security 和 licensing 设计。

## 24. Future Enhancements

### Phase 2

- Emoji picker UI；
- categories；
- recent/frequently used Emoji；
- skin tone variants；
- 更丰富的 keyboard navigation 和 accessibility metadata。

### Phase 3

- workspace/custom Emoji；
- 用户或团队 aliases；
- 可审计的 custom asset pipeline；
- 如有明确产品需求，再评估统一视觉 Emoji renderer。

上述能力不得通过修改本 MVP 的 sanitizer、Markmap、Mermaid 或主 math architecture 来提前实现。

## 25. Open Questions

当前产品行为决策已足够启动实现，暂无必须由用户再次确认的 open question。

唯一的实现前置核验是：Nuvyn 的受支持 Node runtime floor 是否满足 `@mdit/plugin-emoji@1.1.1` 的 `>=22` engine。若不满足，应在依赖 PR 中选择兼容版本或局部兼容方案；这不改变本 PRD 的 shortcode、full data、shortcut 和 completion 产品决策。

## 26. Implementation Phases（仅规划，不在本任务执行）

### Phase E1 — Renderer

交付：

- Emoji dependency/version compatibility decision；
- generated full definitions 和 provenance；
- `:name:` → native Unicode renderer；
- empty shortcut configuration；
- renderer unit/regression tests。

退出条件：未知 shortcode、code、URL、native Unicode、aliases 和现有 Markdown/security tests 全部符合本 PRD。

### Phase E2 — Monaco Completion

交付：

- shared definitions adapter；
- colon context detection；
- range、ranking、30 项上限、alias UI；
- `InsertAsSnippet` provider tests；
- code/URL/time/key/value/IME/large-document tests。

退出条件：`:smi` 可以可靠选择并保存 `:smile:`，且不产生已定义的 false positives。

### Phase E3 — Slash Command

交付：

- `/emoji` command；
- insert `:`；
- `editor.action.triggerSuggest` 连接；
- explicit invocation 与普通 colon trigger 的区分；
- Slash Command compatibility tests。

退出条件：`/emoji` 进入同一 Emoji completion，旧 Slash/Wiki 行为不变。

### Phase E4 — Integration Verification

交付：

- renderer browser specimen；
- 可行时增加真实 Monaco functional E2E；
- full test/typecheck；
- production bundle measurement；
- license/provenance review；
- Code Review checklist 全部通过。

退出条件：本 PRD 的 Acceptance Criteria 全部满足，且没有通过 skip、retry、fixed sleep 或 snapshot 放宽来掩盖问题。

## 27. Implementation / Code Review Guardrails

未来实现 PR 必须满足：

- 不修改主 Markdown sanitizer 来适配 Emoji；
- 不修改 Markmap、Mermaid、KaTeX architecture；
- 不升级 MarkdownIt major version；
- 不把 Unicode preview 写回 Markdown source；
- 不复制 Wiki completion、ranking 或 resolver；
- 不新增 Emoji HTML/image/remote asset renderer；
- 不以一个独立 Emoji data list 取代 shared generated source；
- 不在 completion provider 中扫描全文；
- 不为测试困难添加 `.skip`、`.todo`、retry 或 fixed sleep；
- 不借 Emoji Phase 顺手重构 Monaco、Markdown plugin chain 或 generic post-mount framework。

本任务的 scope lock 是：只新增本文档，停止于 PRD review，不开始任何 Emoji implementation。

## 28. References

### Nuvyn repository findings

- `package.json`
- `src/lib/markdown.ts`
- `src/components/vault/EditorPane.vue`
- `src/components/vault/monacoMarkdown.ts`
- `src/components/vault/monacoMarkdownProviders.ts`
- `src/lib/__tests__/markdown.test.ts`
- `src/lib/__tests__/wikiLinks.test.ts`
- `src/components/vault/__tests__/monacoMarkdown.test.ts`
- `src/components/vault/__tests__/MonacoEditorPane.test.ts`
- `e2e/markdown-visual.spec.ts`
- `docs/README.md`
- `docs/design/authentication-v1-prd.md`

### Upstream sources

- [Official `@mdit/plugin-emoji` documentation](https://mdit-plugins.github.io/emoji.html)
- [Published npm 1.1.1 package manifest](https://registry.npmjs.org/@mdit%2fplugin-emoji/1.1.1)
- [Current upstream main package manifest](https://github.com/mdit-plugins/mdit-plugins/blob/main/packages/plugin-emoji/package.json)
- [Preset implementation](https://github.com/mdit-plugins/mdit-plugins/blob/main/packages/plugin-emoji/src/full.ts)
- [Emoji rule implementation](https://github.com/mdit-plugins/mdit-plugins/blob/main/packages/plugin-emoji/src/rule.ts)
- [Renderer implementation](https://github.com/mdit-plugins/mdit-plugins/blob/main/packages/plugin-emoji/src/render.ts)
- [Upstream data update script](https://github.com/mdit-plugins/mdit-plugins/blob/main/packages/plugin-emoji/scripts/update.ts)
- [`gemoji-json` source and license](https://github.com/delthas/gemoji-json)
- [npm registry metadata for `@mdit/plugin-emoji`](https://registry.npmjs.org/@mdit%2fplugin-emoji/latest)
