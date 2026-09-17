import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import {
  getMarkdownModel,
  registerMarkdownModel,
} from './monacoModelRegistry'
export {
  disposeMarkdownModel,
  disposeManagedDiaryModels,
  renameMarkdownModel,
  resetMarkdownModelsForTesting,
} from './monacoModelRegistry'

export function acquireMarkdownModel(path: string, value: string): monaco.editor.ITextModel {
  const existing = getMarkdownModel(path) as monaco.editor.ITextModel | undefined
  if (existing && !existing.isDisposed()) return existing
  const model = monaco.editor.createModel(value, 'markdown', monaco.Uri.parse(`nuvyn://vault/${path}`))
  registerMarkdownModel(path, model)
  return model
}
