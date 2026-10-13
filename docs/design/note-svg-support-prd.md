# Nuvyn Note SVG 安全支持

**状态：** 已实现
**范围：** 普通 Note 图片上传、渲染与附件引用
**关联历史需求：** [Note 图片上传与插入](./note-image-insertion-prd.md)

这份后续设计记录为 Note 增加经过服务端校验的静态 SVG。它不改写此前 P0 图片需求中暂不支持 SVG 的历史决策，也不把 SVG 转成位图。

## 用户可见行为

用户可以通过现有图片选择器、拖放，或剪贴板提供的本地 SVG 文件将图形插入 Note。系统生成标准 Markdown 图片引用，使用服务器生成的 `attachments/images/<uuid>.svg` 路径。阅读模式通过受认证的 Markdown Resource API 加载资源；Attachment Manager 将其作为 Vault Image 展示，引用索引使用现有 Note 图片引用关系。

PNG、JPEG、WebP、GIF 和 AVIF 继续使用原有光栅流程。Note 原始 Markdown 的 HTML 白名单未放宽，不能直接嵌入 `<svg>`。

## 安全处理

- SVG 输入和规范化输出上限均为 8 MiB。服务端使用 namespace-aware SAX XML 解析器，不用正则代替 XML 解析。
- 拒绝任意 DTD、实体扩展和 XML processing instruction；仅识别并剥离标准 SVG 1.1 公共/系统标识，不加载外部 DTD，内部子集声明始终忽略。限制 XML 深度、文本、属性、元素数量和输出字节数。
- 服务端只序列化静态元素及经验证的属性。脚本、事件处理属性、`foreignObject`、动画、外部链接、任意 URL、外部字体、CSS import、滤镜和未知 XML 内容都会被拒绝，而不是悄悄从图中移除。
- 内部渐变、裁剪路径、mask 和 symbol 引用仅接受本地片段，并在完整解析后检查目标 ID 和目标元素类型。`use` 仅能引用静态 `symbol`，不能指向外部资源。
- `image` 数据 URI 仅接受通过光栅签名检查的 PNG、JPEG、GIF、WebP 或 AVIF；每个内嵌图像最多 4 MiB，总量最多 4 MiB。嵌套 SVG 不接受。
- Excalidraw 使用的内嵌 WOFF2 字体仅在正确 MIME、签名与头部尺寸且满足单字体 512 KiB、总计 2 MiB、最多 16 个字体限制时保留。
- 图片上传只保存规范化后的安全 SVG，并继续使用 UUID、create-only durable 写入、现有路径验证及两路并发限制。
- 资源 API 在每次读取 SVG 时重新校验并规范化。因此通过文件管理器或其他途径手工放入 Vault 的恶意 SVG 也不会绕过上传校验。SVG 响应保留认证、`no-store`、`nosniff`，并添加禁止脚本和对象、限制资源来源及 sandbox 的 CSP。

## 支持的内容与限制

支持常见静态矢量绘图和文字、分组、内部渐变、`clipPath`、Excalidraw 本地图片 `symbol/use` 与裁剪 `mask`。校验会要求 SVG 根节点之外存在可渲染内容：空根、仅元数据/定义/空容器、无有效文字的空文本和零尺寸图形都会被拒绝；被实际使用的内部 symbol/use 图形仍算作内容。此检查是结构性证明，不尝试像素级可见性分析。内嵌的外部图片/字体、嵌套 SVG、`filter`、脚本、交互、动画、未知标签和不在样式白名单内的 CSS 会失败关闭。特别是 Excalidraw 对其他 SVG 应用暗色滤镜的导出可能含有 `filter`，当前会拒绝；可改为导出静态浅色/深色矢量内容再插入。

大图或复杂图可能因 8 MiB、50,000 个元素、64 层深度、512 KiB 文本/属性或内嵌资源限制而被拒绝。服务端拒绝时不会生成附件文件。PDF 使用既有浏览器图片导出路径；PDF 专项的 SVG 字体保真度不作为这次实现的保证。

## 验证重点

覆盖静态与 Excalidraw 风格 SVG、活动内容拒绝、空内容拒绝、上传不落盘、Vault 手工文件读取净化、资源响应头、Markdown 图片 URL、附件目录扫描和 Note 引用追踪。`e2e/fixtures/excalidraw-note-image.svg` 是为测试原创场景并由锁定版本 `@excalidraw/excalidraw@0.18.0-4e758db` 导出的双语矢量/内嵌图片样本；来源、生成包与随导出嵌入的 Virgil 字体授权记录在 `e2e/fixtures/README.md`。浏览器测试解码并绘制该样本，检查实际 `naturalWidth` / `naturalHeight`、非空像素及嵌入字体可加载，同时检查刷新后加载及附件详情引用，而不只检查 HTTP 状态。Chromium / WebKit 的实际运行情况以测试报告为准。
