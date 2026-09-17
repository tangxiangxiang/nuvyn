export type DraftKey = readonly [vaultId: string, documentId: string]

export function isDraftIdentity(vaultId: string, documentId: string): boolean {
  return vaultId.trim().length > 0 && documentId.trim().length > 0
}

export function draftKey(vaultId: string, documentId: string): DraftKey {
  return [vaultId, documentId]
}

