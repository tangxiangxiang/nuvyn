# Tags and Search

## Add Tags

Open Document Properties and edit the comma- or newline-separated Tags field. Tags are stored in SQLite, not written into new Markdown Frontmatter.

Tag identity is case-insensitive and trims one leading `#`. For example, `Java`, `java`, and `#JAVA` match as the same tag. The first observed casing is used as the display form.

## Tags Panel

The Tags panel lists tags by document count, then name. Select a tag to see its documents. The panel's own filter matches tag names only; both `java` and `#java` find the normalized tag.

## File-Tree Filter

The Files panel accepts text and tag tokens:

| Query | Meaning |
| --- | --- |
| `redis cache` | Both text tokens must appear in the title or logical path. |
| `#backend` | The document must contain the tag. |
| `#backend #database` | Both tags are required. |
| `-#draft` | Documents with the tag are excluded. |
| `redis #backend -#draft` | All three conditions apply. |

Text matching is a case-insensitive substring search of path and title. It does not search the body or summary. Exclusions win if the same tag is both required and excluded.

## Command Palette Search

The command palette builds a client-side MiniSearch index over title, path, tags, and summary, with title and path boosted. It also fetches and caches Markdown bodies by file modification time so body matches can fill remaining results. Prefix and limited fuzzy matching apply to the metadata index; body fallback uses a case-insensitive substring.

The indexes are in memory and rebuilt or invalidated after file changes. SQLite remains the source of truth for tags and summaries.
