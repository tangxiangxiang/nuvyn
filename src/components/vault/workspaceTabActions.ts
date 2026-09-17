export interface ClipboardWriter {
  writeText(text: string): Promise<void>
}

function legacyCopyText(text: string, targetDocument: Document): boolean {
  const previousFocus = targetDocument.activeElement instanceof HTMLElement
    ? targetDocument.activeElement
    : null
  const textarea = targetDocument.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  targetDocument.body.appendChild(textarea)
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    return targetDocument.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    if (previousFocus?.isConnected) {
      previousFocus.focus({ preventScroll: true })
    }
  }
}

export async function copyTextToClipboard(
  text: string,
  clipboard: ClipboardWriter | undefined = navigator.clipboard,
  targetDocument: Document = document,
): Promise<boolean> {
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    // Try the dependency-free fallback below.
  }
  return legacyCopyText(text, targetDocument)
}

export interface RevealWorkspacePathOptions {
  revealPath: (path: string) => Promise<boolean | undefined>
  refresh: () => Promise<unknown>
  afterRefresh: () => Promise<unknown>
  onNotFound: (path: string) => void
  onError: (path: string) => void
}

export async function revealWorkspacePath(
  path: string,
  options: RevealWorkspacePathOptions,
): Promise<void> {
  try {
    if (await options.revealPath(path)) return
    await options.refresh()
    await options.afterRefresh()
    if (await options.revealPath(path)) return
    options.onNotFound(path)
  } catch {
    options.onError(path)
  }
}
