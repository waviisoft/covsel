import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

describe('covsel cli', () => {
  it('prints help and exits 0 with no args', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(main([])).toBe(0);
    expect(out.mock.calls.join('')).toContain('covsel — runtime-coverage');
    out.mockRestore();
  });

  it('recognizes command stubs', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(main(['affected'])).toBe(1);
    expect(err.mock.calls.join('')).toContain('not implemented');
    err.mockRestore();
  });

  it('rejects unknown commands', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(main(['frobnicate'])).toBe(1);
    err.mockRestore();
  });
});
