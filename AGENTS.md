# Repository Guidelines

## Project Structure & Module Organization

Nuvyn is a Vue 3 and TypeScript application backed by a Hono server and SQLite. Browser code lives in `src/`: reusable UI in `src/components/`, page-level views in `src/views/`, state and domain logic in `src/features/` and `src/composables/`, and shared utilities in `src/lib/`. Server routes and persistence code live in `server/`; cross-runtime contracts belong in `shared/`. Static assets are stored in `public/`, vault Markdown content defaults to `src/content/`, browser tests live in `e2e/`, and maintenance scripts live in `scripts/`. Keep current documentation in `docs/`; treat `docs/archive/` as historical context only.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependency set. Use Node.js 22 or 24.
- `npm run dev`: start the Vite development server, normally on port 5173.
- `npm run typecheck`: type-check both browser and server projects.
- `npm run build`: run project references through `vue-tsc`, then create the production Vite bundle.
- `npm test`: run unit plus history and recovery integration suites.
- `npm run test:unit`: run the main Vitest suite; pass a path to target one test file.
- `npm run test:e2e`: run Playwright browser coverage.
- `npm run lint:icons`: verify icon-system conventions.

## Coding Style & Naming Conventions

Follow the existing two-space indentation, single quotes in TypeScript, and semicolon-free style. Prefer Vue Composition API with `<script setup lang="ts">`. Name components and Vue files in PascalCase (`LedgerDatePicker.vue`), composables with a `use` prefix, functions and variables in camelCase, and CSS classes in kebab-case. Reuse existing Naive UI components, Ledger tokens, and shared protocol types before introducing abstractions. There is no general formatter command; keep edits focused and run `git diff --check`.

## Testing Guidelines

Vitest tests use `*.test.ts` under colocated `__tests__/` directories. Server tests follow the same pattern in `server/__tests__/`; Playwright specifications live in `e2e/`. Add focused tests for changed behavior, especially persistence, migrations, filtering, recovery, and timezone logic. Run the narrow suite while iterating, then `npm run typecheck`, `npm test`, and relevant E2E coverage before submission.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit-style subjects such as `feat(ledger): ...`, `feat: ...`, and `fix: ...`; keep subjects imperative and scoped when useful. Pull requests should explain the user-visible outcome, note data or migration impact, list verification commands, link related issues, and include screenshots for UI changes. Never commit credentials, generated `dist/`, local databases, or private vault content.

## Git Attribution Rules

- Never add AI attribution to commit messages.
- Never add `Co-Authored-By` for Claude, Codex, ChatGPT, Anthropic, OpenAI, or another AI system.
- Never add `Generated-By` or `Assisted-By` trailers.
- Git author and committer identity must come only from the repository owner's configured Git identity.
