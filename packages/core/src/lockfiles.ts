/**
 * Every lockfile covsel recognises, with the package manager that writes it.
 *
 * One list, read from two places, because they have to agree. A lockfile is
 * where covsel learns that a dependency changed at all: vendored code under
 * `node_modules` is deliberately outside what a recording maps, so nothing in
 * the map moves when a dependency version does, and only the lockfile shows it.
 * Every name here is therefore a default sentinel — a change to one invalidates
 * the map — and every name here is also how `covsel init` works out which
 * command installs an adapter. A manager known to one and not the other is the
 * bug this list exists to make unrepresentable: recognised well enough to
 * install with, but not well enough for its dependency bumps to run any tests.
 *
 * Order is detection order, for a project carrying more than one lockfile
 * because it changed managers and did not clean up. It settles nothing about
 * which install the tree reflects; it only keeps the answer stable. Sentinels
 * do not read it at all — a change to any name here forces a full run whatever
 * position it holds.
 *
 * Two names per manager is normal. npm honours `npm-shrinkwrap.json` over
 * `package-lock.json` when a project publishes one, and bun writes the binary
 * `bun.lockb` in older versions and the text `bun.lock` in newer ones — usually
 * one name or the other, both mid-migration. Covering only the name you have
 * heard of leaves the other exposed exactly as if neither were listed.
 *
 * `npm-shrinkwrap.json` sits last, out of npm's group, because it is the one
 * name that decides nothing on its own: a tree holding only a shrinkwrap
 * resolves to npm by the fallback anyway. Ahead of bun it would instead change
 * a bun project that once published one from bun to npm, for no gain.
 */
export const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['npm-shrinkwrap.json', 'npm'],
] as const;

/** Just the lockfile names, in detection order. */
export const LOCKFILE_NAMES: readonly string[] = LOCKFILES.map(([name]) => name);

/**
 * Files that decide how a lockfile becomes a `node_modules`.
 *
 * A flat list of names rather than a table like `LOCKFILES` above, because
 * nothing needs to know which manager reads which: no command is chosen from
 * this, and a name here has exactly one consequence — a change to it forces a
 * full run.
 *
 * A lockfile says which packages are installed. These say where they are put and
 * what resolves to them, and the two are independent: the same lockfile laid out
 * two ways gives a source two different answers for the same `import`. pnpm's
 * `hoist-pattern` is the sharp case — it fills
 * `node_modules/.pnpm/node_modules/`, the fallback that resolves undeclared
 * ("phantom") imports for everything in the store. Narrowing it removes that
 * directory, an import that worked becomes `MODULE_NOT_FOUND`, and the lockfile
 * does not move by so much as a byte.
 *
 * That is invisible to both halves of covsel's dependency reasoning. No sentinel
 * fires, and the inventory never enters the fallback directory, so a selection
 * is computed against a resolution that no longer holds and the tests for the
 * broken imports are skipped. `.pnpmfile.cjs` is worse still: it rewrites
 * manifests at install time, so it can change what any package depends on
 * without appearing anywhere else.
 *
 * They are sentinels rather than something the inventory measures, because the
 * inventory can only compare what it walked, and the whole difficulty is that
 * these files move what is reachable. A full run needs no such reasoning.
 *
 * The `pnpm` block in `package.json` belongs to this set too, and is already
 * covered by `package.json` being a sentinel.
 *
 * What this cannot cover: the same settings can be set outside the repository
 * entirely — a user-level `~/.npmrc`, or a `NPM_CONFIG_*` environment variable —
 * where nothing in a diff could ever show them. A CI runner configured
 * differently from the machine that recorded the map is beyond what a sentinel
 * can see.
 */
export const INSTALL_CONFIG_NAMES: readonly string[] = [
  '.npmrc', // npm and pnpm both read it
  '.pnpmfile.cjs', // pnpm's install-time hooks
  '.yarnrc.yml', // yarn berry
  '.yarnrc', // yarn classic
  'bunfig.toml', // bun
];
