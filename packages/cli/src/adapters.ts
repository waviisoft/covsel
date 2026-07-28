/**
 * The adapters the CLI can dispatch to, in one place. An adapter is one object
 * satisfying `Adapter` from core, which is where every per-runner difference —
 * how to build a recorder, whether the runner can be narrowed below file level,
 * what to discover as tests when the project has not said — is declared. This
 * file only maps names to those objects; it knows nothing about their shape.
 */
import type { Adapter } from '@covsel/core';
import { genericAdapter } from '@covsel/adapter-generic';
import { vitestAdapter } from '@covsel/adapter-vitest';
import { jestAdapter } from '@covsel/adapter-jest';
import { nodeTestAdapter } from '@covsel/adapter-node-test';
import { cucumberAdapter } from '@covsel/adapter-cucumber';

/** Insertion order is the order adapter names are listed back to the user. */
export const ADAPTERS: Record<string, Adapter> = {
  generic: genericAdapter,
  vitest: vitestAdapter,
  jest: jestAdapter,
  'node-test': nodeTestAdapter,
  cucumber: cucumberAdapter,
};

export const DEFAULT_ADAPTER = 'generic';

/** The adapter names, rendered for an error message: `'a', 'b', or 'c'`. */
export function adapterNameList(): string {
  const names = Object.keys(ADAPTERS).map((n) => `'${n}'`);
  const last = names.pop();
  return names.length === 0 ? (last ?? '') : `${names.join(', ')}, or ${last}`;
}
