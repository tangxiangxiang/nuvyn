# Search and Indexing

Nuvyn combines server-provided metadata with browser-side indexes optimized for interactive filtering and navigation.

## Command palette

The command palette uses MiniSearch. Its primary index includes document title, path, tags, and summary. Document bodies are loaded and cached separately so content search can remain responsive without placing bodies in SQLite.

Search results keep stable document identity alongside paths so navigation survives path changes coordinated by the server.

## File-tree filtering

The file tree has a lightweight query language:

- plain tokens match path or title;
- multiple plain tokens are combined with AND;
- `#tag` requires a tag;
- `-#tag` excludes a tag;
- multiple included tags must all match.

Tag identity is normalized by trimming whitespace, removing one leading `#`, and comparing lowercase values.

## Link index

The server builds an in-memory index for supported Wiki links and relative Markdown links. It resolves outgoing links and backlinks for the Links panel and supports reference rewrites during rename or move operations.

The index is rebuilt from current vault content; it is not a durable database. Nuvyn does not currently ship a standalone graph visualization.

## Consistency

Filesystem content remains authoritative for paths and bodies, while SQLite is authoritative for application metadata. Lifecycle APIs update both domains, and clients refresh affected indexes from the mutation result. External filesystem edits may require the normal tree/index refresh path before every view reflects them.

