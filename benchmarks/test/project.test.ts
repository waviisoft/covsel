import { describe, expect, it } from 'vitest';

import { parseProject } from '../src/project.js';

const valid = {
  name: 'express',
  repo: 'expressjs/express',
  ref: '0123456789abcdef0123456789abcdef01234567',
  adapter: '@covsel/adapter-generic',
  adapterName: 'generic',
  install: ['npm', 'install'],
  runner: ['./node_modules/.bin/mocha', '--reporter', 'dot'],
  covsel: { testGlobs: ['test/**/*.js'], sourceGlobs: ['lib/**/*.js'] },
};

/** The valid definition with one field removed. */
const without = (field: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...valid };
  delete copy[field];
  return copy;
};

describe('parseProject', () => {
  it('accepts a complete definition', () => {
    const project = parseProject(valid, 'express.json');
    expect(project.name).toBe('express');
    expect(project.runner).toEqual(['./node_modules/.bin/mocha', '--reporter', 'dot']);
    expect(project.covsel.testGlobs).toEqual(['test/**/*.js']);
  });

  it('defaults covsel configuration to empty, which means covsel defaults', () => {
    expect(parseProject(without('covsel'), 'x.json').covsel).toEqual({});
  });

  it('keeps an optional rationale and omits it when absent', () => {
    expect(parseProject({ ...valid, rationale: 'why' }, 'x.json').rationale).toBe('why');
    expect(parseProject(valid, 'x.json').rationale).toBeUndefined();
  });

  it.each(['name', 'repo', 'ref', 'adapter', 'adapterName'])(
    'rejects a missing %s',
    (field) => {
      expect(() => parseProject(without(field), 'x.json')).toThrow(field);
    },
  );

  it('rejects an empty string where a name is required', () => {
    expect(() => parseProject({ ...valid, name: '   ' }, 'x.json')).toThrow('name');
  });

  it.each(['install', 'runner'])('rejects an empty %s command', (field) => {
    expect(() => parseProject({ ...valid, [field]: [] }, 'x.json')).toThrow(field);
  });

  it('rejects a command containing a non-string', () => {
    expect(() => parseProject({ ...valid, runner: ['mocha', 7] }, 'x.json')).toThrow(
      'runner',
    );
  });

  it('rejects a repo that is not owner/name', () => {
    expect(() => parseProject({ ...valid, repo: 'express' }, 'x.json')).toThrow('repo');
    expect(() => parseProject({ ...valid, repo: 'a/b/c' }, 'x.json')).toThrow('repo');
  });

  it('rejects anything that is not a JSON object', () => {
    expect(() => parseProject([], 'x.json')).toThrow('JSON object');
    expect(() => parseProject(null, 'x.json')).toThrow('JSON object');
    expect(() => parseProject('express', 'x.json')).toThrow('JSON object');
  });

  it('names the source file in the error, since a run reads many', () => {
    expect(() => parseProject({}, 'projects/fastify.json')).toThrow(
      /projects\/fastify\.json/,
    );
  });

  // A slash-less glob also matches that basename anywhere in the tree, so a
  // source set written as 'index.js' silently grows to every index.js in the
  // repository. That only ever widens selection, so a run would still produce
  // numbers -- for a source set nobody chose.
  it('rejects a slash-less glob, which would match the basename anywhere', () => {
    expect(() =>
      parseProject({ ...valid, covsel: { sourceGlobs: ['index.js'] } }, 'x.json'),
    ).toThrow(/no '\/'/);
  });

  it('accepts the same glob written as a path', () => {
    expect(() =>
      parseProject({ ...valid, covsel: { sourceGlobs: ['./index.js'] } }, 'x.json'),
    ).not.toThrow();
    expect(() =>
      parseProject({ ...valid, covsel: { sourceGlobs: ['**/index.js'] } }, 'x.json'),
    ).not.toThrow();
  });

  it('rejects a slash-less glob in any covsel field, not just sourceGlobs', () => {
    expect(() =>
      parseProject({ ...valid, covsel: { alwaysRun: ['fixture.js'] } }, 'x.json'),
    ).toThrow('alwaysRun');
  });
});
