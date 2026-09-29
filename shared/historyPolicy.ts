/** Return whether a logical or physical Markdown path belongs to Inbox drafts. */
export function isInboxDraftPath(filePath: string): boolean {
  return filePath === 'inbox' || filePath.startsWith('inbox/')
}
