# Icon Usage

Use icons by meaning, not by shape alone. New functional icons come from the single
approved `@vicons/tabler` family through `NIcon`; this page defines stable semantic
distinctions so component changes do not make the documentation stale.

The former `src/components/vault/icons.ts` inventory was removed after the Vault/Note
migration reached zero production consumers. Historical `ICON_*` names in archived
plans describe semantics only; current production code uses Tabler components through
`NIcon`.

## Semantic mapping authority

`ICON_*` names are historical semantic vocabulary, not a second target icon family. The
semantic distinction remains owned by Nuvyn while current glyphs are implemented by the
approved Tabler family:

```text
Legacy: ICON_* export
Target: approved @vicons/tabler glyph rendered by NIcon
```

Do not infer a Tabler export from a similar name. Each new mapping must verify the actual
TypeScript export from the installed approved family, review the meaning at the
consuming surface, and preserve the existing accessible label. The family name is the
product contract; the package version is an implementation detail that can change
through dependency and regression review.

## Target functional vocabulary

| Nuvyn meaning | Approved Tabler candidate |
| --- | --- |
| Search | `Search` |
| Settings | `Settings` |
| Add / create | `Plus` or a more specific `*Plus` glyph |
| Delete | `Trash` |
| Edit | `Pencil` |
| Save | `DeviceFloppy` |
| Calendar | `Calendar` |
| Folder | `Folder` |
| Document / file | `File` or a specific `File*` glyph |
| Account | `User` |
| Wallet / account balance | `Wallet` |
| Income / expense / transfer | semantic `Arrow*` or transaction glyph |
| History | `History` |
| Copy / download / upload | corresponding Tabler utility glyph |
| Chevron / disclosure | `Chevron*` |
| Close | `X` |
| Confirm / success | `Check` |
| Warning / info / error | corresponding Tabler status glyph |
| Theme | semantic sun / moon glyph |

These names are candidate examples for the approved family, not a claim that production
mapping has already happened. Confirm the actual export, glyph meaning, and accessible
label at the consuming surface during its migration. No second icon family is allowed.

## Current surface mapping

| Surface | Primary vocabulary |
| --- | --- |
| Navigation bar | search, theme, edit/read, right-rail, and vault-scope icons |
| Activity bar | files, tags, Git history, and settings |
| File tree and context menu | folders, Markdown files, create, rename, delete, archive |
| Right rail | table of contents and document links |
| Editor/status bar | save and connectivity states |
| AI panel | AI identity, conversation actions, tool-specific icons, tool status |
| History timeline | Git/version and disclosure icons |

Current call sites are best found by locating the corresponding Tabler component and
`NIcon`; semantic names in this document remain stable even when glyph exports change.

## Required distinctions

- `ICON_EDIT` means switching to edit mode; `ICON_RENAME` means renaming a file.
- `ICON_EYE` offers read mode. `ICON_READ` is a reserved book glyph and is not the navigation toggle.
- `ICON_HISTORY` is conversation/timeline history; `ICON_AB_GIT_HISTORY` is the vault Git-history activity.
- `ICON_DELETE` is a general file-tree action; `ICON_DELETE_FILE` is the compact AI tool glyph.
- `ICON_NEW_CHAT` starts a conversation; `ICON_AI_CONVERSATION` is a general conversation concept.
- `ICON_LINKS` represents the current document's backlinks/outgoing links; it does not promise a graph view.
- `ICON_TOC` represents the reading table of contents.
- `ICON_PANEL_RIGHT_OPEN` and `ICON_PANEL_RIGHT_CLOSE` represent panel state, not navigation direction.

## Status vocabulary

State must be distinguishable by glyph as well as color:

| State | Icon |
| --- | --- |
| Saved / successful | `ICON_STATUS_SUCCESS` |
| Modified / external change | `ICON_STATUS_MODIFIED` |
| Saving / pending | `ICON_STATUS_LOADING` |
| Error | `ICON_STATUS_ERROR` |
| Offline | `ICON_STATUS_OFFLINE` |
| Warning | `ICON_STATUS_WARNING` |

The component supplies the state label. Do not rely on color or an icon-only tooltip as the accessible name.

Future status glyphs should use the approved Tabler family. If loading is animated, the
animation belongs to the consuming component or `NIcon` presentation; do not alter the
upstream glyph.

## AI tool mapping

The AI tool card maps tool names to compact glyphs:

| Tool | Icon |
| --- | --- |
| `read_file` | `ICON_READ_FILE` |
| `list_files` | `ICON_LIST_FILES` |
| `create_file` | `ICON_CREATE_FILE` |
| `write_file` | `ICON_WRITE_FILE` |
| `patch_file` | `ICON_PATCH_FILE` |
| `delete_file` | `ICON_DELETE_FILE` |
| `rename_file` | `ICON_RENAME_FILE` |

`update_metadata` currently falls back to the generic tool glyph. If a dedicated icon is added, update the tool map, tests, and this table together.

AI actions follow the same rule: read, list, create, write, patch, delete, rename,
conversation, and new-chat semantics should use approved Tabler glyphs where a matching
meaning exists. A unique Nuvyn AI brand mark requires a separately reviewed
Brand / Domain exception.

## Reserved vocabularies

Some historical semantic names describe coherent future controls or file types and have
no current consumer. Treat them as design vocabulary, not user-facing feature
documentation. Before using one, confirm that its metaphor still fits and choose an
actual approved Tabler export with an accessible labeled control.

## Review checklist

- The icon conveys the same concept everywhere it appears.
- New functional glyphs are imported from `@vicons/tabler` and rendered through
  `NIcon` where a Naive UI control is involved.
- The control has a text label, `aria-label`, or equivalent accessible name.
- Decorative SVG remains `aria-hidden`.
- Hover, focus, active, disabled, and danger states come from the consuming component.
- Theme and status color flow through `currentColor` or CSS tokens.
- No new hand-written functional SVG or copied path was added.
- The current icon lint passes, with only documented brand/generated/renderer
  exceptions in [Icon System](icon-system.md).

See [Icon System](icon-system.md) for geometry and exception rules.
