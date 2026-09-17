# Nuvyn Emoji Support Implementation Plan

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | Ready for Implementation |
| 产品 PRD | [`docs/design/emoji-support-prd.md`](./emoji-support-prd.md) |
| Implementation Plan baseline | `85b97a80176138d6a11b1f7a3095e242344395f2` |
| 计划日期 | 2026-08-12 |
| 本任务范围 | 只产出实施计划，不执行 Emoji implementation |
| 目标 | 将已批准 PRD 拆成可执行、可测试、可 review 的 E1–E4 工作包 |

这份文档回答“实现时改哪些文件、以什么顺序改、每一步如何验证”。产品行为、范围和主要架构决策以 PRD 为准；如果本计划与 PRD 冲突，应停止实现并先修订 PRD，而不是在代码中自行改变产品语义。

本次任务明确不做：

- 不修改 `src/`、`scripts/`、`e2e/` 或测试代码。
- 不修改 `package.json`、`package-lock.json`、`pnpm-lock.yaml`。
- 不安装 npm dependency。
- 不生成或提交 Emoji 数据文件。
- 不升级 MarkdownIt。
- 不实现 Emoji renderer、Monaco completion 或 `/emoji`。

---

## 2. 执行前的冻结结论

以下决策已经由 Emoji PRD 确定，实施阶段不得重新打开为代码级临时选择。

| 主题 | 冻结决策 |
| --- | --- |
| Markdown source | 使用 shortcode，例如 `:rocket:` |
| Preview | 输出 native Unicode Emoji，例如 `🚀` |
| 未知 shortcode | 原文保留，不报错、不吞掉 |
| 原生 Unicode | 原样保留，不反向 normalize 为 shortcode |
| emoticon shortcuts | MVP 不启用；`:)`、`:D`、`:-)`、`:(` 等保持原文 |
| 数据 | full dataset；renderer 与 Monaco 共用同一份 Nuvyn-local generated definitions |
| renderer plugin | 使用 `@mdit/plugin-emoji@1.1.1` 的可兼容入口，并显式关闭 shortcuts |
| MarkdownIt | 保持当前 14.x；不得升级到 15.x |
| upstream 线 | 只使用已发布 npm `1.1.1`；不依赖 GitHub `main` 或 future latest |
| Monaco source insertion | completion 选择后仍保存 shortcode，不保存 glyph |
| `/emoji` | 插入 `:`，随后复用现有 Monaco completion / `triggerSuggest` 路径 |
| suggestion UI | Unicode glyph + shortcode；最多 30 项；保留 aliases |
| preview assets | 不引入 Twemoji、SVG Emoji、图片、CDN 或远程 Emoji asset |
| author customization | 不允许 frontmatter 或 Markdown 定义自定义 HTML Emoji |
| sanitizer | DOMPurify policy 不变；Emoji 只产生文本，不产生 HTML |

实施阶段若发现上述决策需要改变，必须回到 PRD/RFC review，不得借实现便利悄悄变更。

---

## 3. 当前基线架构审计

### 3.1 依赖和运行时

当前真实仓库状态：

- `package.json` 声明 `markdown-it: ^14.1.0`。
- `package-lock.json` 和 `pnpm-lock.yaml` 当前实际解析到 `markdown-it@14.2.0`。
- `@mdit/plugin-emoji` 尚未存在于 `package.json` 或 lockfile。
- 当前 Markdown 依赖链已经包含 `katex`、`dompurify`、task list、footnote、definition list、mark、Wiki Link、Mermaid 和 Markmap 相关能力。
- README、开发文档、Docker 和 GitHub Actions 的安装/CI 主路径使用 npm；CI 明确执行 `npm ci`。
- Node 22/24 都在现有 CI 矩阵中，满足已发布 `@mdit/plugin-emoji@1.1.1` 的 Node `>=22` engine 要求。
- 仓库同时跟踪 `pnpm-lock.yaml`，但 `pnpm-workspace.yaml` 不是 CI 的安装入口；历史上两个 lockfile 的更新并不完全一致。

因此，未来依赖 PR 的最低要求是：

1. `package.json` 使用精确版本 `@mdit/plugin-emoji: 1.1.1`，不得使用 `^` 或 `latest`。
2. `package-lock.json` 必须与 npm CI 安装结果一致。
3. 在提交依赖 PR 前确认仓库是否要求同步 `pnpm-lock.yaml`。若仍将其视为受支持的可复现入口，则一并同步并检查无无关变更；若 npm 是唯一受支持入口，则需要在 PR 描述中记录这一事实，不能默默留下漂移。
4. 不改变 `markdown-it` 的版本范围或 major。

### 3.2 Nuvyn Markdown renderer

`src/lib/markdown.ts` 当前使用异步缓存的 MarkdownIt singleton：

1. 先构建 highlight 函数。
2. 创建 `MarkdownIt({ html: true, linkify: true, typographer: true })`。
3. 按当前顺序启用 task list、anchor、footnote、definition list、mark、Wiki Link、callout、math 等插件。
4. 覆盖 table renderer 等 Nuvyn-specific renderer 行为。
5. `render()` 得到完整 HTML 后进入现有 `sanitizeMarkdownHtml()` / DOMPurify boundary。

注意：当前选项没有 `breaks: true`。Emoji 计划不能把它写成 breaks 已开启，也不能借 Emoji 修改 MarkdownIt options。

当前主 sanitizer 禁止危险标签、事件属性、style、URI 风险和 raw `math`/`svg` 等内容。Emoji 必须只返回 Unicode text；不得新增 sanitizer allowlist，也不得把 Emoji 变成 `<img>`、SVG 或自定义 HTML。

### 3.3 Math、Wiki 和插件边界

- `src/lib/math.ts` 负责 Nuvyn 自己的 math placeholder 生命周期。Emoji implementation 不得修改它，也不得把 Markmap Math 混入 Nuvyn math subsystem。
- `src/lib/wikiLinks.ts` 负责 `[[Target]]` 及 alias 的解析；Emoji implementation 不得复制或改变 Wiki resolver、target ranking、href 语义。
- 当前 Emoji 应作为当前 Markdown extension chain 的最后一个明确 Nuvyn plugin 候选，但 upstream rule 自身会在 MarkdownIt core ruler 中相对 `linkify` 注册。实现时要以实际 token tests 验证，而不是仅凭调用顺序推断。

### 3.4 Monaco completion 架构

实际路径为：

```text
EditorPane.vue
  → 当前 Markdown model 的 completion provider
  → slash / fence / Wiki / heading 等上下文分支
  → Monaco CompletionItem
  → InsertAsSnippet
  → 可选 editor.action.triggerSuggest
```

当前关键事实：

