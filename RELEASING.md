# Releasing

covsel publishes several packages from one repo. Releases are automated with
[Changesets](https://github.com/changesets/changesets); you rarely run `npm
publish` by hand.

## Published packages

| Package                   | npm            | Versioned |
| ------------------------- | -------------- | --------- |
| `covsel` (CLI)            | `covsel`       | semver    |
| `@covsel/core`            | `@covsel/core` | semver    |
| `@covsel/adapter-generic` | published      | semver    |

The docs site (`covsel-docs`) is `private` and never published to npm.

## Versioning policy (semver)

We follow [semver](https://semver.org/) **per package** — each package has its
own version and changelog.

- **patch** — bug fixes, docs, internal changes with no API impact.
- **minor** — backward-compatible additions (new flags, new adapter, new
  exported interface).
- **major** — breaking changes to a public API or CLI contract.

**Pre-1.0 caveat:** while packages are `0.x`, a **minor** bump may include
breaking changes. We still call those out loudly in the changeset. Adapters and
core version independently, but an adapter that requires a newer core should
declare that in its `peerDependencies`/`dependencies` range.

### The map schema is versioned too

`MAP_SCHEMA_VERSION` in `@covsel/core` is a separate, on-disk contract. Bumping
it invalidates every stored map, which — by the fail-open policy — forces a full
test run with a clear log line rather than trusting stale data. **A schema bump
is a breaking change to persisted state**: ship it with a changeset, explain the
invalidation in the changeset body, and treat it as at least a minor (pre-1.0)
or major (post-1.0) release of `@covsel/core`.

## Everyday flow: add a changeset with your PR

Anything user-facing needs a changeset. From your feature branch:

```bash
pnpm changeset
```

Pick the affected packages and bump types, and write a short, user-facing
summary (it becomes the changelog entry). Commit the generated file under
`.changeset/` as part of your PR. Changes that are purely internal (refactors,
test-only, CI) don't need one.

## Publishing is deferred (pre-alpha)

While covsel is pre-alpha, **nothing is published to npm.** The Release
workflow's publish step is guarded by `if: env.NPM_TOKEN != ''`, so with no
`NPM_TOKEN` secret configured the job is a green no-op — it will not push the
placeholder `0.0.0` packages.

To turn on releases when there's something tangible to ship:

1. Create the `@covsel` org (and reserve the bare `covsel` name) on npm, with
   2FA enabled.
2. Add an `NPM_TOKEN` repository secret (an automation token with publish
   rights).
3. Land a changeset that versions the packages off `0.0.0`.

Once the secret exists, the flow below activates automatically.

## How a release happens

1. PRs merge to `main`, each carrying its changeset(s).
2. The **Release** workflow (`.github/workflows/release.yaml`) runs the
   Changesets action, which opens (or updates) a **"Version Packages"** PR. That
   PR consumes the pending changesets, bumps versions, and updates each
   `CHANGELOG.md`.
3. Review and merge the Version Packages PR.
4. On that merge, the workflow runs `pnpm release` (`pnpm build && changeset
publish`) and publishes the bumped packages to npm.

## Publish requirements

- **npm provenance** is enabled (`NPM_CONFIG_PROVENANCE: true`, and the workflow
  has `id-token: write`), so published packages carry a verifiable build
  attestation. Provenance requires publishing from CI — don't publish releases
  from a laptop.
- The workflow authenticates with the `NPM_TOKEN` repository secret.
- Keep **2FA enabled** on the npm org.

## Manual publish (break-glass)

Only if CI cannot publish. You lose provenance, so prefer fixing CI.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm changeset publish   # publishes whatever versions are in package.json
```
