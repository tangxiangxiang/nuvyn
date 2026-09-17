// Compatibility boundary for server callers. The pure algorithm lives in
// shared/ so browser comparisons and HTTP history routes use identical rules.
export { computeFileDiff } from '../../shared/file-diff.js'
export type { DiffOp, FileDiff } from '../../src/lib/history-api.js'
