# Releasing

covsel publishes several packages from one repo. Releases are automated with
[Changesets](https://github.com/changesets/changesets); you rarely run `npm
publish` by hand.

## Published packages

| Package                      | Purpose                                   |
| ---------------------------- | ----------------------------------------- |
| `covsel`                     | The CLI                                   |
| `@covsel/core`               | Observer, Mapper, Store, Selector, Policy |
| `@covsel/conformance`        | The shared suite every adapter must pass  |
| `@covsel/adapter-generic`    | Wrap-any-command adapter                  |
| `@covsel/adapter-vitest`     | Vitest adapter                            |
| `@covsel/adapter-jest`       | Jest adapter                              |
| `@covsel/adapter-node-test`  | node:test adapter                         |
| `@covsel/adapter-mocha`      | Mocha adapter                             |
| `@covsel/adapter-cucumber`   | cucumber-js adapter                       |
| `@covsel/adapter-playwright` | Playwright adapter                        |

All of them are versioned by semver, independently. The docs site
(`covsel-docs`) and the benchmark harness (`@covsel/benchmarks`) are `private`,
so Changesets versions them and `changeset publish` never pushes them to npm.

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

## What publishing needs, and how it is set up

The Release workflow's publish step is guarded by `if: env.NPM_TOKEN != ''`, so
a repository with no `NPM_TOKEN` secret has a green no-op instead of a release —
which is what a fork gets, and what this repository had while it was pre-alpha.

Two things stand behind that secret, and they are claimed differently. **Creating
the `covsel` organisation on npm claims the whole `@covsel` scope**, before
anything is published. **The bare `covsel` name is claimed only by publishing to
it** — npm has no reservation mechanism, so nothing holds it in advance and the
first release is what takes it. Do not publish a placeholder to sit on a name;
npm's policy discourages it and it costs the real first release its provenance.

### The token

npm no longer issues classic "automation" tokens. What you can create is a
**granular access token**, which always carries an expiry, and configuring one
for a _first_ publish has a wrinkle worth knowing before you hit it: the package
selector only lists packages that already exist, so it cannot cover packages the
release is about to create. Grant it:

- **Packages and scopes** — read and write, for all packages.
- **Organizations** — read and write on `covsel`. This is the one people miss:
  without it the scoped packages 403 even though the bare `covsel` publishes
  fine, because creating a package inside a scope is an organisation write.

Once every package exists, regenerate a token scoped to exactly those packages
and replace the secret. Broad-then-narrow is the only order npm allows.

Check the organisation's publishing policy too (org → Settings → Publishing
access). Set to "require two-factor authentication", it rejects token publishes
outright and CI cannot publish at all.

**An expiring token fails loudly, not silently.** The secret still exists, so the
guard above still passes and npm answers 401 — a red release job, not a skipped
one. A release that goes red after a quiet period is almost always this.

Longer term, npm supports **trusted publishing** for GitHub Actions: OIDC, no
stored token, nothing to rotate, and provenance comes free. `release.yaml`
already has the `id-token: write` it needs. Configure it on each package's
settings page once the packages exist, then delete `NPM_TOKEN`.

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
  from a laptop. It also requires each package to declare the `repository` it is
  built from, which every published package here does.
- The workflow authenticates with the `NPM_TOKEN` repository secret.
- Keep **2FA enabled** on the npm org.
- Scoped packages publish publicly because `.changeset/config.json` sets
  `"access": "public"`. Without it npm would refuse a first publish under a
  scope, since scoped packages default to restricted.

## Manual publish (break-glass)

Only if CI cannot publish. You lose provenance, so prefer fixing CI.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm changeset publish   # publishes whatever versions are in package.json
```
