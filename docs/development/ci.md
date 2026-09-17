# Continuous Integration

The GitHub Actions workflow in `.github/workflows/ci.yml` runs for pull requests
and for pushes to `main`. A feature-branch push is covered by its pull request,
so it does not start a second identical workflow run.

## Verification lanes

- `static-check` runs typechecking and the production build once on Ubuntu with
  Node.js 24.
- `unit`, `integration-history`, and `integration-recovery` run the independent
  Vitest lanes in parallel on Ubuntu with Node.js 24. Recovery remains the full
  crash-recovery suite.
- `e2e-application` runs the complete application-level browser suite once on
  Ubuntu with Node.js 24, split into two Playwright shards. Its config keeps
  `fullyParallel: false`, `workers: 1`, and `retries: 0` because each shard
  shares one server generation, Vault, and browser persistence.
- `draft-store-e2e` runs the Draft Store browser suite once on Ubuntu with
  Node.js 24.
- `platform-compatibility` runs only the targeted `test:platform-smoke` lane
  on Ubuntu with Node.js 22, Windows with Node.js 24, and macOS with Node.js
  24.

The remaining dedicated lanes stay separate: `tags-scale`, `docker-smoke`,
`auth-browser`, and the macOS `visual` baseline job. Browser and visual jobs
upload failure evidence with unique artifact names where applicable.

This topology keeps full application correctness on the canonical Ubuntu/Node
24 lanes while retaining targeted OS and Node compatibility coverage. It does
not make critical lanes non-blocking or reduce assertions.

## Additional jobs

- `docker-smoke` builds the production image, starts it with temporary writable mounts, and probes `/api/health`.
- `visual` runs the Markdown visual baselines on macOS and uploads failure evidence.
- Browser and visual jobs upload `test-results/` artifacts when failures occur.

The workflow grants read-only repository contents permission and cancels an older run for the same workflow and ref when a replacement starts.

## Keeping CI maintainable

When adding a required local verification command, add it to CI or explain why it is intentionally local-only. Keep platform-specific baselines out of the cross-platform suite, and use fault-injection fixtures rather than timing guesses for crash guarantees.
