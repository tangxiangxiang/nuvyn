declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it'
  interface TaskListsOptions {
    enabled?: boolean
    label?: boolean
    labelAfter?: boolean
    lineNumber?: boolean
  }
  const plugin: (md: MarkdownIt, opts?: TaskListsOptions) => void
  export default plugin
}

declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it'
  // markdown-it-footnote 4.x 默认不接受配置;所有行为通过覆盖
  // md.renderer.rules.footnote_* 完成。这里只声明插件函数本身。
  const plugin: (md: MarkdownIt) => void
  export default plugin
}

declare module 'markdown-it-deflist' {
  import type MarkdownIt from 'markdown-it'
  // markdown-it-deflist 3.x 同样不接受配置;所有样式通过覆盖
  // md.renderer.rules.dl_open / dt_open / dd_open 等完成。
  const plugin: (md: MarkdownIt) => void
  export default plugin
}

declare module 'markdown-it-mark' {
  import type MarkdownIt from 'markdown-it'
  // markdown-it-mark 4.x: ==text== → <mark>text</mark>。无配置。
  // package.json 将其声明为 direct dependency，因为源码直接导入它。
  const plugin: (md: MarkdownIt) => void
  export default plugin
}
