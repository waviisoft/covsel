---
'@covsel/core': minor
---

Select on a dependency change instead of falling open on every lockfile diff.

Phase 3 of covsel/covsel#47. A lockfile change was a full run, and dependency
bumps are among the most frequent diffs a repository sees — on a busy repo that
single trigger can account for more full runs than every source change combined.
The information needed to do better has been recorded since #71 and #84 and read
by nothing. Now it decides.

When a diff's only dependency-related changes are lockfiles and `package.json`
edits confined to their dependency blocks, covsel resolves them to the set of
packages whose resolution actually moved, and selects the tests whose entries ran
code in one of those packages. A bump to a package one test executed runs that
test. A bump to a package no test executed runs nothing.

That downgrade of the lockfile sentinel is the only one covsel makes, and it
holds only when every precondition does. Each rules out a way the comparison
could be a lie rather than a measurement:

- **The map recorded an inventory.** Without one there is no "before" side. Every
  map recorded before that field existed is in this position, and takes the path
  it always did — the sentinel fires, in its own words. That is deliberate: it is
  not a downgrade that failed but a question the map cannot be asked, and a
  project that dropped lockfiles from its `sentinels` keeps the behaviour it
  chose rather than being overruled with a full run it decided not to spend.
- **The tree provably reflects the lockfile.** A lockfile pulled but not
  installed leaves the old packages on disk, so diffing inventories would report
  nothing changed and skip the tests for everything that really moved. pnpm
  writes a byte-identical copy of its lockfile into the store on every install,
  and comparing the two is the whole proof. Note the asymmetry that makes it
  necessary: "the tree shows no difference" is not a safe test on its own,
  because a tree stale for one reason can still differ for another.
- **The tree still yields an inventory now.** No "after" side, no comparison.
- **Every changed package was installed at record time.** One that was not is a
  package the map never had an opinion about, and its silence is an artifact
  rather than a measurement — the same distinction `observed` draws for paths.
- **Both sides used the same package manager.** A repository that switched
  between recording and now satisfies the freshness proof and nothing else.

A manifest edit is admitted only when every changed `package.json` moved nothing
but its dependency blocks. The sentinel matches every workspace manifest, so the
question is asked of each one: a `scripts` block edited in one package changes
how that suite runs whatever the others did.

Package changes are a separate axis from file changes, and deliberately not
synthesised as `Change` records with `node_modules/` paths. Those paths are
outside every recording's `observed` scope by construction, so each one would
trip the unobserved-change rule and force the very full run this exists to avoid.

`status` takes the same step in the same order as `affected`, so it cannot
announce a full run the selection then downgrades.

Also new: `fileAtCommit`, which reads one file as of one commit — the "before"
side of a manifest diff, for the cases where knowing _that_ a file changed is not
enough and what changed inside it decides the answer.

Only pnpm can reach the selecting path today, because only pnpm's marker is its
lockfile. npm and yarn keep falling open, now for two reasons rather than one:
they leave no comparable freshness proof, and their flat `node_modules` gives a
package no identity a change to its contents would move.

One edge worth naming, since it looks like a bug from outside: removing the
_last_ dependency a project has leaves nothing to vouch for, which is reported as
no inventory, and falls open. Correct, and invisible on any tree with more than
one package left standing.
