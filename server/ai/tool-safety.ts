// Edit-10.4: server-enforced safety for AI file mutation tools.
//
// The Edit-10.3 live workspace snapshot is the turn's context
// authority. This module turns the normalized ChatContext into ONE
// ToolSafetyPolicy and applies it to every mutation tool call,
// immediately before the side effect (never once per runChat — the
// model may call tools seconds after reasoning, and a clean document
// must be RE-verified against the server's current identity and raw
// at call time).
//
//   none / legacy-path          → unrestricted (old clients keep
//                                 current behavior; they carry no
//                                 reliable dirty/read-only state)
//   live History / Diff /       → deny-protected-path
//        Recovery               →   (read-only-context)
//   live Document external      → deny-protected-path
//                                →   (external-conflict)
//   live Document dirty         → deny-protected-path
//                                →   (unsaved-context)
//   live Document transient     → deny-protected-path
//        saveStatus             →   (unstable-context)
//   live Document clean+stable  → verify-clean-document: every
//        same-path mutation re-reads the server's current document
//        and requires documentId + raw to match the snapshot before
//        the tool may run. Same path ≠ same document (path reuse
//        after delete/rename), and same document ≠ same content
//        (disk changed after the snapshot).
//
// A blocked call returns an ordinary is_error ToolResult — never a
// throw, never a file_changed, never a disk write, and never a
// database write: the clean-document re-verification is a pure read,
// so a blocked mutation leaves server state byte-identical. rename
// safety covers the rename's WHOLE footprint — source, destination,
// and every backlink file its reference rewrite would modify. The
// policy lives only in the current runChat's memory: it is not
// persisted, not sent over SSE, not echoed to the model beyond the
// short error text, and expectedRaw / documentIds never appear in
// any message.
import fs from 'node:fs'
import type { Database as DatabaseT } from 'better-sqlite3'
import type { AiLiveContextSnapshot } from '../../src/composables/vault/aiLiveContext.js'
import type { ChatContext } from './chat.js'
import { getDocumentMetadata } from '../documentMetadata.js'
import { filePathFor, normalizeLogicalContentPath } from '../paths.js'

// ── Mutation target classification (§5.1) ───────────────────────────

/**
 * What a tool call intends to mutate. `none` = read-only tool;
 * `unknown` = fail-closed bucket for unknown tools or malformed
 * mutating input — never treated as read-only. The dispatcher
 * rejects unknown/malformed calls with its own errors; the guard
 * simply never certifies them as safe.
 */
export type ToolMutationTarget =
  | { kind: 'none' }
  | { kind: 'single-path'; path: string }
  | {
      kind: 'rename'
      sourcePath: string
      destinationPath: string
      /**
       * Every backlink source file the rename will REWRITE when
       * update_references is on (default). rename_file's mutation
       * footprint is source + destination + all rewritten reference
       * files — an "unrelated" rename can indirectly modify the
       * protected document by rewriting a link inside it. Static
       * classification returns `[]`; the dispatcher fills the real
       * set from the link index (it needs the async index build)
       * before locking and guarding.
       */
      referencePaths: string[]
    }
  | { kind: 'unknown' }

/**
 * Every tool the AI surface defines. The exhaustive switch below
 * makes an unclassified addition to this union a typecheck error;
 * tools.test / tool-safety.test additionally assert set equality with
 * TOOL_DEFINITIONS so a tool added there fails tests until it is
 * classified here.
 */
export type ClassifiedToolName =
  | 'read_file'
  | 'list_files'
  | 'create_file'
  | 'write_file'
  | 'patch_file'
  | 'delete_file'
  | 'update_metadata'
  | 'rename_file'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function getToolMutationTarget(
  toolName: string,
  input: Record<string, unknown>,
): ToolMutationTarget {
  switch (toolName as ClassifiedToolName) {
    case 'read_file':
    case 'list_files':
      return { kind: 'none' }
    case 'create_file':
    case 'write_file':
    case 'patch_file':
    case 'delete_file':
    case 'update_metadata': {
      return isNonEmptyString(input.path)
        ? { kind: 'single-path', path: input.path }
        : { kind: 'unknown' }
    }
    case 'rename_file': {
      // Static classification only: the backlink reference footprint
      // (referencePaths) is resolved later by the dispatcher, which
      // holds the link index. Empty here means "no known reference
      // writes YET", never "reference writes are exempt".
      return isNonEmptyString(input.path) && isNonEmptyString(input.new_path)
        ? { kind: 'rename', sourcePath: input.path, destinationPath: input.new_path, referencePaths: [] }
        : { kind: 'unknown' }
    }
    default:
      // Unknown tool: fail closed. The dispatcher rejects it too;
      // the point is that it never lands in the read-only bucket.
      return { kind: 'unknown' }
  }
}

// ── ChatContext → policy (§5.2) ─────────────────────────────────────

export type DenyReason =
  | 'read-only-context'
  | 'unsaved-context'
  | 'external-conflict'
  | 'unstable-context'

