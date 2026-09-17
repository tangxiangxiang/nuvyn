# Project Structure

```text
nuvyn/
├── src/                  Vue client
│   ├── components/       Shared and vault UI
│   ├── composables/      Editor, history, search, links, recovery state
│   ├── lib/              Rendering, search, API, and utility modules
│   └── views/            Routed views
├── server/               Hono API and trusted services
│   ├── ai/               Providers, sessions, context, and tools
│   ├── history/          Vault Git operations
│   ├── migrations/       SQLite schema migrations
│   └── routes/           Document, folder, metadata, link, and vault APIs
├── shared/               Cross-boundary policies and types
├── e2e/                  Playwright suites and visual baselines
├── scripts/              Repository maintenance scripts
├── public/               Static application assets
├── docs/                 Maintained documentation and archive
├── src/content/          Default development vault
└── data/                 Default server state directory
```

## Where changes belong

- UI behavior and browser persistence: `src/components/` or `src/composables/`.
- Trusted filesystem or database behavior: `server/`.
- A rule that must be enforced consistently on client and server: `shared/`, with authoritative validation on the server.
- SQLite schema evolution: a new ordered file in `server/migrations/` plus migration tests.
- End-user behavior: update `docs/user-guide/`.
- Runtime or deployment behavior: update `docs/deployment/`.
- Architectural invariants: update `docs/architecture/`.

Historical plans and completion evidence belong in `docs/archive/`; they must not become the canonical description of current behavior.