- `MARKDOWN_SLASH_COMMANDS` 位于 `src/components/vault/monacoMarkdown.ts`。
- slash completion 在 `src/components/vault/EditorPane.vue` 中根据当前行前缀识别 `/...`，并使用 `CompletionItemKind.Snippet`、`insertTextRules: InsertAsSnippet`、range 和 command。
- 当前 slash provider 已有 `/wiki` 的最小链路：插入 `[[`，再执行 `editor.action.triggerSuggest`，由现有 Wiki provider 继续处理。
- `monacoMarkdownProviders.ts` 为 model context 做 URI 隔离，并注册全局 Markdown completion provider；目前 trigger characters 包括 `[`, backtick 和 `/`。
- `EditorPane.vue` 的 provider 读取当前行局部内容；completion 不应改成全量 `model.getValue()` 扫描。
- 已有 `composing` 状态及 composition start/end 处理；当前它主要用于阻止 composition 中间态直接 emit 为正式 modelValue，现有 completion provider 尚不会仅因 `composing === true` 自动返回空 suggestions。
- E2 应复用这个已有 state，并新增 Emoji completion-level composing guard；不要创建 Emoji-specific IME state，也不要把“现有 completion 已处理 IME”写成当前能力。
- `isLargeDocument` 对 500k+ 文档关闭部分 decoration/folding 行为；Emoji completion 只能使用当前行和必要的受限上下文，不能因为加入 `:` trigger 而扫描整篇文档。
- 当前 Monaco 已有 Markdown completion provider、Wiki/slash completion、opening-fence language completion、line-local input、`composing` state、composition start/end listeners、model URI isolation 和 500k+ large-document threshold。
- 当前 opening-fence language completion 只处理正在输入 fenced-code opening line、并为语言标识提供建议的分支；它不是通用的 `isCursorInsideFencedCode()` 能力。
- 当前不存在可复用的 inline-code completion guard、fenced-code cursor-context detector、generic Markdown code-context helper、Emoji completion-level `composing` guard 或 Emoji context parser。Emoji E2 必须实现这些最小能力，但不得创建第二套 Markdown parser。

### 3.5 当前测试和浏览器验证

- `src/lib/__tests__/markdown.test.ts` 使用真实 Nuvyn `render()`，覆盖 math、Wiki、footnote、definition list、highlight、task list、raw HTML sanitizer 等行为；它是 Emoji renderer 集成测试的主入口。
- `src/lib/__tests__/wikiLinks.test.ts` 适合保留 Wiki plugin 的专项回归，但不能替代完整 Nuvyn renderer test。
- `src/components/vault/__tests__/monacoMarkdown.test.ts` 适合纯函数、slash command、ranking、range/context helper 测试。
- `src/components/vault/__tests__/MonacoEditorPane.test.ts` 已 mock Monaco registry 和 editor command，可验证真实 provider 路径、`InsertAsSnippet`、Wiki slash、IME 和大文档行为。
- `src/views/MarkdownTestView.vue` 是现有 Markdown visual fixture；`e2e/markdown-visual.spec.ts` 已覆盖普通 Markdown、math、Wiki、Mermaid、Markmap 等。
- Playwright 当前使用真实 Vite server，通常 `workers: 1`、`retries: 0`；Emoji 验收应使用 locator/auto-wait，不得用固定 sleep、重试或 skip 掩盖问题。
- 当前没有 Emoji implementation 或 Emoji data module；也没有需要立即修改的 license/notice 文件。实现阶段若提交 generated data，必须先确认仓库的第三方 attribution 约定。

---

## 4. Upstream 和依赖策略

### 4.1 必须锁定已发布 artifact

Emoji MVP 的依赖基线是已发布的 `@mdit/plugin-emoji@1.1.1`，不是 GitHub moving branch。

| 来源 | MarkdownIt peer | 本阶段处理 |
| --- | --- | --- |
| npm `@mdit/plugin-emoji@1.1.1` | `^14.2.0` | 允许作为 MVP 基线 |
| upstream GitHub `main`（review snapshot） | `^15.0.0` | 不采用，不跟随 |
| Nuvyn 当前实际 lock | `markdown-it@14.2.0` | 保持不变 |

这个区分必须写在依赖 PR 和 code review 描述中。main 的 package version 字段可能仍显示 `1.1.1`，不能只看 version 判断 peer compatibility。

实现前的 artifact verification：

1. 从 npm 发布 manifest 和 tarball 检查 `1.1.1` 的 peer、engine、exports、license 和实际 dist API。
2. 确认 `markdown-it@14.2.0` 满足 peer。
3. 确认实现引用的是公开 export，不读取 upstream 仓库内部源码路径或未承诺的 `emojiData` dist 路径。
4. 若已发布 tarball 与 PRD 记载不一致，停止 E1 dependency commit，先更新 PRD/plan。

参考资料：

