// Shared archive-note logic.
//
// Places in the vault need to push a file into archive/<slug>.md:
//   - FileTree's right-click "归档" menu item
//   - AiPanel's Drafts panel archive button
//
// Both compute the same targetPath, call the same patchPost endpoint,
// handle the same server-side -2 suffix collision, and toast the same
// success / failure messages. The only thing they differ on is which
// events they emit afterward — FileTree emits 'refresh' and maybe
// 'select', AiPanel emits 'refresh-tree' and 'open'. So the composable
// owns the patch + toast + collision handling and returns the final
// path; the caller does its own emits.

import { useToast } from '../useToast'
import { patchPost } from '../../lib/api'
import { useI18n } from '../useI18n'
import { getFallbackVaultFileChanges } from './context/fileChanges'
import { useOptionalVaultContext } from './context/useVaultContext'

export function useArchiveNote() {
  const toast = useToast()
  const { t } = useI18n()
  const vaultContext = useOptionalVaultContext()

  /**
   * Move `path` to `targetPath` (default: archive/<filename>). Returns
   * the final path the server wrote (which may have a -2 / -3 suffix
   * on collision), or null if no action was taken (target equals
   * source, or no filename could be derived). Errors are toasted and
   * return null.
   *
   * The optional `targetPath` override is used by batch archive: the
   * caller pre-computes unique names from the full posts[] snapshot
   * so server-side collision suffixes don't pile up as -2/-3/-4/...
   * When omitted, falls back to archive/<filename>.
   */
  async function archive(path: string, targetPath?: string): Promise<string | null> {
    const filename = path.split('/').pop()
    if (!filename) return null
    const finalTarget = targetPath ?? `archive/${filename}`
    if (finalTarget === path) return null
    try {
      const moved = vaultContext?.lifecycle
        ? await vaultContext.lifecycle.renameFile(path, { targetPath: finalTarget })
        : await patchPost(path, { targetPath: finalTarget })
      if (!vaultContext?.lifecycle) {
        getFallbackVaultFileChanges().publish({
          oldPath: path,
          path: moved.path,
          kind: 'rename',
          source: 'editor-lifecycle',
        })
      }
      const displayFrom = finalTarget.replace(/^archive\//, '')
      const displayTo = moved.path.replace(/^archive\//, '').replace(/\.md$/, '')
      const toastMsg = displayFrom === displayTo
        ? t('archive.done')
        : t('archive.done_to', { path: moved.path })
      toast.success(toastMsg)
      return moved.path
    } catch (err: any) {
      toast.error(t('archive.failed', { error: err.message ?? t('common.unknown_error') }))
      return null
    }
  }

  return { archive }
}
