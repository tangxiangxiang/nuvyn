# Nuvyn — Personal OS

> [!NOTE]
> 本文是 Nuvyn 当前的系统级产品定义。它规定产品定位、Workspace 语义和长期设计原则；不替代 `docs/architecture/` 中的运行时 authority，也不把未来方向当作已经实现的功能。

## Nuvyn 的产品定位

Nuvyn 的系统级定位是：

> **Nuvyn is a Personal OS for your digital life.**

这里的 `Personal OS` 不是传统意义上的操作系统，也不是 Windows、macOS 或 Linux 的替代品。它表示：

> Nuvyn 是承载个人数字生活信息、知识、经历、财务、思考，以及未来更多个人数据的统一工作空间。

Nuvyn 真正要解决的问题不是把某一个垂直领域做得最复杂，而是让属于同一个人的不同信息能够在同一个系统中被组织、关联、理解和长期保存。

因此，Nuvyn 不应被简单定义为：

- Markdown 笔记软件；
- 日记软件；
- 记账软件；
- 白板软件；
- 文件管理器；
- Excalidraw 容器；
- 多功能工具集合。

这些都是 Nuvyn 的局部能力或实现方式。更高层级的定义是：

> **一个围绕“个人”构建的 Personal OS。**

在当前产品边界内，Nuvyn 仍然是 self-hosted、single-owner、private 的个人系统。`Owner` 是统一的产品中心；这不意味着引入团队、租户、RBAC 或多人协作模型。

## Core Workspaces

Nuvyn 当前的四个核心一级 Workspace 是：

```text
Note   → 我知道什么
Diary  → 我经历了什么
Ledger → 我的钱发生了什么
Board  → 我正在思考和构思什么
```

对应的英文语义是：

```text
Note   → What I know
Diary  → What I experience
Ledger → What happens to my money
Board  → What I am thinking
```

它们分别承担不同类型的个人信息：

| Workspace | 负责的信息 | 典型表达方式 |
| --- | --- | --- |
| Note | 知识与长期内容 | 线性 Markdown 文档、链接和标签 |
| Diary | 时间与个人经历 | 以日期为入口的个人记录 |
| Ledger | 个人财务事件 | 账户、分类、交易和余额投影 |
| Board | 视觉化思考、设计与探索 | 空间布局、图形、连接和画布 |

Note、Diary、Ledger、Board 不是四个彼此割裂的软件，而是同一个 Personal OS 中针对不同个人信息类型提供的一级 Workspace。它们可以拥有各自最适合数据类型的 UI、交互和数据模型，但共享同一个 User / Owner 上下文，以及系统级的身份、安全、可发现性、共享元数据和公共基础设施边界。不同 Workspace 可以保留自己的领域数据模型和持久化方式。

Workspace 的独立性表示领域专业化，不表示信息孤岛，也不要求所有 Workspace 使用相同的 UI 或文件结构。

## Why Nuvyn Exists

市场上已经有很多优秀的垂直工具：

- Note 可以使用 Obsidian、Notion 等知识工具；
- Diary 可以使用 Day One 等日记工具；
- Board 可以使用 Excalidraw 等白板工具；
- Ledger 可以使用专业记账软件。

Nuvyn 的目标不是在每一个垂直领域全面击败这些专业软件。Nuvyn 的核心优势来自一个更高层的问题：

> **这些信息属于同一个人，因此它们应该能够存在于同一个系统中，并建立关系。**

例如，用户今天在 Diary 中写下：

```text
今天决定重新设计 Board 首页。
```

这条经历未来可以关联到：

```text
Board / Homepage Design
Note  / Board PRD
Ledger / Nuvyn
```

其中最后一项可以代表这个项目产生的支出。Nuvyn 的目标不是只保存三份或四份数据，而是能够逐步理解：这些信息属于同一个项目、同一个时间段和同一个用户上下文。

这就是 Nuvyn 与单一垂直工具之间的重要区别：长期价值来自连接和上下文，而不只是单个页面拥有多少功能。

## Personal OS Design Principles

### 1. User-centric

Nuvyn 的中心不是文件，也不是模块，而是：

> **User / Owner**

所有 Workspace 都围绕同一个人的数字生活建立。文件、交易、日记日期、白板场景和 AI 上下文，最终都服务于同一个 Owner 的长期信息连续性。

### 2. Workspace specialization

不同 Workspace 负责不同类型的信息，并可以使用自己的 UI、交互和数据模型：

```text
Note   → 知识与长期内容
Diary  → 时间与个人经历
Ledger → 个人财务事件
Board  → 视觉化思考、设计与探索
```