- [mdit-plugins Emoji documentation](https://mdit-plugins.github.io/emoji.html)
- [Published `@mdit/plugin-emoji@1.1.1` manifest](https://registry.npmjs.org/@mdit%2fplugin-emoji/1.1.1)
- [Upstream plugin package manifest](https://github.com/mdit-plugins/mdit-plugins/blob/main/packages/plugin-emoji/package.json)
- [gemoji-json source](https://github.com/delthas/gemoji-json)

### 4.2 API 选择

upstream 提供的语义应按以下方式使用：

- `fullEmoji`：提供完整默认 definitions，同时带有 upstream 默认 shortcut 语义；不直接使用，因为 MVP 明确关闭 emoticon shortcuts。
- `lightEmoji`：覆盖较小；不满足 full dataset 决策。
- `bareEmoji`：接收 definitions、shortcuts、enabled 等选项，是 Nuvyn 需要的最小 public integration point。

推荐实现使用 `bareEmoji`：

- `definitions` 指向 Nuvyn generated full definitions。
- `shortcuts` 显式为空，确保 `:)`、`:D` 等不被转换。
- 不提供用户可修改的 definitions。
- 不提供 custom HTML renderer；使用 Unicode text renderer。

upstream rule 的已知特征：

- 识别 `:emoji_name:` shortcode。
- 未知名称保持原文。
- renderer 输出 Unicode glyph，而不是远程资源。
- 在 MarkdownIt core 中相对 `linkify` 注册规则。
- autolink URL 区域和普通 explicit Markdown link label 的处理不同；实现必须用真实 tests 固化自然 token 语义，不额外写 URL-looking label parser。

### 4.3 数据来源和 provenance

建议的长期数据流：

```text
pinned gemoji-json / upstream source revision
        ↓ deterministic generator
committed Nuvyn generated definitions
        ↓
┌──────────────────────┐
│ Markdown renderer    │
│ Monaco autocomplete  │
└──────────────────────┘
```

要求：

- generated definitions 是唯一运行时 Emoji mapping source。
- runtime shared entry 的最小语义是 `{ name: string, glyph: string }`；source 中的每个 alias 展开为独立 entry，renderer 视图可由同一份数据投影为 `Record<shortcode, glyph>`。
- 不让 renderer 从 `@mdit/plugin-emoji` 私有 dist 导出读取一份数据，同时让 Monaco 手工复制另一份。
- aliases 保留，例如 `:+1:` 和 `:thumbsup:` 都有效，即使 glyph 相同。
- 不按 glyph 去重 shortcode。
- generator 输出必须稳定排序、可重复生成、无运行时网络请求。
- generated artifact header 只记录可复现的 provenance：source、pinned source revision、由该 revision metadata 派生的 source revision date、generator version、license 和 attribution reference；不记录 generator 执行时的 wall-clock 时间。
- header 的固定字段为 `Generated file — do not edit manually`、`Source`、`Source revision`、`Source revision date`、`Generator version`、`License`；如果未来已有 `SOURCE_DATE_EPOCH` policy，可以复用，但 Emoji MVP 不建立这套 infrastructure。
- wall-clock regeneration time is review metadata only；它可以写入 PR description、commit message 或 release notes，但不能进入 generated artifact。
- source、license 和 attribution 必须在实现 PR 中随 generated data 一并可追溯；不能只在 commit message 中口头说明。
- 如果 generator 需要新的 dev-only data package，必须单独说明其 license、lockfile 影响和维护方式；不得把数据包作为运行时依赖无理由打入 bundle。

---

## 5. 目标架构和不变量

### 5.1 Renderer 数据流

```text
Markdown source :rocket:
        ↓
MarkdownIt 14 + existing Nuvyn plugins
        ↓
Emoji token / text renderer
        ↓
Unicode text 🚀
        ↓
existing DOMPurify boundary, unchanged
        ↓
preview
```

Emoji plugin 不能产出 author-controlled HTML。未知 shortcode、原生 Unicode、代码内容和 URL destination 必须有明确 token 保护。

### 5.2 Editor 数据流

```text
user types :smi
        ↓
Markdown completion provider checks local context
        ↓
shared generated definitions + deterministic ranking
        ↓
≤ 30 CompletionItems: `😄 :smile:`
        ↓
replace only current shortcode query with `smile:`
        ↓
existing leading `:` remains
        ↓
source becomes :smile:
```

Completion item 的插入文本不应保存 glyph；UI label 可以显示 glyph + shortcode。replacement range 必须只覆盖 `smi`，或在 query 已包含前导冒号时覆盖完整 query，具体取决于现有 provider range convention，但最终 source 必须恰好是 `:smile:`。

### 5.3 `/emoji` 数据流

```text
/emoji slash command
        ↓
InsertAsSnippet inserts `:`
        ↓
existing editor.action.triggerSuggest path
        ↓
Emoji provider is explicitly invoked for empty query
        ↓
shared completion items
```

`/emoji` 不直接插入 `😀`，不直接插入固定 `:smile:`，不创建独立 popup，不复制 Wiki ranking。

### 5.4 不变量

实现和 review 必须始终能回答：

- renderer 和 Monaco 是否读同一份 definitions？必须是。
- source 是否仍是 shortcode？必须是。
- renderer 是否只输出文本？必须是。
- `:)` 是否仍是原文？MVP 必须是。
- completion 是否避免全量文档扫描？必须是。
- `/emoji` 是否复用现有 suggestion command path？必须是。
- sanitizer、math、Wiki、Markmap、Mermaid 是否被改动？不得被无关改动。

---

## 6. 未来实现的文件变更地图

下表是后续 implementation PR 预期修改范围；本次计划生成任务没有修改这些文件。

| 文件 | 阶段 | 预期职责 | 不应承担的职责 |
| --- | --- | --- | --- |
| `package.json` | E1 | 精确加入 `@mdit/plugin-emoji@1.1.1`；必要时加入受审计的 generator dev dependency | 不升级 MarkdownIt；不加入 renderer/Monaco 两套数据依赖 |
| `package-lock.json` | E1 | 与 npm CI 安装结果同步 | 不产生无关升级 |
| `pnpm-lock.yaml` | E1 | 仅在仓库政策要求时同步 tracked importer | 不以 lockfile 变更顺带升级依赖 |
| `scripts/generate-emoji-data.mjs` | E1 | 从 pinned source 生成稳定 definitions | 不在运行时联网；不执行用户数据 |
| `src/lib/generated/emojiData.ts` | E1 | committed generated full definitions | 不手工编辑；不放 Monaco 逻辑 |
| `src/lib/emoji.ts` | E1/E2 | 共享 definitions adapter、entry index、规范化和纯 ranking | 不持有 editor instance；不解析整篇 Markdown |
| `src/lib/markdown.ts` | E1 | 注册 `bareEmoji`，传入 shared definitions 和空 shortcuts | 不改 sanitizer、math、Wiki 或全局 options |
| `src/components/vault/monacoMarkdown.ts` | E2/E3 | `/emoji` command 数据；必要的纯 Emoji query/context 类型导出 | 不复制 definitions；不实现另一套搜索服务 |
| `src/components/vault/EditorPane.vue` | E2/E3 | `:` trigger、context guard、CompletionItems、`/emoji` 连接 | 不新增 picker；不全量扫描文档 |
| `src/components/vault/monacoMarkdownProviders.ts` | E2 | 将 `:` 加入全局 provider trigger registration（若现有注册路径需要） | 不改变 URI context isolation |
| `src/lib/__tests__/emoji.test.ts` | E1 | shared data/ranking/纯 helper tests | 不只测字符串常量而绕过真实 renderer |
| `src/lib/__tests__/markdown.test.ts` | E1/E4 | 真实 Nuvyn renderer Emoji 和既有 Markdown regression | 不改既有 sanitizer 期望来适应 Emoji |
| `src/components/vault/__tests__/monacoMarkdown.test.ts` | E2/E3 | command、ranking、query/range/context pure tests | 不替代 Monaco provider integration |
| `src/components/vault/__tests__/MonacoEditorPane.test.ts` | E2/E3 | 真实 provider registry 路径、InsertAsSnippet、trigger、IME、model isolation | 不只 mock `CompletionItem` 数据结构 |
| `src/views/MarkdownTestView.vue` | E4 | 加入最小 Emoji visual specimen | 不改变其它 Markdown specimen 语义 |
| `e2e/markdown-visual.spec.ts` 或最小 dedicated spec | E4 | 限定 article/fixture 的 Emoji preview assertion | 不依赖全局 `.katex` 等误命中；不使用固定 sleep |
| `docs/...` attribution file（如需要） | E1 | 按仓库现有机制记录 gemoji/upstream license | 不在无机制时凭空创建大型 license system |

明确不在本功能 PR 中修改：

- `src/lib/math.ts`
- `src/composables/useMathMount.ts`
- `src/lib/wikiLinks.ts`
- `src/components/Mermaid.vue`
- `src/lib/mermaidRuntime.ts`
- `src/composables/useMermaidMount.ts`
- `src/lib/markmapSecurity.ts`
- Markmap lifecycle/security files
- DOMPurify policy和 Markdown main sanitizer allow/deny list
- backend、数据库、Markdown post-mount framework

---

## 7. E1 — Renderer 和共享 Emoji 数据

### E1.0 Artifact 和环境 preflight

实现者先做只读核验，成功后才允许改依赖：

1. 查看 npm `@mdit/plugin-emoji@1.1.1` tarball 的 public exports、types、peer 和 engine。
2. 确认 Node 22/24 是 Nuvyn supported CI runtime。
3. 确认实际 installed MarkdownIt 仍为 14.2.0。
4. 确认没有现成 Emoji data module、生成器或 third-party notice 可复用。
5. 记录 npm 与 tracked pnpm lockfile 的维护决定。

若上述任一结果与本计划不符，E1 停止，不在代码中绕过 peer 或强行使用 main branch。

### E1.1 依赖提交

将 `@mdit/plugin-emoji` 作为精确版本依赖加入。依赖提交必须：

- 不改 `markdown-it` range/lock resolution。
- 不引入 Twemoji、远程 Emoji CDN 或图片 renderer。
- 不把 upstream GitHub `main` 当作 npm dependency source。
- 只更新实际需要的 lockfile entries。
- 在 commit/PR body 写明 `1.1.1` 与 main `^15.0.0` 的区别。

### E1.2 Generated data pipeline

推荐实现顺序：

1. 确定 pinned `gemoji-json`/upstream source revision 及其 revision date metadata。
2. generator 只读取 pinned source，生成 Nuvyn-local definitions。
3. 对 source entry 的每个 alias 生成一个平等的 `{ name, glyph }` entry，并把它们展开为同一 generated module 中的 `Record<shortcode, glyph>`；不建立首选 shortcode 层级。
4. 按稳定 shortcode key 顺序写出，避免每次更新产生无意义 diff。
5. 写入 deterministic provenance header：`Source`、`Source revision`、`Source revision date`、`Generator version`、`License`；不写 `Generated at`、`Date.now()` 或任何 wall-clock timestamp。
6. generator 对缺失 glyph、非法/空 shortcode、重复 shortcode key（无论 glyph 是否相同）、source schema 变化失败退出；相同 glyph 对应多个不同 shortcode 是合法的。
7. runtime 不访问网络、不动态拉取 Emoji 数据。

generator 的验证要求：

- 同一 source revision、generator version 和 inputs 连续运行两次，输出 byte-for-byte identical。
- source revision date 来自 pinned revision metadata，重复运行不会变化。
- alias 不因为 glyph 相同而被去重；每个有效 alias 都是独立 shortcode entry。
- shortcode key 重复出现时 generation fail（即使 glyph 相同也不覆盖）；不同 shortcode 共享 glyph 是合法的。
- 生成结果不得依赖 current date/time、timezone、locale、randomness 或未锁定的 network latest state。
- unknown shortcode 不在 definitions 中时由 renderer 原文保留。
- 生成文件不含可执行 HTML、URL、script 或用户输入。

### E1.3 Shared adapter 和 ranking index

`src/lib/emoji.ts` 的职责应保持纯函数化：

- 导出 renderer 所需的 definitions 视图。
- 导出 Monaco 所需的 entry 视图：`name`、`glyph`、必要的 normalized key。
- 初始化一次 normalized lookup/index；不在每次按键时重建 full dataset。
- `rankEmojiSuggestions(query)` 只处理 query 和静态 entries，返回最多 30 项。
- 排序固定为 exact match → startsWith → contains → stable lexical fallback；aliases 作为独立有效 entry 保留。
- 不引入 MiniSearch 或大型通用 search service；当前数据量不足以证明需要它。
- 不读取 editor model、不依赖 Vue/reactivity、不触碰 MarkdownIt state。

测试必须先覆盖 adapter，再接 renderer 和 Monaco，防止两条消费者各自发明 mapping。

### E1.4 MarkdownIt 注册

在 `src/lib/markdown.ts` 中：

1. 引入已发布包的 public `bareEmoji` API。
2. 传入 shared generated definitions。
3. 显式传入空 shortcuts，关闭 emoticon shortcut。
4. 将注册放在当前 plugin chain 的计划位置，随后用 token/output tests 验证与 math、Wiki、mark、linkify 的相互作用。
5. 保持 `new MarkdownIt({ html: true, linkify: true, typographer: true })` 的现状，不添加 `breaks`。
6. 保持现有 `render()` 和 DOMPurify boundary 原样。

不得：

- 复制 upstream full data 到另一个 Monaco 文件。
- 用 DOMPurify “修复” Emoji 输出；正确输出本来就是 text。
- 在 math placeholder、Markmap 或 Mermaid 路径里额外执行 Emoji replacement。
- 用自定义 renderer 把 Emoji 变成 image/SVG/HTML。

### E1.5 Renderer 测试矩阵

测试放置在现有真实 renderer test suite，并根据需要增加 shared data 专项 suite：

| 场景 | 期望 |
| --- | --- |
| `:smile:` | `😄` |
| `:rocket:` | `🚀` |
| `:+1:` | `👍` |
| `:thumbsup:` | `👍`；alias 仍有效 |
| `:unknown_xyz:` | 原文保留 |
| 原生 `😀` | 原样保留 |
| `Text :smile: text` | 只替换 shortcode |
| `完成 :rocket:` | 中文旁边正常替换 |
| 多个 shortcode | 各自转换 |
| `` `:smile:` `` | 保持 code text |
| fenced code 中 `:smile:` | 保持 code text |
| `https://example.com/:smile` 作为 link destination | destination 不转换 |
| `<https://example.com/:smile>` | autolink URL 不转换 |
| `[:smile:](https://example.com)` | explicit label 按 upstream 普通 inline 语义转换 |
| `[https://example.com/:smile](...)` | explicit label 按普通 inline text 处理，`:smile` 按 upstream 语义转换；destination 不转换 |
| `:)`、`:D`、`:-)` | MVP 原文保留 |
| math 与 `:smile:` 相邻 | math placeholder 语义不回归 |
| Wiki target/alias 中的 colon | resolver 语义不改变；按真实 token 行为验证 |
| mark/highlight、footnote、deflist、task list | 现有输出不回归 |
| raw HTML + shortcode | sanitizer 仍按原 policy 工作，Emoji 不新增 HTML 能力 |

此外至少增加 malformed/边界输入：单独 `:`、未闭合 `:smile`、`foo::bar`、`key:value`、URL、JSON/YAML 文本，确保 unknown 或不完整内容不被错误吞掉。

### E1 Exit Criteria

- npm artifact 与 MarkdownIt 14.2.0 peer 核验通过。
- shared definitions 生成可重复且有 deterministic provenance；artifact 不含 wall-clock timestamp。
- 同一 pinned source revision、generator version 和 inputs 连续生成两次必须 byte-for-byte identical。
- 每个有效 source alias 都是独立 shortcode entry；相同 glyph 可重复，重复 shortcode key 必须让 generator fail。
- renderer 使用 shared definitions 和空 shortcuts。
- known/unknown/alias/code/fence/link/math/Wiki regression tests 通过。
- DOMPurify policy diff 为零。
- 本阶段未引入 remote asset、custom HTML 或 MarkdownIt major upgrade。

---

## 8. E2 — Monaco Emoji Completion

### E2.1 Provider 接入点

修改范围只限现有 Markdown completion path：

1. 将 `:` 加入 `EditorPane.vue` 的 Markdown completion trigger characters。
2. 如全局 provider registration 也声明 trigger characters，则同步修改 `monacoMarkdownProviders.ts`。
3. 保持按 model URI 查找 context 的隔离机制。
4. 在既有 provider 分支中加入 Emoji context 分支；不得注册第二个全局 Markdown completion provider。
5. 继续使用现有 Monaco `CompletionItem` 和 `InsertAsSnippet` insertion path。

如果 Monaco runtime 的 local provider 已经因 `:` 自动调用，而 global delegate 只需更新 trigger list，则只做必要的最小改动。

### E2.2 Emoji shortcode context

Emoji suggestion 不能因为任意冒号触发。实现阶段先抽出可测试的纯 context helper，至少返回：

- 当前 shortcode query（不含前导 `:`）。
- completion replacement range。
- 是否处在合法 Emoji boundary。
- 是否处于 inline code。
- 是否处于 fenced code。
- 是否属于 URL、时间、key/value、路径或其它明确排除场景。

推荐产品行为：

允许：

- 行首 `:s`、`:smi`、`:rocket`。
- 空白后 `今天 :rocket`。
- 普通文本 boundary 后的 shortcode。
- alias 名称中的字母、数字、下划线、连字符和 `+`。

默认抑制：

- `http://`、`https://`、普通 URL path。
- `12:30`、ISO 时间日期。
- `key: value`、YAML/CSS/JSON 风格 colon。
- `foo::bar`、`::1`。
- Windows path，例如 `C:\Users`。
- `foo:bar` 等无 whitespace boundary 的普通标识符。
- inline code。
- fenced code。
- IME composition 期间。

renderer 和 editor 可以有不同的 false-positive regex；不要为了复用 helper 而把 editor context 规则塞进 MarkdownIt parser。

### E2.3 Code context 处理

renderer 侧必须可靠保护 inline/fenced code。editor 侧应尽量不在 code 中弹 completion，但不得为此扫描 500k 文档。

实施顺序：

1. 优先检查 Monaco 当前 tokenization/API 是否能可靠识别 Markdown inline/fenced code。
2. 若可靠，直接使用 token/context 结果。
3. 若不能，使用当前行和受限的向上 fence context 扫描；不调用全量 `model.getValue()`。
4. 在无法可靠确定 fenced state 时，选择不弹建议而不是误弹。
5. 将跨 fence、未闭合 fence、inline code、escaped backtick 写成 provider tests。

大文档验收必须断言 Emoji completion 路径不调用全量文本读取，也不会对每个 keypress 做全文 Markdown parse。

### E2.4 Completion item 约定

每个 item：

- label：`😄 :smile:` 形式，显示 glyph 和对应 shortcode name；每个 alias 都可独立显示，不因 glyph 相同而去重。
- detail：`Emoji` 或现有 UI locale 约定的等价短 detail。
- insertText：输入 `:smi` 时插入完整的 `smile:`，replacement range 只覆盖已有的 `smi`；前导 `:` 保留，最终 source 必须是 `:smile:`。
- insertTextRules：继续使用 `CompletionItemInsertTextRule.InsertAsSnippet`，即使文本没有 placeholder，也必须走现有 insertion mechanism。
- range：只替换当前 Emoji query，不覆盖前面的普通文本。
- command：不增加 Emoji 专属 command registry；普通 `:` query 走 provider，`/emoji` 走既有 triggerSuggest 链路。

选择后最终模型文本必须是 `:smile:`。测试应读取 model 内容或实际 edit operation，而不是只断言一个 item 字段。

### E2.5 Query、排序和上限

建议固定为：

1. query 与 name 完全相同：exact。
2. name 以 query 开头：startsWith。
3. name 包含 query：contains。
4. aliases 作为独立名称参与排序。
5. 同层级按 normalized lexical key 和稳定 source order 排序。
6. 最多返回 `MAX_EMOJI_SUGGESTIONS = 30`。

空 query 的策略与 `/emoji` 分开：

- 普通用户刚输入单独 `:` 时不应无条件注入 30 个全量 suggestions；可以返回空，或只在 Monaco 明确的手动/显式触发 context 下返回 top 30。
- `/emoji` 选择后必须能进入显式 Emoji completion，即便 query 为空。
- 实现不得把所有候选每次 keypress 直接交给 Monaco 再依赖 Monaco 自己排序。

### E2.6 IME、model isolation 和大型文档

- `composing === true` 时 provider 返回空或不主动触发建议。
- composition end 后不改变现有 model change/undo 行为；只恢复后续正常 completion。
- 每个 completion item 绑定当前 model URI/context，不从模块级 mutable current model 读取数据。
- query 只来自当前 line/range；禁止在 completion path 调用全量 `getValue()`。
- 对 500k+ 文档运行 provider test，断言结果正确且没有全文扫描。

### E2.7 E2 Tests

必须覆盖：

- `:smi` 返回 `smile` candidate。
- `:rocket`、`:+1`、alias query 可以找到对应 item。
- unknown query 无 suggestion。
- exact/prefix/contains 排序可预测。
- 返回数量不超过 30。
- range 替换后 source 是 `:smile:`。
- item 的 `InsertAsSnippet` 标志沿真实 provider 路径存在。
- label 同时显示 glyph 和 shortcode。
- 普通 `:` 的行为不会无条件污染 suggestions。
- `/emoji` 的显式空 query 能进入候选。
- URL、时间、key:value、`foo::bar`、`::1`、Windows path 不误触发。
- inline/fenced code 不弹或按明确 MVP fallback 抑制。
- 中文文本和普通 whitespace boundary 正常。
- composition 期间无建议，composition 后可恢复。
- 两个 model URI 之间不串候选或 range。
- 500k+ 文档不触发全文读取。
- 现有 Wiki、heading、fence language 和其它 completion regression 继续通过。

### E2 Exit Criteria

- `:` trigger 只接入现有 Markdown provider。
- shared generated data 是唯一 suggestion source。
- CompletionItem 真正使用 InsertAsSnippet。
- context/range/ranking/limit/IME/large-document tests 通过。
- E2 新增并通过 completion-level `composing` guard、inline-code guard 和 fenced-code cursor-context guard；这些是 E2 实现责任，不得在 review 中声称它们原本已是 reusable helper。
- Wiki completion 和现有 provider 分支无回归。

---

## 9. E3 — `/emoji` Slash Command

### E3.1 Command 数据

在 `MARKDOWN_SLASH_COMMANDS` 增加一项：

| 字段 | 计划值 |
| --- | --- |
| label | `emoji` |
| detail | `Emoji` 或现有中文 detail 规范下的 `表情` |
| insertText | `:` |
| insertion | 复用当前 slash completion 的 `InsertAsSnippet` |
| command | 复用 `editor.action.triggerSuggest` |

最终 command 数据必须通过现有 `filterMarkdownSlashCommands()` 可搜索；label/detail 的大小写和中文 detail 规则与当前 helper 保持一致。

### E3.2 空 query 的显式触发

`/emoji` 与普通冒号的区别是：`/emoji` 是明确用户意图，选择后即使 query 为空也应显示 Emoji candidates。

实现验证顺序：

1. 先确认当前 Monaco `CompletionContext.triggerKind` 能区分 `triggerCharacter` 和 `invoke`，以及 `editor.action.triggerSuggest` 通过 CompletionItem command 的真实行为。
2. 若现有 provider 已能从 invocation context 得到“显式触发”，让 Emoji 分支只在该 context 放行空 query。
3. 如果 built-in command context 不能可靠区分，使用当前 model context 中的短生命周期、一次性 explicit Emoji marker；marker 必须按 model URI 隔离，消费一次即清除，不做模块级全局 flag。
4. 不新增第二套 completion provider、搜索服务或 popup command registry。
5. 加测试证明普通 `:` 和 `/emoji` 的空 query 行为不同。

这项是 E3 的重点实现验证，不应以“插入了 `:`”作为完成标准。

### E3.3 Command 测试

- `filterMarkdownSlashCommands('emoji')` 找到 command。
- slash completion 返回 `emoji`，其 insertion 是 `:`，不是 Unicode glyph 或固定 `:smile:`。
- 返回 item 使用 `InsertAsSnippet`。
- 选择后执行现有 `editor.action.triggerSuggest`。
- 真实 provider path 能收到显式 Emoji invocation 并显示候选。
- 选择候选后最终 source 是 `:smile:`。
- 既有 heading/list/task/quote/callout/math/code/mermaid/markmap/table/wiki command 数据和插入行为不变。
- `/wiki` 仍通过原有 `[[` + Wiki completion 流程工作。

### E3 Exit Criteria

- `/emoji` 仅增加一个现有 command 数据项。
- 不新增独立 Emoji picker/command system。
- empty query 的显式触发有真实 provider test。
- 所有既有 slash command regression 通过。

---

## 10. E4 — Integration Verification

### E4.1 Markdown fixture

在现有 `MarkdownTestView.vue` 增加最小且稳定的 Emoji specimen，建议包含：

```md
Emoji: :smile: :rocket: :+1:

完成 :rocket:

`:smile:`

```text
:smile:
```
```

fixture 不应加入大规模 Emoji gallery，也不应改变现有 Mermaid/Markmap/math specimen。

### E4.2 Browser assertion

优先扩展现有 `e2e/markdown-visual.spec.ts`，或建立一个最小 dedicated spec，使用现有 Playwright server/config：

- 以稳定的 article/fixture selector 定位 Emoji specimen。
- 断言 preview text 中出现 `😄`、`🚀`、`👍`。
- 断言 code inline/fenced 区域仍包含 literal `:smile:`，没有被 renderer 转换。
- 断言未知 shortcode仍存在（若 fixture 包含）。
- 不依赖截图中的 glyph 像素；visual screenshot 如需保持稳定，继续使用现有 mask 约定。
- 使用 `expect(...).toBeVisible()`、`toContainText()` 等 auto-wait；禁止 `waitForTimeout`、retry、skip。

Monaco browser E2E 只在现有测试 harness 能可靠打开真实 EditorPane 时增加最小路径：输入 `:smi`、选择 `smile`、读取 source 为 `:smile:`。如果当前 harness 不适合稳定操作 Monaco，E2 的真实 provider/component tests 是 MVP 必需覆盖，browser 侧至少覆盖 renderer；不要为了一个功能建立大型脆弱 suite，但不得省略已定义的 provider integration test。

### E4.3 Security and compatibility verification

E4 必须复跑或确认现有 regression：

- DOMPurify policy 未变化。
- raw HTML、event handler、javascript URL 规则未变化。
- math placeholder/KaTeX architecture 未变化。
- Markmap security/KaTeX lifecycle 未变化。
- Mermaid 未变化。
- Wiki Link renderer 和 Monaco completion 未变化。
- footnote、definition list、highlight、task list、callout 未变化。

### E4 Exit Criteria

- 真实 Nuvyn renderer fixture 显示 native Unicode Emoji。
- code、unknown、native Unicode、中文和 alias 行为在 unit/integration 中已覆盖。
- 现有 visual/e2e functional assertions 通过。
- 没有靠固定等待或重试掩盖异步问题。

---

## 11. 测试计划总表

### 11.1 Renderer 和数据

| 层级 | 文件/命令 | 必须证明 |
| --- | --- | --- |
| shared data | `src/lib/__tests__/emoji.test.ts` | definitions、alias、ranking、上限、稳定排序 |
| real renderer | `src/lib/__tests__/markdown.test.ts` | shortcode → Unicode、unknown、native、code/fence、links、math/Wiki interaction |
| generator | generator-specific test 或 deterministic check | 同一 pinned revision/version/inputs 重复生成 byte-identical；无 wall-clock timestamp；revision date deterministic；任何 duplicate shortcode key（含同 glyph）失败；duplicate glyph aliases 保留；不依赖 time/locale/randomness/network latest state |
| sanitizer regression | 现有 Markdown tests | policy unchanged；Emoji 不产 HTML |

### 11.2 Monaco

| 层级 | 文件 | 必须证明 |
| --- | --- | --- |
| pure helper | `monacoMarkdown.test.ts` 或 shared emoji test | prefix、boundary、range、ranking、limit |
| provider integration | `MonacoEditorPane.test.ts` | real registration/delegate path、trigger、CompletionItem、InsertAsSnippet |
| slash integration | `MonacoEditorPane.test.ts` | `/emoji` → `:` → triggerSuggest → empty-query Emoji suggestions |
| regression | existing Monaco suites | Wiki、slash commands、IME、large document、fence completion |

### 11.3 Browser

| 层级 | 位置 | 必须证明 |
| --- | --- | --- |
| Markdown preview | `e2e/markdown-visual.spec.ts` 或 dedicated minimal spec | Marked fixture 内出现 glyph，code literal 未转换 |
| Monaco optional | existing EditorPane-capable browser harness | source remains shortcode after selection |
| visual | existing screenshot path | 不把 Emoji pixel 当成稳定 snapshot contract |

---

## 12. 命令级验证顺序

以下是 implementation 阶段的验证顺序，不是本次文档任务要执行的命令。

### 12.1 每个阶段本地验证

1. `npm run typecheck`
2. focused Vitest for changed package/file
3. `npm run build`
4. `git diff --check`

### 12.2 E1/E2/E3 focused commands

```text
npx vitest run \
  src/lib/__tests__/emoji.test.ts \
  src/lib/__tests__/markdown.test.ts \
  src/components/vault/__tests__/monacoMarkdown.test.ts \
  src/components/vault/__tests__/MonacoEditorPane.test.ts
```

具体路径以实现时实际新增文件为准；不得用 `.skip`、`.todo`、retry 或 sleep 降低验收标准。

### 12.3 全量验证

```text
npm run typecheck
npm run test:unit
npm run test:history-integration
npm run test:recovery-integration
npm test
npm run build
npm run test:e2e
```

如果仓库脚本要求先启动特定 server，使用既有脚本，不另造 Emoji server harness。

### 12.4 CI 验证

CI 需要覆盖现有 matrix：

- Node 22/24。
- Ubuntu/macOS/Windows 的 typecheck/build/unit/已有 browser path。
- Chromium visual/Markdown functional tests。

本次只记录一个与 Emoji 无关的已知 CI 风险：Node 24 × better-sqlite3 native teardown 曾出现 `node::RemoveEnvironmentCleanupHook` / `Statement::~Statement()` crash，并导致后续 Playwright connection refused。Emoji 实现 PR 不得把这个 recurring CI noise 误判为 Emoji 回归，也不得在本阶段顺手修改 native dependency；若复现，应单独建 CI/runtime issue。

---

## 13. 性能计划

### 13.1 Renderer

- generated definitions 静态加载一次。
- 不在每次 `render()` 动态下载或解析 Emoji 数据。
- 不引入 Emoji HTML asset、图片或 CDN。
- 记录 build 前后 initial JS bundle 变化；没有证据时不做 manual chunk/dynamic import 重构。

### 13.2 Monaco

- normalized entries/index 初始化一次，不在每个 keypress 重建。
- 只处理当前 line/query；不得全量扫描文档。
- suggestion 上限 30。
- 过滤和排序为 O(entries) 的简单静态路径即可；若 profiling 证明有问题，再考虑预计算 prefix index。
- 500k+ 文档仍允许 Emoji completion，因为工作量依赖当前 line 而非全文；测试需检查实际调用路径。
- 不为理论上的大 dataset 引入 MiniSearch、trie 或动态 worker，除非 build/profile 给出证据。

### 13.3 验证指标

实现 PR 至少记录：

- `npm run build` 是否通过。
- generated data 的模块大小和压缩前 bundle 变化。
- 30-item limit 是否有效。
- 500k 文档 provider test 是否调用过 `getValue()` 全文入口。
- 普通输入 `:` 是否出现可感知的全量 completion 开销。

---

## 14. 安全和兼容性不变量

### 14.1 安全

必须保持：

- shortcode 只映射到 Unicode text。
- definitions 来自受信任的 committed/generated source。
- author Markdown/frontmatter 不能注入 definitions、HTML、SVG、image URL、script 或 CSS。
- DOMPurify config 不变。
- link destination/href 不因 Emoji replacement 被改写。
- unknown shortcode 不被当作 HTML 或 executable token。
- remote asset loader、Markmap、Mermaid、KaTeX 主架构不被 Emoji 触发。

代码 review 要特别拒绝：

- 以 `v-html`/raw HTML 作为 Emoji renderer。
- 以 `<img>`、SVG 或 external URL 渲染 glyph。
- 从 frontmatter 合并自定义 emoji map。
- 为了让 Emoji 显示而放宽 `ALLOWED_TAGS`、`ALLOWED_ATTR`、URI policy 或 DOMPurify。

### 14.2 Markdown 兼容

必须回归：

- inline/fenced code。
- math placeholder、KaTeX。
- Wiki Link target/alias。
- link destination 和 autolink。
- footnote、definition list、highlight、task list、callout。
- raw HTML sanitizer。
- MarkdownIt 当前 `html/linkify/typographer` options；不得出现 breaks 误改。

### 14.3 Monaco 兼容

必须回归：

- 所有原有 slash commands。
- `/wiki` 的 `[[` 和现有 completion。
- `InsertAsSnippet` placeholder/selection 行为。
- keyboard handling、undo/redo、composition。
- 多 model URI 隔离。
- fenced code language completion。

---

## 15. License、provenance 和更新策略

### 15.1 许可证要求

实施 PR 必须附：

- `@mdit/plugin-emoji@1.1.1` 的 MIT license 事实。
- gemoji-json/upstream data source 的 MIT/provenance 事实。
- source URL、pinned revision/version 和生成脚本版本。
- 仓库现有 attribution/notice 文件位置；若没有，先与维护者确认最小记录方式。

不要复制大量 upstream source code 到说明文档；只提交必要的 generated data、generator 和短 provenance header。

### 15.2 更新流程

未来 Emoji data update 应是独立、可审计的维护 PR：

1. 更新 pinned source revision。
2. 运行 generator。
3. 检查新增/删除/alias/glyph diff。
4. 重新运行 renderer 和 Monaco tests。
5. 检查 license/provenance。
6. 记录是否影响 bundle size、排序或用户可见语义。

不允许运行时跟随 upstream main，也不允许自动联网更新 definitions。

---

## 16. Rollback 和故障隔离

### 16.1 依赖/API 不匹配

如果 npm `1.1.1` 的实际公开 API 与 PRD 不一致：

- 不通过 `as any` 读取私有 export。
- 不切换到 upstream main。
- 不升级 MarkdownIt 15。
- 回滚 E1 dependency/data commit，提交 compatibility finding。

### 16.2 Renderer 回归

如果 Emoji plugin 破坏 math、Wiki、code 或 sanitizer：

- 保留失败测试作为 blocker evidence。
- 撤销 plugin registration，保留或回滚依赖和 generated data，避免半启用状态。
- 不在 sanitizer 或 math subsystem 中加临时 bypass。

### 16.3 Monaco 回归

如果 `:` trigger 噪声过大或 provider 路径不稳定：

- 可暂时关闭 `:` trigger 和 `/emoji` command，但不得删除 shared data/renderer 测试中发现的产品事实。
- 不引入独立 picker 或第二个 provider。
- 修复 context/range/explicit invocation 后再重新启用。

### 16.4 生成数据回归

如果 generator 输出不稳定或 provenance 不完整：

- 不提交生成结果。
- 修 generator/source pin，直到连续生成稳定。
- 不手工编辑 generated file 来掩盖 generator 错误。

---

## 17. Commit 和 PR 拆分建议

推荐一个 feature branch、一个最终 PR，使用逻辑清晰且每个中间 commit 可验证的提交序列：

1. `emoji: add pinned renderer dependency and generated data pipeline`
   - `package.json`、lockfile、generator、generated definitions、license/provenance、E1 tests。
2. `emoji: integrate markdown renderer`
   - `src/lib/markdown.ts` 和真实 renderer tests；若第一笔已包含 renderer，可合并为一笔。
3. `emoji: add shared completion ranking and context guards`
   - `src/lib/emoji.ts`、Monaco pure/provider tests。
4. `emoji: add slash command completion flow`
   - `MARKDOWN_SLASH_COMMANDS`、provider trigger、`/emoji` tests。
5. `emoji: add markdown fixture and browser verification`
   - `MarkdownTestView.vue`、最小 e2e、最终回归记录。

不要求机械地保持五个 commit；重点是：

- 不出现只更新 `package.json` 却无法 typecheck 的长时间中间状态。
- 不把与 Emoji 无关的 lockfile upgrade、CI/native fix 或 Markdown architecture refactor 混进来。
- 每个 commit 的测试范围在 commit body 或 PR description 中明确。

---

## 18. Acceptance Criteria 到实现验证的映射

| PRD 验收项 | 实现位置 | 验证 |
| --- | --- | --- |
| `:smile:` → `😄` | `markdown.ts` + generated data | real renderer test + browser fixture |
| `:rocket:` → `🚀` | same | renderer test |
| `:+1:` 和 `:thumbsup:` | shared definitions | alias test |
| unknown 原文 | upstream rule integration | renderer test |
| native Unicode 原样 | renderer | renderer test |
| inline/fenced code 不转换 | renderer + editor context | renderer/provider tests |
| explicit link label 自然语义 | renderer token path | link/autolink tests |
| destination/autolink URL 不转换 | renderer token path | link tests |
| shortcuts disabled | `bareEmoji` options | `:)`/`:D` tests |
| shared full data | generated module + adapter | import/source audit + tests |
| Monaco `:query` | provider | component test |
| source 保存 shortcode | CompletionItem range/insertText | model edit assertion |
| glyph + shortcode label | provider | CompletionItem test |
| max 30 | ranking helper | unit test |
| exact/prefix/contains ranking | shared helper | deterministic unit test |
| boundary false positives | context helper | URL/time/YAML/path tests |
| IME safe | EditorPane provider | composition test |
| 500k doc safe | provider path | large document test |
| `/emoji` exists | slash command list/filter | slash test |
| `/emoji` inserts `:` | slash completion | provider edit assertion |
| `/emoji` triggers existing suggest | command path | provider command test |
| empty explicit query works | context trigger/marker | dedicated E3 test |
| Wiki completion unchanged | existing provider | Wiki regression suite |
| DOMPurify unchanged | no policy diff | source diff + security tests |
| no Twemoji/remote assets | renderer/data design | dependency and output audit |
| no MarkdownIt major upgrade | dependency/lock | package/lock diff |
| browser preview visible | E4 fixture | Playwright functional assertion |
| no wall-clock timestamp in generated artifact | generator | deterministic generation check |
| source revision metadata deterministic | generator provenance | pinned revision metadata check |
| aliases remain independent entries; duplicate keys fail | generator/shared data | duplicate-glyph and duplicate-key tests |

---

## 19. 风险登记

| 风险 | Likelihood | Impact | Mitigation | 阶段 |
| --- | --- | --- | --- | --- |
| npm `1.1.1` 与 upstream main peer 状态混淆 | Medium | High | 精确 pin；依赖 PR 写清 `^14.2.0` vs `^15.0.0` | E1 |
| package 的 Node `>=22` 与未来 runtime policy 不一致 | Low | High | 依赖前检查 CI/发行支持矩阵，不静默降低 engine | E1 |
| npm 与 tracked pnpm lockfile policy 不一致 | Medium | Medium | implementation 前确认维护政策；避免无关 lock churn | E1 |
| full data 增加 bundle | Medium | Medium | 先测 build/bundle；静态一次加载，不提前做复杂 split | E1/E4 |
| generated source upstream 漂移 | Medium | Medium | pin revision、deterministic generator、单独 data update PR | E1 |
| alias 被 glyph 去重 | Medium | Medium | entry 按 shortcode 保留，专门 alias tests | E1/E2 |
| `:` 触发误命中技术文本 | High | Medium | boundary/context helper、负例矩阵、最多 30 项 | E2 |
| fenced code state 难以局部判断 | Medium | Medium | Monaco tokenization 或受限 backward scan；无法确定时 suppress | E2 |
| inline math/Wiki token interaction | Medium | High | 真实 Nuvyn renderer tests，不手写第二 parser | E1 |
| `/emoji` 空 query 与普通 `:` 冲突 | Medium | Medium | 使用显式 completion context 或一次性 model marker | E3 |
| IME composition 噪声 | Medium | Medium | composition guard，保持现有 IME 生命周期 | E2 |
| Monaco provider model 串线 | Low | High | URI context isolation tests | E2 |
| license/attribution 遗漏 | Low | High | provenance header + notice review gate | E1 |
| native better-sqlite3 CI teardown crash | Medium | Medium | 独立 issue；不把 unrelated crash 归因 Emoji | E4/CI |
| visual glyph 因字体差异 flake | Medium | Low | text functional assertion；不做 glyph pixel snapshot | E4 |

---

## 20. Implementation Blockers 和 Open Questions

### 20.1 Implementation Blockers

None。当前三个 review issue 均已在本计划中修正为文档约束，不构成产品或实现 blocker。

Supporting audit facts：

- 审计依据：MarkdownIt 14.2.0 满足已发布 plugin `1.1.1` 的 peer range；Node 22/24 满足该 package 的 declared engine；现有 renderer 和 Monaco provider 有明确的 planned integration points；当前任务不需要先修改 Markmap、Mermaid、KaTeX 或 sanitizer。

### 20.2 Open Implementation Questions

以下问题不改变产品方向，但必须在对应阶段落地前确认：

1. **双 lockfile 政策**：npm/`package-lock.json` 是 CI 权威；维护者是否仍要求 `pnpm-lock.yaml` 可复现？推荐实现 PR 在提交前确认并按结果同步，不能靠个人假设提交一边漂移的 lockfiles。
2. **Monaco explicit trigger 细节**：当前版本的 `CompletionContext.triggerKind`/`triggerCharacter` 是否能可靠识别 `editor.action.triggerSuggest` 的显式调用？若不能，采用 model-URI 隔离的一次性 marker；两种方案都必须由 E3 test 固化。
3. **generator source packaging**：是否允许增加一个仅用于生成 Emoji data 的 dev-only source package，还是采用 pinned source artifact/脚本输入？无论选择哪种，都必须保留 MIT attribution 和 deterministic output；不得把 source package 作为运行时依赖带入产品。
4. **浏览器 Monaco harness**：现有 e2e 是否已具备可靠的 EditorPane 输入/选择能力？若没有，E2 provider integration tests 是必要主证据，E4 browser 只验证 renderer preview，不新建大型编辑器 suite。

这些问题都不能通过改变 shortcode、shortcut、full dataset 或 sanitizer 决策来“解决”。

---

## 21. Definition of Done

Emoji implementation PR 只有在以下全部完成后才能从 implementation review 进入 release review：

- [ ] 使用已发布 `@mdit/plugin-emoji@1.1.1`，没有依赖 upstream main。
- [ ] MarkdownIt 仍为 14.x，lock 中仍为当前受支持版本。
- [ ] generated full definitions 有 source pin、source revision date、license、attribution 和 deterministic generator。
- [ ] generated artifact 不含 wall-clock timestamp；同一 pinned source revision、generator version 和 inputs 产生 byte-identical output。
- [ ] 每个有效 source alias 都是独立 shortcode entry；相同 glyph 可有多个名称，重复 shortcode key 会让 generation fail。
- [ ] renderer 与 Monaco 共用同一个 definitions source。
- [ ] `bareEmoji` 明确关闭 emoticon shortcuts。
- [ ] `:smile:`、`:rocket:`、`:+1:`、aliases、unknown、native Unicode 正确。
- [ ] inline/fenced code、URL destination、autolink 和 explicit label 行为由真实 tests 固化。
- [ ] renderer 不产生 HTML/image/SVG/remote asset。
- [ ] DOMPurify policy 没有修改。
- [ ] `:query` completion 使用既有 Monaco provider 和 InsertAsSnippet。
- [ ] label 显示 glyph + shortcode，source 最终保存 shortcode。
- [ ] ranking deterministic，suggestion 上限不超过 30。
- [ ] URL/time/key:value/path/code/IME false positives 有测试。
- [ ] E2 复用已有 `composing` state，并实现 completion-level IME guard；inline-code/fenced-code cursor-context guards 被作为 E2 新增责任验证，而不是声称为现有 helper。
- [ ] large document completion 不扫描全文。
- [ ] `/emoji` 存在，插入 `:`，复用 `triggerSuggest`，空 query 显式触发可用。
- [ ] 既有 slash、Wiki、Markdown、math、Markmap、Mermaid 行为回归通过。
- [ ] 真实 Markdown browser assertion 通过，不使用 fixed timeout/retry/skip。
- [ ] `npm run typecheck`、`npm test`、build 和适用 E2E 通过。
- [ ] 任何 unrelated CI/native crash 已单独记录，没有混入 Emoji PR。
- [ ] PR diff 无无关重构、无 MarkdownIt major upgrade、无新 Emoji feature scope。

---

## 22. 后续执行清单

这是给实现者的顺序清单；本次不执行。

### Preflight

- [ ] Checkout `85b97a80176138d6a11b1f7a3095e242344395f2` 或明确的后续 review baseline。
- [ ] 核验 npm `@mdit/plugin-emoji@1.1.1` artifact。
- [ ] 核验 Node、MarkdownIt、npm CI 和 lockfile policy。
- [ ] 确认 pinned data source revision、source revision date、license 和 attribution 机制。
- [ ] 确认 generated artifact 不包含 wall-clock timestamp。

### E1

- [ ] Add exact dependency and approved lockfile updates。
- [ ] Add deterministic generator and generated full definitions。
- [ ] Generate twice with the same pinned revision/version/inputs and compare byte-identical output。
- [ ] Verify source revision date is deterministic and duplicate-glyph aliases survive。
- [ ] Verify duplicate shortcode names fail generation, including same-glyph duplicates。
- [ ] Verify generation is independent of current time, timezone, locale, randomness and unpinned network state。
- [ ] Add shared adapter/index/ranking primitives。
- [ ] Integrate `bareEmoji` with empty shortcuts。
- [ ] Add real renderer/data tests。
- [ ] Run E1 focused tests, typecheck and build。

### E2

- [ ] Add `:` trigger to existing provider registration only。
- [ ] Add context/range/code/IME/large-document guards。
- [ ] Add shared-data CompletionItems and deterministic ranking。
- [ ] Assert `InsertAsSnippet` through actual provider path。
- [ ] Add model isolation and false-positive tests。
- [ ] Run E2 focused tests and existing Wiki/slash regressions。

### E3

- [ ] Add `/emoji` to `MARKDOWN_SLASH_COMMANDS`。
- [ ] Insert `:` and reuse `editor.action.triggerSuggest`。
- [ ] Implement/test explicit empty-query behavior without a second provider。
- [ ] Confirm all existing slash commands unchanged。

### E4

- [ ] Add minimal Markdown fixture。
- [ ] Add functional browser assertion for Emoji inside the intended fixture。
- [ ] Run unit, integration, build and browser commands。
- [ ] Review sanitizer/math/Wiki/Markmap/Mermaid diff boundaries。
- [ ] Record bundle impact, license provenance, known unrelated CI failures and final acceptance mapping。

---

## 23. 计划完成边界

本文件是实施计划，不是 implementation。它不授权当前任务修改任何业务代码或依赖，也不代表 E1–E4 已执行。实现完成的判定必须以实际代码 diff、测试输出和 PR review evidence 为准。
