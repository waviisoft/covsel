# AGENTS.md

Conventions for AI agents (and humans) working in this repo. Keep changes
consistent with what's here; if you change a convention, update this file in the
same PR.

## What covsel is

Runtime-coverage test impact analysis for any JS/TS runner: watch what code each
test executes, persist a `test → covered-code` map, and given a git diff run
only the tests whose covered code changed. The guiding architecture and
rationale live in [`DESIGN.md`](./DESIGN.md).

## The one rule that overrides the others: fail open

covsel's promise is that it **never skips a test whose behavior a change could
alter**. Every ambiguity resolves toward running _more_ tests, never fewer. When
you touch selection, policy, the map schema, or anything that decides what runs:

- Prefer over-selection to under-selection, always.
- A stale, unreadable, wrong-schema, or absent map means **run everything**.
- Add a test that would fail if your change could cause a needed test to be
  skipped. This is the anti-regression guard we care about most.

## Repository layout

```
packages/core/              @covsel/core — Observer/Mapper/Store/Selector/Policy
                            interfaces + the versioned map schema. Stable contract;
                            discuss design changes in an issue first.
packages/cli/               covsel — the CLI, thin over core.
packages/adapter-generic/   @covsel/adapter-generic — Level-0 wrap-any-command adapter.
packages/adapter-*/         one package per runner (the community lane).
docs/                       VitePress site (private package, deployed to GitHub Pages).
```

## Toolchain

pnpm workspaces, TypeScript (ESM-first with a dual CJS build via tsup), Vitest,
ESLint (flat) + Prettier, Changesets. Node ≥ 22.

```bash
pnpm install
pnpm build            # tsup build of every package
pnpm test             # vitest (tests live in packages/*/test)
pnpm typecheck        # tsc --noEmit per package
pnpm lint             # eslint
pnpm format           # prettier --write .
pnpm format:check     # prettier --check . (CI runs this)
pnpm docs:dev         # run the docs site locally
pnpm docs:build       # build the docs site
```

Before pushing, the full green bar is: `pnpm lint && pnpm typecheck && pnpm build
&& pnpm test && pnpm format:check` (and `pnpm docs:build` if you touched docs).
CI runs these across Node 22/24.

## Code conventions

- **ESM with explicit extensions.** `moduleResolution` is NodeNext — import local
  files with a `.js` extension (`./schema.js`), even from `.ts` sources.
- **Prettier is authoritative:** single quotes, semicolons, trailing commas,
  `printWidth` 90. Run `pnpm format`; don't hand-format.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax` are on. Use `import type`
  for type-only imports.
- **Adapters depend on `@covsel/core` only** — never on each other or on CLI
  internals.

### Comments do not reference issues, PRs, or docs

Code comments must **not** cite issue numbers, PR numbers, commit hashes, or
section anchors in Markdown docs (e.g. "see DESIGN.md §7", "lands in Issue #14").
Those references rot the moment the tracker or the doc is reorganized. Explain
the _why_ in prose that stands on its own. Roadmap/milestone tracking lives in
GitHub issues, not in source.

### Ship only what works

The CLI (and any user-facing surface) exposes **only implemented behavior**.
Don't add command stubs that error with "not implemented" — a command appears
when it works. Planned UX is documented in the README/docs as "target UX," not
wired into the tool. Likewise, don't advertise milestones in user-facing text.

## Testing

- Vitest. Tests live in `packages/<pkg>/test/**/*.test.ts`; the workspace alias
  resolves `@covsel/core` to source, so no build step is needed to run them.
- Integration tests that spawn a subprocess (e.g. the `NODE_V8_COVERAGE`
  coverage-observation test in `@covsel/core`) are fine — give them a generous
  per-test timeout and clean up temp dirs in a `finally`.
- Put runner fixtures under `packages/<pkg>/test/fixtures/`. Fixtures named
  `*.test.mjs` are not collected by Vitest (it only collects `*.test.ts`).

## Releases

Semver per package, automated with Changesets. Add a changeset (`pnpm
changeset`) for any user-facing change. Bumping `MAP_SCHEMA_VERSION` is a
breaking change to persisted state. Full process: [`RELEASING.md`](./RELEASING.md).

## Git & PRs

- Branch from `main`. Do not commit build artifacts — `dist/`, `node_modules/`,
  and VitePress output are gitignored; keep it that way.
- PRs use the template: a titleless prose **summary** (written to read as the
  squash-merge commit message, with no issue/PR references), optional **Why** and
  **Changes**, the **checklist**, and any GitHub attributions at the bottom.
- We squash-merge; the PR summary becomes the commit message.
- Never put secrets, tokens, or personal data in code, tests, fixtures, commit
  messages, or PR text.

## Identity

License is **MIT**; copyright holder is **WAVIISoft, LLC**. Use that exact name
in any copyright or author field.
