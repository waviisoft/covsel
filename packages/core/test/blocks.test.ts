import { describe, expect, it } from 'vitest';
import { changedBlockHashes, extractBlocks } from '../src/index.js';

const SRC = `import { tag } from './shared.js';

const PREFIX = 'x';

export function alpha(n) {
  return tag(PREFIX + n * 2);
}

export const beta = (n) => tag(PREFIX + (n + 1));
`;

function block(source: string, name: string): string | undefined {
  return extractBlocks(source).find((b) => b.name === name)?.hash;
}

describe('extractBlocks', () => {
  it('emits a module block plus one block per function', () => {
    const names = extractBlocks(SRC).map((b) => b.name);
    expect(names[0]).toBe('<module>');
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('is stable across reformatting (whitespace / line shifts)', () => {
    const reformatted = SRC.replace(/\n/g, '\n\n').replace(
      'return tag',
      '  return    tag',
    );
    for (const name of ['<module>', 'alpha', 'beta']) {
      expect(block(reformatted, name)).toBe(block(SRC, name));
    }
  });

  it('changes only the edited function block on a body edit', () => {
    const edited = SRC.replace('n * 2', 'n * 3');
    expect(block(edited, 'alpha')).not.toBe(block(SRC, 'alpha'));
    expect(block(edited, 'beta')).toBe(block(SRC, 'beta'));
    expect(block(edited, '<module>')).toBe(block(SRC, '<module>'));
  });

  it('changes the module block on a top-level edit', () => {
    const edited = SRC.replace("'x'", "'y'");
    expect(block(edited, '<module>')).not.toBe(block(SRC, '<module>'));
    expect(block(edited, 'alpha')).toBe(block(SRC, 'alpha'));
  });

  it('does not throw on malformed input', () => {
    expect(() => extractBlocks('function ( { bad')).not.toThrow();
  });
});

describe('changedBlockHashes', () => {
  it('is empty for a pure reformat', () => {
    const reformatted = SRC.replace(/\n/g, '\n\n');
    expect(changedBlockHashes(SRC, reformatted)).toEqual([]);
  });

  it('reports the edited function hash', () => {
    const edited = SRC.replace('n * 2', 'n * 3');
    expect(changedBlockHashes(SRC, edited)).toContain(block(SRC, 'alpha'));
    expect(changedBlockHashes(SRC, edited)).not.toContain(block(SRC, 'beta'));
  });

  it('reports the module hash on a top-level edit', () => {
    const edited = SRC.replace("'x'", "'y'");
    expect(changedBlockHashes(SRC, edited)).toContain(block(SRC, '<module>'));
  });

  it('reports the removed block when a function is deleted', () => {
    const removed = SRC.replace(
      /export const beta = \(n\) => tag\(PREFIX \+ \(n \+ 1\)\);\n/,
      '',
    );
    const changed = changedBlockHashes(SRC, removed);
    expect(changed).toContain(block(SRC, 'beta'));
  });
});
