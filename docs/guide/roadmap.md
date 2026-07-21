# Roadmap

covsel ships in milestones. The full plan — including the seed issue backlog —
is in [DESIGN.md](https://github.com/waviisoft/covsel/blob/main/DESIGN.md).

## Milestone 0 — Repo bootstrap ✅

Repo exists, CI is green, the OSS scaffolding is complete, and a contributor can
clone, `pnpm install`, `pnpm test`, and `pnpm build` with zero manual steps. The
CLI shell (`--help` / `--version`) and the versioned map schema are in place.

## Milestone 1 — MVP: Level-0 file-level selection

- `core`: Observer (`NODE_V8_COVERAGE` process mode), Mapper (source-map →
  `sourceGlobs`), local Store, file-level Selector, Policy (fail-open,
  sentinels, new-test detection).
- `adapter-generic` + `adapter-vitest`.
- CLI: `record`, `affected`, `run`, `status`.
- `examples/vitest-basic` proves the loop end-to-end in CI.

**Done when:** editing one source file selects only the test files that execute
it; editing a sentinel selects everything; a brand-new test always runs.

## Milestone 2 — v1: per-test precision + real adapters

- Inspector snapshot-diff Observer (per-test granularity).
- **Block-hash** granularity in the Mapper.
- Adapters: `jest`, `mocha`, `node:test`, **`cucumber`**, `playwright`.
- CI story: publish-map-on-main, fetch-merge-base-map-on-PR, shard-merge; Stores
  for GitHub Actions cache + S3/GCS.
- `covsel watch`.

## Milestone 3 — v2: bundlers, monorepo, ecosystem

- Bundler source-map plugins (Turbopack/webpack/esbuild/vite) for browser
  coverage.
- Compose with Nx/Turbo project graphs.
- fs-read tracking for non-JS dependencies.
- Optional remote map service.
