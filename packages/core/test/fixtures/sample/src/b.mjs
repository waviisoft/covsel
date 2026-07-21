import { tag } from './shared.mjs';
export function beta(x) {
  return tag(`beta:${x + 1}`);
}
