# Development Setup

## Prerequisites

- Node.js 22 or 24
- npm
- Git available on `PATH`

Use npm for reproducible contributor setup because CI installs from `package-lock.json` with `npm ci`.

## Install and run

```bash
npm ci
mkdir -p src/content/inbox src/content/literature src/content/archive
npm run dev
```

The source development path needs the three vault roots to exist before the Vite plugin starts. The production server creates missing initial roots itself.

## Useful commands

```bash
npm run typecheck
npm test
npm run build
npm run lint:icons
npm run test:e2e
```

`npm run start` starts the production server from TypeScript and expects a built `dist/` for the client. For runtime variables, see [Configuration](../getting-started/configuration.md).

## Working data

Development uses `src/content/` by default and can create `data/nuvyn.db`. History may initialize a nested Git repository in the vault. Do not confuse it with the outer source repository when inspecting changes or cleaning test data.

Tests use temporary fixtures and dedicated Playwright server ports where configured. Avoid pointing tests at a real vault.

