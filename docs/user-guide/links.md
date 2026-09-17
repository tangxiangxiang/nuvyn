# Links and Backlinks

Nuvyn recognizes Wiki links and vault-relative Markdown links between notes. The right rail shows two views for the active document:

- **Backlinks** lists notes that link to the current note.
- **Outgoing links** lists notes referenced by the current note.

The server builds an in-memory forward index from Markdown files and derives backlinks from it. Duplicate references to the same target and anchor in one source are collapsed for display. External URLs, root-absolute URLs, and links inside code are not treated as vault relationships.

Broken Wiki links remain visible in rendered Markdown as missing targets, but only resolvable targets appear in the relationship index.

When a rename may affect inbound references, Nuvyn can show the impacted source paths and update them as part of the guarded lifecycle operation. If a referenced document changes during planning, the rename fails with a retryable conflict rather than writing a stale reference update.

Nuvyn does not currently provide a standalone knowledge-graph view. Historical design plans for one are preserved in the [archive](../archive/specs/2026-06-13-knowledge-graph-design.md), but they do not describe a shipped feature.
