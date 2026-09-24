// covsel's `inventory.command` reads this script's stdout as its own test
// inventory JSON -- every scenario's id and, where the harness's owner tracks
// one, an opaque version. It exists so a scenario's own definition changing
// can select just that scenario, without a repository-wide sentinel forcing
// a full run on every change to the harness. See docs/guide/adapters/harness.md
// and docs/guide/getting-started.md's "Tests that are not files" section.
//
// `HARNESS_VERSIONS_FILE`, when set, points at a JSON file tracking each
// scenario's version -- deliberately outside this repository's own working
// tree, the way a real harness's would be (a step file's hash, a pinned spec
// commit, a broker's revision, all living wherever *that* is owned, not here).
// A version tracked *inside* this repo would be a file covsel's own diff can
// see, and an untracked one changing would correctly force a full run as an
// unobserved change -- which is exactly the failure this mechanism exists to
// avoid, so the example does not shortcut it by writing one.
//
// `mul` is not a file in this repository at all -- unlike `add`/`sub`, which
// still have an anchor file under `harness/tests/` for `testGlobs` to match,
// `spec:mul` is named only here. That is the ordinary shape for an acceptance
// suite an external harness drives entirely: recording and selection both
// work for it purely through this inventory, with no file on disk standing
// in for it anywhere.
//
// `div`, present only once `versions.json` names it, stands in for a
// scenario the inventory adds later -- new to covsel, never recorded, and
// never given a `TESTS` entry in `run.py` either, since these scenarios only
// ever appear in a selection this example reads, never one it runs.
import { existsSync, readFileSync } from 'node:fs';

const versionsPath = process.env.HARNESS_VERSIONS_FILE;
const versions =
  versionsPath !== undefined && existsSync(versionsPath)
    ? JSON.parse(readFileSync(versionsPath, 'utf8'))
    : {};

const entries = ['add', 'sub'].map((id) => ({
  id: { file: `harness/tests/${id}.harness` },
  version: versions[id] ?? 'v1',
}));
entries.push({ id: { file: 'spec:mul' }, version: versions.mul ?? 'v1' });
if (versions.div !== undefined) {
  entries.push({ id: { file: 'spec:div' }, version: versions.div });
}

process.stdout.write(
  JSON.stringify({
    source: process.env.HARNESS_SOURCE ?? 'harness-basic-inventory',
    entries,
  }),
);
