/**
 * A stock ts-jest setup. covsel needs no configuration here — the adapter
 * passes the coverage flags it needs on the command line.
 */
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', {}] },
  // The sources use ESM `.js` specifiers, which ts-jest emits as CommonJS
  // requires; strip the extension so Jest's resolver finds the `.ts` file.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
