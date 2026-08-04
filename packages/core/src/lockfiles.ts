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
