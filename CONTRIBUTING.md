# Contributing to covsel

Thanks for your interest! Adapters are the primary community contribution
surface — core stays small and stable.

New here? [`AGENTS.md`](./AGENTS.md) captures the repo conventions (code style,
the fail-open rule, testing, git/PR practices) in one place — worth a skim
before your first PR.

## Dev setup

```bash
git clone https://github.com/waviisoft/covsel
cd covsel
pnpm install
pnpm build && pnpm test
```

Requires Node ≥ 22 and pnpm (via `corepack enable`).

## Repo layout

- `packages/core` — Observer, Mapper, Store, Selector, Policy, map schema.
  Changes here need a design discussion first (open an issue).
- `packages/cli` — the `covsel` command, thin over core.
- `packages/adapter-*` — one package per runner. **This is where new
  contributors should start.**

## Writing an adapter

1. Open an _adapter request_ issue (template provided) or claim an existing one.
2. Copy `packages/adapter-generic` as a starting point.
3. Export one object implementing the `Adapter` interface from `@covsel/core`.
   Its `createRecorder` observes the runner — calling `observer.startTest(id)` /
   `observer.endTest(id)` around each test via your runner's lifecycle hooks —
   and its `formatSelection` emits the runner's input for a selection. Runners
   that can be narrowed below file level add `runSelection`; runners whose tests
   are not `*.test.*` sources add `defaultTestGlobs`.
4. Pass `@covsel/conformance`, the shared suite every adapter runs. See
   [`docs/guide/adapters/writing-an-adapter.md`](./docs/guide/adapters/writing-an-adapter.md)
   for the fixture it needs, and `packages/adapter-generic/test` for a worked
   example.

## Workflow

- Branch from `main`; open a PR with a [Changeset](https://github.com/changesets/changesets)
  (`pnpm changeset`) for anything user-facing. See [`RELEASING.md`](./RELEASING.md)
  for how versions and publishing work.
- CI must pass: lint, typecheck, build, tests, and format check on Node
  22/24.
- Adapter packages list their maintainer in `CODEOWNERS`.
- Never include secrets, tokens, or personal data in code, tests, fixtures, or
  PR text.

## Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