export type ToolSafetyPolicy =
  | { kind: 'unrestricted' }
  | { kind: 'deny-protected-path'; protectedPath: string; reason: DenyReason }
  | {
      kind: 'verify-clean-document'
      protectedPath: string
      expectedDocumentId: string
      expectedRaw: string
    }

/**
 * Pure function of the normalized ChatContext. Copies only primitive
 * fields out of the snapshot, so the returned policy is a by-value
 * object with no reactive state and no live reference to the
 * snapshot. Priority inside a Document context: external > dirty >
 * unstable > clean (most specific reason wins).
 */
export function deriveToolSafetyPolicy(ctx: ChatContext): ToolSafetyPolicy {
  if (ctx.kind !== 'live') {
    // none → no workspace context; legacy-path → old clients send no
    // reliable dirty/read-only/external state, so their current
    // (unrestricted) tool behavior is preserved.
    return { kind: 'unrestricted' }
  }
  const snapshot = ctx.liveContext
  switch (snapshot.kind) {
    case 'diff':
    case 'recovery':
      // Read-only workspace views. Even a Diff whose after-side is
      // the live editor is protected: the user's active workspace is
      // the read-only comparison, not the editable document.
      return {
        kind: 'deny-protected-path',
        protectedPath: snapshot.identity.path,
        reason: 'read-only-context',
      }
    case 'document': {
      const protectedPath = snapshot.identity.path
      if (snapshot.external || snapshot.saveStatus === 'external') {
        return { kind: 'deny-protected-path', protectedPath, reason: 'external-conflict' }
      }
      if (snapshot.dirty) {
        return { kind: 'deny-protected-path', protectedPath, reason: 'unsaved-context' }
      }
      if (snapshot.saveStatus !== 'idle' && snapshot.saveStatus !== 'saved') {
        // saving / error / offline / a bare 'dirty' status without the
        // dirty flag: transient, fail closed.
        return { kind: 'deny-protected-path', protectedPath, reason: 'unstable-context' }
      }
      return {
        kind: 'verify-clean-document',
        protectedPath,
        expectedDocumentId: snapshot.identity.documentId,
        expectedRaw: snapshot.raw,
      }
    }
    default: {
      // Exhaustive over AiLiveContextSnapshot['kind']: a NEW snapshot
      // kind is a typecheck error here until it gets an explicit
      // policy — never a silent unrestricted fall-through.
      const unhandled: never = snapshot
      throw new Error(`deriveToolSafetyPolicy: unhandled live context kind ${(unhandled as AiLiveContextSnapshot).kind}`)
    }
  }
}

// ── Guard (§11) ─────────────────────────────────────────────────────

export type ToolSafetyErrorCode =
  | 'active-context-read-only'
  | 'active-context-unsaved'
  | 'active-context-external-conflict'
  | 'active-context-unstable'
  | 'active-context-identity-mismatch'
  | 'active-context-stale'
  | 'active-context-unverifiable'

export type ToolSafetyDecision =
  | { allowed: true }
  | { allowed: false; code: ToolSafetyErrorCode; message: string }

/** The server's CURRENT view of a document — what an editor opening
 * the file right now would see (same authority as GET /api/posts). */
export interface CurrentServerDocument {
  documentId: string
  path: string
  raw: string
}

export type ReadCurrentServerDocument = (
  logicalPath: string,
) => CurrentServerDocument | null | Promise<CurrentServerDocument | null>

const DENY_CODE: Record<DenyReason, ToolSafetyErrorCode> = {
  'read-only-context': 'active-context-read-only',
  'unsaved-context': 'active-context-unsaved',
  'external-conflict': 'active-context-external-conflict',
  'unstable-context': 'active-context-unstable',
}

// Error texts are shown to the model as an ordinary tool_result.
// They carry the error code and the LOGICAL path only — never the
// snapshot raw, never the disk raw, never documentIds, never
// filesystem paths.
const BLOCK_MESSAGE: Record<ToolSafetyErrorCode, (logicalPath: string) => string> = {
  'active-context-read-only': (p) =>
    `Tool blocked: active-context-read-only. The active workspace is a read-only History, Diff, or Recovery view of ${p}. Do not modify this path from the current context; ask the user to switch to the editable document first.`,
  'active-context-unsaved': (p) =>
    `Tool blocked: active-context-unsaved. The active document ${p} has unsaved editor content. Do not modify its disk file; ask the user to save or resolve the document first.`,
  'active-context-external-conflict': (p) =>
    `Tool blocked: active-context-external-conflict. The active document ${p} has an unresolved external change. Ask the user to resolve the conflict before any modification.`,
  'active-context-unstable': (p) =>
    `Tool blocked: active-context-unstable. The active document ${p} is in a transient save state. Ask the user to finish saving before any modification.`,
  'active-context-unverifiable': (p) =>
    `Tool blocked: active-context-unverifiable. The server cannot currently verify the identity of ${p} (the file is missing, unreadable, or has no document identity). Do not modify it in this turn.`,
  'active-context-identity-mismatch': (p) =>
    `Tool blocked: active-context-identity-mismatch. The path ${p} now belongs to a different document identity than the active snapshot. Do not modify it; ask the user to re-open the intended document.`,
  'active-context-stale': (p) =>
    `Tool blocked: active-context-stale. The on-disk content of ${p} changed after the snapshot was captured. Do not apply this mutation from the stale snapshot; ask the user to review the file and re-send.`,
}

