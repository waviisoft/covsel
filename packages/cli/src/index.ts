import { MAP_SCHEMA_VERSION } from '@covsel/core';

const COMMANDS = ['record', 'affected', 'run', 'watch', 'explain', 'status'] as const;
type Command = (typeof COMMANDS)[number];

const HELP = `covsel — runtime-coverage test impact analysis for any JS/TS runner

Usage:
  covsel record  [--adapter <name>] -- <runner command>   Record a full run, build/refresh the map
  covsel affected [--since <ref>] [--format <fmt>]        Print tests affected by the diff
  covsel run     -- <runner command>                      Run only affected tests
  covsel watch   -- <runner command>                      Rerun affected tests as you edit
  covsel explain <file>                                   Show which tests cover a file
  covsel status                                           Map age, coverage, sentinel triggers

Options:
  -h, --help       Show this help
  -v, --version    Show version

covsel never skips a test whose behavior your change could alter — and when it
can't be sure, it runs it (fail-open). Map schema v${MAP_SCHEMA_VERSION}.
`;

export function main(argv: string[] = process.argv.slice(2)): number {
  const [cmd] = argv;

  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '-v' || cmd === '--version') {
    process.stdout.write('0.0.0\n');
    return 0;
  }
  if ((COMMANDS as readonly string[]).includes(cmd)) {
    process.stderr.write(
      `covsel ${cmd as Command}: not implemented yet — Milestone 1 (see DESIGN.md §7)\n`,
    );
    return 1;
  }
  process.stderr.write(`covsel: unknown command "${cmd}". Run covsel --help.\n`);
  return 1;
}
