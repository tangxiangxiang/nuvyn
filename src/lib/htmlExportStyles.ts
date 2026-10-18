import postcss from 'postcss'
import readerStyles from '../style.css?raw'
import shikiStyles from '../shiki.css?raw'
import katexStyles from 'katex/dist/katex.min.css?raw'

// Only parser-owned reading primitives are shared, never application layout,
// theme overrides or PDF/A4 pagination. Keep the Flex enumerations in one place.
const selected = postcss.parse(readerStyles)
for (const node of [...selected.nodes]) {
  if (node.type === 'rule') {
    if (!node.selectors.every((s) => /^\.article (?:\.nuvyn-flex|\.callout|\.markdown-container|blockquote)/u.test(s))) node.remove()
  } else if (node.type === 'atrule' && node.name === 'container') {
    if (!node.toString().includes('.nuvyn-flex-mobile-stack')) node.remove()
  } else node.remove()
}

export const HTML_READING_STYLES = `
:root{color-scheme:light;--text:#202124;--text-h:#111827;--text-muted:#6b7280;--bg:#fff;--code-bg:#f5f6f8;--border:#d7dce2;--vs-text-1:#202124;--vs-text-3:#6b7280;--vs-bg-2:#f5f6f8;--mono:ui-monospace,SFMono-Regular,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--text);font:16px/1.7 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.article{width:100%;max-width:960px;margin:auto;padding:40px 28px;overflow-wrap:anywhere}
h1,h2,h3,h4{line-height:1.3;color:var(--text-h);margin:1.6em 0 .7em}h1{font-size:2rem}h2{font-size:1.5rem}p,ul,ol,pre,table{margin:1em 0}a{color:#005fb8}a.header-anchor{color:inherit;text-decoration:none}
img{max-width:100%;height:auto}pre{overflow:auto;padding:1rem 2rem;border-radius:12px;background:var(--code-bg);font:14px/1.55 var(--mono);white-space:pre}code{font-family:var(--mono)}:not(pre)>code{background:var(--code-bg);border-radius:4px;padding:.12em .3em}
.table-scroll{max-width:100%;overflow-x:auto}table{border-collapse:collapse}th,td{border:1px solid var(--border);padding:8px 12px}th{background:#f5f6f8}hr{border:0;border-top:1px solid var(--border);margin:2rem 0}
.math-block{max-width:100%;overflow-x:auto;padding:12px 0}.math-inline{display:inline}.footnotes{font-size:.85em}.task-list-item{list-style:none}.task-list-item input{margin-right:.4em}
.nuvyn-flex>*{min-width:0;max-width:100%;margin-top:0;margin-bottom:0}.nuvyn-flex img{display:block}
.nuvyn-code-group-pdf-label{padding:8px 16px;background:#eef0f4;font-weight:600}.nuvyn-code-group-panel{display:block!important}.nuvyn-code-group{border:1px solid var(--border);border-radius:12px;overflow:hidden;margin:1em 0}.nuvyn-code-group pre{margin:0;border-radius:0}
.html-diagram>svg{display:block;width:100%;height:auto;max-width:100%}.board-embed{display:block;margin:1em 0;padding:16px;border:1px solid var(--border);border-radius:12px;text-align:center}.board-embed img{display:block;margin:auto;max-height:480px;width:auto}
.markmap{font:16px/20px sans-serif}.markmap-foreign p{margin:0}.markmap-foreign{display:inline-block}.markmap a{color:#005fb8}
details>summary{cursor:pointer}dt{font-weight:600}dd{margin-left:1.5em}mark{background:#fff0a8}
@media(max-width:600px){.article{padding:24px 16px}pre{padding:16px}h1{font-size:1.7rem}}
${selected.toString()}
${shikiStyles}
:root[data-theme='light'] .article pre.shiki{background-color:var(--code-bg)}
.article pre[data-language]{position:relative}.article pre[data-language]::after{content:attr(data-language);position:absolute;right:1rem;top:.75rem;color:var(--text-muted);font:12px/1 var(--mono)}
.article pre.nuvyn-code-single-line[data-language]::after{top:50%;transform:translateY(-50%)}
.article a:not([href]){color:inherit;text-decoration:none;cursor:default}
`

export const HTML_KATEX_STYLES = katexStyles
export const HTML_KATEX_FONTS = import.meta.glob('/node_modules/katex/dist/fonts/*.woff2', {
  query: '?url', import: 'default', eager: true,
}) as Record<string, string>
