# Nuvyn Documentation

Nuvyn is a Personal OS for your digital life. It is a self-hosted, single-owner system that brings together knowledge, experiences, finances, and visual thinking while keeping its Markdown content and technical boundaries explicit.

The canonical product definition and long-term design principles are in [Nuvyn — Personal OS](product.md). This hub indexes current user, architecture, deployment, development, and design documentation.

## Product

- [Nuvyn — Personal OS](product.md)

## Getting Started

- [Quick Start](getting-started/quick-start.md)
- [Installation](getting-started/installation.md)
- [Configuration](getting-started/configuration.md)

## User Guide

- [Overview](user-guide/overview.md)
- [Diary (Current)](user-guide/diary.md)
- [Ledger (Current)](user-guide/ledger.md)
- [Vault and Archive Protocol](user-guide/vault.md)
- [Editor and Draft Recovery](user-guide/editor.md)
- [Markdown, Links, and Diagrams](user-guide/markdown.md)
- [AI](user-guide/ai.md)
- [Tags and Search](user-guide/tags-and-search.md)
- [History](user-guide/history.md)
- [Links and Backlinks](user-guide/links.md)

## Deployment

- [Deployment Overview](deployment/overview.md)
- [Docker](deployment/docker.md)
- [Docker Release Deployment](deployment/docker-release.md)
- [Runtime Configuration](deployment/configuration.md)
- [Security](deployment/security.md)
- [Backup and Restore](deployment/backup-and-restore.md)

## Architecture

- [Architecture Overview](architecture/overview.md)
- [Diary Architecture (Current)](architecture/diary.md)
- [Ledger Architecture (Current)](architecture/ledger.md)
- [Storage](architecture/storage.md)
- [Edit and Save](architecture/edit-and-save.md)
- [Document Lifecycle](architecture/document-lifecycle.md)
- [History](architecture/history.md)
- [AI](architecture/ai.md)
- [Search and Indexing](architecture/search-and-indexing.md)
- [Security Boundaries](architecture/security.md)
- [Crash Recovery](architecture/crash-recovery.md)

## Development

- [Development Setup](development/setup.md)
- [Project Structure](development/project-structure.md)
- [Testing](development/testing.md)
- [Continuous Integration](development/ci.md)

## Design

- [Ledger UI Language (Current)](design/ledger-ui-language.md)
- [Shiki Syntax Highlighting Migration PRD](design/syntax-highlighting-shiki-migration-prd.md)
- [Shiki Syntax Highlighting Migration Implementation Plan](design/syntax-highlighting-shiki-migration-implementation-plan.md)
- [Shiki H0 Baseline & Contract Audit](design/syntax-highlighting-shiki-h0-audit.md)
- [Shiki H1 Dependency & Runtime Foundation](design/syntax-highlighting-shiki-h1-runtime-foundation.md)
- [Shiki H2 Fence Discovery & Dynamic Language Loading](design/syntax-highlighting-shiki-h2-language-loading.md)
- [Shiki H3 Markdown Renderer Cutover](design/syntax-highlighting-shiki-h3-renderer-cutover.md)
- [Shiki H4 Style-to-Class & Security Closure](design/syntax-highlighting-shiki-h4-security-closure.md)
- [Shiki H5 Theme Integration](design/syntax-highlighting-shiki-h5-theme-integration.md)
- [Shiki H6 PDF Compatibility](design/syntax-highlighting-shiki-h6-pdf-compatibility.md)
- [Shiki H7 highlight.js Cleanup](design/syntax-highlighting-shiki-h7-highlightjs-cleanup.md)
- [Shiki H8 Full Regression, Bundle Audit & Release Gate](design/syntax-highlighting-shiki-h8-release-gate.md)
- [Nuvyn VitePress-Style Markdown Extensions PRD](design/vitepress-markdown-extensions-prd.md)
- [Nuvyn VitePress-Style Markdown Extensions Implementation Plan](design/vitepress-markdown-extensions-implementation-plan.md)
- [Nuvyn VitePress-Style Markdown Extensions MD-EXT-0 Audit](design/vitepress-markdown-extensions-md-ext-0-audit.md)
- [Nuvyn VitePress-Style Markdown Extensions MD-EXT-1 Anchors, TOC, Links & Lazy Images](design/vitepress-markdown-extensions-md-ext-1-anchors-toc-links-images.md)
- [Nuvyn VitePress-Style Markdown Extensions MD-EXT-2 Custom Containers](design/vitepress-markdown-extensions-md-ext-2-containers.md)
- [Nuvyn VitePress-Style Markdown Extensions MD-EXT-3 Shiki Code Annotations & Unified Fence Metadata](design/vitepress-markdown-extensions-md-ext-3-code-annotations.md)
- [Nuvyn VitePress-Style Markdown Extensions MD-EXT-4 Line Numbers](design/vitepress-markdown-extensions-md-ext-4-line-numbers.md)
- [Nuvyn VitePress-Style Markdown Extensions MD-EXT-5 Code Groups](design/vitepress-markdown-extensions-md-ext-5-code-groups.md)
- [Nuvyn VitePress-Style Markdown Extensions MD-EXT-6 Safe Snippets & Markdown Includes](design/vitepress-markdown-extensions-md-ext-6-resources.md)
- [PDF Export V1 PRD](design/pdf-export-prd.md)
- [PDF Export V1 Implementation Plan](design/pdf-export-implementation-plan.md)
- [Board V1 PRD](design/board-v1-prd.md)

