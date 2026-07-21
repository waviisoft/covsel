import { MAP_SCHEMA_VERSION } from '@covsel/core';

/**
 * Commands are added here only as they become usable. While covsel is
 * pre-alpha the CLI ships nothing it cannot actually do: it prints help and
 * its version, and nothing else. The planned command surface — record /
 * affected / run / watch / explain / status — is documented in the README's
 * "target UX" section, not advertised here as if it worked.
 */
const HELP = `covsel — runtime-coverage test impact analysis for any JS/TS runner

Status: pre-alpha. No selection commands are available yet; the map schema,
layer interfaces, and this CLI shell exist. See the README for the planned
command surface and how to follow along.

Usage:
  covsel --help       Show this help
  covsel --version    Show version

covsel never skips a test whose behavior your change could alter — and when it
can't be sure, it runs it (fail-open). Map schema v${MAP_SCHEMA_VERSION}.
`;

export const VERSION = '0.0.0';

export function main(argv: string[] = process.argv.slice(2)): number {
  const [arg] = argv;

  if (!arg || arg === '-h' || arg === '--help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (arg === '-v' || arg === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  process.stderr.write(`covsel: no commands are available yet. Run covsel --help.\n`);
  return 1;
}