function block(code: ToolSafetyErrorCode, logicalPath: string): ToolSafetyDecision {
  return { allowed: false, code, message: BLOCK_MESSAGE[code](logicalPath) }
}

/**
 * Decide whether one mutation may proceed under one policy.
 *
 * Equivalence is on CANONICAL logical paths: `notes/a` and
 * `notes/a.md` are the same protected path. rename_file is guarded on
 * its ENTIRE mutation footprint — source, destination, AND every
 * backlink reference file the rename will rewrite — so an unrelated
 * rename that would indirectly modify the protected document (by
 * rewriting a link inside it) is blocked / re-verified like a direct
 * write. A rename of an unrelated file ONTO the active path is
 * blocked, not left to the accidental "target already exists"
 * failure. create_file on the protected path is not exempt either.
 *
 * verify-clean-document performs the server re-verification HERE —
 * the caller runs the guard inside the same critical section as the
 * tool's own write, immediately before the side effect.
 */
export async function guardToolMutation(input: {
  policy: ToolSafetyPolicy
  target: ToolMutationTarget
  readCurrentDocument: ReadCurrentServerDocument
}): Promise<ToolSafetyDecision> {
  const { policy, target } = input
  if (policy.kind === 'unrestricted') return { allowed: true }
  // Read-only tools are never guarded; unknown/malformed calls pass
  // through to the dispatcher, which rejects them without side
  // effects (the guard never certifies them as safe — it just has
  // nothing to protect against).
  if (target.kind === 'none' || target.kind === 'unknown') return { allowed: true }

  const protectedPath = normalizeLogicalContentPath(policy.protectedPath) ?? policy.protectedPath
  const touched = target.kind === 'single-path'
    ? [target.path]
    : [target.sourcePath, target.destinationPath, ...target.referencePaths]
  const touchesProtected = touched.some((candidate) => {
    const normalized = normalizeLogicalContentPath(candidate)
    return normalized !== null && normalized === protectedPath
  })
  if (!touchesProtected) return { allowed: true }

  if (policy.kind === 'deny-protected-path') {
    return block(DENY_CODE[policy.reason], protectedPath)
  }

  // verify-clean-document: all three must hold at call time.
  const current = await input.readCurrentDocument(protectedPath)
  if (!current || !current.documentId) {
    return block('active-context-unverifiable', protectedPath)
  }
  if (current.documentId !== policy.expectedDocumentId) {
    // Same path, DIFFERENT document (delete + recreate, or a rename
    // swapped someone else in). Byte-identical raw does NOT rescue
    // this: path reuse must never be mistaken for the same document.
    return block('active-context-identity-mismatch', protectedPath)
  }
  if (current.raw !== policy.expectedRaw) {
    // Same document, changed disk (external edit, another window's
    // save) after the snapshot. The snapshot is no longer an
    // authority for a mutation.
    return block('active-context-stale', protectedPath)
  }
  return { allowed: true }
}

// ── Authoritative server read (§8.1) ────────────────────────────────

/**
 * Read the server's CURRENT view of a document: the file's raw bytes
 * plus the database-owned document identity — the same DATA the
 * editor's GET /api/posts/:path serves, read here as a PURE READ.
 * Verification must never repair or complete server state: no
 * ensureDocumentMetadata, no saveDocumentMetadata, no migration
 * import — a mutation that ends up BLOCKED must leave the database
 * byte-identical (no tag re-touch, no updatedAt advance, and above
 * all no freshly minted identity row for a file that has none).
 *
 * Returns null when the file is missing, unreadable, has an invalid
 * path, or has no identity on its existing metadata row — all of
 * which the guard reports as unverifiable. A file on disk with NO
 * documents row is unverifiable, NOT identity-mismatch: minting an
 * id to compare against would both write during verification and
 * guarantee the wrong error code. Never throws into the chat.
 */
export function readCurrentServerDocument(
  db: DatabaseT,
  logicalPath: string,
): CurrentServerDocument | null {
  const canonical = normalizeLogicalContentPath(logicalPath)
  if (!canonical) return null

  let raw: string
  try {
    raw = fs.readFileSync(filePathFor(canonical), 'utf8')
  } catch {
    return null
  }

  const metadata = getDocumentMetadata(db, canonical)
  if (!metadata?.id) return null

  return {
    documentId: metadata.id,
    path: canonical,
    raw,
  }
}
