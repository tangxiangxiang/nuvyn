# Ledger UI Language

> [!IMPORTANT]
> 这是当前 Ledger 的可复用 UI 语言。规则来自已提交的 Ledger 组件、页面和近期交互调整；它不是旧 PRD 的视觉草案，也不把偶然 CSS 当成规范。

## 1. Design Direction

Ledger 采用 compact、calm、personal finance 和 high information density 的方向，不做厚重的 admin-console。白/浅灰 surface、紫色 primary accent、柔和边框、轻阴影和足够留白共同构成基础层。内容优先，装饰只用于建立层级和状态。

## 2. Semantic Colors

- 收入使用绿色。
- 支出使用红色。
- 转账、还款、提现共用紫色系；子类型通过文案和箭头区分，不另造业务颜色。
- 警告和错误使用控件的语义色，不借用收入/支出颜色表达无关状态。

## 3. Action Button Size

Ledger 的普通 action NButton 统一使用 size="small"，形成约 32px 的 compact rhythm。适用范围包括返回概览、新增账户、记一笔、保存、取消、编辑、删除、恢复、重试、重新加载和清除筛选。

这条规则只约束 action button，不要求 Input、Select、DatePicker 或 Loading 也使用 small；表单控件可根据信息密度使用 medium。icon-only close button 可以保留独立的方形几何，但仍使用小尺寸和明确 aria-label。

按钮语义保持简单：primary 用于主要提交或创建，基础/secondary 用于取消、编辑和次要动作，danger 只用于删除或归档等破坏性操作。不要在同一组操作中混用 default、medium、large 的 action 高度。

## 4. Forms

桌面表单优先采用两列布局：金额等核心字段占满宽度，账户/分类和时间/地点并列，交易对象与备注按需占满宽度。label 紧凑但清晰，必填和可选状态直观可见。移动端降为单列；交易 sheet 是表单间距、按钮和焦点行为的 reference。

## 5. Transaction Type Hierarchy

一级交易类型始终是支出、收入、转账。普通转账、还款和提现只属于 Transfer 的二级业务子类型，不能升级为顶层 tab 或独立的 Transaction type。

交易记录类型 badge 保留轻量方向箭头：收入向上、支出向下、转账向右；“全部”使用上下箭头符号表示混合方向。还款/提现沿用转账紫色系。

## 6. Account Select

账户选择器使用 icon-rich renderer：

- 已选值显示图标和账户名称，不持续显示余额。
- 下拉项显示图标、账户名称和右对齐余额。
- 资产账户与负债账户用 group header 分组。
- 名称过长使用 ellipsis；余额 nowrap 并形成统一的右侧数值列。
- builtin、银行和 custom icon 使用相同尺寸盒子垂直对齐。

交易筛选卡的紧凑布局可能已经在卡片左侧提供固定账户图标，因此可以隐藏已选值中的重复图标；下拉项仍必须使用同一套 icon、名称和余额 renderer。新账户选择器不得重新引入另一套文本选项。

## 7. Category Select

分类选择器的已选值和下拉项都使用图标加分类名称，不显示额外 description 或余额。收入、支出分类必须保持 kind 语义；系统分类图标也沿用同一尺寸和颜色处理。筛选卡如果已有固定前缀图标，可隐藏重复的 collapsed icon，但不能改变下拉项样式。

## 8. Transaction Table

Transactions workspace 使用 data table + pagination，而不是 timeline 或 infinite scrolling。主要列保持交易、类型、分类、账户、备注、时间和金额。桌面表格用固定高度区域承载滚动数据和固定表头，分页区独立固定在底部；当前控件通过 NDataTable 的 max-height 约束数据区。

表格不使用 vertical gridline；用轻量 horizontal separation、留白和 hover/selected surface 建立行层级。金额列右对齐，正负金额使用收入/支出语义色；时间显示 Ledger 时区下的完整年份、日期和时间。

## 9. Transfer Badges

顶部筛选仍保持全部、收入、支出、转账四项。表格中可显示：

~~~text
→ 转账
→ 还款
→ 提现
~~~

箭头保留方向提示但保持轻量；不要把“还款”或“提现”渲染成新的一级筛选体系。

## 10. Modal / Sheet

Ledger modal/sheet 保持 compact、centered 和 clear hierarchy。标题只保留一层产品上下文和一层当前操作标题；详情与编辑复用相同的容器、关闭按钮、footer 对齐和 focus/trap 行为。桌面使用居中 surface，窄屏允许转为 bottom-sheet 式布局。内容较长时只让内容区滚动，不能让操作按钮漂移或被裁切。

## 11. Empty / Loading / Error

- 初次加载使用明确的 loading/skeleton，不用演示数据填充主内容。
- 没有记录时使用 NEmpty，区分“暂无记录”和“当前筛选无结果”，并提供记第一笔或清除筛选动作。
- 请求失败使用就地错误提示和重试入口；保留用户可继续判断的上下文。
- 未确认的新建操作使用独立 recovery gate，不和普通空状态或普通 validation error 混淆。

## 12. Things To Avoid

- 不混用普通 action button 的尺寸和高度。
- 不把表格改回 activity timeline 或无限滚动。
- 不把还款/提现提升成一级 Transaction Type。
- 不在 collapsed account select 永久显示余额。
- 不让下拉余额贴着账户名；它必须右对齐。
- 不为 Ledger 引入 heavy admin-console chrome。
- 不把账户和分类的 icon-rich select 拆成多套 renderer。
- 不复制某个组件当前的偶然 CSS 作为新设计规则；先确认它是否属于共享语义或布局 invariant。