不需要为了追求表面统一，而强迫所有 Workspace 使用完全相同的 UI 或文件结构。统一应发生在身份、权限、安全边界、可发现性和连接能力上；领域数据模型和持久化方式仍然可以保持专业化。

### 3. Cross-workspace connection

Workspace 在交互上可以保持独立，但数据不应成为信息孤岛。长期方向应允许并安全地表达：

```text
Note   ↔ Diary
Note   ↔ Board
Diary  ↔ Board
Ledger ↔ Diary
Ledger ↔ Note
Ledger ↔ Board
```

`Project Context` 是跨 Workspace 聚合同一个项目相关内容的上下文概念。例如：

```text
Project Context: Nuvyn

Note
├─ Board PRD
└─ Architecture

Board
└─ Homepage Design

Diary
└─ 2026-09-16

Ledger
└─ Nuvyn 相关支出
```

`Project Context` 当前只是 Personal OS 的跨 Workspace 上下文概念，不代表系统已经存在 `Project` 一级 Workspace，也不代表当前已经实现完整的 Project 数据模型。它未来可以通过 `Relation`、`Tag`、`Metadata`、`Reference` 或 `Context aggregation` 等方式实现，具体形式需要另行设计。

系统架构应为以下能力预留空间：

- `Reference`：从一个内容或记录指向另一个对象；
- `Relation`：表达对象之间的结构化关系；
- `Backlink`：发现反向引用；
- `Tag`、`Project Context`、`Timeline` 和 `Unified Search`：帮助跨 Workspace 找回上下文。

现有 Wiki links、Markdown links 和 backlinks 是这一方向的已实现基础；更通用的跨 Workspace Relation 不属于本次文档任务的实现范围。

### 4. Shared system capabilities

以下能力属于整个 Personal OS，而不应分别在 Note、Diary、Ledger、Board 中重复建设：

```text
Search
Tags
Relations
Timeline
Command Palette
AI
Storage
Sync
Security
Metadata
```

它们可以由不同的技术模块实现，但产品语义应保持系统级一致。上列能力包含已存在的基础能力和未来预留方向；具体实现状态以当前 architecture 和 user guide 为准。

### 5. Integration over feature competition

Nuvyn 不追求：

```text
Note > Obsidian
Board > Excalidraw
Ledger > 专业财务软件
Diary > 专业日记软件
```

Nuvyn 更重要的目标是：

```text
Note + Diary + Ledger + Board
```

能够共同组成一个统一的 Personal OS。长期护城河应更多来自 `Integration`，而不是 `Feature Count`。这不是绝对的优先级规则：每个 Workspace 仍然必须先保持足够好的基础体验。

### 6. Context accumulates over time

Nuvyn 使用越久，系统中积累的个人上下文应该越有价值：

```text
使用 1 天   → Nuvyn 是工具
使用 1 个月 → Nuvyn 是工作空间
使用 1 年   → Nuvyn 成为个人数字历史的一部分
```

长期数据连续性、可解释的历史和跨 Workspace 上下文积累，是 Nuvyn 的核心产品价值之一。

## Conceptual System Layers

下面是指导未来产品设计的概念模型，不是当前代码目录、运行时调用图或功能上线清单：

```text
Nuvyn — Personal OS

┌────────────────────────────────┐
│          Intelligence          │
│                                │
│ AI · Search · Timeline         │
│ Relations · Command            │
├────────────────────────────────┤
│           Workspaces           │
│                                │
│ Note · Diary · Ledger · Board  │
├────────────────────────────────┤
│              Core              │
│                                │
│ Files · Tags · Metadata        │
│ Storage · Sync · Security      │
└────────────────────────────────┘
```

- `Core` 提供身份、安全、共享元数据、基础设施和公共存储能力；不同 Workspace 可以保留自己的领域数据模型和持久化方式；
- `Workspaces` 提供针对信息类型的专业化入口；
- `Intelligence` 跨 Workspace 提供搜索、关系、时间线、命令和 AI 等理解与操作能力。

Core 的“共享”指公共能力与产品上下文，不指一套统一的领域数据模型；统一产品上下文也不等于所有 Workspace 使用相同的存储结构。`Relation`、`Timeline`、`Sync` 等概念在图中出现，不代表本次已经实现或需要立即修改代码架构。未来实现必须先有独立的产品和架构契约。

## AI and the Intelligence Layer

AI 不应优先被设计成一个独立 Workspace。它更适合作为：

> **Personal OS Intelligence Layer**

AI 的长期价值在于跨 Workspace 理解同一个 Owner 的上下文。例如：

- “我为什么最后决定 Board 首页不使用 File Tree？”需要综合 Note、Board、Diary 和历史决策；
- “这个月 Nuvyn 项目花了多少钱？”主要读取 Ledger；
- “这个月我主要在做什么？”可以综合 Note、Diary、Board 和 Ledger。

