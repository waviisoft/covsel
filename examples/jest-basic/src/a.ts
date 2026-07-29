import { tag } from './shared.js';

export function alpha(x: number): string {
  return tag(`alpha:${x * 2}`);
}