Diary design and implementation lineage below is historical and cannot
override the [Diary Architecture](architecture/diary.md) or [Diary User
Guide](user-guide/diary.md):

- [Diary Calendar PRD (Historical Planning)](design/diary-prd.md)
- [Diary Implementation Plan (Historical)](design/diary-implementation-plan.md)
- [Diary Home Workspace Lineage (Historical)](design/diary-home-workspace-prd.md)
- [Diary Mood Lineage (Historical)](design/diary-mood-prd.md)
- [Diary Encryption Lineage (Historical)](design/diary-encryption-implementation-plan.md)
- [Diary VCalendar Compatibility Evidence (Historical)](design/diary-vcalendar-compatibility-report.md)

Ledger planning documents below are historical implementation lineage, not current runtime authority:

- [Ledger v1 Product Requirements (Historical Planning)](design/ledger-v1-prd.md)
- [Ledger Foundation PRD (Historical Planning)](design/ledger-l0-foundation-prd.md)
- [Ledger L0 Foundation Implementation Plan (Historical Planning)](design/ledger-l0-foundation-implementation-plan.md)
- [Ledger UI Integration PRD (Historical Planning)](design/ledger-ui-integration-prd.md)
- [Ledger UI Integration Implementation Plan (Historical Planning)](design/ledger-ui-integration-implementation-plan.md)
- [Ledger Historical Period Navigation PRD (Historical Planning)](design/ledger-period-navigation-prd.md)
- [Ledger Historical Period Navigation Implementation Plan (Historical Planning)](design/ledger-period-navigation-implementation-plan.md)
- [Logo](design/logo.md)
- [Icon System](design/icon-system.md)
- [Icon Usage](design/icon-usage.md)

## Migrations

- [Document Metadata Migration](migrations/document-metadata.md)

## Historical Documents

[The documentation archive](archive/README.md) preserves completed plans, former specifications, implementation records, closure evidence, and freeze backlogs. It explains how Nuvyn evolved; it is not authoritative for current behavior. The [Diary V1 Final Closure](archive/closures/2026-09-14-diary-v1-final-closure.md) records the closure decision.

## Documentation Conventions

- Put user-visible behavior in `docs/user-guide/`.
- Put deployment and operational procedures in `docs/deployment/`.
- Put current implementation architecture in `docs/architecture/`.
- Put contributor workflows in `docs/development/`.
- Put reusable visual-system rules in `docs/design/`.
- Put one-time, still-supported upgrade procedures in `docs/migrations/`.
- Put completed plans, superseded specifications, implementation records, closure reports, and freeze notes in `docs/archive/`.

Keep one authoritative document per topic and link to it from shorter summaries. Do not place implementation plans or closure reports directly under `docs/`.