当前 AI 运行时仍以受保护的 live workspace context、文件和元数据工具为边界；本节只定义产品方向，不在本次任务中实现跨 Workspace AI。

## Feature Decision Principle

未来考虑新功能时，不应首先问：

> 别的软件有没有这个功能？

而应首先问：

> **这个功能是否增强了 Nuvyn 作为 Personal OS 的能力？**

需要区分：

```text
Workspace Feature
Personal OS Capability
```

例如：

- `Board` 新增画笔，是 `Workspace Feature`；
- `Board` 可以和 `Note` 建立 `Relation`，是 `Personal OS Capability`。

长期来看，Personal OS Capability 的战略价值通常高于单一 Workspace Feature，但这不取代对 Workspace 基础体验的投入，也不是机械的优先级公式。

## Product Boundary and Future Expansion

Personal OS 是限制产品边界的原则，而不是扩大产品边界的理由。当前阶段，`Project` 的正式语义是 `Project Context`，不是一级 Workspace，也不代表完整的 Project 数据模型。只有未来经过单独评估，`Project` 才可能成为独立的一级 Workspace 候选。考虑新增 `Task`、`Bookmark`、`Calendar`、`Project`、`Contact` 等一级 Workspace 之前，应先判断：

1. 它是否是一种长期存在的个人核心信息？
2. 它是否值得成为一级 Workspace？
3. 它是否可以通过已有 Workspace 加 `Relation` 实现？
4. 它是否增强 Personal OS，而不仅仅增加 `Feature Count`？

新领域只有在能够形成清晰的个人信息边界，并为整体上下文带来持续价值时，才应成为新的一级 Workspace。

## Terminology

| 术语 | Nuvyn 中的含义 |
| --- | --- |
| `Personal OS` | 围绕一个人的数字生活组织、连接和长期保存信息的产品定位；不是传统操作系统。 |
| `Workspace` | Personal OS 中针对一种主要个人信息类型的一级产品入口；不是独立软件。 |
| `Project Context` | 跨 Workspace 聚合同一个项目相关内容的上下文概念；当前不是一级 Workspace，也不代表完整的 Project 数据模型。 |
| `Vault` | Nuvyn 的 Markdown 文件与文件生命周期边界，是 Personal OS 的文档存储基础之一，不是一级 Workspace。 |
| `Core` | 由多个 Workspace 共享的身份、安全、共享元数据、基础设施和公共存储能力；不要求统一的领域数据模型或持久化方式。 |
| `Intelligence Layer` | 跨 Workspace 进行搜索、关系、时间线、命令和 AI 理解的系统层。 |
| `Workspace Feature` | 只服务某个 Workspace 的具体能力，例如 Board 画笔或 Ledger 账户筛选。 |
| `Personal OS Capability` | 连接或增强多个 Workspace 的系统级能力，例如 Relation、Backlink 或 Unified Search。 |
| `Module` | 代码或服务的技术组织边界；可以支撑一个或多个 Workspace，不等同于产品层级。 |
| `Feature` | 面向用户或系统的具体能力；需要根据作用范围区分 Workspace Feature 与 Personal OS Capability。 |
| `Resource` | 可被引用、关联或持久化的内容、记录、文件或资产；不是 Workspace 的同义词。 |

现有文档中出现的 `module`、`feature`、`resource` 等技术术语仍按各自架构上下文解释；本表只规定它们与产品层 Workspace 的关系。

Vault 主要服务于 Note、Diary 以及其他基于 Markdown 的内容。Ledger、Board 等 Workspace 可以拥有独立的数据模型和持久化机制。

## Brand and Product Language

系统内部可以正式使用：

```text
Nuvyn — Personal OS
Nuvyn is a Personal OS for your digital life.
```

面向用户的中文描述应保持自然，例如：

```text
属于你的数字生活空间。
一个承载知识、经历、财务和思考的个人数字空间。
```

不把中文产品名称机械翻译为“个人操作系统”。本节规定产品语言；当前 UI 的品牌表面以 Nuvyn 为准，兼容性与历史技术标识仍按各自契约保留。

## Scope of This Definition

本次更新只补充和统一系统级产品定义：

- 不修改业务代码、数据库、路由或 Workspace 页面；
- 不新增功能，不重构现有架构，不删除已经成立的领域定义；
- 不改变 Note、Diary、Ledger 的现有业务契约，也不改写 Board 的开发计划；
- 当前运行时行为仍以 `docs/architecture/` 和 `docs/user-guide/` 中的 authority 为准；
- 未来 Relation、跨 Workspace AI、Timeline、Sync 等能力需要另行设计、实现和验证。
