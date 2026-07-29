import { tag } from './shared.js';

export function beta(x: number): string {
  return tag(`beta:${x + 1}`);
}
